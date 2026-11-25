import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { ConverterScreen } from '../Tool/ConverterScreen';
import { Sentence } from '../Tool/Sentence';
import { convertDocxToPdf } from '../../services/pdfLazy';
import { downloadBytes } from '../../services/pdfShared';
import type { ProcessingStatus } from '../../types';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export const WordToPDF: React.FC = () => {
  useI18n();
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
      setStatus({ ...idleStatus(), error: t("word-to-pdf.choose.a.docx.word.file.older.doc.334d2c") });
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
    setStatus({ isProcessing: true, progress: 5, message: t("word-to-pdf.opening.word.document.fe5d6e") });

    try {
      const bytes = await convertDocxToPdf(file, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException(t("word-to-pdf.operation.cancelled.386cf3"), 'AbortError');
        const progress = Math.round(10 + (current / Math.max(1, total)) * 85);
        setStatus({
          isProcessing: true,
          progress,
          message: t("word-to-pdf.laying.out.paragraph.of.fd57af", { v0: current, v1: total }),
        });
      });
      if (activeRun.current !== runId) return;

      downloadBytes(bytes, `${file.name.replace(/\.docx$/i, '')}.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: t("word-to-pdf.pdf.ready.cf5972") });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("word-to-pdf.word.to.pdf.conversion.failed.2f69fc"),
      });
    }
  };

  const cancel = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: t("word-to-pdf.conversion.cancelled.nothing.was.saved.44e2e7") });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const refusal = Boolean(status.error && /no readable text|does not contain a word document|not a readable word file/i.test(status.error));

  const title = t("word-to-pdf.word.to.pdf.8d26d0");

  return (
    <ConverterScreen
      title={title}
      heavyTitle={t("word-to-pdf.this.is.a.large.word.file.and.1543cf")}
      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      uploadLabel={t("word-to-pdf.choose.a.docx.word.file.055d87")}
      onSelect={select}
      file={file}
      icon={<FileText aria-hidden size={18} />}
      status={status}
      // Kept: a user who expects the styled document back would only find out after opening the PDF.
      sentence={(
        <Sentence
          template="word-to-pdf.text.and.page.breaks.are.kept.fonts.75cce8"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      errorTitle={refusal ? t("word-to-pdf.there.is.nothing.to.convert.16ffb2") : t("word-to-pdf.that.did.not.work.93a203")}
      refused={refusal}
      actionLabel={t("word-to-pdf.save.pdf.2462a8")}
      tryAgainLabel={t("word-to-pdf.try.again.d8b839")}
      cancelLabel={t("word-to-pdf.cancel.19766e")}
      chooseAnotherLabel={t('tool.chooseAnotherFile')}
      actionIcon={<FileText aria-hidden size={18} />}
      onConvert={() => void convert()}
      onCancel={cancel}
      onChooseAnother={chooseAnother}
    />
  );
};
