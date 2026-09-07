import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, FileText, Loader2, Wrench } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { FileUpload } from '../UI/FileUpload';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { PDFFile, ProcessingStatus } from '../../types';
import { repairPDF } from '../../services/pdfDocument';
import { loadPDFDocument, renderPageAsImage } from '../../services/pdfBrowser';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { androidExportFileName } from '../../services/androidParity';
import { formatBytes } from '../UI/format';

interface RepairPreview {
  objectUrl: string;
  pageCount: number;
}

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const RepairPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(emptyStatus);
  const previewUrlRef = useRef<string | null>(null);
  const selectionVersionRef = useRef(0);

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null);
  }, []);

  useEffect(() => () => {
    if (previewUrlRef.current?.startsWith('blob:')) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const selected = files[0];
    if (!isPdfFile(selected)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Choose a PDF file.' });
      return;
    }

    const selectionVersion = selectionVersionRef.current + 1;
    selectionVersionRef.current = selectionVersion;
    clearPreview();
    setPreviewError(null);
    setPreviewLoading(true);
    setStatus(emptyStatus());
    setFile({
      id: uuidv4(),
      file: selected,
      name: selected.name,
      size: selected.size,
    });

    let pdfDocument: any = null;
    try {
      pdfDocument = await loadPDFDocument(selected);
      if (pdfDocument.numPages < 1) throw new Error('The PDF has no pages.');
      const rendered = await renderPageAsImage(pdfDocument, 0, {
        format: 'image/jpeg',
        quality: 0.88,
        scale: 1.2,
      });
      if (selectionVersion !== selectionVersionRef.current) {
        URL.revokeObjectURL(rendered.objectUrl);
        return;
      }
      previewUrlRef.current = rendered.objectUrl;
      setPreview({ objectUrl: rendered.objectUrl, pageCount: pdfDocument.numPages });
    } catch (error) {
      console.error(error);
      if (selectionVersion === selectionVersionRef.current) {
        setPreviewError('First-page preview is unavailable, but you can still re-save this PDF.');
      }
    } finally {
      try {
        if (pdfDocument?.destroy) await pdfDocument.destroy();
      } finally {
        if (selectionVersion === selectionVersionRef.current) setPreviewLoading(false);
      }
    }
  };

  const chooseAnotherFile = () => {
    selectionVersionRef.current += 1;
    clearPreview();
    setPreviewLoading(false);
    setPreviewError(null);
    setFile(null);
    setStatus(emptyStatus());
  };

  const handleRepair = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Re-saving the PDF on your device…' });
    try {
      const bytes = await repairPDF(file.file);
      downloadBlob(
        new Blob([bytes], { type: 'application/pdf' }),
        androidExportFileName('repair', file.name, 'pdf'),
        'application/pdf',
      );
      setStatus({
        isProcessing: false,
        progress: 100,
        message: 'Re-saved copy created.',
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'This PDF could not be repaired. If it has a password, remove it with Unlock PDF first; otherwise the file is too damaged to fix here.',
      });
    }
  };

  return (
    <ToolShell centered={!file}>
      {/* The scope limit is stated once, beside the export button, where it
          changes whether to press it. */}
      <ToolHeader title="Repair PDF" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div key="upload" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to re-save" />
          </motion.div>
        ) : (
          <motion.div key="repair" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <section
              aria-label="Selected PDF"
              className="flex items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3"
            >
              <div className="min-w-0">
                <p className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</p>
                <p className="type-caption text-[var(--text-tertiary)]">{formatBytes(file.size)}</p>
              </div>
              <Button tone="quiet" onClick={chooseAnotherFile} disabled={status.isProcessing} className="shrink-0">
                Change
              </Button>
            </section>

            <section className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4">
              <div className="mx-auto flex max-w-sm flex-col items-center">
                <div className="relative flex aspect-[210/297] w-[46%] min-w-32 items-center justify-center overflow-hidden rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]">
                  {previewLoading && <Loader2 aria-label="Loading first-page preview" className="h-6 w-6 animate-spin text-[var(--accent-text)]" />}
                  {!previewLoading && preview && (
                    <img
                      src={preview.objectUrl}
                      alt={`First page of ${file.name}`}
                      className="h-full w-full object-contain"
                    />
                  )}
                  {!previewLoading && !preview && (
                    <FileText aria-hidden className="h-10 w-10 text-[var(--text-tertiary)]" />
                  )}
                </div>
                <p className="type-footnote mt-1.5 font-medium text-[var(--text-secondary)]">
                  {preview ? `Page 1 of ${preview.pageCount}` : previewLoading ? 'Loading preview…' : 'Preview unavailable'}
                </p>
                {previewError && <p className="mt-1 text-center text-sm text-[var(--text-secondary)]">{previewError}</p>}
              </div>

              {/* Kept: without it "Repair" promises recovery this tool cannot
                  do. Matches the Android footer summary. */}
              <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-field)] bg-[var(--status-caution-quiet)] px-3 py-2 text-[var(--status-caution-text)]">
                <Wrench aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="type-footnote">
                  Re-saving fixes minor compatibility issues; it cannot recover missing content or badly damaged files.
                </p>
              </div>

              {status.isProcessing && (
                <div role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin text-[var(--accent-text)]" />
                  {status.message}
                </div>
              )}

              {!status.isProcessing && status.error && (
                <div role="alert" className="mt-3 flex items-start gap-2 rounded-[var(--radius-field)] bg-[var(--status-danger-quiet)] px-3 py-2 text-[var(--status-danger-text)]">
                  <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm font-medium leading-5">{status.error}</p>
                </div>
              )}

              {!status.isProcessing && !status.error && status.progress === 100 && (
                <div role="status" aria-live="polite" className="mt-3 flex items-start gap-2 rounded-[var(--radius-field)] bg-[var(--status-success-quiet)] px-3 py-2 text-[var(--status-success-text)]">
                  <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm font-medium leading-5">{status.message}</p>
                </div>
              )}

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  tone="primary"
                  icon={<Wrench aria-hidden size={18} />}
                  busy={status.isProcessing}
                  onClick={handleRepair}
                  className="w-full sm:w-auto"
                >
                  Save repaired PDF
                </Button>
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </ToolShell>
  );
};
