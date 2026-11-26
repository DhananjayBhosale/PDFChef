import { t, formatPercent } from '../../services/i18n/core.ts';
import { pdfProblemMessage } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { RotateCcw, Save, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { FileUpload } from '../UI/FileUpload';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { Notice, ProgressLine } from '../Tool/parts';
import { FilePreview } from '../Tool/FilePreview';
import { useWide } from '../../hooks/useMediaQuery';
import { PDFFile, PDFMetadata, ProcessingStatus } from '../../types';
import { getPDFMetadata, loadPDFDocument, setPDFMetadata } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { formatBytes, toolOutputName } from '../UI/format';

type MetadataTextField = 'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer';

const METADATA_FIELDS: ReadonlyArray<{ key: MetadataTextField; label: string; hint: string }> = [
  { key: 'title', get label() { return t("metadata-pdf.title.7e8cd2"); }, get hint() { return t("metadata-pdf.the.name.of.the.document.which.some.2558ca"); } },
  { key: 'author', get label() { return t("metadata-pdf.author.d95082"); }, get hint() { return t("metadata-pdf.who.wrote.it.47c51a"); } },
  { key: 'subject', get label() { return t("metadata-pdf.subject.689712"); }, get hint() { return t("metadata-pdf.a.short.line.about.what.it.covers.b0bbee"); } },
  { key: 'keywords', get label() { return t("metadata-pdf.keywords.8bfdb9"); }, get hint() { return t("metadata-pdf.words.to.help.you.find.it.later.84e301"); } },
  { key: 'creator', get label() { return t("metadata-pdf.made.with.42c6b8"); }, get hint() { return t("metadata-pdf.the.app.the.document.was.originally.written.9a123d"); } },
  { key: 'producer', get label() { return t("metadata-pdf.saved.as.pdf.by.854dda"); }, get hint() { return t("metadata-pdf.the.app.that.turned.it.into.a.ecace5"); } },
];

/** A hint's first clause, as the box's placeholder: the whole hint was cut mid-sentence in the box (T-14).
 *  The whole hint stays the box's description. Same translated string, no new one. */
const placeholderOf = (hint: string) => hint.split(/[,;،，、；(（]/)[0].trim() || hint;

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const MetadataPDF: React.FC = () => {
  useI18n();
  const wide = useWide();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [metadata, setMetadata] = useState<PDFMetadata>({});
  const [sourceMetadata, setSourceMetadata] = useState<PDFMetadata>({});
  const [clearAllPending, setClearAllPending] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>(emptyStatus);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const selected = files[0];
    if (!isPdfFile(selected)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("metadata-pdf.choose.a.pdf.file.c2a7df") });
      return;
    }

    setStatus({ isProcessing: true, progress: 10, message: t("metadata-pdf.reading.this.pdf.s.details.on.your.3b0103") });
    try {
      const probe = await loadPDFDocument(selected);
      const pageCount = Number(probe?.numPages) || 0;
      if (probe?.destroy) void probe.destroy();
      if (pageCount < 1) throw new Error(t("metadata-pdf.no.readable.pages.c37281"));

      const loaded = await getPDFMetadata(selected);
      setSourceMetadata(loaded);
      setMetadata(loaded);
      setClearAllPending(false);
      setFile({
        id: uuidv4(),
        file: selected,
        name: selected.name,
        size: selected.size,
      });
      setStatus({ isProcessing: false, progress: 100, message: t("metadata-pdf.details.loaded.e7d90c") });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: pdfProblemMessage(error) ?? t("metadata-pdf.this.pdf.s.details.could.not.be.ac723c"),
      });
    }
  };

  const chooseAnotherFile = () => {
    setFile(null);
    setMetadata({});
    setSourceMetadata({});
    setClearAllPending(false);
    setStatus(emptyStatus());
  };

  const resetToSource = () => {
    setMetadata(sourceMetadata);
    setClearAllPending(false);
    setStatus({
      isProcessing: false,
      progress: 0,
      message: t("metadata-pdf.your.changes.have.been.undone.nothing.is.535615"),
    });
  };

  const clearSixProperties = () => {
    setMetadata({});
    setClearAllPending(true);
    setStatus({
      isProcessing: false,
      progress: 0,
      message: t("metadata-pdf.all.six.boxes.emptied.nothing.is.saved.64927c"),
    });
  };

  const updateMetadataField = (field: MetadataTextField, value: string) => {
    setMetadata((current) => ({ ...current, [field]: value }));
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: t("metadata-pdf.creating.the.updated.pdf.on.this.device.e2cac9") });

    try {
      const pdfBytes = await setPDFMetadata(file.file, metadata, { clearAll: clearAllPending });
      downloadBlob(
        new Blob([pdfBytes], { type: 'application/pdf' }),
        toolOutputName('metadata', file.name, 'pdf'),
        'application/pdf',
      );
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("metadata-pdf.updated.pdf.created.with.the.details.shown.ad2e55"),
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: t("metadata-pdf.the.updated.pdf.could.not.be.made.4f5b0e"),
      });
    }
  };

  const title = t("metadata-pdf.document.info.758cc7");

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="form"
        body={(
          <div className="tk-empty">
            {status.isProcessing ? (
              <ProgressLine label={t("metadata-pdf.reading.this.pdf.s.details.on.your.3b0103")} />
            ) : (
              <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("metadata-pdf.choose.a.pdf.to.see.its.details.182ae2")} error={status.error} />
            )}
          </div>
        )}
      />
    );
  }

  const outcome = status.error
    ? <Notice tone="error" role="alert">{status.error}</Notice>
    : !status.isProcessing && status.message
      ? <Notice role="status">{status.message}</Notice>
      : null;

  const form = (
    <div className="tk-form tk-form-grid" role="group" aria-label={t("metadata-pdf.document.properties.7115a7")}>
      {METADATA_FIELDS.map(({ key, label, hint }) => (
        <div key={key} className="tk-field">
          <label htmlFor={`metadata-${key}`}>{label}</label>
          <input
            id={`metadata-${key}`}
            type="text"
            value={typeof metadata[key] === 'string' ? metadata[key] : ''}
            onChange={(event) => updateMetadataField(key, event.target.value)}
            placeholder={placeholderOf(hint)}
            // The hint is the box's description too (B-021): a box filled from the PDF never shows its placeholder.
            aria-describedby={`metadata-hint-${key}`}
            autoComplete="off"
            disabled={status.isProcessing}
            className="chef-field"
          />
          <span id={`metadata-hint-${key}`} className="sr-only">{hint}</span>
        </div>
      ))}
    </div>
  );

  const chips = (
    <>
      <button type="button" onClick={resetToSource} disabled={status.isProcessing} className="tk-chip chef-pressable">
        <RotateCcw aria-hidden size={15} />{t("metadata-pdf.undo.my.changes.9ed9fe")}
      </button>
      <button type="button" onClick={clearSixProperties} disabled={status.isProcessing} aria-describedby="metadata-empties-note" className="tk-chip tk-chip-danger chef-pressable">
        <Trash2 aria-hidden size={15} />{t("metadata-pdf.empty.all.six.boxes.2d84a6")}
      </button>
    </>
  );
  // Without it, "Empty all six boxes" reads as full sanitization, which it is not. It is the
  // button's description at all times, and is shown once the button is pressed (T-14).
  const emptiesText = t("metadata-pdf.this.empties.the.six.boxes.below.other.dba172");
  const emptiesNote = clearAllPending ? <Notice tone="caution">{emptiesText}</Notice> : null;
  const emptiesDescription = <span id="metadata-empties-note" className="sr-only">{emptiesText}</span>;

  return (
    <ToolScreen
      className="tk-info"
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={chooseAnotherFile} disabled={status.isProcessing} />}
      kind="form"
      bodyLabel={t("metadata-pdf.selected.pdf.ed0ff3")}
      // Phones: the six fields are the body, with the two chips and their note above them, so
      // "the six boxes below" is true in both layouts (verify V-05), as in today's build.
      // Desktop: the first page beside the fields, the chips and the note in the band above.
      body={wide ? <FilePreview file={file.file} name={file.name} meta={formatBytes(file.size)} /> : (
        <div className="tk-form">
          <div className="tk-info-lead">
            <div className="tk-chips">{chips}{emptiesDescription}</div>
            {emptiesNote && <div className="tk-notice">{emptiesNote}</div>}
          </div>
          {form}
        </div>
      )}
      side={wide ? form : undefined}
      // Kept: an empty field does not mean an empty value.
      sentence={(
        <Sentence
          template="metadata-pdf.leaving.a.box.empty.keeps.whatever.the.98e023"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      chips={wide ? <>{chips}{emptiesDescription}</> : undefined}
      notice={wide ? <>{outcome}{emptiesNote}</> : outcome}
      onRun={() => void handleSave()}
      runDisabled={status.isProcessing}
      runLabel={(
        <>
          <Save aria-hidden size={18} />
          <span>{t("metadata-pdf.save.changes.dd0ae7")}</span>
        </>
      )}
      progress={status.isProcessing ? (
        <ProgressLine label={status.message} percent={formatPercent(Math.max(0, Math.min(100, status.progress)))} value={status.progress} />
      ) : undefined}
    />
  );
};
