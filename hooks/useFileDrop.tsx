import { t } from '../services/i18n/core.ts';
import { useI18n } from '../services/i18n/react';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { acceptsDroppedFile } from '../services/fileDrop';
import { useOpenedPdf } from './useOpenedPdf';

interface DropTarget {
  accept: string;
  onFiles: (files: File[]) => void | Promise<void>;
  element?: React.RefObject<HTMLElement>;
  priority?: number;
}

const DropContext = createContext<Set<React.MutableRefObject<DropTarget>> | null>(null);

export function useFileDrop(target: DropTarget) {
  const targets = useContext(DropContext);
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    targets?.add(latest);
    return () => { targets?.delete(latest); };
  }, [targets]);
}

/** One owner prevents browser navigation; mounted tools own how files are imported. */
export const FileDropProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useI18n();
  const targets: Set<React.MutableRefObject<DropTarget>> = useRef(new Set<React.MutableRefObject<DropTarget>>()).current;
  const { setOpenedPdfFile } = useOpenedPdf();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const dragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return; // Leave text selection and in-app sorting alone.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const drop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!hasFiles(event) && !files.length) return;
      event.preventDefault();
      setError('');
      if (!files.length) return;
      const containsTarget = (target: DropTarget) => event.target instanceof Node
        && Boolean(target.element?.current?.contains(event.target));
      const candidates = Array.from(targets, (ref) => ref.current).sort((a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) || Number(containsTarget(b)) - Number(containsTarget(a)));
      for (const candidate of candidates) {
        const accepted = files.filter((file) => acceptsDroppedFile(file, candidate.accept));
        if (!accepted.length) continue;
        Promise.resolve().then(() => candidate.onFiles(accepted)).catch(() => {
          setError(t("use-file-drop.unable.to.open.these.files.please.try.d9cdfe"));
        });
        return;
      }
      const pdf = files.find((file) => acceptsDroppedFile(file, '.pdf,application/pdf'));
      if (pdf) {
        setOpenedPdfFile(pdf);
        navigate('/view');
      } else {
        setError(t("use-file-drop.this.file.is.not.supported.here.drop.cac5ac"));
      }
    };
    window.addEventListener('dragover', dragOver);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('drop', drop);
    };
  }, [navigate, setOpenedPdfFile, targets]);

  return <DropContext.Provider value={targets}>
    {children}
    {error && <div role="alert" className="fixed inset-x-4 top-4 z-[250] mx-auto max-w-lg rounded-xl bg-[var(--surface-raised)] p-4 shadow-lg">
      {error}
      <button className="chef-target ml-3 underline" onClick={() => setError('')}>{t("use-file-drop.dismiss.48845b")}</button>
    </div>}
  </DropContext.Provider>;
};
