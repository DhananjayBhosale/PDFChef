import { formatBytes, toolOutputName, splitFilename } from '../UI/format';
import { localizeError, pdfProblemMessage } from '../../services/i18n/errors.ts';
import { getPdfRenderScale } from '../../services/pdfPageGeometry';
import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { extractEmbeddedImagesFromPDF, loadJSZip, loadPDFDocument, renderPageAsImage, renderPdfPageToBlob, type EmbeddedPdfImageAsset, type ImageExportConfig } from '../../services/pdfLazy';
import { deliverBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import { parseBoundedPageRange } from '../../services/pageRange';
import { shouldWarnForBytes } from '../../services/workspace';
import { DEFAULT_IMAGE_EXPORT_QUALITY, DEFAULT_IMAGE_EXPORT_SCALE, MAX_IMAGE_EXPORT_SCALE, MIN_IMAGE_EXPORT_QUALITY, MIN_IMAGE_EXPORT_SCALE, imageExportExtension, imageExportPageFileName, imageExportRenderScale, resolveOptionalPageSelection } from '../../services/androidParity';
import { Download, FileImage, ImageIcon, Loader2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { PreviewFrame } from '../Tool/PreviewFrame';
import { ChefSliderField } from '../UI/ChefSlider';
import { usePanZoom } from '../../hooks/usePanZoom';
import { MAX_ZOOM } from '../../hooks/useZoom';
import { StatusToast } from '../UI/StatusToast';
import { ToolScreen } from '../Tool/ToolScreen';
import { EnterCloses, FieldLabel } from '../Tool/Popover';
import { ChangeFile, LogoTile } from '../Tool/ToolTop';
import { Sentence, type SlotDef } from '../Tool/Sentence';
import { Notice, ProgressLine, useAnnouncer } from '../Tool/parts';
import { clip, clipLength, pagesPhrase, percent, times, type PageKeys } from '../Tool/values';
import { useWide } from '../../hooks/useMediaQuery';
import { useReplaceOnDrop } from '../../hooks/useFileDrop';
import { formatPercent } from '../../services/i18n/core.ts';
import { useRemembered, useRememberedFields } from '../Tool/useRemembered';
import { SharpPageLayer } from '../Tool/SharpPageLayer';

/** The page phrases this sentence owns (plan 2.14). */
const IMAGE_PAGE_KEYS: PageKeys = {
  all: 'sentence.pdfToImage.pages.all',
  single: 'sentence.pdfToImage.pages.single',
  range: 'sentence.pdfToImage.pages.range',
  list: 'sentence.pdfToImage.pages.list',
  selected: 'sentence.pdfToImage.pages.selected',
};

type ExportMode = 'pages' | 'embedded-images';

/** Today's choice buttons (Pages / Images, JPEG / PNG / WEBP): buttons that are pressed or not. */
function ChoiceRow<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="tk-chipgroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="tk-chip tk-choice chef-pressable"
        >{option.label}</button>
      ))}
    </div>
  );
}

const PageImagePreview: React.FC<{
  pdfDoc: any;
  scale: number;
  zoom: number;
  transform?: string;
}> = ({ pdfDoc, scale, zoom, transform }) => {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let active = true;
    let renderTask: any = null;
    void (async () => {
      const page = await pdfDoc.getPage(1);
      if (!active) return;
      // Within the page canvas cap, as every other preview (s4-04).
      const viewport = page.getViewport({ scale: getPdfRenderScale(page, scale) });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      renderTask = page.render({ canvasContext: context, viewport });
      await renderTask.promise;
    })().catch((error) => {
      if (active && error?.name !== 'RenderingCancelledException') console.error(error);
    });
    return () => {
      active = false;
      renderTask?.cancel?.();
    };
  }, [pdfDoc, scale]);

  // The page is fitted inside the preview box, never taller than it. A fixed 64dvh cap was taller
  // than the box on a phone, so the box clipped the page and showed only its blank middle.
  return (
    <figure className="absolute inset-0">
      {/* Left to right like every other page preview: PDF.js draws the page's text with the canvas's
          direction, and in Arabic an inherited right to left spaced the words wrongly (polish item 12). */}
      <canvas
        ref={canvasRef}
        dir="ltr"
        role="img"
        aria-label={t("pdfto-image.page.1.preview.b4963a")}
        className="absolute inset-0 m-auto block max-h-full max-w-full select-none rounded-[2px] border border-[var(--border-strong)] bg-white shadow-[var(--elevation-panel)]"
      />
      <SharpPageLayer source={{ pdfDoc }} pageIndex={0} zoom={zoom > 1 ? zoom : undefined} transform={transform} fitted />
    </figure>
  );
};



