import { localizeError } from '../../services/i18n/errors.ts';
import { useWide } from '../../hooks/useMediaQuery';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { Download, FileSliders } from 'lucide-react';
import { ConverterScreen } from '../Tool/ConverterScreen';
import { ToggleValue } from '../Tool/ToggleValue';
import { Sentence } from '../Tool/Sentence';
import type { PptxPageRotation } from '../../services/officeDocument';
import { downloadBytes } from '../../services/pdfShared';
import type { ProcessingStatus } from '../../types';
import { useRemembered } from '../Tool/useRemembered';

const idleStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** The first slide, for the preview (research r2, H3-03); the converter loads on demand. */
const renderFirstSlide = async (file: File) => (await import('../../services/officeDocument')).renderPptxFirstSlide(file);

export const PowerPointToPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [rotation, setRotation] = useRemembered<PptxPageRotation>('orientation', 'keep', (value) => value === 'keep' || value === 'rotate_clockwise');
  const [status, setStatus] = useState<ProcessingStatus>(idleStatus);
  const activeRun = useRef(0);
  const orientationRef = useRef<HTMLFieldSetElement>(null);
  const wide = useWide();

  useEffect(() => () => {
    activeRun.current += 1;
  }, []);

  const select = (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.pptx')) {
      setStatus({ ...idleStatus(), error: t("power-point-to-pdf.choose.a.pptx.powerpoint.file.older.ppt.e54210") });
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
    setStatus({ isProcessing: true, progress: 5, message: t("power-point-to-pdf.opening.presentation.0efdbf") });

    try {
      const { convertPptxToPdf } = await import('../../services/officeDocument');
      const bytes = await convertPptxToPdf(file, rotation, (current, total) => {
        if (activeRun.current !== runId) throw new DOMException(t("power-point-to-pdf.operation.cancelled.386cf3"), 'AbortError');
        const progress = Math.round(5 + (current / Math.max(1, total)) * 90);
        setStatus({
          isProcessing: true,
          progress,
          message: t("power-point-to-pdf.rendering.slide.of.f9574b", { v0: current, v1: total }),
        });
      });
      if (activeRun.current !== runId) return;

      downloadBytes(bytes, `${file.name.replace(/\.pptx$/i, '')}.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: t("power-point-to-pdf.pdf.ready.cf5972") });
    } catch (error) {
      if (activeRun.current !== runId || isAbortError(error)) return;
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error && error.message ? localizeError(error) : t("power-point-to-pdf.powerpoint.to.pdf.conversion.failed.8ad688"),
      });
    }
  };

  const cancel = () => {
    activeRun.current += 1;
    setStatus({ isProcessing: false, progress: 0, message: t("power-point-to-pdf.conversion.cancelled.nothing.was.saved.44e2e7") });
  };

  const chooseAnother = () => {
    activeRun.current += 1;
    setFile(null);
    setStatus(idleStatus());
  };

  const unsupported = Boolean(status.error && /choose a \.pptx|does not contain any slides|unable to read this powerpoint/i.test(status.error));

  const title = t("power-point-to-pdf.powerpoint.to.pdf.7f2bc0");
  const orientationLabel = t("power-point-to-pdf.page.orientation.6a6e01");
  const options = [
    { value: 'keep' as const, label: t("power-point-to-pdf.keep.183f00"), detail: t("power-point-to-pdf.a.16.9.slide.stays.a.16.57bd28") },
    { value: 'rotate_clockwise' as const, label: t("power-point-to-pdf.rotate.c3613b"), detail: t("power-point-to-pdf.turn.pages.without.stretching.or.cropping.9361e1") },
  ];

  const orientationChoice = (
    <fieldset ref={orientationRef} className="tk-fieldrow tk-choice-row" disabled={status.isProcessing}>
      <legend className="sr-only">{orientationLabel}</legend>
      {options.map((option) => (
        <React.Fragment key={option.value}>
          <label className="tk-check">
            <input
              type="radio"
              name="rotation"
              value={option.value}
              checked={rotation === option.value}
              onChange={() => setRotation(option.value)}
              aria-describedby={`pptx-rotation-${option.value}`}
            />
            <span>{option.label}</span>
          </label>
          <span id={`pptx-rotation-${option.value}`} className="sr-only">{option.detail}</span>
        </React.Fragment>
      ))}
    </fieldset>
  );

  return (
    <ConverterScreen
      title={title}
      heavyTitle={t("power-point-to-pdf.this.is.a.large.presentation.and.may.797adf")}
      accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
      uploadLabel={t("power-point-to-pdf.choose.a.pptx.presentation.b0468b")}
      onSelect={select}
      file={file}
      renderPreview={renderFirstSlide}
      icon={<FileSliders aria-hidden size={18} />}
      status={status}
      sentence={(
        <Sentence
          template="sentence.pptx"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
          slots={{
            // Desktop: the two radios are on the screen under the sentence (one tap, owner decision
            // 1); the slot reads the choice and moves focus to it. Phone: the words are the two
            // radios, and a tap switches them (polish 2026-11-15, item 3), so it needs no card.
            orientation: {
              label: orientationLabel,
              text: rotation === 'keep' ? t('sentence.pptx.keep') : t('sentence.pptx.rotate'),
              ...(wide
                ? { focusTarget: () => orientationRef.current?.querySelector<HTMLElement>('input:checked') ?? null }
                : {
                  inline: (
                    <ToggleValue
                      label={orientationLabel}
                      value={rotation}
                      onChange={setRotation}
                      disabled={status.isProcessing}
                      options={[
                        { ...options[0], text: t('sentence.pptx.keep') },
                        { ...options[1], text: t('sentence.pptx.rotate') },
                      ]}
                    />
                  ),
                }),
            },
          }}
        />
      )}
      chips={wide ? orientationChoice : undefined}
      caution={t("power-point-to-pdf.slides.become.page.images.so.text.is.432ba2")}
      errorTitle={unsupported ? t("power-point-to-pdf.presentation.not.supported.b3641f") : t("power-point-to-pdf.conversion.failed.7e3dcd")}
      refused={unsupported}
      actionLabel={t("power-point-to-pdf.save.pdf.2462a8")}
      tryAgainLabel={t("power-point-to-pdf.try.again.d8b839")}
      cancelLabel={t("power-point-to-pdf.cancel.19766e")}
      chooseAnotherLabel={t('tool.chooseAnotherFile')}
      actionIcon={<Download aria-hidden size={18} />}
      onConvert={() => void convert()}
      onCancel={cancel}
      onChooseAnother={chooseAnother}
    />
  );
};
