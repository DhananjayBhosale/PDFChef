import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import { FileType2 } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { Badge, Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { PDFFile, ProcessingStatus } from '../../types';
import {
  convertPDFToDocx,
  DOCX_MIME_TYPE,
  NO_EXTRACTABLE_TEXT_MESSAGE,
} from '../../services/docxExport';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import { formatBytes } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const PDFToWord: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const handleFilesSelected = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!isPdfFile(selected)) {
      setStatus({ ...idleStatus(), error: 'Choose a PDF file.' });
      return;
    }
    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm('This is a large PDF and may use substantial browser memory. Continue?')
    ) {
      return;
    }

    activeRun.current += 1;
    setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size });
    setStatus(idleStatus());
  };

  const handleConvert = async () => {
    if (!file) return;
    const runId = activeRun.current + 1;
    activeRun.current = runId;
    setStatus({ isProcessing: true, progress: 5, message: 'Opening PDF…' });

    try {
      const blob = await convertPDFToDocx(file.file, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException('Operation cancelled.', 'AbortError');
        const progress = total > 0 ? Math.round((current / total) * 90) + 5 : 5;
        setStatus({ isProcessing: true, progress, message: `Reading page ${current} of ${total}…` });
      });
      if (activeRun.current !== runId) return;

      const baseName = file.name.replace(/\.pdf$/i, '') || 'converted';
      downloadBlob(blob, `${baseName} (converted).docx`, DOCX_MIME_TYPE);
      setStatus({ isProcessing: false, progress: 100, message: 'Word document ready.' });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? error.message : 'PDF to Word conversion failed.',
      });
    }
  };

  const cancelConversion = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: 'Conversion cancelled. Nothing was saved.' });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const refusal = status.error === NO_EXTRACTABLE_TEXT_MESSAGE;

  return (
    <ToolShell centered={!file}>
      {/* The fidelity limits are stated once, beside the button, not here and
          there. */}
      <ToolHeader title={<>PDF to Word <Badge tone="caution" className="align-middle">Beta</Badge></>} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div key="upload" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf,application/pdf" label="Choose a PDF" />
          </motion.div>
        ) : (
          <motion.section
            key="selected"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300">
                <FileType2 aria-hidden size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">
                  {formatBytes(file.size)} · PDF
                </p>
              </div>
            </div>

            {/* Kept: this is a beta text export, and a user who expects the page
                design back would only find out after opening the .docx. */}
            <p className="mt-2.5 border-t border-[var(--border-hairline)] pt-2.5 type-footnote text-[var(--text-secondary)]">
              Text is exported; fonts, images, tables, and layout are not.
            </p>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-cyan-200 bg-cyan-50 p-3 dark:border-cyan-400 dark:bg-cyan-500/10">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-cyan-900 dark:text-cyan-100">
                  <span>{status.message || 'Converting…'}</span>
                  <span className="tabular-nums">{status.progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="PDF to Word progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={status.progress}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-cyan-100 dark:bg-cyan-950"
                >
                  <div className="h-full rounded-full bg-cyan-600 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
              </div>
            )}

            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                <p className="font-bold">{refusal ? 'No text to convert' : 'Conversion failed'}</p>
                <p className="mt-1 leading-relaxed">{status.error}</p>
              </div>
            )}

            {!status.isProcessing && status.message && (
              <p role="status" aria-live="polite" className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                {status.message}
              </p>
            )}

            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
              {status.isProcessing ? (
                <Button tone="secondary" block onClick={cancelConversion}>
                  Cancel
                </Button>
              ) : (
                <Button
                  tone="primary"
                  block
                  className="sm:w-auto"
                  icon={<FileType2 aria-hidden size={18} />}
                  onClick={() => void handleConvert()}
                >
                  {status.error ? 'Try again' : 'Export Word document'}
                </Button>
              )}
              <Button tone="secondary" block className="sm:w-auto" disabled={status.isProcessing} onClick={chooseAnother}>
                Choose another
              </Button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {!file && status.error && (
        <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-300">
          {status.error}
        </div>
      )}
    </ToolShell>
  );
};
