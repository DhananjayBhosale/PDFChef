import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { flattenPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { Eye, Maximize, FileCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { StatusToast } from '../UI/StatusToast';
import { Button, StatusLine } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';
import { formatBytes } from '../UI/format';

const flattenedOutputName = (filename: string) => {
  const baseName = filename.replace(/\.pdf$/i, '').trim() || 'document';
  return `${baseName} (flattened).pdf`;
};

export const FlattenPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0 || !isPdfFile(files[0])) return;
    setFile({ id: uuidv4(), file: files[0], name: files[0].name, size: files[0].size });
    setShowPreview(false);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const reset = () => {
    setFile(null);
    setShowPreview(false);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const handleFlatten = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("flatten-pdf.locking.the.filled.answers.c0bd41") });
    try {
      const pdfBytes = await flattenPDF(file.file);
      setStatus({ isProcessing: true, progress: 90, message: t("flatten-pdf.getting.your.pdf.ready.3a0d56") });
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        flattenedOutputName(file.name),
        'application/pdf',
      );
      setStatus({ isProcessing: false, progress: 100, message: t("flatten-pdf.flattened.pdf.is.ready.642c71") });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: t("flatten-pdf.this.pdf.s.answers.could.not.be.764895"),
      });
    }
  };

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={t("flatten-pdf.flatten.pdf.86c838")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
             <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("flatten-pdf.choose.a.pdf.to.flatten.ed41a4")} />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto flex max-w-md flex-col gap-3">
            <ToolPanel className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <FileCheck aria-hidden size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                <p className="type-caption text-[var(--text-tertiary)]">{formatBytes(file.size)}</p>
              </div>
            </ToolPanel>

            {/* Kept, and kept here rather than under the title: flattening is
                one-way for the exported copy, and this is the line beside the
                button that does it. */}
            <StatusLine tone="caution">{t("flatten-pdf.filled.form.fields.become.page.content.keep.c504aa")}</StatusLine>

            <div className="flex flex-col gap-2">
              <Button
                tone="primary"
                block
                busy={status.isProcessing}
                icon={<Maximize aria-hidden size={18} />}
                onClick={() => void handleFlatten()}
              >{t("flatten-pdf.lock.the.answers.and.save.264d62")}</Button>
              <Button tone="secondary" block disabled={status.isProcessing} icon={<Eye aria-hidden size={18} />} onClick={() => setShowPreview(true)}>{t("flatten-pdf.preview.pdf.f53f8f")}</Button>
              <Button tone="quiet" block disabled={status.isProcessing} onClick={reset}>{t("flatten-pdf.choose.another.pdf.9434e3")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showPreview && file && (
        <PDFPreviewModal
          file={file.file}
          pageIndex={0}
          pageLabel={file.name}
          onClose={() => setShowPreview(false)}
        />
      )}
      <StatusToast status={status} />
    </ToolShell>
  );
};