/** Comma and range syntax, as in the app's `pages=1,3-5` option token. */

export const PDFToImage: React.FC = () => {
  useI18n();
  const wide = useWide();
  const settingsRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  /** A page export can stop between pages (T-05): Cancel sets this, the loop checks it. */
  const exportCancelRef = useRef(false);
  // Leaving the tool discards its file, as its question says: a running export stops with it.
  useEffect(() => () => { exportCancelRef.current = true; }, []);
  const [exportCancellable, setExportCancellable] = useState(false);
  const [exportCancelling, setExportCancelling] = useState(false);
  /** The last export was stopped with Cancel: said once, and shown when no other line is (r4, desktop-05). */
  const [exportCancelled, setExportCancelled] = useState(false);
  const [announcer, announce] = useAnnouncer();

  // `PdfTool.PDF_TO_JPG.defaultOptionValue` is "format=jpg;quality=85;scale=1.2".
  const [config, setConfig] = useRememberedFields<ImageExportConfig>({
    format: 'image/jpeg',
    quality: DEFAULT_IMAGE_EXPORT_QUALITY / 100,
    scale: DEFAULT_IMAGE_EXPORT_SCALE,
  }, {
    format: (value) => value === 'image/jpeg' || value === 'image/png' || value === 'image/webp',
    quality: (value) => value >= MIN_IMAGE_EXPORT_QUALITY / 100 && value <= 1,
    scale: (value) => value >= MIN_IMAGE_EXPORT_SCALE && value <= MAX_IMAGE_EXPORT_SCALE,
  });
  /** The app's `pages=` token; empty means every page. */
  const [pageSelection, setPageSelection] = useState('');
  const [preview, setPreview] = useState<{ objectUrl: string; blob: Blob; width: number; height: number; sizeBytes: number } | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [isScanningImages, setIsScanningImages] = useState(false);
  const [embeddedImages, setEmbeddedImages] = useState<EmbeddedPdfImageAsset[]>([]);
  const [selectedEmbeddedIds, setSelectedEmbeddedIds] = useState<string[]>([]);
  const [exportMode, setExportMode] = useState<ExportMode>('pages');
  const [largeJobConfirmed, setLargeJobConfirmed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const embeddedImagesRef = useRef<EmbeddedPdfImageAsset[]>([]);
  const scanRunIdRef = useRef(0);

  // Two fingers, Ctrl+wheel, − and + (about the top of the page), and a drag that stops at the
  // page's edges: the shared page zoom (pass 5).
  const { zoom, zoomIn, zoomOut, reset: resetZoom, gestureRef, onPointerDown: handlePointerDown, transform, touchAction } = usePanZoom({ max: MAX_ZOOM });

  const replaceEmbeddedImages = useCallback((nextImages: EmbeddedPdfImageAsset[]) => {
    revokeObjectUrls(embeddedImagesRef.current.map((image) => image.objectUrl));
    embeddedImagesRef.current = nextImages;
    setEmbeddedImages(nextImages);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      revokeObjectUrls(embeddedImagesRef.current.map((image) => image.objectUrl));
      if (pdfDoc?.destroy) {
        void pdfDoc.destroy();
      }
    };
  }, [pdfDoc]);

  const scanEmbeddedImages = useCallback(async (doc: any) => {
    const runId = ++scanRunIdRef.current;
    setIsScanningImages(true);

    try {
      const images = await extractEmbeddedImagesFromPDF(doc);
      if (runId !== scanRunIdRef.current) {
        revokeObjectUrls(images.map((image) => image.objectUrl));
        return;
      }

      replaceEmbeddedImages(images);
      setSelectedEmbeddedIds(images.map((image) => image.id));
      if (images.length === 0 && exportMode === 'embedded-images') {
        setExportMode('pages');
      }
    } catch (error) {
      console.error(error);
      if (runId === scanRunIdRef.current) {
        replaceEmbeddedImages([]);
        setSelectedEmbeddedIds([]);
      }
    } finally {
      if (runId === scanRunIdRef.current) {
        setIsScanningImages(false);
      }
    }
  }, [exportMode, replaceEmbeddedImages]);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const selectedFile = files[0];
    if (!isPdfFile(selectedFile)) return;

    try {
      const doc = await loadPDFDocument(selectedFile);
      setExportCancelled(false);
      setFile({
        id: uuidv4(),
        file: selectedFile,
        name: selectedFile.name,
        size: selectedFile.size,
        pageCount: doc.numPages,
      });
      setPdfDoc(doc);
      setExportMode('pages');
      replaceEmbeddedImages([]);
      setSelectedEmbeddedIds([]);
      void scanEmbeddedImages(doc);
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: pdfProblemMessage(error) ?? t("pdfto-image.this.pdf.could.not.be.opened.choose.2b90a7") });
    }
  };

  const updatePreview = useCallback(async () => {
    if (!pdfDoc) return;
    setIsGeneratingPreview(true);
    try {
      const rendered = await renderPageAsImage(pdfDoc, 0, config);
      // The preview stays within the canvas cap, so an oversized page renders smaller than its
      // export. The memory estimate reads the full size, so a heavy job still warns (s4-04).
      const full = (await pdfDoc.getPage(1)).getViewport({ scale: config.scale });
      const grow = (full.width * full.height) / Math.max(1, rendered.width * rendered.height);
      const result = grow > 1
        ? { ...rendered, width: Math.round(full.width), height: Math.round(full.height), sizeBytes: Math.round(rendered.sizeBytes * grow) }
        : rendered;
      let previewResult = result;
      if (Capacitor.isNativePlatform()) {
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onerror = () => reject(new Error(t("pdfto-image.preview.image.could.not.be.opened.70d755")));
          reader.onload = () => typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error(t("pdfto-image.preview.image.could.not.be.opened.70d755")));
          reader.readAsDataURL(result.blob);
        });
        URL.revokeObjectURL(result.objectUrl);
        previewResult = { ...result, objectUrl: dataUrl };
      }
      setPreview((previous) => {
        if (previous?.objectUrl && previous.objectUrl.startsWith('blob:')) {
          URL.revokeObjectURL(previous.objectUrl);
        }
        previewUrlRef.current = previewResult.objectUrl;
        return previewResult;
      });
    } catch (error) {
      console.error(error);
    } finally {
      setIsGeneratingPreview(false);
    }
  }, [config, pdfDoc]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(updatePreview, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [updatePreview]);

  const resolvedPageSelection = useMemo<number[] | null>(() => {
    if (!pdfDoc) return [];
    try {
      return resolveOptionalPageSelection(
        (pageSelection.trim() ? parseBoundedPageRange(pageSelection, pdfDoc.numPages) : []).map((index) => index + 1),
        pdfDoc.numPages,
        t("pdfto-image.pages.to.convert.965608"),
      );
    } catch {
      return null;
    }
  }, [pageSelection, pdfDoc]);

  const exportPageCount = resolvedPageSelection?.length ?? 0;
  const estimatedWorkingMemoryBytes = useMemo(() => {
    if (!file || !preview || exportPageCount === 0) return 0;
    // One decoded page and one render canvas are live together, while encoded images
    // accumulate in the ZIP. This is a warning estimate, not a promised measurement.
    const activePageBytes = preview.width * preview.height * 4 * 2;
    const accumulatedOutputBytes = preview.sizeBytes * exportPageCount * 1.5;
    return Math.round(file.size + activePageBytes + accumulatedOutputBytes);
  }, [exportPageCount, file, preview]);
  // "Warn before a heavy job" (Settings) decides, at its own threshold, applied to the memory this
  // export needs (fix round 2, item 7): a 60-page, 12 kB file is not a heavy job.
  const requiresLargeJobConfirmation = shouldWarnForBytes(estimatedWorkingMemoryBytes);
  const estimatedWorkingMemoryMb = Math.max(1, Math.ceil(estimatedWorkingMemoryBytes / (1024 * 1024)));

  useEffect(() => {
    setLargeJobConfirmed(false);
  }, [config.format, config.quality, config.scale, file?.id, pageSelection]);

  /**
   * Stays busy until the file is written. On Android a zip can take a minute to reach storage;
   * saying "Done!" and freeing Convert before then was not true.
   */
  const saveResult = async (blob: Blob, name: string, mimeType?: string) => {
    // Writing the file is not stopped half way: Cancel ends with the rendering.
    setExportCancellable(false);
    setStatus({ isProcessing: true, progress: 0, message: t("pdfto-image.saving.23e392") });
    try {
      await deliverBlob(blob, name, mimeType);
    } catch (error) {
      // A closed save picker is a choice; the result strip already offers the file again.
      if (error instanceof Error && error.name === 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: '' });
        return;
      }
      throw error;
    }
    setStatus({ isProcessing: false, progress: 100, message: t("pdfto-image.done.b4e19e") });
  };

  /**
   * `PdfToJpgToolProcessor` in the Android app: an empty page selection means every page, a single
   * exported page is delivered as one image rather than a one-entry archive, and multi-page names
   * are zero padded so a listing sorts the way the document reads.
   */
  const handlePageExport = async () => {
    if (!pdfDoc || !file) return;
    if (resolvedPageSelection === null) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdfto-image.check.the.page.range.use.values.such.4fe08b") });
      return;
    }
    if (requiresLargeJobConfirmation && !largeJobConfirmed) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: t("pdfto-image.review.the.large.export.memory.warning.before.540b9d"),
      });
      return;
    }
    setStatus({ isProcessing: true, progress: 0, message: t("pdfto-image.starting.export.8e015a") });
    setExportCancelled(false);
    exportCancelRef.current = false;
    setExportCancelling(false);
    setExportCancellable(true);
    const stopIfCancelled = () => {
      if (exportCancelRef.current) throw new DOMException('cancelled', 'AbortError');
    };

    try {
      const extension = imageExportExtension(config.format);
      const exportIndices = resolvedPageSelection;
      const highestPageIndex = exportIndices[exportIndices.length - 1];

      const renderPage = async (pageIndex: number) => {
        const page = await pdfDoc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        return renderPdfPageToBlob(page, {
          ...config,
          scale: imageExportRenderScale(viewport.width, viewport.height, config.scale),
        });
      };

      if (exportIndices.length === 1) {
        setStatus({ isProcessing: true, progress: 50, message: t("pdfto-image.rendering.page.f14d93", { v0: exportIndices[0] + 1 }) });
        const { blob } = await renderPage(exportIndices[0]);
        stopIfCancelled();
        await saveResult(
          blob,
          `${splitFilename(file.name).stem.trim() || 'document'}.${extension}`,
          config.format,
        );
        return;
      }

      const zip = new (await loadJSZip())();
      for (let index = 0; index < exportIndices.length; index += 1) {
        stopIfCancelled();
        const pageIndex = exportIndices[index];
        setStatus({
          isProcessing: true,
          progress: (index / exportIndices.length) * 100,
          message: t("pdfto-image.rendering.page.662494", { v0: pageIndex + 1, v1: index + 1, v2: exportIndices.length }),
        });
        const { blob } = await renderPage(pageIndex);
        zip.file(imageExportPageFileName(pageIndex, extension, highestPageIndex), blob);
      }
      stopIfCancelled();
      setExportCancellable(false);

      setStatus({ isProcessing: true, progress: 100, message: t("pdfto-image.putting.the.pictures.into.one.zip.file.1a0af7") });
      const content = await zip.generateAsync({ type: 'blob' });
      await saveResult(content, toolOutputName('images', file.name, 'zip'));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && exportCancelRef.current) {
        setStatus({ isProcessing: false, progress: 0, message: '' });
        setExportCancelled(true);
        announce(t("pdfto-word.conversion.cancelled.nothing.was.saved.44e2e7"));
        return;
      }
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? localizeError(error) : t("pdfto-image.saving.did.not.work.f30329"),
      });
    } finally {
      exportCancelRef.current = false;
      setExportCancellable(false);
      setExportCancelling(false);
    }
  };

  const selectedEmbeddedImages = useMemo(
    () => embeddedImages.filter((image) => selectedEmbeddedIds.includes(image.id)),
    [embeddedImages, selectedEmbeddedIds],
  );

  const downloadEmbeddedImages = async (images: EmbeddedPdfImageAsset[]) => {
    if (!file || images.length === 0) return;

    try {
      if (images.length === 1) {
        await saveResult(images[0].blob, toolOutputName('image', file.name, 'png'), 'image/png');
        return;
      }

      setStatus({ isProcessing: true, progress: 10, message: t("pdfto-image.getting.the.pictures.ready.13eef3") });
      const zip = new (await loadJSZip())();
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        setStatus({
          isProcessing: true,
          progress: ((index + 1) / images.length) * 100,
          message: t("pdfto-image.packing.image.33f98f", { v0: index + 1, v1: images.length }),
        });
        zip.file(
          `embedded-image-${String(index + 1).padStart(2, '0')}-pages-${image.pageNumbers.join('-')}.png`,
          image.blob,
        );
      }

      const content = await zip.generateAsync({ type: 'blob' });
      await saveResult(content, toolOutputName('images', file.name, 'zip'));
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("pdfto-image.embedded.image.export.failed.e49cf7") });
    }
  };

  const handleEmbeddedExport = async () => {
    await downloadEmbeddedImages(selectedEmbeddedImages);
  };

  const handleStartOver = () => {
    scanRunIdRef.current += 1;
    setExportCancelled(false);
    setIsScanningImages(false);
    setSelectedEmbeddedIds([]);
    setExportMode('pages');
    if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = null;
    replaceEmbeddedImages([]);
    if (pdfDoc?.destroy) {
      void pdfDoc.destroy();
    }
    setFile(null);
    setPdfDoc(null);
    setPreview(null);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  };

  const hasDetectedEmbeddedImages = embeddedImages.length > 0;
  const hasImageModeOption = isScanningImages || hasDetectedEmbeddedImages;

  const toggleEmbeddedSelection = (imageId: string) => {
    setSelectedEmbeddedIds((previous) =>
      previous.includes(imageId)
        ? previous.filter((id) => id !== imageId)
        : [...previous, imageId],
    );
  };

  const handlePrimaryAction = () => {
    if (exportMode === 'embedded-images') {
      void handleEmbeddedExport();
      return;
    }
    void handlePageExport();
  };

  const pageActionLabel = resolvedPageSelection === null
    ? t("pdfto-image.check.page.range.093d41")
    : t('pdfToImage.convertPages', { count: exportPageCount });
  const primaryActionLabel = exportMode === 'embedded-images'
    ? t("pdfto-image.download.selected.ecbb46", { v0: selectedEmbeddedImages.length > 0 ? ` (${selectedEmbeddedImages.length})` : '' })
    : pageActionLabel;

  const title = t("pdfto-image.pdf.to.image.185e0a");
  const toast = <StatusToast status={status} />;
  // Desktop: this route's header keeps "Back to tools" as the logo link. Phones: the tool's mark
  // and name are that link, as on every tool (owner decision D-1), with the same name.
  const leading = (
    <Link
      to="/"
      aria-label={t("pdfto-image.back.to.tools.e42d59")}
      title={t("pdfto-image.back.to.tools.e42d59")}
      className="tk-brand chef-pressable"
    >
      <LogoTile />
    </Link>
  );

  // Below 768 px the header has no Change control, so the screen takes a dropped file itself.
  useReplaceOnDrop({ onReplace: handleStartOver, busy: status.isProcessing, off: wide || !file });

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("pdfto-image.choose.a.pdf.to.convert.443592")} />
          </div>
        )}
        toast={toast}
      />
    );
  }

  const embeddedMode = exportMode === 'embedded-images';
  const pagesInvalid = !embeddedMode && resolvedPageSelection === null;
  const pagesText = (() => {
    if (embeddedMode) {
      // "all 3 stored pictures" / "the only stored picture" when every one is chosen (pass 5, item 6).
      if (selectedEmbeddedImages.length > 0 && selectedEmbeddedImages.length === embeddedImages.length) {
        return t('sentence.pdfToImage.images.all', { count: embeddedImages.length });
      }
      return selectedEmbeddedImages.length > 0
        ? t('sentence.pdfToImage.images.some', { count: selectedEmbeddedImages.length, total: embeddedImages.length })
        : t('sentence.pdfToImage.images.none');
    }
    if (resolvedPageSelection === null) return clip(pageSelection.trim(), clipLength(wide));
    return pagesPhrase(IMAGE_PAGE_KEYS, resolvedPageSelection, file.pageCount).text;
  })();
  const pagesLabel = embeddedMode ? t("pdfto-image.images.3df294", { v0: '' }) : t("pdfto-image.pages.9046da");
  const formatName = config.format.split('/')[1].toUpperCase();
  const qualityLabel = t("pdfto-image.quality.1b2c08");
  const scaleLabel = t("pdfto-image.resolution.d4055f");
  const formatLabel = t("pdfto-image.format.2f3436");
  const pagesNoticeId = `pdf-to-image-pages-notice-${file.id}`;

  // The editors' controls: in each slot's editor on phones, beside the page on desktop
  // (owner decision 1, A-008), so each change is one step. Same nodes, names and handlers.
  const whatEditor = (
    <div className="tk-fieldcol">
      {hasImageModeOption && (
        <ChoiceRow
          label={t("pdfto-image.mode.5e23ec")}
          value={exportMode}
          options={[
            { value: 'pages' as ExportMode, label: t("pdfto-image.pages.9046da") },
            {
              value: 'embedded-images' as ExportMode,
              label: isScanningImages ? t("pdfto-image.scanning.38d96d") : t("pdfto-image.images.3df294", { v0: hasDetectedEmbeddedImages ? ` (${embeddedImages.length})` : '' }),
            },
          ]}
          onChange={(next) => { if (next === 'pages' || hasDetectedEmbeddedImages) setExportMode(next); }}
        />
      )}
      {!embeddedMode ? (
        <label className="tk-field" htmlFor="pdf-to-image-pages">
          <FieldLabel>{t("pdfto-image.pages.9046da")}</FieldLabel>
          <input
            id="pdf-to-image-pages"
            value={pageSelection}
            onChange={(event) => setPageSelection(event.target.value)}
            placeholder={t("pdfto-image.all.pages.or.1.3.5.7f85f6")}
            aria-invalid={pagesInvalid}
            aria-describedby={pagesInvalid ? pagesNoticeId : undefined}
            className="chef-field"
          />
        </label>
      ) : hasDetectedEmbeddedImages && (
        <>
          <div className="tk-fieldrow">
            <span className="tk-caution">{t("pdfto-image.selection.ca4067")}</span>
            <span dir="ltr" className="tk-caution tabular">{formatNumber(selectedEmbeddedImages.length)} / {formatNumber(embeddedImages.length)}</span>
          </div>
          <div className="tk-fieldrow">
            <button type="button" onClick={() => setSelectedEmbeddedIds(embeddedImages.map((image) => image.id))} className="tk-btn tk-btn-outline chef-pressable">{t("pdfto-image.select.all.1fc9a3")}</button>
            <button type="button" onClick={() => setSelectedEmbeddedIds([])} className="tk-btn tk-btn-outline chef-pressable">{t("pdfto-image.clear.83b12c")}</button>
          </div>
        </>
      )}
    </div>
  );
  const formatEditor = (
    <ChoiceRow
      label={formatLabel}
      value={config.format}
      options={(['image/jpeg', 'image/png', 'image/webp'] as const).map((format) => ({ value: format, label: format.split('/')[1].toUpperCase() }))}
      onChange={(format) => setConfig({ ...config, format })}
    />
  );
  const qualityEditor = (
    <ChefSliderField
      label={qualityLabel}
      suffix="%"
      min={MIN_IMAGE_EXPORT_QUALITY}
      max={100}
      step={1}
      value={Math.round(config.quality * 100)}
      onChange={(next) => setConfig({ ...config, quality: next / 100 })}
      ariaLabel={t("pdfto-image.image.quality.6ad454")}
    />
  );
  const scaleEditor = (
    <ChefSliderField
      label={scaleLabel}
      suffix="×"
      decimals={2}
      fixedDecimals
      min={MIN_IMAGE_EXPORT_SCALE}
      max={MAX_IMAGE_EXPORT_SCALE}
      step={0.05}
      value={config.scale}
      onChange={(next) => setConfig({ ...config, scale: next })}
      ariaLabel={t("pdfto-image.image.resolution.93626a")}
    />
  );
  const settingSlot = (name: string, editor: React.ReactNode) => (wide
    ? { focusTarget: () => settingsRef.current?.querySelector<HTMLElement>(`[data-setting="${name}"] :is(input, [aria-pressed="true"], [role="slider"])`) ?? null }
    : { editor });

  const whatSlot: SlotDef = {
    label: pagesLabel,
    text: pagesText,
    bidi: pagesInvalid || (!embeddedMode && pagesText.includes('–')) ? 'ltr' : undefined,
    tone: pagesInvalid ? 'error' : undefined,
    ...settingSlot('what', <EnterCloses valid={!pagesInvalid}>{whatEditor}</EnterCloses>),
  };

  const formatSlot: SlotDef = {
    label: formatLabel,
    text: formatName,
    ...settingSlot('format', formatEditor),
  };

  const qualitySlot: SlotDef = {
    label: qualityLabel,
    text: percent(Math.round(config.quality * 100)),
    ...settingSlot('quality', qualityEditor),
  };

  const scaleSlot: SlotDef = {
    label: scaleLabel,
    text: times(config.scale),
    ...settingSlot('scale', scaleEditor),
  };

  const settings = wide ? (
    <div ref={settingsRef} className="tk-side-settings">
      <div data-setting="what" className="tk-side-setting">{whatEditor}</div>
      {!embeddedMode && <div data-setting="format" className="tk-side-setting"><span className="tk-side-label">{formatLabel}</span>{formatEditor}</div>}
      {!embeddedMode && config.format !== 'image/png' && <div data-setting="quality" className="tk-side-setting">{qualityEditor}</div>}
      {!embeddedMode && <div data-setting="scale" className="tk-side-setting">{scaleEditor}</div>}
    </div>
  ) : undefined;

  const sentence = embeddedMode ? (
    <Sentence
      // One picture is "a PNG file" (pass 5, item 6).
      template={selectedEmbeddedImages.length === 1 ? 'sentence.pdfToImage.embeddedOne'
        : selectedEmbeddedImages.length > 0 ? 'sentence.pdfToImage.embedded' : 'sentence.pdfToImage.embeddedNone'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{ what: whatSlot }}
    />
  ) : config.format === 'image/png' ? (
    <Sentence
      // One page makes one picture: "as a PNG picture" (pass 5, item 6).
      template={exportPageCount === 1 ? 'sentence.pdfToImage.losslessOne' : 'sentence.pdfToImage.lossless'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{ what: whatSlot, format: formatSlot, scale: scaleSlot }}
    />
  ) : (
    <Sentence
      template={exportPageCount === 1 ? 'sentence.pdfToImage.lossyOne' : 'sentence.pdfToImage.lossy'}
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
      slots={{ what: whatSlot, format: formatSlot, quality: qualitySlot, scale: scaleSlot }}
    />
  );

  const notice = pagesInvalid ? (
    <Notice tone="error" role="alert" id={pagesNoticeId}>{t("pdfto-image.use.page.numbers.or.ranges.such.as.28c6a3")}</Notice>
  ) : !embeddedMode && requiresLargeJobConfirmation ? (
    /* Kept in full: this is the one place the tool can warn that a large export may exhaust the tab's memory. */
    <Notice tone="caution" role="note">
      <strong>{t("pdfto-image.large.browser.export.daeb4c")}</strong>{' '}
      {t("pdfto-image.message.aa8fdb0667", { v0: exportPageCount, v1: estimatedWorkingMemoryMb })}
      <label className="tk-check">
        <input
          type="checkbox"
          checked={largeJobConfirmed}
          onChange={(event) => setLargeJobConfirmed(event.target.checked)}
        />
        <span>{t("pdfto-image.continue.with.this.export.37f365")}</span>
      </label>
    </Notice>
  ) : !embeddedMode && hasDetectedEmbeddedImages ? (
    // Today's "12 images detected" and its "Images (12)" button (A-009): the only sign at rest
    // that the PDF holds pictures that can be saved at full quality. On desktop the button is beside the page.
    <Notice role="status">
      {/* The plural-aware "1 image found" / "12 images found" (polish item 15). */}
      {t("pdf-advanced-tools.message.ba0aedff09", { count: embeddedImages.length })}
      {!wide && (
        <>
          {' '}
          <button type="button" onClick={() => setExportMode('embedded-images')} disabled={status.isProcessing} className="tk-chip tk-notice-action chef-pressable">
            {t("pdfto-image.images.3df294", { v0: ` (${embeddedImages.length})` })}
          </button>
        </>
      )}
    </Notice>
  ) : exportCancelled && !status.isProcessing ? (
    // Spoken by the announcer; drawn here without a live role so it is heard once.
    <Notice>{t("pdfto-word.conversion.cancelled.nothing.was.saved.44e2e7")}</Notice>
  ) : null;

  const runLabel = (
    <>
      <Download aria-hidden size={18} />
      <span>{primaryActionLabel}</span>
    </>
  );
  const progress = status.isProcessing ? (
    <ProgressLine
      label={status.message || t("pdfto-image.starting.export.8e015a")}
      percent={status.progress > 0 ? formatPercent(Math.max(0, Math.min(100, status.progress))) : undefined}
      value={status.progress}
      quietCancel
      cancel={exportCancellable ? (
        <button
          type="button"
          onClick={() => { exportCancelRef.current = true; setExportCancelling(true); }}
          disabled={exportCancelling}
          className="tk-btn chef-pressable"
        >
          {t("output-center.cancel.19766e")}
        </button>
      ) : undefined}
    />
  ) : undefined;

  const body = embeddedMode ? (
    <div className="tk-embedded">
      <h2 className="tk-embedded-title">
        <ImageIcon aria-hidden size={18} />{t("pdfto-image.embedded.images.f88df7")}
        {hasDetectedEmbeddedImages && <span className="tk-embedded-count tabular">{t("pdf-advanced-tools.message.ba0aedff09", { count: embeddedImages.length })}</span>}
      </h2>
      {isScanningImages ? (
        <div className="tk-crop-state">
          <Loader2 className="animate-spin" size={28} aria-hidden />
          <p>{t("pdfto-image.scanning.pdf.for.embedded.images.0f63ee")}</p>
        </div>
      ) : embeddedImages.length === 0 ? (
        <div className="tk-crop-state">
          <ImageIcon size={36} aria-hidden className="opacity-50" />
          <p>{t("pdfto-image.this.pdf.has.no.pictures.stored.inside.5e555c")}</p>
        </div>
      ) : (
        <div className="tk-embgrid">
          {embeddedImages.map((image, index) => {
            const isSelected = selectedEmbeddedIds.includes(image.id);
            return (
              <article key={image.id} className="tk-embcard" data-selected={isSelected ? '' : undefined}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={t("pdfto-image.image.0f73dd", { v0: index + 1, v1: isSelected ? t("pdfto-image.selected.bd44f3") : '' })}
                  onClick={() => toggleEmbeddedSelection(image.id)}
                  className="tk-embcard-pic chef-pressable"
                >
                  <img src={image.objectUrl} alt="" aria-hidden />
                </button>
                <div className="tk-embcard-info">
                  <div className="tk-embcard-head">
                    <div>
                      <div className="tk-embcard-name">{t("pdfto-image.message.fd3495587c", { v0: index + 1 })}</div>
                      <div className="tk-embcard-meta">{t("pdfto-image.message.1fac9292db", { v0: image.pageNumbers.join(', ') })}</div>
                    </div>
                    <span className="tk-embcard-state">{isSelected ? t("pdfto-image.selected.57fd7a") : t("pdfto-image.not.selected.df12ae")}</span>
                  </div>
                  <div className="tk-embcard-meta tabular">
                    <span dir="ltr">{image.width} × {image.height}</span> · {t("pdfto-image.pixels.6ec9c2")} · {formatBytes(image.byteSize)} · {t("pdfto-image.lossless.png.daae34")}
                  </div>
                  <button
                    type="button"
                    aria-label={t("pdfto-image.download.image.fdaf13", { v0: index + 1 })}
                    onClick={() => void downloadEmbeddedImages([image])}
                    disabled={status.isProcessing}
                    className="tk-btn tk-btn-outline chef-pressable"
                  >
                    <Download aria-hidden size={16} />{t("pdfto-image.download.image.2fd3a0")}</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  ) : (
    <PreviewFrame tools={<ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={MAX_ZOOM} />}>
      <h2 className="sr-only">{title}</h2>
      <div
        ref={gestureRef}
        className={`tk-imgstage-view ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{ touchAction }}
        onPointerDown={handlePointerDown}
      >
        {isGeneratingPreview && (
          <div className="tk-imgstage-busy">
            <Loader2 className="animate-spin text-[var(--accent-text)]" size={40} />
          </div>
        )}
        {preview ? (
          // The zoom sits above the stage, so the page fills it (T-13).
          <div
            className="absolute inset-0"
            style={zoom === 1 ? undefined : { transform }}
          >
            <PageImagePreview pdfDoc={pdfDoc} scale={config.scale} zoom={zoom} transform={transform} />
          </div>
        ) : (
          <div className="tk-crop-state">
            <FileImage size={48} className="opacity-50" aria-hidden />
            <p>{t("pdfto-image.generating.preview.17a59a")}</p>
          </div>
        )}
      </div>
    </PreviewFrame>
  );

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: <>{t('format.pageCount', { count: file.pageCount })} · {formatBytes(file.size)}</> }}
      // In the header on phones too, as Watermark (round 6, mobile-03).
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={handleStartOver} />}
      leading={wide ? leading : undefined}
      homeLabel={t("pdfto-image.back.to.tools.e42d59")}
      kind={embeddedMode ? 'grid' : 'preview'}
      bodyLabel={title}
      body={body}
      side={settings}
      sentence={sentence}
      notice={notice}
      onRun={handlePrimaryAction}
      runDisabled={
        status.isProcessing ||
        (exportMode === 'embedded-images'
          ? selectedEmbeddedImages.length === 0
          : !preview || resolvedPageSelection === null || (requiresLargeJobConfirmation && !largeJobConfirmed))
      }
      runLabel={runLabel}
      progress={progress}
      toast={toast}
      extra={announcer}
    />
  );
};
