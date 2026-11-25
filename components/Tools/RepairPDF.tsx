import { t, formatPercent } from '../../services/i18n/core.ts';
import { classifyPdfError, pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { Wrench } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { repairPDF } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { formatBytes, toolOutputName } from '../UI/format';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { Notice, ProgressLine } from '../Tool/parts';
import { FilePreview } from '../Tool/FilePreview';

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const RepairPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(emptyStatus);
  // Today's page count and "preview unavailable, but you can still re-save" line (A-010).
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const selected = files[0];
    if (!isPdfFile(selected)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("repair-pdf.choose.a.pdf.file.c2a7df") });
      return;
    }
    setStatus(emptyStatus());
    setPageCount(null);
    setPreviewFailed(false);
    setFile({
      id: uuidv4(),
      file: selected,
      name: selected.name,
      size: selected.size,
    });
  };

  const chooseAnotherFile = () => {
    setFile(null);
    setStatus(emptyStatus());
    setPageCount(null);
    setPreviewFailed(false);
  };

  const handleRepair = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("repair-pdf.re.saving.the.pdf.on.your.device.e6995d") });
    try {
      const bytes = await repairPDF(file.file);
      downloadBlob(
        new Blob([bytes], { type: 'application/pdf' }),
        toolOutputName('repair', file.name, 'pdf'),
        'application/pdf',
      );
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("repair-pdf.re.saved.copy.created.5997a8"),
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        // The unreadable message suggests Repair PDF, which is this tool, so it keeps its own.
        error: (classifyPdfError(error) !== 'unreadable' && pdfProblemMessage(error))
          || t("repair-pdf.this.pdf.could.not.be.repaired.if.d256c8"),
      });
    }
  };

  const title = t("repair-pdf.repair.pdf.43faa0");

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("repair-pdf.choose.a.pdf.to.re.save.02a5c9")} error={status.error} />
          </div>
        )}
      />
    );
  }

  const notice = status.error
    ? <Notice tone="error" role="alert">{status.error}</Notice>
    : !status.isProcessing && status.progress === 100 && status.message
      ? <Notice role="status">{status.message}</Notice>
      : previewFailed
        ? <Notice tone="caution" role="status">{t("repair-pdf.first.page.preview.is.unavailable.but.you.652fb7")}</Notice>
        : null;
  const meta = <>{pageCount !== null && <>{t('format.pageCount', { count: pageCount })} · </>}{formatBytes(file.size)}</>;

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={chooseAnotherFile} disabled={status.isProcessing} />}
      kind="file"
      bodyLabel={t("repair-pdf.selected.pdf.ed0ff3")}
      body={<FilePreview file={file.file} name={file.name} meta={meta} onPages={setPageCount} onFailed={() => setPreviewFailed(true)} />}
      // The scope limit is stated once, beside the export button, where it changes whether to press it.
      sentence={(
        <Sentence
          template="repair-pdf.re.saving.fixes.minor.compatibility.issues.it.48a32c"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      notice={notice}
      action={(
        <button type="button" onClick={() => void handleRepair()} disabled={status.isProcessing} className="tk-primary chef-pressable">
          <Wrench aria-hidden size={18} />
          <span>{t("repair-pdf.save.repaired.pdf.ac389a")}</span>
        </button>
      )}
      progress={status.isProcessing ? (
        <ProgressLine label={status.message} percent={formatPercent(Math.max(0, Math.min(100, status.progress)))} value={status.progress} />
      ) : undefined}
    />
  );
};
