import english from '../../services/i18n/en-US.ts';
import { useWide } from '../../hooks/useMediaQuery';
import { LocalizedError, localizeError } from '../../services/i18n/errors.ts';
import { getLocale, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useNavigationType } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
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
import { createPDFFromImages } from '../../services/pdfLazy';
import { preparePdfImageAsset } from '../../services/imageBrowser';
import { imageProblemOf, skippedImagesMessage, type SkippedImage } from '../../services/imageIntake';
import { createJpegPhotoPdf } from '../../services/jpegPhotoPdf';
import { mapWithConcurrency } from '../../services/mapWithConcurrency';
import { downloadBlob, type OutputReadyRecord } from '../../services/pdfShared';
import { OUTPUT_RENAMED_EVENT, announceOutput, announceOutputRenamed, announceRecordsChanged } from '../../services/workspace';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { Sentence } from '../Tool/Sentence';
import { EnterCloses } from '../Tool/Popover';
import { useFileDrop } from '../../hooks/useFileDrop';
import { Notice, ProgressLine, useToolAnnounce } from '../Tool/parts';
import { PageGrid } from '../Tool/PageGrid';
import { PeekButton, usePinchToOpen } from '../Tool/PagePeek';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { Button, ConfirmSheet, Sheet, StatusLine } from '../UI/Primitives';
import {
  useHaptics,
  useWorkspacePlatform,
  type RecentRecord,
} from '../../hooks/useWorkspaceRuntime';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useMonetization } from '../../hooks/useMonetization';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { historyIndex } from '../Layout/navigationHistory';
import { keepsMakePdfDraftOnLeave, makePdfDraft, releaseMakePdfDraft } from './makePdfDraft';
import type { StoredDocument } from '../../services/domain/workspaceModels';
import { datedFileStem, filenameStemLimit, formatBytes, photoStem, renameKeepingExtension, sanitizeFilenameStem, splitFilename } from '../UI/format';

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
const PDF_EXTENSION = '.pdf';
/** A row's thumbnail is 44 x 56 points; 400 x 400 pixels covers it at any phone's density. */
const THUMBNAIL_PIXELS = 160_000;

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
  const navigationType = useNavigationType();
  // Back returns to the pages left here; any other way in starts empty.
  const [entry] = useState(() => {
    if (navigationType !== 'POP') releaseMakePdfDraft();
    return { index: historyIndex(), path: window.location.pathname };
  });
  const [images, setImages] = useState<CapturedImage[]>(() => makePdfDraft.pages);
  const [exportedImages, setExportedImages] = useState<CapturedImage[] | null>(() => makePdfDraft.exported);
  const discardSheet = useConfirmDiscard(images.length > 0 && images !== exportedImages);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  // Decoding camera photos takes seconds on a phone; say so instead of looking stuck. A count,
  // because the scanner notice's camera button can add photos while a batch is still decoding.
  const [photosBeingAdded, setPhotosBeingAdded] = useState(0);
  const addingPhotos = photosBeingAdded > 0;
  const [confirmClear, setConfirmClear] = useState(false);
  const freshPdfName = () => datedFileStem(t("make-pdf.scanned.pdf.370cd5"), new Date(), getLocale());
  // Null until the person types, so the suggested name follows the first photo (owner decision,
  // path to 9), or today's date and language when there is no usable photo name.
  const [typedPdfName, setTypedPdfName] = useState<string | null>(() => makePdfDraft.typedName);
  const photosPdfName = () => photoStem(images[0]?.file.name) || freshPdfName();
  const pdfName = typedPdfName ?? photosPdfName();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Phone (owner decision 2026-11-15, item 1): a setting appears once, as a value in the sentence
  // whose card holds its control. Desktop keeps the control on the screen beside the sentence.
  const wide = useWide();
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());

  const navigate = useNavigate();
  const haptic = useHaptics();
  const platform = useWorkspacePlatform();
  const { setOpenedPdfFile } = useOpenedPdf();
  const { completeJob } = useMonetization();

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
      let scan = result.document;
      // On iOS a scan is one of the week's free results. Past them it becomes a preview like
      // any other result: its kept copy is dropped so only Pro can save or share it.
      const grant = await completeJob(`scan-${scan.ref}`).catch(() => 'preview-only' as const);
      if (grant === 'preview-only') {
        // The kept copy goes even when the preview cannot be read, or Recent would list it as saved.
        const preview = await platform.reopen(recordFor(scan))
          .finally(() => platform.documentStorage?.delete(scan.ref).catch(() => undefined));
        const locked: OutputReadyRecord = {
          id: `scan-${scan.ref}`,
          filename: `${freshPdfName()}.pdf`,
          mimeType: 'application/pdf',
          size: preview.size,
          toolPath: '/make-pdf',
          createdAt: Date.now(),
          blob: preview,
          historyRetained: false,
          accessLocked: true,
        };
        announceOutput(locked);
        haptic('commit');
        return;
      }
      // The device scanner calls every scan "Scanned document.pdf"; give it the
      // same dated name a photo PDF gets. If that fails the scan keeps its name.
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

  useEffect(() => {
    makePdfDraft.pages = images;
    makePdfDraft.typedName = typedPdfName;
    makePdfDraft.exported = exportedImages;
  }, [images, typedPdfName, exportedImages]);

  useEffect(() => () => {
    const nextIndex = historyIndex();
    // StrictMode's rehearsal unmount never leaves this entry, so it keeps everything.
    if (nextIndex === entry.index && window.location.pathname === entry.path) return;
    if (keepsMakePdfDraftOnLeave(entry.index, nextIndex)) return;
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
    releaseMakePdfDraft();
  }, []);

  const appendFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    // Every picture left out is named in one notice, whatever the reason.
    const skipped: SkippedImage[] = [];
    const supported = picked.flatMap((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase();
      const resolvedType = file.type.startsWith('image/') ? file.type : GALLERY_IMAGE_MIME[extension ?? ''];
      if (!resolvedType || resolvedType === 'image/svg+xml') {
        skipped.push({ name: file.name, problem: 'unreadable' });
        return [];
      }
      return [file.type === resolvedType
        ? file
        : new File([file], file.name, { type: resolvedType, lastModified: file.lastModified })];
    });

    const counted = supported.length > 0;
    if (counted) setPhotosBeingAdded(count => count + 1);
    const checked = await mapWithConcurrency(supported, IMAGE_PREPARE_CONCURRENCY, async (file) => {
      try {
        // Use the same orientation-normalized pixels for the export, and a small copy of them for
        // the row's thumbnail, so a long list never holds every full photo decoded on screen.
        const asset = await preparePdfImageAsset(file, { previewMaxPixels: THUMBNAIL_PIXELS });
        return { file: asset.file, previewUrl: asset.previewUrl };
      } catch (error) {
        skipped.push({ name: file.name, problem: imageProblemOf(error) });
        return null;
      }
    }).finally(() => { if (counted) setPhotosBeingAdded(count => count - 1); });

    const valid = checked.filter((item): item is { file: File; previewUrl: string } => item !== null);
    setSelectionNotice(skipped.length > 0 ? skippedImagesMessage(skipped) : null);
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

  const announce = useToolAnnounce();
  const removeImage = (id: string) => {
    const index = images.findIndex((item) => item.id === id);
    if (index >= 0) announce(t('tool.removed', { v0: t('page-thumbnail.page.c140ba', { v0: index + 1 }) }));
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
      const files = images.map((item) => item.file);
      // Photos are JPEGs, written into the PDF as they are; pdf-lib's copies are only for PNGs.
      const pdf = await createJpegPhotoPdf(files)
        ?? new Blob([await createPDFFromImages(files)], { type: 'application/pdf' });
      const fallback = `${photosPdfName()}.pdf`;
      downloadBlob(pdf, renameKeepingExtension(pdfName, '.pdf', fallback));
      setExportedImages(images);
      setStatus({ isProcessing: false, progress: 100, message: t("make-pdf.scanned.pdf.ready.with.page.02e105", { count: images.length }) });
    } catch (error) {
      console.error(error);
      // A known reason (such as a PDF too big to save) is said plainly instead of the generic line.
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof LocalizedError ? localizeError(error) : t("make-pdf.the.pdf.could.not.be.made.try.cd3740"),
      });
    } finally {
      operationRef.current = false;
    }
  };

  const title = t("make-pdf.create.pdf.e45411");
  const busy = status.isProcessing;
  const hasPages = images.length > 0;
  // An empty name saves under today's default name, as before (M-14).
  const nameMissing = pdfName.trim().length === 0;
  const shownName = nameMissing ? `${photosPdfName()}.pdf` : `${pdfName}.pdf`;
  const startBusy = busy || scanning;

  // Camera and Gallery are not disabled while adding: the one just used still has focus.
  const cameraButton = (className: string) => (
    <button
      type="button"
      onClick={() => { if (!addingPhotos) cameraInputRef.current?.click(); }}
      aria-disabled={addingPhotos || undefined}
      disabled={startBusy}
      className={className}
    >
      <Camera aria-hidden size={18} />
      <span>{scanner ? t("make-pdf.basic.camera.237a91") : t("make-pdf.camera.03494b")}</span>
    </button>
  );
  const galleryButton = (className: string) => (
    <button
      type="button"
      onClick={() => { if (!addingPhotos) galleryInputRef.current?.click(); }}
      aria-disabled={addingPhotos || undefined}
      disabled={startBusy}
      className={className}
    >
      {addingPhotos ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <FileImage aria-hidden size={18} />}
      <span>{addingPhotos ? t("make-pdf.adding.photos.137e59") : t("make-pdf.gallery.352cfc")}</span>
    </button>
  );

  // The device scanner (Android app): Scan document, or the kept scan's card, and the basic-camera fallback.
  const scannerSection = scanner ? (
    <section aria-label={t("make-pdf.device.scanner.7d7538")} className="tk-makepdf-scanner">
      {scanned ? (
        <div className="chef-enter tk-makepdf-scan">
          <div className="tk-makepdf-scan-head">
            <CheckCircle2 aria-hidden size={20} className="tk-makepdf-scan-mark" />
            <div className="min-w-0">
              <p role="status" className="tk-makepdf-scan-title">{t("make-pdf.message.93ad0d32b8", { count: scanned.pageCount })}</p>
              <p className="tk-makepdf-scan-meta chef-filename">{t("make-pdf.message.d22425d581", { v0: scannedName, v1: formatBytes(scanned.document.sizeBytes) })}</p>
            </div>
          </div>
          <div className="tk-makepdf-scan-actions">
            <Button
              tone="primary"
              busy={openingScan}
              disabled={scanning || busy}
              icon={<ExternalLink aria-hidden size={16} />}
              onClick={() => void openScan()}
              className="min-h-12 flex-1 basis-[11rem]"
            >{t("make-pdf.open.scanned.pdf.213753")}</Button>
            {platform.rename && (
              <Button
                tone="secondary"
                disabled={scanning || openingScan || busy}
                icon={<Pencil aria-hidden size={16} />}
                onClick={startScanRename}
                className="min-h-12 flex-1 basis-[9rem]"
              >{t("output-center.rename.3064d7")}</Button>
            )}
            <Button
              tone="secondary"
              busy={scanning}
              disabled={openingScan || busy}
              icon={<RefreshCw aria-hidden size={16} />}
              onClick={() => void runScan()}
              className="min-h-12 flex-1 basis-[9rem]"
            >{t("make-pdf.scan.again.3d0458")}</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => void runScan()} disabled={busy || scanning} aria-busy={scanning || undefined} className="tk-primary chef-pressable">
          {scanning ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <ScanLine aria-hidden size={18} />}
          <span>{t("make-pdf.scan.document.49793d")}</span>
        </button>
      )}

      {scanNotice && (
        <div className="tk-makepdf-scan-notice" role="status" aria-live="polite">
          <StatusLine tone="caution" icon={<AlertTriangle aria-hidden size={16} />}>
            {scanNotice}
          </StatusLine>
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={busy || scanning || openingScan}
            className="tk-btn chef-pressable"
          >
            <Camera aria-hidden size={16} />
            <span>{t("make-pdf.use.the.basic.camera.8625f2")}</span>
          </button>
        </div>
      )}
    </section>
  ) : null;

  const skippedNotice = selectionNotice ? (
    <div role="status" aria-live="polite" className="tk-makepdf-skipped">
      <AlertTriangle aria-hidden className="mt-0.5 shrink-0" size={18} />
      <span>{selectionNotice}</span>
    </div>
  ) : null;

  const addingLine = <span role="status" aria-live="polite" className="sr-only">{addingPhotos ? t("make-pdf.adding.photos.137e59") : ''}</span>;

  const inputs = (
    <>
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
    </>
  );

  const sheets = (
    <>
      {inputs}
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
          maxLength={filenameStemLimit('.pdf')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setScanRenameValue(sanitizeFilenameStem(event.target.value));
            setScanRenameError('');
          }}
        />
        {scanRenameError && <div className="mt-2"><StatusLine tone="danger">{scanRenameError}</StatusLine></div>}
      </Sheet>

      {discardSheet}
    </>
  );
  const toast = <StatusToast status={status} />;

  // No pages yet: today's start choices, centred.
  // Pictures dropped on the screen are added like picked ones.
  useFileDrop({ accept: 'image/*', onFiles: appendFiles });

  // A photo opens large, at full size, with its eye or two fingers spread on it, as pages do in
  // the page grids (fable-2 item 2), so a scan can be checked for sharpness before saving.
  const [largePhoto, setLargePhoto] = useState<{ file: File; url: string } | null>(null);
  const openPhoto = (index: number) => {
    const image = images[index];
    if (image) setLargePhoto({ file: image.file, url: URL.createObjectURL(image.file) });
  };
  useEffect(() => () => { if (largePhoto) URL.revokeObjectURL(largePhoto.url); }, [largePhoto]);
  const photoPinchRef = usePinchToOpen((target) => {
    const index = Number(target?.closest('[data-peek-page]')?.getAttribute('data-peek-page'));
    if (Number.isInteger(index) && index >= 0) openPhoto(index);
  });

  if (!hasPages) {
    return (
      <ToolScreen
        title={title}
        kind="grid"
        holdsWork={false}
        body={(
          <div className="tk-empty">
            <div className="tk-makepdf-start">
              {scannerSection}
              <div className="tk-makepdf-starts">
                {cameraButton(scanner ? 'tk-btn tk-btn-outline tk-makepdf-big chef-pressable' : 'tk-primary tk-makepdf-big chef-pressable')}
                {galleryButton('tk-btn tk-btn-outline tk-makepdf-big chef-pressable')}
              </div>
              {addingLine}
              {skippedNotice}
            </div>
          </div>
        )}
        extra={sheets}
        toast={toast}
      />
    );
  }

  const nameLabel = t("output-center.file.name.3efed3");
  // Today's field, on the screen under the sentence (phones) or in the band beside it (desktop),
  // one step as before (owner decision 1, B-008).
  const nameEditor = (
    <EnterCloses>
      <label className="tk-field" htmlFor="make-pdf-name">
        <span>{nameLabel}</span>
        <span className="tk-makepdf-name">
          <input
            ref={nameRef}
            id="make-pdf-name"
            className="chef-field"
            value={pdfName}
            placeholder={photosPdfName()}
            maxLength={filenameStemLimit('.pdf')}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setTypedPdfName(sanitizeFilenameStem(event.target.value))}
          />
          <span aria-hidden className="tk-makepdf-ext">{PDF_EXTENSION}</span>
        </span>
      </label>
    </EnterCloses>
  );

  const sentence = (
    <Sentence
      template="sentence.makePdf.export"
      values={{ count: images.length }}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={busy}
      slots={{
        name: {
          label: nameLabel,
          text: shownName,
          // Desktop: the field is in the band beside the sentence; the slot points at it. Phone:
          // the field is in the slot's card, so the name shows once (owner decision 2026-11-15).
          // The field's own label names it, so the card's title is for assistive technology only.
          ...(wide ? { focusTarget: () => nameRef.current } : { editor: nameEditor, showTitle: false }),
        },
      }}
    />
  );

  const chips = (
    <>
      {wide && <div className="tk-inline-field tk-makepdf-namefield">{nameEditor}</div>}
      {/* Camera and Gallery sit here, so they stay on screen however many pages there are
          (B-011). The one pair once photos are in: the add tile after the last page repeated
          them (polish item 9). With no photos yet, Camera is the filled first action. */}
      {cameraButton('tk-chip chef-pressable')}
      {galleryButton('tk-chip chef-pressable')}
      <button
        type="button"
        onClick={() => setConfirmClear(true)}
        disabled={busy || addingPhotos}
        className="tk-chip tk-chip-danger chef-pressable"
      >
        <Trash2 aria-hidden />
        {t("make-pdf.clear.all.29a390")}
      </button>
    </>
  );

  const notice = selectionNotice
    ? <Notice tone="caution" role="status">{selectionNotice}</Notice>
    : <Notice>{t("make-pdf.message.dc7f250a5f", { v2: formatBytes(totalSize), count: images.length })}</Notice>;

  const runLabel = (
    <>
      <ScanLine aria-hidden size={18} />
      <span>{t("make-pdf.export.page.pdf.2e36cb", { count: images.length })}</span>
    </>
  );

  const progress = busy ? <ProgressLine label={status.message} /> : undefined;

  const body = (
    <>
      <h2 id="make-pdf-pages" className="sr-only">{title}</h2>
      {scannerSection}
      {addingLine}
      <PageGrid count={images.length} minTile={150} labelHeight={96} gestureRef={photoPinchRef}>
        {images.map((image, index) => (
          <div key={image.id} className="tk-mtile" data-work-item={image.id} data-peek-page={index}>
            <div className="tk-mtile-page">
              <img src={image.previewUrl} alt={t("make-pdf.scan.07df33", { v0: index + 1 })} draggable={false} />
              <PeekButton page={index + 1} onOpen={() => openPhoto(index)} />
            </div>
            {/* The photo's own name, as before (B-010): one line, the full name in its title. */}
            <bdi className="tk-mtile-name chef-filename" title={image.file.name}>{image.file.name}</bdi>
            <span className="tk-tile-label tabular" title={t("make-pdf.message.179910f5ad", { v0: index + 1, v1: formatBytes(image.file.size) })}>
              {t("make-pdf.message.179910f5ad", { v0: index + 1, v1: formatBytes(image.file.size) })}
            </span>
            <div className="tk-mtile-actions">
              <button
                type="button"
                onClick={() => moveImage(index, index - 1)}
                disabled={index === 0}
                aria-label={t("make-pdf.move.page.up.79624d", { v0: index + 1 })}
                className="tk-move chef-pressable"
              >
                <ArrowUp aria-hidden size={18} className="tk-mtile-prev" />
              </button>
              <button
                type="button"
                onClick={() => moveImage(index, index + 1)}
                disabled={index === images.length - 1}
                aria-label={t("make-pdf.move.page.down.9e61e2", { v0: index + 1 })}
                className="tk-move chef-pressable"
              >
                <ArrowDown aria-hidden size={18} className="tk-mtile-next" />
              </button>
              <button
                type="button"
                onClick={() => removeImage(image.id)}
                disabled={busy}
                aria-label={t("make-pdf.remove.page.0a72af", { v0: index + 1 })}
                className="tk-move tk-move-danger chef-pressable"
              >
                <Trash2 aria-hidden size={18} />
              </button>
            </div>
          </div>
        ))}
      </PageGrid>
      {largePhoto && (
        <PDFPreviewModal file={largePhoto.file} image={largePhoto.url} pageIndex={0} pageLabel={largePhoto.file.name} onClose={() => setLargePhoto(null)} />
      )}
    </>
  );

  return (
    <ToolScreen
      title={title}
      kind="grid"
      bodyLabelledBy="make-pdf-pages"
      body={body}
      sentence={sentence}
      chips={chips}
      notice={notice}
      onRun={() => void handleBuildPdf()}
      runDisabled={busy || addingPhotos}
      runLabel={runLabel}
      progress={progress}
      extra={sheets}
      toast={toast}
    />
  );
};
