import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Upload } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useOpenedPdf, type OpenedPdfRouteState } from '../../hooks/useOpenedPdf';
import { Button, cx } from './Primitives';
import { useHaptics } from '../../hooks/useWorkspaceRuntime';

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
  label = 'Choose a PDF',
  allowOpenedPdf = true,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [usedOpenedPdf, setUsedOpenedPdf] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const { openedPdf } = useOpenedPdf();
  const haptic = useHaptics();

  const acceptsPdf = accept.toLowerCase().includes('.pdf') || accept.toLowerCase().includes('application/pdf');
  const routeState = location.state as OpenedPdfRouteState | null;
  const canUseOpenedPdf = Boolean(allowOpenedPdf && openedPdf && acceptsPdf);

  useEffect(() => {
    if (
      !canUseOpenedPdf
      || !routeState?.useOpenedPdf
      || routeState.openedPdfId !== openedPdf?.id
      || usedOpenedPdf
      || !openedPdf
    ) return;
    setUsedOpenedPdf(true);
    onFilesSelected([openedPdf.file]);
  }, [canUseOpenedPdf, onFilesSelected, openedPdf, routeState?.openedPdfId, routeState?.useOpenedPdf, usedOpenedPdf]);

  const openPicker = useCallback(() => {
    haptic('selection');
    inputRef.current?.click();
  }, [haptic]);

  return (
    <div
      data-file-upload
      onDragOver={(event) => {
        event.preventDefault();
        if (!isDragging) setIsDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setIsDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        const dropped = Array.from(event.dataTransfer.files ?? []);
        if (dropped.length > 0) {
          haptic('commit');
          onFilesSelected(multiple ? dropped : dropped.slice(0, 1));
        }
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
            onFilesSelected(picked);
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

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button tone="primary" icon={<FolderOpen aria-hidden size={16} />} onClick={openPicker}>
          {multiple ? 'Choose files' : 'Choose file'}
        </Button>
        {canUseOpenedPdf && openedPdf && (
          <Button icon={<FileText aria-hidden size={16} />} onClick={() => onFilesSelected([openedPdf.file])}>
            Use {openedPdf.name.length > 22 ? `${openedPdf.name.slice(0, 20)}…` : openedPdf.name}
          </Button>
        )}
      </div>

    </div>
  );
};
