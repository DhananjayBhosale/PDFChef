import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { FileType2 } from 'lucide-react';
import { ConverterScreen } from '../Tool/ConverterScreen';
import { Sentence } from '../Tool/Sentence';
import { PDFFile, ProcessingStatus } from '../../types';
import { convertPDFToDocx } from '../../services/pdfLazy';
import { DOCX_MIME_TYPE, NO_EXTRACTABLE_TEXT_MESSAGE } from '../../services/docxConstants';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const PDFToWord: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  useReleasePdfDocument(file?.file);
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const handleFilesSelected = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!isPdfFile(selected)) {
      setStatus({ ...idleStatus(), error: t("pdfto-word.choose.a.pdf.file.c2a7df") });
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
    setStatus({ isProcessing: true, progress: 5, message: t("pdfto-word.opening.pdf.070f6c") });

    try {
      const blob = await convertPDFToDocx(file.file, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException(t("pdfto-word.operation.cancelled.386cf3"), 'AbortError');
        const progress = total > 0 ? Math.round((current / total) * 90) + 5 : 5;
        setStatus({ isProcessing: true, progress, message: t("pdfto-word.reading.page.of.71ef9b", { v0: current, v1: total }) });
      });
      if (activeRun.current !== runId) return;

      const baseName = file.name.replace(/\.pdf$/i, '') || 'converted';
      downloadBlob(blob, `${baseName}.docx`, DOCX_MIME_TYPE);
      setStatus({ isProcessing: false, progress: 100, message: t("pdfto-word.word.document.ready.a23679") });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("pdfto-word.pdf.to.word.conversion.failed.90ac9c"),
      });
    }
  };

  const cancelConversion = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: t("pdfto-word.conversion.cancelled.nothing.was.saved.44e2e7") });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const refusal = status.error === NO_EXTRACTABLE_TEXT_MESSAGE;
  const title = t("pdfto-word.pdf.to.word.1a1bff");

  return (
    <ConverterScreen
      title={title}
      heavyTitle={t("pdfto-word.this.is.a.large.pdf.and.may.848eab")}
      accept=".pdf,application/pdf"
      uploadLabel={t("pdfto-word.choose.a.pdf.3ba70f")}
      onSelect={handleFilesSelected}
      file={file?.file ?? null}
      drawable
      icon={<FileType2 aria-hidden size={18} />}
      status={status}
      // The fidelity limits are stated once, at the button: a beta text export.
      sentence={(
        <Sentence
          template="pdfto-word.text.is.exported.fonts.images.tables.and.6094ba"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      errorTitle={refusal ? t("pdfto-word.there.are.no.words.to.convert.689a27") : t("pdfto-word.that.did.not.work.93a203")}
      refused={false}
      actionLabel={t("pdfto-word.save.word.file.document.c3f319")}
      tryAgainLabel={t("pdfto-word.try.again.d8b839")}
      cancelLabel={t("pdfto-word.cancel.19766e")}
      chooseAnotherLabel={t('tool.chooseAnotherFile')}
      actionIcon={<FileType2 aria-hidden size={18} />}
      onConvert={() => void handleConvert()}
      onCancel={cancelConversion}
      onChooseAnother={chooseAnother}
    />
  );
};
