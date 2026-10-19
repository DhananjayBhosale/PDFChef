import english from '../../services/i18n/en-US.ts';
import { getLocale, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Camera,
  CheckCircle2,
  ExternalLink,
  FileImage,
  Loader2,
  Pencil,
  RefreshCw,
  ScanLine,
  Trash2,
} from 'lucide-react';
import { ProcessingStatus } from '../../types';
import { createPDFFromImages } from '../../services/pdfDocument';
import { preparePdfImageAsset } from '../../services/imageBrowser';
import { mapWithConcurrency } from '../../services/mapWithConcurrency';
import { downloadBlob, type OutputReadyRecord } from '../../services/pdfShared';
import { OUTPUT_RENAMED_EVENT, announceOutput, announceOutputRenamed, announceRecordsChanged } from '../../services/workspace';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { Button, ConfirmSheet, Sheet, StatusLine } from '../UI/Primitives';
import {
  useHaptics,
  useWorkspacePlatform,
  type RecentRecord,
} from '../../hooks/useWorkspaceRuntime';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import type { StoredDocument } from '../../services/domain/workspaceModels';
import { datedFileStem, formatBytes, renameKeepingExtension, sanitizeFilenameStem, splitFilename } from '../UI/format';

interface CapturedImage {
  id: string;
  file: File;
  previewUrl: string;
}

const GALLERY_IMAGE_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp',
};

interface ScanOutcome {
  document: StoredDocument;
  pageCount: number;
}

/**
 * What the device scanner could not do, said plainly.
 *
 * Each line answers the one question the person actually has — was anything
 * saved, and what can I do now — and none of them blames the person or leaks a
 * code, a path or an exception. Every one of these states still leaves the
 * basic camera one press away, and none of them launches it uninvited.
 */
const SCAN_FAILURES: Readonly<Record<string, string>> = {
  get SCANNER_BUSY() { return t("make-pdf.a.scan.is.already.running.let.it.3000ed"); },
  get SCANNER_STORAGE_FULL() { return t("make-pdf.there.is.not.enough.free.space.on.285c0c"); },
  get SCANNER_LIMIT_EXCEEDED() { return t("make-pdf.that.scan.is.too.large.to.keep.d7d4ee"); },
  get SCANNER_INTERRUPTED() { return t("make-pdf.the.scan.stopped.before.it.finished.so.957a38"); },
  get SCANNER_UNAVAILABLE() { return t("make-pdf.the.device.scanner.could.not.start.it.e74210"); },
  get SCANNER_LAUNCH_FAILED() { return t("make-pdf.the.device.scanner.could.not.start.it.e74210"); },
};
const SCAN_FAILED = english["make-pdf.that.scan.could.not.be.kept.so.30410c"];
const SCAN_OPEN_FAILED = english["make-pdf.that.scan.could.not.be.opened.it.7a1de2"];
const IMAGE_PREPARE_CONCURRENCY = 2;

/** Capacitor reports a fixed code beside the message; the message itself is never shown. */
const scanFailureFor = (caught: unknown): string => {
  const code = (caught as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && SCAN_FAILURES[code]) || t("make-pdf.that.scan.could.not.be.kept.so.30410c");
};

/**
 * The scan as Recent already understands it, so one reopen path serves the tool
 * handoff, the web reader and the fallback without a second document model.
 */
const recordFor = (document: StoredDocument): RecentRecord => ({
  entry: {
    id: `android:${document.ref}`,
    documentRef: document.ref,
    name: document.name,
    mimeType: document.mimeType,
    toolId: '/make-pdf',
    createdAt: document.retainedAt ?? 0,
    inputSizeBytes: null,
    outputSizeBytes: document.sizeBytes,
    spaceSavedBytes: null,
  },
  document,
  available: true,
});

