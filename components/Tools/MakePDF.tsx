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
  RefreshCw,
  ScanLine,
  Trash2,
} from 'lucide-react';
import { ProcessingStatus } from '../../types';
import { createPDFFromImages } from '../../services/pdfDocument';
import { downloadBlob } from '../../services/pdfShared';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { Button, ConfirmSheet, StatusLine } from '../UI/Primitives';
import {
  useHaptics,
  useWorkspacePlatform,
  type RecentRecord,
} from '../../hooks/useWorkspaceRuntime';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import type { StoredDocument } from '../../services/domain/workspaceModels';
import { formatBytes } from '../UI/format';

interface CapturedImage {
  id: string;
  file: File;
  previewUrl: string;
}

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
  SCANNER_BUSY: 'A scan is already running. Let it finish, then start the next one.',
  SCANNER_STORAGE_FULL: 'There is not enough free space on this device to keep that scan.',
  SCANNER_LIMIT_EXCEEDED: 'That scan is too large to keep. Scan fewer pages and try again.',
  SCANNER_INTERRUPTED: 'The scan stopped before it finished, so nothing was kept.',
  SCANNER_UNAVAILABLE:
    'The device scanner could not start. It may still be getting ready the first time you use it.',
  SCANNER_LAUNCH_FAILED:
    'The device scanner could not start. It may still be getting ready the first time you use it.',
};
const SCAN_FAILED = 'That scan could not be kept, so nothing was changed.';
const SCAN_OPEN_FAILED = 'That scan could not be opened. It is still kept on this device.';

/** Capacitor reports a fixed code beside the message; the message itself is never shown. */
const scanFailureFor = (caught: unknown): string => {
  const code = (caught as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && SCAN_FAILURES[code]) || SCAN_FAILED;
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
  const [images, setImages] = useState<CapturedImage[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
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
      setScanned({ document: result.document, pageCount: result.pageCount });
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
      setScanNotice(SCAN_OPEN_FAILED);
      haptic('error');
    } finally {
      setOpeningScan(false);
      operationRef.current = false;
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
      const resolvedType = file.type === 'image/jpeg' || file.type === 'image/jpg' || extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : file.type === 'image/png' || extension === 'png'
          ? 'image/png'
          : null;
      if (!resolvedType) return [];
      return [file.type === resolvedType
        ? file
        : new File([file], file.name, { type: resolvedType, lastModified: file.lastModified })];
    });

    const checked = await Promise.all(supported.map(async (file) => {
      const previewUrl = URL.createObjectURL(file);
      const readable = await new Promise<boolean>((resolve) => {
        const preview = new Image();
        preview.onload = () => resolve(preview.naturalWidth > 0 && preview.naturalHeight > 0);
        preview.onerror = () => resolve(false);
        preview.src = previewUrl;
      });
      if (!readable) URL.revokeObjectURL(previewUrl);
      return readable ? { file, previewUrl } : null;
    }));

    const valid = checked.filter((item): item is { file: File; previewUrl: string } => item !== null);
    const skippedCount = picked.length - valid.length;
    setSelectionNotice(skippedCount > 0
      ? `${skippedCount} ${skippedCount === 1 ? 'photo was' : 'photos were'} skipped: only readable JPEG and PNG images are supported.`
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
    setStatus({ isProcessing: true, progress: 10, message: `Building ${images.length}-page PDF on this device…` });
    try {
      const bytes = await createPDFFromImages(images.map((item) => item.file));
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `scanned-${Date.now()}.pdf`);
      setStatus({ isProcessing: false, progress: 100, message: `Scanned PDF ready with ${images.length} page${images.length === 1 ? '' : 's'}.` });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Failed to build PDF' });
    } finally {
      operationRef.current = false;
    }
  };

  return (
    <ToolShell width="wide" centered={images.length === 0}>
      <ToolHeader title="Create PDF" />

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png"
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
        accept="image/jpeg,image/png"
        multiple
        className="hidden"
        onChange={(event) => {
          void appendFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {scanner && (
        <section
          aria-label="Device scanner"
          className="mb-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3"
        >
          {scanned ? (
            <div className="chef-enter space-y-3">
              <div className="flex items-start gap-2">
                <CheckCircle2 aria-hidden size={20} className="mt-0.5 shrink-0 text-[var(--status-success-text)]" />
                <div className="min-w-0">
                  <p role="status" className="text-[1.0625rem] font-semibold text-[var(--text-primary)]">
                    {scanned.pageCount} page{scanned.pageCount === 1 ? '' : 's'} scanned
                  </p>
                  <p className="type-footnote chef-filename text-[var(--text-secondary)]">
                    {scanned.document.name ?? 'Scan'} · {formatBytes(scanned.document.sizeBytes)} · kept on this device
                  </p>
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
                >
                  Open scanned PDF
                </Button>
                <Button
                  tone="secondary"
                  busy={scanning}
                  disabled={openingScan || status.isProcessing}
                  icon={<RefreshCw aria-hidden size={16} />}
                  onClick={() => void runScan()}
                  className="min-h-12 flex-1 basis-[9rem]"
                >
                  Scan again
                </Button>
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
            >
              Scan document
            </Button>
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
              >
                Use the basic camera
              </Button>
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
            <span>{scanner ? 'Basic camera' : 'Camera'}</span>
          </button>
          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            disabled={status.isProcessing || scanning}
            className="chef-target flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)] disabled:opacity-55"
          >
            <FileImage aria-hidden size={18} />
            <span>Gallery</span>
          </button>
          {images.length > 0 && (
          <div className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)] sm:ml-auto">
            <span>{images.length} page{images.length === 1 ? '' : 's'} • {formatBytes(totalSize)}</span>
            {images.length > 0 && (
              <button type="button" onClick={() => setConfirmClear(true)} disabled={status.isProcessing} className="chef-target rounded-[var(--radius-control)] px-2 font-semibold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)] disabled:opacity-55">
                Clear all
              </button>
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
        <div className="mb-3">
          <button
            type="button"
            onClick={() => void handleBuildPdf()}
            disabled={status.isProcessing}
            className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-sm font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55 sm:w-auto sm:min-w-64"
          >
            {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <ScanLine aria-hidden size={18} />}
            <span>{status.isProcessing ? status.message : `Export ${images.length}-page PDF`}</span>
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
                <img src={image.previewUrl} alt={`Scan ${index + 1}`} className="h-14 w-11 shrink-0 rounded-[var(--radius-control)] border border-[var(--border-hairline)] object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{image.file.name}</div>
                  <div className="type-caption text-[var(--text-tertiary)]">Page {index + 1} • {formatBytes(image.file.size)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => moveImage(index, index - 1)}
                  disabled={index === 0}
                  aria-label={`Move page ${index + 1} up`}
                  className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-35"
                >
                  <ArrowUp aria-hidden size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => moveImage(index, index + 1)}
                  disabled={index === images.length - 1}
                  aria-label={`Move page ${index + 1} down`}
                  className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-35"
                >
                  <ArrowDown aria-hidden size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  disabled={status.isProcessing}
                  className="chef-target inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)] disabled:opacity-55"
                  aria-label={`Remove page ${index + 1}`}
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
        title="Remove every page?"
        description="Photos on your device and any PDF you already exported are not affected."
        confirmLabel="Remove all"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          clearImages();
          setConfirmClear(false);
        }}
      />

      <StatusToast status={status} />
    </ToolShell>
  );
};
