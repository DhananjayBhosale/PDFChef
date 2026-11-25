import React from 'react';
import { ErrorText } from '../UI/ErrorText';
import { formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import type { ProcessingStatus } from '../../types';
import { FileUpload } from '../UI/FileUpload';
import { formatBytes } from '../UI/format';
import { ToolScreen } from './ToolScreen';
import { ChangeFile } from './ToolTop';
import { FileCard, Notice, ProgressLine } from './parts';
import { FilePreview } from './FilePreview';

/**
 * The three Office converters (plan 2.17): a Word file cannot be drawn, so the canvas is its
 * file card; PowerPoint shows its first slide and PDF to Word the PDF's first page. Every label
 * is passed in already translated, so each tool keeps its own catalog keys.
 */
export const ConverterScreen: React.FC<{
  title: string;
  accept: string;
  uploadLabel: string;
  onSelect: (files: File[]) => void;
  file: File | null;
  /** Show the first page of the file (a PDF). Otherwise its file card. */
  drawable?: boolean;
  /** Draws the first page of a file that is not a PDF (PowerPoint's first slide); its file card if that fails. */
  renderPreview?: (file: File) => Promise<string>;
  icon: React.ReactNode;
  status: ProcessingStatus;
  /** The statement or the sentence with its slot. */
  sentence: React.ReactNode;
  /** Today's caution line, shown while nothing else needs the notice line. */
  caution?: string;
  /** One-tap choices under the sentence (a two-way choice drawn at rest). */
  chips?: React.ReactNode;
  /** The error's heading ("That did not work", or the refusal's own). */
  errorTitle: string;
  /** The error is a refusal: Try again would only fail again, so "Choose another" leads. */
  refused: boolean;
  actionLabel: string;
  tryAgainLabel: string;
  cancelLabel: string;
  chooseAnotherLabel: string;
  actionIcon: React.ReactNode;
  onConvert: () => void;
  onCancel: () => void;
  onChooseAnother: () => void;
  /** Plain slots-free extra (a modal). */
  extra?: React.ReactNode;
  /** The "Warn before a heavy job" question for this kind of file (asked before converting). */
  heavyTitle: string;
}> = ({
  title, accept, uploadLabel, onSelect, file, drawable, renderPreview, icon, status, sentence, caution, chips, errorTitle, refused,
  actionLabel, tryAgainLabel, cancelLabel, chooseAnotherLabel, actionIcon, onConvert, onCancel, onChooseAnother, extra, heavyTitle,
}) => {
  useI18n();

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={onSelect} accept={accept} label={uploadLabel} error={status.error} />
          </div>
        )}
      />
    );
  }

  // A file that cannot be drawn (a Word file, a slide that failed to draw) is its compact card:
  // a page-sized white box with one icon read as a preview that failed (pass 5, item 7).
  const fileCard = (
    <div className="tk-cardstage">
      <FileCard icon={icon} name={file.name} meta={formatBytes(file.size)} />
    </div>
  );

  const notice = status.error
    ? (
      <Notice tone="error" role="alert">
        <span className="tk-notice-title">{errorTitle}</span>
        <ErrorText text={status.error} />
      </Notice>
    )
    : !status.isProcessing && status.message
      ? <Notice role="status">{status.message}</Notice>
      : caution ? <Notice tone="caution">{caution}</Notice> : null;

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size, title: heavyTitle }}
      change={refused ? undefined : <ChangeFile label={chooseAnotherLabel} onClick={onChooseAnother} disabled={status.isProcessing} />}
      kind="file"
      bodyLabel={title}
      body={drawable
        ? <FilePreview file={file} name={file.name} meta={formatBytes(file.size)} icon={icon} />
        : renderPreview
          ? <FilePreview file={file} name={file.name} meta={formatBytes(file.size)} icon={icon} render={renderPreview} fallback={fileCard} />
          : fileCard}
      sentence={sentence}
      chips={chips}
      notice={notice}
      action={refused ? (
        <button type="button" onClick={onChooseAnother} className="tk-primary chef-pressable">
          <span>{chooseAnotherLabel}</span>
        </button>
      ) : (
        <button type="button" onClick={onConvert} disabled={status.isProcessing} className="tk-primary chef-pressable">
          {actionIcon}
          <span>{status.error ? tryAgainLabel : actionLabel}</span>
        </button>
      )}
      progress={status.isProcessing ? (
        <ProgressLine
          label={status.message}
          percent={formatPercent(Math.max(0, Math.min(100, status.progress)))}
          value={status.progress}
          cancel={<button type="button" onClick={onCancel} className="tk-btn chef-pressable">{cancelLabel}</button>}
        />
      ) : undefined}
      extra={extra}
    />
  );
};
