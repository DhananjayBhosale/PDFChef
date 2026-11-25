import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, FileText, FolderOpen, Upload } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getDropZoneError, registerDropZone, rememberPickedFile, subscribeDropZoneError } from './dropZone';
import { ErrorText } from './ErrorText';
import { useOpenedPdf, type OpenedPdfRouteState } from '../../hooks/useOpenedPdf';
import { Button, cx } from './Primitives';
import { useHaptics } from '../../hooks/useWorkspaceRuntime';
import { takeHandedDrop, useFileDrop } from '../../hooks/useFileDrop';
import { preloadPdfEngine } from '../../services/pdfLazy';

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void;
  accept: string;
  multiple?: boolean;
  label?: string;
  /**
   * Whether the currently opened PDF may seed this queue. Compare needs it for
   * Document A only: seeding both slots would silently compare a file with
   * itself.
   */
  allowOpenedPdf?: boolean;
  /** Why the last file did not open; shown inside the zone, under its label (T-09). */
  error?: string;
  /** A drop hands on every file even when the picker takes one (Compare: A, then B). */
  dropsAll?: boolean;
}

/**
 * The one way a document enters the app. It is a button first and a drop target
 * second, because on a phone there is nothing to drop. Drag styling only appears
 * on devices that can actually drag.
 */
export const FileUpload: React.FC<FileUploadProps> = ({
  onFilesSelected,
  accept,
  multiple = false,
  label = t("file-upload.choose.a.pdf.3ba70f"),
  allowOpenedPdf = true,
  error,
  dropsAll = false,
}) => {
  useI18n();
  // An empty file is refused at the door (T-09): it can only fail later, after a main action looked ready.
  const [emptyError, setEmptyError] = useState('');
  const handedError = useSyncExternalStore(subscribeDropZoneError, getDropZoneError, () => '');
  useEffect(() => registerDropZone(accept), [accept]);
  const intake = (files: File[]) => {
    const empty = files.filter((file) => file.size === 0);
    setEmptyError(empty.length ? t('file-upload.empty.file', { v0: empty[0].name }) : '');
    const usable = files.filter((file) => file.size > 0);
    rememberPickedFile(window.location.pathname, usable);
    if (usable.length) onFilesSelected(usable);
  };
  const shownError = emptyError || error || handedError;
  const [isDragging, setIsDragging] = useState(false);
  const usedOpenedPdf = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { openedPdf } = useOpenedPdf();
  const haptic = useHaptics();
  const takeDrop = (files: File[]) => {
    haptic('commit');
    intake(multiple || dropsAll ? files : files.slice(0, 1));
  };
  useFileDrop({ accept, element: dropRef, onFiles: takeDrop });
  // A file dropped on the loaded tool: its Change brought this zone back, and the file comes in here.
  useEffect(() => {
    const handed = takeHandedDrop(window.location.pathname);
    if (handed) takeDrop(handed);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the zone appears
  }, []);

  const acceptsPdf = accept.toLowerCase().includes('.pdf') || accept.toLowerCase().includes('application/pdf');
  const routeState = location.state as OpenedPdfRouteState | null;
  const canUseOpenedPdf = Boolean(allowOpenedPdf && openedPdf && acceptsPdf);

  useEffect(() => {
    if (
      !canUseOpenedPdf
      || !routeState?.useOpenedPdf
      || routeState.openedPdfId !== openedPdf?.id
      || usedOpenedPdf.current
      || !openedPdf
    ) return;
    let cancelled = false;
    // Wait until mount effects finish. StrictMode's initial cleanup must not invalidate a
    // document load started by the first effect pass or start that same cached load twice.
    queueMicrotask(() => {
      if (cancelled || usedOpenedPdf.current) return;
      usedOpenedPdf.current = true;
      // Consume history too: this upload surface remounts when the reader closes a document.
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
        replace: true,
        state: { ...routeState, useOpenedPdf: false },
      });
      rememberPickedFile(location.pathname, [openedPdf.file]);
      onFilesSelected([openedPdf.file]);
    });
    return () => { cancelled = true; };
  }, [canUseOpenedPdf, location.pathname, location.search, location.hash, navigate, onFilesSelected, openedPdf, routeState]);

  // PDF.js is not part of a tool's first screen: it starts loading once a person reaches for the
  // zone, so it is usually ready by the time the picker closes.
  const preload = acceptsPdf ? preloadPdfEngine : undefined;

  const openPicker = useCallback(() => {
    haptic('selection');
    inputRef.current?.click();
  }, [haptic]);

  return (
    <div
      ref={dropRef}
      data-file-upload
      onPointerDownCapture={preload}
      onFocusCapture={preload}
      onDragEnter={preload}
      onDragOver={(event) => {
        event.preventDefault();
        if (!isDragging) setIsDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setIsDragging(false);
      }}
      onDrop={() => {
        setIsDragging(false);
      }}
      className={cx(
        'rounded-[var(--radius-panel)] border border-dashed p-4 text-center transition-colors duration-transition ease-settle sm:p-6',
        isDragging
          ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)]'
          : 'border-[var(--border-strong)] bg-[var(--surface-raised)]',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        // Opened by the labelled button beside it, so it must not also sit in
        // the tab order as an unlabelled 1x1 stop.
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          if (picked.length > 0) {
            haptic('commit');
            intake(picked as File[]);
          }
          event.target.value = '';
        }}
      />

      <span
        aria-hidden
        className="mx-auto mb-2 grid h-11 w-11 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]"
      >
        <Upload size={20} strokeWidth={1.9} />
      </span>

      <h2 className="type-title3 font-semibold text-[var(--text-primary)]">{label}</h2>
      {shownError && (
        <p role="alert" className="tk-drop-error">
          <AlertTriangle aria-hidden size={16} className="mt-0.5 shrink-0" />
          <span><ErrorText text={shownError} /></span>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button tone="primary" icon={<FolderOpen aria-hidden size={16} />} onClick={openPicker}>
          {multiple ? t("file-upload.choose.files.1157de") : t("file-upload.choose.file.b09c73")}
        </Button>
        {canUseOpenedPdf && openedPdf && (
          <Button icon={<FileText aria-hidden size={16} />} onClick={() => onFilesSelected([openedPdf.file])}>{t("file-upload.message.1a047c4b6b", { v0: openedPdf.name.length > 22 ? t("file-upload..1092cb", { v0: openedPdf.name.slice(0, 20) }) : openedPdf.name })}</Button>
        )}
      </div>

    </div>
  );
};
