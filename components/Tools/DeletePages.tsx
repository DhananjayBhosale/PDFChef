import React, { useState, useEffect, useMemo } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPdfPagePreviews } from '../../services/pdfBrowser';
import { deletePagesFromPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { Trash2, Loader2, Undo2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { androidExportFileName } from '../../services/androidParity';
import { parseBoundedPageRange } from '../../services/pageRange';

export const DeletePages: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pagesToDelete, setPagesToDelete] = useState<number[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rangeInput, setRangeInput] = useState('');
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const totalPages = previews.length || file?.pageCount || 0;
  const pagesToDeleteSet = useMemo(() => new Set(pagesToDelete), [pagesToDelete]);

  useEffect(() => {
    let cancelled = false;

    if (file) {
      setLoadingPreviews(true);
      setPreviewError(null);
      getPdfPagePreviews(file.file)
        .then(urls => {
          if (cancelled) {
            revokeObjectUrls(urls);
            return;
          }
          setPreviews(urls);
          setLoadingPreviews(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError(error instanceof Error ? error.message : 'The pages could not be shown. Choose another file, or run Repair PDF on it first.');
          setLoadingPreviews(false);
        });
    } else {
      setPreviews([]);
      setPagesToDelete([]);
      setRangeInput('');
      setSelectionMessage(null);
      setPreviewError(null);
    }

    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(previews);
    };
  }, [previews]);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (!isPdfFile(f)) return;
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size });
  };

  const togglePage = (idx: number) => {
    setSelectionMessage(null);
    setPagesToDelete((previous) => {
      if (previous.includes(idx)) return previous.filter((pageIndex) => pageIndex !== idx);
      if (totalPages > 0 && previous.length >= totalPages - 1) {
        setSelectionMessage('At least one page must remain in the PDF.');
        return previous;
      }
      return [...previous, idx].sort((left, right) => left - right);
    });
  };

  const markRange = () => {
    try {
      const requested = parseBoundedPageRange(rangeInput, totalPages);
      const next = new Set([...pagesToDelete, ...requested]);
      if (next.size >= totalPages) {
        setSelectionMessage('That range would delete every page. At least one page must remain.');
        return;
      }
      setPagesToDelete([...next].sort((left, right) => left - right));
      setSelectionMessage(`${requested.length} page${requested.length === 1 ? '' : 's'} marked from the range.`);
    } catch (error) {
      setSelectionMessage(error instanceof Error ? error.message : 'Enter a valid page range.');
    }
  };

  const handleDelete = async () => {
    if (!file || pagesToDelete.length === 0) return;
    if (pagesToDelete.length >= totalPages) {
      setSelectionMessage('At least one page must remain in the PDF.');
      return;
    }
    setStatus({ isProcessing: true, progress: 10, message: 'Removing pages...' });
    try {
      const pdfBytes = await deletePagesFromPDF(file.file, pagesToDelete);
      
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        androidExportFileName('delete_pages', file.name, 'pdf'),
      );
      setStatus({ isProcessing: false, progress: 100, message: 'Trimmed PDF ready.' });
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? error.message : 'The pages could not be removed. Try again, or run Repair PDF on this file first.',
      });
    }
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title="Delete Pages" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to delete pages" />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  disabled={status.isProcessing}
                  className="chef-pressable chef-target -ml-1 flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
                  aria-label="Choose another PDF"
                >
                  <Undo2 aria-hidden size={18} />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              {!loadingPreviews && !previewError && totalPages > 0 && (
                <div className="flex items-end gap-2">
                  <label className="min-w-0 flex-1 type-footnote font-semibold text-[var(--text-secondary)]">
                    Mark a page range
                    <input
                      value={rangeInput}
                      onChange={(event) => setRangeInput(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') markRange(); }}
                      placeholder="2,4-6"
                      inputMode="text"
                      maxLength={512}
                      className="chef-field mt-1 h-10 w-full px-3 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={markRange}
                    className="chef-pressable chef-hit-y h-10 shrink-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"
                  >
                    Mark
                  </button>
                </div>
              )}

              <ToolSelectionBar
                summary={
                  selectionMessage ??
                  (totalPages > 0 && pagesToDelete.length >= totalPages
                    ? 'At least one page must remain.'
                    : `${totalPages - pagesToDelete.length} remaining · ${pagesToDelete.length} marked`)
                }
                actions={[
                  {
                    key: 'restore',
                    label: 'Restore all',
                    hidden: pagesToDelete.length === 0,
                    onClick: () => { setPagesToDelete([]); setSelectionMessage('All pages restored.'); },
                  },
                ]}
              />
            </ToolPanel>

            <Button
              tone="primary"
              block
              busy={status.isProcessing}
              disabled={loadingPreviews || pagesToDelete.length === 0 || pagesToDelete.length >= totalPages}
              icon={<Trash2 aria-hidden size={18} />}
              onClick={() => void handleDelete()}
            >
              Save without those pages
            </Button>

            {loadingPreviews ? (
              <div className="flex flex-col items-center justify-center gap-2 py-6 text-[var(--text-tertiary)]">
                <Loader2 aria-hidden className="animate-spin" size={24} />
                <p className="text-sm">Loading pages...</p>
              </div>
            ) : previewError ? (
              <div className="flex flex-col items-center gap-2 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] px-4 py-4 text-center">
                <p className="font-semibold text-[var(--status-danger-text)]">The pages could not be shown. Choose another file, or run Repair PDF on it first.</p>
                <p className="max-w-measure text-sm text-[var(--text-secondary)]">{previewError}</p>
                <Button tone="secondary" onClick={() => setFile(null)}>Choose another PDF</Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                {previews.map((url, index) => (
                  <button
                    type="button"
                    key={index}
                    onClick={() => togglePage(index)}
                    aria-pressed={pagesToDeleteSet.has(index)}
                    aria-label={`${pagesToDeleteSet.has(index) ? 'Restore' : 'Mark'} page ${index + 1}`}
                    className={`relative rounded-xl text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-canvas)] ${pagesToDeleteSet.has(index) ? 'opacity-60 grayscale scale-[0.98]' : 'hover:-translate-y-1'}`}
                  >
                     <div className={`rounded-lg overflow-hidden border-2 ${pagesToDeleteSet.has(index) ? 'border-rose-500' : 'border-[var(--border-strong)]'}`}>
                        <img src={url} alt={`Page ${index + 1} preview`} loading="lazy" decoding="async" className="w-full h-auto" />
                        {pagesToDeleteSet.has(index) && (
                          <div className="absolute inset-0 flex items-center justify-center bg-rose-500/20">
                            <div className="bg-rose-500 text-white p-2 rounded-full"><Trash2 size={24}/></div>
                          </div>
                        )}
                     </div>
                     <div className="tabular mt-1 text-center text-xs text-[var(--text-tertiary)]">Page {index + 1}</div>
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <StatusToast status={status} />
    </ToolShell>
  );
};
