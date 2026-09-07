import React, { useEffect, useRef, useState } from 'react';
import { Download, FileSliders } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FileUpload } from '../UI/FileUpload';
import { Badge, Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import type { PptxPageRotation } from '../../services/officeDocument';
import { downloadBytes } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';
import { formatBytes } from '../UI/format';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const PowerPointToPDF: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [rotation, setRotation] = useState<PptxPageRotation>('keep');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const select = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.pptx')) {
      setStatus({ ...idleStatus(), error: 'Choose a .pptx PowerPoint file. Older .ppt files are not supported.' });
      return;
    }
    if (
      shouldWarnForFiles([selected]) &&
      !window.confirm('This is a large presentation and may use substantial browser memory. Continue?')
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
    setStatus({ isProcessing: true, progress: 5, message: 'Opening presentation…' });

    try {
      const { convertPptxToPdf } = await import('../../services/officeDocument');
      const bytes = await convertPptxToPdf(file, rotation, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException('Operation cancelled.', 'AbortError');
        const progress = Math.round(5 + (current / Math.max(1, total)) * 90);
        setStatus({
          isProcessing: true,
          progress,
          message: `Rendering slide ${current} of ${total}…`,
        });
      });
      if (activeRun.current !== runId) return;

      downloadBytes(bytes, `${file.name.replace(/\.pptx$/i, '')}.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: 'PDF ready.' });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? error.message : 'PowerPoint to PDF conversion failed.',
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

  const unsupported = Boolean(status.error && /choose a \.pptx|does not contain any slides|unable to read this powerpoint/i.test(status.error));

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={<>PowerPoint to PDF <Badge tone="caution" className="align-middle">Beta</Badge></>} />

      <div>
        {!file ? (
          <FileUpload
            onFilesSelected={select}
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            label="Choose a .pptx presentation"
          />
        ) : (
          <section className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">
                <FileSliders aria-hidden size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">
                  {formatBytes(file.size)} · .pptx
                </p>
              </div>
            </div>

            <fieldset className="mt-3" disabled={status.isProcessing}>
              <legend className="type-footnote font-semibold text-[var(--text-secondary)]">Page orientation</legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {([
                  ['keep', 'Keep', 'A 16:9 slide stays a 16:9 PDF page.'],
                  ['rotate_clockwise', 'Rotate', 'Turn pages without stretching or cropping.'],
                ] as const).map(([value, label, detail]) => (
                  <label
                    key={value}
                    className={`chef-target flex cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm font-bold transition-colors ${
                      rotation === value
                        ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                        : 'border-[var(--border-strong)] text-[var(--text-primary)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="rotation"
                      value={value}
                      checked={rotation === value}
                      onChange={() => setRotation(value)}
                      className="sr-only"
                    />
                    <span>{label}</span>
                    <span className="sr-only">{detail}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <p className="mt-2.5 border-t border-[var(--border-hairline)] pt-2.5 type-footnote text-[var(--text-secondary)]">
              Slides become page images, so text is not selectable.
            </p>

            {status.isProcessing && (
              <div role="status" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-orange-200 bg-orange-50 p-3 dark:border-orange-400 dark:bg-orange-500/10">
                <div className="flex items-center justify-between gap-3 text-sm font-semibold text-orange-900 dark:text-orange-100">
                  <span>{status.message || 'Converting…'}</span>
                  <span className="tabular-nums">{status.progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="PowerPoint to PDF progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={status.progress}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-orange-100 dark:bg-orange-950"
                >
                  <div className="h-full rounded-full bg-orange-500 transition-[width]" style={{ width: `${status.progress}%` }} />
                </div>
              </div>
            )}

            {status.error && (
              <div role="alert" className="mt-3 rounded-[var(--radius-field)] border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-400 dark:bg-rose-500/10 dark:text-rose-200">
                <p className="font-bold">{unsupported ? 'Presentation not supported' : 'Conversion failed'}</p>
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
                !unsupported && (
                  <Button
                    tone="primary"
                    block
                    className="sm:w-auto"
                    icon={<Download aria-hidden size={18} />}
                    onClick={() => void convert()}
                  >
                    {status.error ? 'Try again' : 'Save PDF'}
                  </Button>
                )
              )}
              <Button
                tone={unsupported ? 'primary' : 'secondary'}
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