export const MakePDF: React.FC = () => {
  useI18n();
  const [images, setImages] = useState<CapturedImage[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const freshPdfName = () => datedFileStem(t("make-pdf.scanned.pdf.370cd5"), new Date(), getLocale());
  // Null until the person types, so the suggested name follows today's date and language.
  const [typedPdfName, setTypedPdfName] = useState<string | null>(null);
  const pdfName = typedPdfName ?? freshPdfName();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());

  const navigate = useNavigate();
  const haptic = useHaptics();
  const platform = useWorkspacePlatform();
  const { setOpenedPdfFile } = useOpenedPdf();

  // The port, never a native client. Absent on every other platform, so this
  // whole section is missing rather than disabled: a dead primary action is
  // worse than no primary action.
  const scanner = platform.documentScanner;
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScanOutcome | null>(null);
  const [openingScan, setOpeningScan] = useState(false);
  const [scanRenameOpen, setScanRenameOpen] = useState(false);
  const [scanRenameValue, setScanRenameValue] = useState('');
  const [scanRenameBusy, setScanRenameBusy] = useState(false);
  const [scanRenameError, setScanRenameError] = useState('');

  /**
   * One latch for Scan, Open and Scan again. State alone is a frame too slow:
   * two quick presses both pass a `scanning === false` check before React has
   * re-rendered, and the native scanner answers the second with a busy failure
   * the person did nothing to deserve.
   */
  const operationRef = useRef(false);
  const claimOperation = () => {
    if (operationRef.current) return false;
    operationRef.current = true;
    return true;
  };

  const handOff = async (document: StoredDocument, toolPath: string | null) => {
    const file = await platform.reopen(recordFor(document));
    const opened = setOpenedPdfFile(file);
    if (toolPath === null) {
      navigate('/view');
      return;
    }
    navigate(toolPath, { state: { useOpenedPdf: true, openedPdfId: opened.id } });
  };

  const runScan = async () => {
    if (!scanner || !claimOperation()) return;
    setScanNotice(null);
    setScanning(true);
    haptic('selection');
    try {
      const result = await scanner.scan();
      // Backing out of the scanner is an ordinary choice, not a failure: the
      // page returns exactly as it was, with nothing announced and nothing
      // saved or downloaded.
      if (result.status === 'cancelled') return;
      // The device scanner calls every scan "Scanned document.pdf"; give it the
      // same dated name a photo PDF gets. If that fails the scan keeps its name.
      let scan = result.document;
      if (platform.rename && scan.name === 'Scanned document.pdf') {
        const dated = `${freshPdfName()}.pdf`;
        try {
          await platform.rename(recordFor(scan), dated);
          scan = { ...scan, name: dated };
        } catch {
          // Renaming is a courtesy; the scan itself is already safe.
        }
      }
      setScanned({ document: scan, pageCount: result.pageCount });
      const output: OutputReadyRecord = {
        id: `scan-${scan.ref}`,
        filename: scan.name ?? 'scan.pdf',
        mimeType: scan.mimeType ?? 'application/pdf',
        size: scan.sizeBytes ?? 0,
        toolPath: '/make-pdf',
        createdAt: scan.retainedAt ?? Date.now(),
        blob: null,
        historyRetained: true,
        recentRecord: recordFor(scan),
      };
      announceOutput(output);
      haptic('commit');
    } catch (caught) {
      setScanNotice(scanFailureFor(caught));
      haptic('error');
    } finally {
      setScanning(false);
      operationRef.current = false;
    }
  };

  const openScan = async () => {
    if (!scanned || !claimOperation()) return;
    const { document } = scanned;
    setScanNotice(null);
    setOpeningScan(true);
    try {
      const reader = platform.pdfReader;
      if (reader?.isEligible(document)) {
        // The native reader reads the durable document itself, so the bytes are
        // never pulled across the bridge just to display them. Only a refused
        // launch falls back, and only once.
        const result = await reader.open(document).catch(() => null);
        if (result === null) {
          await handOff(document, null);
          return;
        }
        // Closing the reader is the ordinary end of reading. Nothing to report.
        if (result.action === 'closed') return;
        await handOff(document, result.toolPath);
        return;
      }
      await handOff(document, null);
    } catch {
      setScanNotice(t("make-pdf.that.scan.could.not.be.opened.it.7a1de2"));
      haptic('error');
    } finally {
      setOpeningScan(false);
      operationRef.current = false;
    }
  };

  // A rename from the result sheet must reach the card, or Open and Rename would use the old name.
  useEffect(() => {
    const onRenamed = (event: Event) => {
      const { id, filename } = (event as CustomEvent<{ id: string; filename: string }>).detail;
      setScanned((current) => current && `scan-${current.document.ref}` === id
        ? { ...current, document: { ...current.document, name: filename } }
        : current);
    };
    window.addEventListener(OUTPUT_RENAMED_EVENT, onRenamed);
    return () => window.removeEventListener(OUTPUT_RENAMED_EVENT, onRenamed);
  }, []);

  const scannedName = scanned?.document.name ?? t("make-pdf.scan.ea1c51");

  const startScanRename = () => {
    setScanRenameValue(splitFilename(scannedName).stem);
    setScanRenameError('');
    setScanRenameOpen(true);
  };

  const saveScanName = async () => {
    if (!scanned || !platform.rename) return;
    const { document } = scanned;
    const nextName = renameKeepingExtension(scanRenameValue, '.pdf', document.name ?? `${freshPdfName()}.pdf`);
    setScanRenameBusy(true);
    setScanRenameError('');
    try {
      await platform.rename(recordFor(document), nextName);
      setScanned((current) => current?.document.ref === document.ref
        ? { ...current, document: { ...current.document, name: nextName } }
        : current);
      announceOutputRenamed(`scan-${document.ref}`, nextName);
      announceRecordsChanged();
      setScanRenameOpen(false);
      haptic('commit');
    } catch {
      setScanRenameError(t("output-center.that.file.could.not.be.saved.4d740f"));
      haptic('error');
    } finally {
      setScanRenameBusy(false);
    }
  };

  const totalSize = useMemo(
    () => images.reduce((sum, image) => sum + image.file.size, 0),
    [images],
  );

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  }, []);

  const appendFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    const supported = picked.flatMap((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase();
      const resolvedType = file.type.startsWith('image/') ? file.type : GALLERY_IMAGE_MIME[extension ?? ''];
      if (!resolvedType || resolvedType === 'image/svg+xml') return [];
      return [file.type === resolvedType
        ? file
        : new File([file], file.name, { type: resolvedType, lastModified: file.lastModified })];
    });

    const checked = await mapWithConcurrency(supported, IMAGE_PREPARE_CONCURRENCY, async (file) => {
      try {
        // Use the same orientation-normalized pixels for the preview and export.
        const asset = await preparePdfImageAsset(file);
        return { file: asset.file, previewUrl: asset.previewUrl };
      } catch {
        return null;
      }
    });

    const valid = checked.filter((item): item is { file: File; previewUrl: string } => item !== null);
    const skippedCount = picked.length - valid.length;
    setSelectionNotice(skippedCount > 0
      ? t("image-browser.image.could.not.be.decoded.7984a8")
      : null);
    const next = valid.map(({ file, previewUrl }) => {
      previewUrlsRef.current.add(previewUrl);
      return {
        id: uuidv4(),
        file,
        previewUrl,
      };
    });
    setImages((prev) => [...prev, ...next]);
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target && target.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrlsRef.current.delete(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const clearImages = () => {
    images.forEach((image) => {
      URL.revokeObjectURL(image.previewUrl);
      previewUrlsRef.current.delete(image.previewUrl);
    });
    setImages([]);
    setSelectionNotice(null);
    setTypedPdfName(null);
  };

  const moveImage = (fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= images.length || toIndex >= images.length) return;
    setImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const handleBuildPdf = async () => {
    // The same latch the scanner uses, so building from photos can never run
    // alongside a scan, an open, or a second build.
    if (images.length === 0 || !claimOperation()) return;
    setStatus({ isProcessing: true, progress: 10, message: t("make-pdf.building.page.pdf.on.this.device.85fead", { count: images.length }) });
    try {
      const bytes = await createPDFFromImages(images.map((item) => item.file));
      const fallback = `${freshPdfName()}.pdf`;
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), renameKeepingExtension(pdfName, '.pdf', fallback));
      setStatus({ isProcessing: false, progress: 100, message: t("make-pdf.scanned.pdf.ready.with.page.02e105", { count: images.length }) });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("make-pdf.the.pdf.could.not.be.made.try.cd3740") });
    } finally {
      operationRef.current = false;
    }
  };

  return (
    <ToolShell width="wide" centered={images.length === 0}>
      <ToolHeader title={t("make-pdf.create.pdf.e45411")} />

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          void appendFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          void appendFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {scanner && (
        <section
          aria-label={t("make-pdf.device.scanner.7d7538")}
          className="mb-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3"
        >
          {scanned ? (
            <div className="chef-enter space-y-3">
              <div className="flex items-start gap-2">
                <CheckCircle2 aria-hidden size={20} className="mt-0.5 shrink-0 text-[var(--status-success-text)]" />
                <div className="min-w-0">
                  <p role="status" className="text-[1.0625rem] font-semibold text-[var(--text-primary)]">{t("make-pdf.message.93ad0d32b8", { count: scanned.pageCount })}</p>
                  <p className="type-footnote chef-filename text-[var(--text-secondary)]">{t("make-pdf.message.d22425d581", { v0: scannedName, v1: formatBytes(scanned.document.sizeBytes) })}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  busy={openingScan}
                  disabled={scanning || status.isProcessing}
                  icon={<ExternalLink aria-hidden size={16} />}
                  onClick={() => void openScan()}
                  className="min-h-12 flex-1 basis-[11rem]"
                >{t("make-pdf.open.scanned.pdf.213753")}</Button>
                {platform.rename && (
                  <Button
                    tone="secondary"
                    disabled={scanning || openingScan || status.isProcessing}
                    icon={<Pencil aria-hidden size={16} />}
                    onClick={startScanRename}
                    className="min-h-12 flex-1 basis-[9rem]"
                  >{t("output-center.rename.3064d7")}</Button>
                )}
                <Button
                  tone="secondary"
                  busy={scanning}
                  disabled={openingScan || status.isProcessing}
                  icon={<RefreshCw aria-hidden size={16} />}
                  onClick={() => void runScan()}
                  className="min-h-12 flex-1 basis-[9rem]"
                >{t("make-pdf.scan.again.3d0458")}</Button>
              </div>
            </div>
          ) : (
            <Button
              block
              tone="primary"
              busy={scanning}
              icon={<ScanLine aria-hidden size={18} />}
              onClick={() => void runScan()}
              disabled={status.isProcessing}
              className="min-h-12"
            >{t("make-pdf.scan.document.49793d")}</Button>
          )}

          {scanNotice && (
            <div className="mt-3 space-y-2" role="status" aria-live="polite">
              <StatusLine tone="caution" icon={<AlertTriangle aria-hidden size={16} />}>
                {scanNotice}
              </StatusLine>
              <Button
                tone="secondary"
                icon={<Camera aria-hidden size={16} />}
                onClick={() => cameraInputRef.current?.click()}
                disabled={status.isProcessing || scanning || openingScan}
                className="min-h-12"
              >{t("make-pdf.use.the.basic.camera.8625f2")}</Button>
            </div>
          )}
        </section>
      )}

      <div className="mb-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={status.isProcessing || scanning}
            className={scanner
              // One filled action per screen. With the device scanner present
              // the plain camera is the fallback, so it stops competing for the
              // same glance while keeping the exact behaviour it always had.
              ? 'chef-target flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)] disabled:opacity-55'
              : 'chef-target flex items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55'}
          >
            <Camera aria-hidden size={18} />
            <span>{scanner ? t("make-pdf.basic.camera.237a91") : t("make-pdf.camera.03494b")}</span>
          </button>
          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            disabled={status.isProcessing || scanning}
            className="chef-target flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)] disabled:opacity-55"
          >
            <FileImage aria-hidden size={18} />
            <span>{t("make-pdf.gallery.352cfc")}</span>
          </button>
          {images.length > 0 && (
          <div className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)] sm:ml-auto">
            <span>{t("make-pdf.message.dc7f250a5f", { v2: formatBytes(totalSize), count: images.length })}</span>
            {images.length > 0 && (
              <button type="button" onClick={() => setConfirmClear(true)} disabled={status.isProcessing} className="chef-target rounded-[var(--radius-control)] px-2 font-semibold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)] disabled:opacity-55">{t("make-pdf.clear.all.29a390")}</button>
            )}
          </div>
          )}
        </div>
      </div>

      {/* The action goes in flow, directly under the intake it belongs to, and
          before the queue it acts on. A bar pinned to the bottom of the phone
          screen competes with the tab bar for the same strip and hides the last
          page in the list behind itself; in flow it is anchored to the control
          that produced the pages and cannot cover anything. */}
      {images.length > 0 && (
        <div className="mb-3 space-y-2">
          <div>
            <label htmlFor="make-pdf-name" className="type-footnote block font-semibold text-[var(--text-secondary)]">{t("output-center.file.name.3efed3")}</label>
            <input
              id="make-pdf-name"
              className="chef-field mt-1 sm:max-w-md"
              value={pdfName}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              disabled={status.isProcessing}
              onChange={(event) => setTypedPdfName(sanitizeFilenameStem(event.target.value))}
            />
          </div>
          <button
            type="button"
            onClick={() => void handleBuildPdf()}
            disabled={status.isProcessing}
            className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55 sm:w-auto sm:min-w-64"
          >
            {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <ScanLine aria-hidden size={18} />}
            <span>{status.isProcessing ? status.message : t("make-pdf.export.page.pdf.2e36cb", { count: images.length })}</span>
          </button>
        </div>
      )}

      {selectionNotice && (
        <div role="status" aria-live="polite" className="mb-3 flex items-start gap-2 rounded-[var(--radius-field)] border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber-800 dark:border-amber-500 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 shrink-0" size={18} />
          <span>{selectionNotice}</span>
        </div>
      )}

      <AnimatePresence mode="wait">
        {images.length > 0 && (
          <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
            {/* One queue row, not a stacked card: the phone version used to give
                each page a full-width 176px preview, so three pages filled the
                screen before the reorder controls appeared. */}
            {images.map((image, index) => (
              <div key={image.id} className="flex items-center gap-2 rounded-[var(--radius-row)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-1.5">
                <img src={image.previewUrl} alt={t("make-pdf.scan.07df33", { v0: index + 1 })} className="h-14 w-11 shrink-0 rounded-[var(--radius-control)] border border-[var(--border-hairline)] object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{image.file.name}</div>
                  <div className="type-caption text-[var(--text-tertiary)]">{t("make-pdf.message.179910f5ad", { v0: index + 1, v1: formatBytes(image.file.size) })}</div>
                </div>
                <button
                  type="button"
                  onClick={() => moveImage(index, index - 1)}
                  disabled={index === 0}
                  aria-label={t("make-pdf.move.page.up.79624d", { v0: index + 1 })}
                  className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-35"
                >
                  <ArrowUp aria-hidden size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => moveImage(index, index + 1)}
                  disabled={index === images.length - 1}
                  aria-label={t("make-pdf.move.page.down.9e61e2", { v0: index + 1 })}
                  className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-35"
                >
                  <ArrowDown aria-hidden size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  disabled={status.isProcessing}
                  className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)] disabled:opacity-55"
                  aria-label={t("make-pdf.remove.page.0a72af", { v0: index + 1 })}
                >
                  <Trash2 aria-hidden size={18} />
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmSheet
        open={confirmClear}
        title={t("make-pdf.remove.every.page.6c477e")}
        description={t("make-pdf.photos.on.your.device.and.any.pdf.f3658c")}
        confirmLabel={t("make-pdf.remove.all.ef7b7e")}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          clearImages();
          setConfirmClear(false);
        }}
      />

      <Sheet
        open={scanRenameOpen}
        onClose={() => setScanRenameOpen(false)}
        title={t("output-center.rename.3064d7")}
        dismissible={!scanRenameBusy}
        footer={
          <>
            <Button tone="secondary" disabled={scanRenameBusy} onClick={() => setScanRenameOpen(false)}>{t("output-center.cancel.19766e")}</Button>
            <Button
              tone="primary"
              busy={scanRenameBusy}
              disabled={scanRenameBusy || !scanRenameValue.trim()}
              onClick={() => void saveScanName()}
            >{t("output-center.save.name.b72972")}</Button>
          </>
        }
      >
        <label htmlFor="make-pdf-scan-name" className="type-footnote block font-semibold text-[var(--text-secondary)]">{t("output-center.file.name.3efed3")}</label>
        <input
          id="make-pdf-scan-name"
          className="chef-field mt-1"
          value={scanRenameValue}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setScanRenameValue(sanitizeFilenameStem(event.target.value));
            setScanRenameError('');
          }}
        />
        {scanRenameError && <div className="mt-2"><StatusLine tone="danger">{scanRenameError}</StatusLine></div>}
      </Sheet>

      <StatusToast status={status} />
    </ToolShell>
  );
};
