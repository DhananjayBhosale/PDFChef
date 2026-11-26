import { t, formatPercent } from '../../services/i18n/core.ts';
import { pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { flattenPDF } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { Eye, Maximize } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { formatBytes, toolOutputName } from '../UI/format';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { Notice, ProgressLine } from '../Tool/parts';
import { FilePreview } from '../Tool/FilePreview';
import { useWide } from '../../hooks/useMediaQuery';

export const FlattenPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [savedFile, setSavedFile] = useState<PDFFile | null>(null);
  const discardSheet = useConfirmDiscard(file !== null && file !== savedFile);
  const [showPreview, setShowPreview] = useState(false);
  const wide = useWide();
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
        toolOutputName('flatten', file.name, 'pdf'),
        'application/pdf',
      );
      setSavedFile(file);
      setStatus({ isProcessing: false, progress: 100, message: t("flatten-pdf.flattened.pdf.is.ready.642c71") });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: pdfProblemMessage(error) ?? t("flatten-pdf.this.pdf.s.answers.could.not.be.764895"),
      });
    }
  };

  const title = t("flatten-pdf.flatten.pdf.86c838");

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("flatten-pdf.choose.a.pdf.to.flatten.ed41a4")} error={status.error} />
          </div>
        )}
      />
    );
  }

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="file"
      bodyLabel={title}
      body={<FilePreview file={file.file} name={file.name} meta={formatBytes(file.size)} />}
      // Kept, and kept at the button that does it: flattening is one-way for the exported copy.
      sentence={(
        <Sentence
          // Two lines on a phone (review 2, item 10).
          template="flatten-pdf.statement"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      notice={status.error
        ? <Notice tone="error" role="alert">{status.error}</Notice>
        : !status.isProcessing && status.progress === 100 && status.message
          ? <Notice role="status">{status.message}</Notice>
          : null}
      // On a phone the eye sits beside the main action, with its words as its name, so the foot
      // is one row of actions (review 2, item 10). Desktop keeps the words.
      secondary={(
        <button type="button" disabled={status.isProcessing} onClick={() => setShowPreview(true)} title={wide ? undefined : t("flatten-pdf.preview.pdf.f53f8f")} className="tk-btn chef-pressable">
          <Eye aria-hidden size={18} />
          <span className={wide ? undefined : 'sr-only'}>{t("flatten-pdf.preview.pdf.f53f8f")}</span>
        </button>
      )}
      onRun={() => void handleFlatten()}
      runDisabled={status.isProcessing}
      runLabel={(
        <>
          <Maximize aria-hidden size={18} />
          <span>{t("flatten-pdf.lock.the.answers.and.save.264d62")}</span>
        </>
      )}
      progress={status.isProcessing ? (
        <ProgressLine label={status.message} percent={formatPercent(Math.max(0, Math.min(100, status.progress)))} value={status.progress} />
      ) : undefined}
      extra={(
        <>
          {showPreview && (
            <PDFPreviewModal
              file={file.file}
              pageIndex={0}
              pageLabel={file.name}
              onClose={() => setShowPreview(false)}
            />
          )}
          {discardSheet}
        </>
      )}
    />
  );
};
