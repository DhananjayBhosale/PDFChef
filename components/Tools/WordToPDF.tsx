import React, { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FileUpload } from '../UI/FileUpload';
import { Badge, Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { convertDocxToPdf } from '../../services/officeDocument';
import { downloadBytes } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';
import { formatBytes } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const WordToPDF: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const select = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.docx')) {
      setStatus({ ...idleStatus(), error: 'Choose a .docx Word file. Older .doc files are not supported.' });
      return;
    }
    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm('This is a large Word file and may use substantial browser memory. Continue?')
    ) {
      return;
    }

    activeRun.current += 1;
    setFile(selected);
    setStatus(idleStatus());
  };

  const convert = async () => {
    if (!file) return;
    const runId = activeRun.current + 1;
    activeRun.current = runId;
    setStatus({ isProcessing: true, progress: 5, message: 'Opening Word document…' });

    try {
      const bytes = await convertDocxToPdf(file, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException('Operation cancelled.', 'AbortError');
        const progress = Math.round(10 + (current / Math.max(1, total)) * 85);
        setStatus({
          isProcessing: true,
          progress,
          message: `Laying out paragraph ${current} of ${total}…`,
        });
      });
      if (activeRun.current !== runId) return;

      downloadBytes(bytes, `${file.name.replace(/\.docx$/i, '')}.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: 'PDF ready.' });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? error.message : 'Word to PDF conversion failed.',
      });
    }
  };

  const cancel = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: 'Conversion cancelled. Nothing was saved.' });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const refusal = Boolean(status.error && /no readable text|does not contain a word document|not a readable \.docx/i.test(status.error));

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={<>Word to PDF <Badge tone="caution" className="align-middle">Beta</Badge></>} />

      <div>
        {!file ? (
          <FileUpload
            onFilesSelected={select}
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            label="Choose a .docx Word file"
          />
        ) : (
          <section className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
                <FileText aria-hidden size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">
                  {formatBytes(file.size)} · .docx
                </p>
              </div>
            </div>

            {/* Kept: a user who expects the styled document back would only find
                out after opening the PDF. */}
            <p className="mt-2.5 border-t border-[var(--border-hairline)] pt-2.5 type-footnote text-[var(--text-secondary)]">
              Text and page breaks are kept; fonts, styling, and images are not.
            </p>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-blue-200 bg-blue-50 p-3 dark:border-blue-400 dark:bg-blue-500/10">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-blue-900 dark:text-blue-100">
                  <span>{status.message || 'Converting…'}</span>
                  <span className="tabular-nums">{status.progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Word to PDF progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={status.progress}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950"
                >
                  <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
              </div>
            )}

            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                <p className="font-bold">{refusal ? 'Nothing to convert' : 'Conversion failed'}</p>
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
                <Button tone="secondary" block onClick={cancel}>Cancel</Button>
              ) : (
                !refusal && (
                  <Button
                    tone="primary"
                    block
                    className="sm:w-auto"
                    icon={<FileText aria-hidden size={18} />}
                    onClick={() => void convert()}
                  >
                    {status.error ? 'Try again' : 'Export PDF'}
                  </Button>
                )
              )}
              <Button
                tone={refusal ? 'primary' : 'secondary'}
                block
                className="sm:w-auto"
                disabled={status.isProcessing}
                onClick={chooseAnother}
              >
                Choose another
              </Button>
            </div>
          </section>
        )}
      </div>

      {!file && status.error && (
        <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-300">
          {status.error}
        </div>
      )}
    </ToolShell>
  );
};
