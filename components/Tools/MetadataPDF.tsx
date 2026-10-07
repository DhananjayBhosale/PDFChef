import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, RotateCcw, Save, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { FileUpload } from '../UI/FileUpload';
import { Button } from '../UI/Primitives';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { PDFFile, PDFMetadata, ProcessingStatus } from '../../types';
import { getPDFMetadata, setPDFMetadata } from '../../services/pdfDocument';
import { loadPDFDocument } from '../../services/pdfBrowser';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { androidExportFileName } from '../../services/androidParity';
import { formatBytes } from '../UI/format';

type MetadataTextField = 'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer';

const METADATA_FIELDS: ReadonlyArray<{ key: MetadataTextField; label: string; hint: string }> = [
  { key: 'title', get label() { return t("metadata-pdf.title.7e8cd2"); }, get hint() { return t("metadata-pdf.the.name.of.the.document.which.some.2558ca"); } },
  { key: 'author', get label() { return t("metadata-pdf.author.d95082"); }, get hint() { return t("metadata-pdf.who.wrote.it.47c51a"); } },
  { key: 'subject', get label() { return t("metadata-pdf.subject.689712"); }, get hint() { return t("metadata-pdf.a.short.line.about.what.it.covers.b0bbee"); } },
  { key: 'keywords', get label() { return t("metadata-pdf.keywords.8bfdb9"); }, get hint() { return t("metadata-pdf.words.to.help.you.find.it.later.84e301"); } },
  { key: 'creator', get label() { return t("metadata-pdf.made.with.42c6b8"); }, get hint() { return t("metadata-pdf.the.app.the.document.was.originally.written.9a123d"); } },
  { key: 'producer', get label() { return t("metadata-pdf.saved.as.pdf.by.854dda"); }, get hint() { return t("metadata-pdf.the.app.that.turned.it.into.a.ecace5"); } },
];

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const MetadataPDF: React.FC = () => {
  useI18n();
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
        error: t("metadata-pdf.this.pdf.s.details.could.not.be.ac723c"),
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
        androidExportFileName('metadata', file.name, 'pdf'),
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

  return (
    <ToolShell width="list" centered={!file}>
      <ToolHeader title={t("metadata-pdf.document.info.758cc7")} />

      <AnimatePresence mode="wait">
        {!file ? (
          status.isProcessing ? (
            <motion.div
              key="reading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              role="status"
              aria-live="polite"
              className="flex items-center justify-center gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-4 py-4 text-[var(--text-secondary)]"
            >
              <Loader2 aria-hidden className="h-5 w-5 animate-spin text-[var(--accent-text)]" />
              <span className="font-medium">{t("metadata-pdf.reading.this.pdf.s.details.on.your.3b0103")}</span>
            </motion.div>
          ) : (
            <motion.div key="upload" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("metadata-pdf.choose.a.pdf.to.see.its.details.182ae2")} />
            </motion.div>
          )
        ) : (
          <motion.div
            key="editor"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <section
              aria-label={t("metadata-pdf.selected.pdf.ed0ff3")}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3"
            >
              <div className="min-w-0">
                <p className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</p>
                <p className="type-caption text-[var(--text-tertiary)]">{formatBytes(file.size)}</p>
              </div>
              <Button tone="quiet" onClick={chooseAnotherFile} className="shrink-0">{t("metadata-pdf.change.c0bf75")}</Button>
            </section>

            <section
              aria-label={t("metadata-pdf.document.properties.7115a7")}
              className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Button icon={<RotateCcw aria-hidden size={18} />} onClick={resetToSource} block>{t("metadata-pdf.undo.my.changes.9ed9fe")}</Button>
                <Button
                  tone="destructive"
                  icon={<Trash2 aria-hidden size={18} />}
                  onClick={clearSixProperties}
                  block
                >{t("metadata-pdf.empty.all.six.boxes.2d84a6")}</Button>
              </div>

              {/* Kept: without it, "Clear" reads as full sanitization, which
                  it is not. */}
              <p className="mt-2 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2 type-footnote text-[var(--text-secondary)]">{t("metadata-pdf.this.empties.the.six.boxes.below.other.dba172")}</p>

              <div className="mt-3 space-y-2.5">
                {METADATA_FIELDS.map(({ key, label, hint }) => (
                  <div key={key}>
                    <label htmlFor={`metadata-${key}`} className="block text-sm font-semibold text-[var(--text-primary)]">
                      {label}
                    </label>
                    <p id={`metadata-${key}-hint`} className="type-footnote mb-1.5 text-[var(--text-secondary)]">
                      {hint}
                    </p>
                    <input
                      id={`metadata-${key}`}
                      type="text"
                      value={typeof metadata[key] === 'string' ? metadata[key] : ''}
                      onChange={(event) => updateMetadataField(key, event.target.value)}
                      aria-describedby={`metadata-${key}-hint`}
                      autoComplete="off"
                      className="chef-field"
                    />
                  </div>
                ))}
              </div>

              {/* Kept: an empty field does not mean an empty value. */}
              <p className="type-footnote mt-3 text-[var(--text-secondary)]">{t("metadata-pdf.leaving.a.box.empty.keeps.whatever.the.98e023")}</p>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  tone="primary"
                  icon={<Save aria-hidden size={18} />}
                  busy={status.isProcessing}
                  onClick={handleSave}
                  className="w-full sm:w-auto"
                >{t("metadata-pdf.save.changes.dd0ae7")}</Button>
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
