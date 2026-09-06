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

const METADATA_FIELDS: ReadonlyArray<{ key: MetadataTextField; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'creator', label: 'Creator' },
  { key: 'producer', label: 'Producer' },
];

const emptyStatus = (): ProcessingStatus => ({ isProcessing: false, progress: 0, message: '' });

export const MetadataPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [metadata, setMetadata] = useState<PDFMetadata>({});
  const [sourceMetadata, setSourceMetadata] = useState<PDFMetadata>({});
  const [clearAllPending, setClearAllPending] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>(emptyStatus);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const selected = files[0];
    if (!isPdfFile(selected)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Choose a PDF file.' });
      return;
    }

    setStatus({ isProcessing: true, progress: 10, message: 'Reading metadata on this device…' });
    try {
      const probe = await loadPDFDocument(selected);
      const pageCount = Number(probe?.numPages) || 0;
      if (probe?.destroy) void probe.destroy();
      if (pageCount < 1) throw new Error('No readable pages');

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
      setStatus({ isProcessing: false, progress: 100, message: 'Metadata loaded.' });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'Unable to read metadata from this PDF. Choose another file or try Repair PDF first.',
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
      message: 'Original values restored in this draft.',
    });
  };

  const clearSixProperties = () => {
    setMetadata({});
    setClearAllPending(true);
    setStatus({
      isProcessing: false,
      progress: 0,
      message: 'Six document properties cleared in this draft.',
    });
  };

  const updateMetadataField = (field: MetadataTextField, value: string) => {
    setClearAllPending(false);
    setMetadata((current) => ({ ...current, [field]: value }));
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Creating the updated PDF on this device…' });

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
        message: clearAllPending
          ? 'Updated PDF created with the six editable properties cleared.'
          : 'Updated PDF created.',
      });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'Unable to create the updated PDF. Your original file was not changed.',
      });
    }
  };

  return (
    <ToolShell width="list" centered={!file}>
      <ToolHeader title="Metadata" />

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
              <span className="font-medium">Reading metadata on this device…</span>
            </motion.div>
          ) : (
            <motion.div key="upload" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to inspect" />
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
              aria-label="Selected PDF"
              className="flex items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3"
            >
              <div className="min-w-0">
                <p className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</p>
                <p className="type-caption text-[var(--text-tertiary)]">{formatBytes(file.size)}</p>
              </div>
              <Button tone="quiet" onClick={chooseAnotherFile} className="shrink-0">
                Change
              </Button>
            </section>

            <section
              aria-label="Document properties"
              className="rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Button icon={<RotateCcw aria-hidden size={18} />} onClick={resetToSource} block>
                  Reset to source
                </Button>
                <Button
                  tone="destructive"
                  icon={<Trash2 aria-hidden size={18} />}
                  onClick={clearSixProperties}
                  block
                >
                  Clear six properties
                </Button>
              </div>

              {/* Kept: without it, "Clear" reads as full sanitization, which
                  it is not. */}
              <p className="mt-2 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2 type-footnote text-[var(--text-secondary)]">
                XMP, attachments, annotations, form values, scripts and hidden layers remain.
              </p>

              <div className="mt-3 space-y-2.5">
                {METADATA_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <label htmlFor={`metadata-${key}`} className="mb-1.5 block text-sm font-semibold text-[var(--text-primary)]">
                      {label}
                    </label>
                    <input
                      id={`metadata-${key}`}
                      type="text"
                      value={typeof metadata[key] === 'string' ? metadata[key] : ''}
                      onChange={(event) => updateMetadataField(key, event.target.value)}
                      autoComplete="off"
                      className="chef-field"
                    />
                  </div>
                ))}
              </div>

              {/* Kept: an empty field does not mean an empty value. */}
              <p className="type-footnote mt-3 text-[var(--text-secondary)]">
                Blank fields leave the source value unchanged.
              </p>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  tone="primary"
                  icon={<Save aria-hidden size={18} />}
                  busy={status.isProcessing}
                  onClick={handleSave}
                  className="w-full sm:w-auto"
                >
                  Export updated PDF
                </Button>
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
