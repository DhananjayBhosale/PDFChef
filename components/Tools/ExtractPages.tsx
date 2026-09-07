import React, { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { PageThumbnail } from '../UI/PageThumbnail';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolSelectionBar, ToolShell } from '../UI/ToolLayout';
import { PDFFile, ProcessingStatus } from '../../types';
import { loadPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { extractPages } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';

const extractedOutputName = (filename: string) => {
  const baseName = filename.replace(/\.pdf$/i, '').trim() || 'document';
  return `${baseName} (extracted).pdf`;
};

export const ExtractPages: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  useEffect(() => {
    let cancelled = false;
    let openedDocument: any | null = null;

    if (file) {
      setLoadingPreviews(true);
      setPreviewError('');
      setPdfDoc(null);
      setTotalPages(0);
      void loadPDFDocument(file.file)
        .then((document) => {
          openedDocument = document;
          if (cancelled) {
            if (document?.destroy) void document.destroy();
            return;
          }
          setPdfDoc(document);
          setTotalPages(document.numPages ?? 0);
          setSelectedPages([]);
          setLoadingPreviews(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          setPreviewError('The pages could not be shown. Choose another file, or run Repair PDF on it first.');
          setLoadingPreviews(false);
        });
    } else {
      setPdfDoc(null);
      setTotalPages(0);
      setSelectedPages([]);
      setPreviewError('');
    }

    return () => {
      cancelled = true;
      if (openedDocument?.destroy) void openedDocument.destroy();
    };
  }, [file]);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0 || !isPdfFile(files[0])) return;
    const selected = files[0];
    setFile({
      id: uuidv4(),
      file: selected,
      name: selected.name,
      size: selected.size,
    });
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const reset = () => {
    setFile(null);
    setSelectedPages([]);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const loadPagePreview = async (pageIndex: number) => {
    if (!pdfDoc) throw new Error('PDF is not ready');
    const rendered = await renderPageAsImage(pdfDoc, pageIndex, {
      format: 'image/jpeg',
      quality: 0.72,
      scale: 0.35,
    });
    return rendered.objectUrl;
  };

  const togglePage = (index: number) => {
    setSelectedPages((prev) => (
      prev.includes(index)
        ? prev.filter((value) => value !== index)
        : [...prev, index].sort((a, b) => a - b)
    ));
  };

  const selectAll = () => {
    setSelectedPages(Array.from({ length: totalPages }, (_, index) => index));
  };

  const clearSelection = () => setSelectedPages([]);

  const handleExtract = async () => {
    if (!file || selectedPages.length === 0) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Extracting selected pages...' });
    try {
      const pdfBytes = await extractPages(file.file, selectedPages);
      setStatus({ isProcessing: true, progress: 90, message: 'Preparing extracted PDF...' });
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        extractedOutputName(file.name),
        'application/pdf',
      );
      setStatus({ isProcessing: false, progress: 100, message: `${selectedPages.length} page${selectedPages.length === 1 ? '' : 's'} extracted.` });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'The selected pages could not be extracted.' });
    }
  };

  return (
    <ToolShell width="full" centered={!file}>
      <ToolHeader title="Extract Pages" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-auto w-full max-w-3xl">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to extract pages" />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <ToolPanel className="flex flex-col gap-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  onClick={reset}
                  disabled={status.isProcessing}
                  aria-label="Choose another PDF"
                  className="chef-pressable chef-target -ml-1 grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                >
                  <ArrowLeft aria-hidden size={18} />
                </button>
                <h2 className="chef-filename min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>

              <ToolSelectionBar
                summary={loadingPreviews ? 'Loading pages…' : `${selectedPages.length} of ${totalPages} selected`}
                actions={[
                  {
                    key: 'select-all',
                    label: 'Select all',
                    disabled: loadingPreviews || status.isProcessing || totalPages === 0 || selectedPages.length === totalPages,
                    onClick: selectAll,
                  },
                  {
                    key: 'clear',
                    label: 'Clear',
                    hidden: selectedPages.length === 0,
                    disabled: status.isProcessing,
                    onClick: clearSelection,
                  },
                ]}
              />
            </ToolPanel>

            <Button
              tone="primary"
              block
              busy={status.isProcessing}
              disabled={loadingPreviews || selectedPages.length === 0}
              icon={<Download aria-hidden size={18} />}
              onClick={() => void handleExtract()}
            >
              Export {selectedPages.length} selected page{selectedPages.length === 1 ? '' : 's'}
            </Button>

            {loadingPreviews ? (
              <div className="flex flex-col items-center justify-center gap-2 py-6 text-[var(--text-tertiary)]">
                <Loader2 aria-hidden className="animate-spin" size={24} />
                <p className="text-sm">Loading pages...</p>
              </div>
            ) : previewError ? (
              <div role="alert" className="px-4 py-4 text-center text-sm font-medium text-[var(--status-danger-text)]">
                {previewError}
              </div>
            ) : totalPages === 0 ? (
              <p className="px-4 py-4 text-center text-sm text-[var(--text-secondary)]">This PDF has no pages in it. Choose another file.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                {Array.from({ length: totalPages }, (_, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-label={`${selectedPages.includes(index) ? 'Deselect' : 'Select'} page ${index + 1}`}
                    aria-pressed={selectedPages.includes(index)}
                    disabled={status.isProcessing}
                    onClick={() => togglePage(index)}
                    className="min-w-0 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-canvas)] disabled:opacity-60"
                  >
                    <PageThumbnail
                      pageIndex={index}
                      loadPreview={() => loadPagePreview(index)}
                      isSelected={selectedPages.includes(index)}
                      onToggle={() => undefined}
                    />
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
