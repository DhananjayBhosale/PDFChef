import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import {
  extractEmbeddedImagesFromPDF,
  loadPDFDocument,
  renderPageAsImage,
  renderPdfPageToBlob,
  type EmbeddedPdfImageAsset,
  type ImageExportConfig,
} from '../../services/pdfBrowser';
import { downloadBlob, isPdfFile, revokeObjectUrls } from '../../services/pdfShared';
import {
  DEFAULT_IMAGE_EXPORT_QUALITY,
  DEFAULT_IMAGE_EXPORT_SCALE,
  MAX_IMAGE_EXPORT_SCALE,
  MIN_IMAGE_EXPORT_QUALITY,
  MIN_IMAGE_EXPORT_SCALE,
  androidExportDirectoryName,
  androidExportFileName,
  imageExportExtension,
  imageExportPageFileName,
  imageExportRenderScale,
  resolveOptionalPageSelection,
} from '../../services/androidParity';
import { Download, FileImage, ImageIcon, Loader2, Settings2, Undo2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import JSZip from 'jszip';
import { ZoomControls } from '../UI/ZoomControls';
import { ChefSliderField } from '../UI/ChefSlider';
import { useZoom } from '../../hooks/useZoom';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { tools } from './toolCatalog';
import { ToolIdentity } from './ToolIdentity';
import { useImmersiveWorkspace } from '../Layout/AppShell';

const PDF_TO_IMAGE_TOOL = tools.find((tool) => tool.path === '/pdf-to-jpg');

type ExportMode = 'pages' | 'embedded-images';

const PageImagePreview: React.FC<{
  pdfDoc: any;
  scale: number;
}> = ({ pdfDoc, scale }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let active = true;
    let renderTask: any = null;
    void (async () => {
      const page = await pdfDoc.getPage(1);
      if (!active) return;
      const viewport = page.getViewport({ scale });
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

  return (
    <figure className="flex max-w-full flex-col items-center">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Page 1 preview"
        className="block max-h-[64dvh] max-w-full select-none rounded-[2px] border border-[var(--border-strong)] bg-white object-contain shadow-[var(--elevation-panel)] md:max-h-[78vh]"
      />
    </figure>
  );
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const getBaseName = (filename: string) => filename.replace(/\.pdf$/i, '');

/** Comma and range syntax, as in the app's `pages=1,3-5` option token. */
const parsePageRangeInput = (raw: string, totalPages: number): number[] => {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const selected = new Set<number>();
  for (const token of trimmed.split(',')) {
    const part = token.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [startRaw, endRaw] = part.split('-', 2);
      const start = Number(startRaw.trim());
      const end = Number(endRaw.trim());
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end) {
        throw new Error(`Invalid page range: ${part}`);
      }
      for (let page = start; page <= end; page += 1) selected.add(page);
    } else {
      const page = Number(part);
      if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid page number: ${part}`);
      selected.add(page);
    }
  }

  return [...selected].sort((left, right) => left - right).map((page) => page - 1);
};

export const PDFToImage: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  // `PdfTool.PDF_TO_JPG.defaultOptionValue` is "format=jpg;quality=85;scale=1.2".
  const [config, setConfig] = useState<ImageExportConfig>({
    format: 'image/jpeg',
    quality: DEFAULT_IMAGE_EXPORT_QUALITY / 100,
    scale: DEFAULT_IMAGE_EXPORT_SCALE,
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

  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });

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
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Failed to load PDF' });
    }
  };

  const updatePreview = useCallback(async () => {
    if (!pdfDoc) return;
    setIsGeneratingPreview(true);
    try {
      const result = await renderPageAsImage(pdfDoc, 0, config);
      let previewResult = result;
      if (Capacitor.isNativePlatform()) {
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onerror = () => reject(new Error('Preview image could not be opened.'));
          reader.onload = () => typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Preview image could not be opened.'));
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

  const handlePointerDown = (event: React.PointerEvent) => {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX - pan.x;
    const startY = event.clientY - pan.y;

    const onMove = (moveEvent: PointerEvent) => {
      setPan({ x: moveEvent.clientX - startX, y: moveEvent.clientY - startY });
    };
    const onUp = (upEvent: PointerEvent) => {
      event.currentTarget.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  const resolvedPageSelection = useMemo<number[] | null>(() => {
    if (!pdfDoc) return [];
    try {
      return resolveOptionalPageSelection(
        parsePageRangeInput(pageSelection, pdfDoc.numPages).map((index) => index + 1),
        pdfDoc.numPages,
        'Pages to convert',
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
  const requiresLargeJobConfirmation = exportPageCount > 50
    || estimatedWorkingMemoryBytes >= 256 * 1024 * 1024;
  const estimatedWorkingMemoryMb = Math.max(1, Math.ceil(estimatedWorkingMemoryBytes / (1024 * 1024)));

  useEffect(() => {
    setLargeJobConfirmed(false);
  }, [config.format, config.quality, config.scale, file?.id, pageSelection]);

  /**
   * `PdfToJpgToolProcessor` in the Android app: an empty page selection means every page, a single
   * exported page is delivered as one image rather than a one-entry archive, and multi-page names
   * are zero padded so a listing sorts the way the document reads.
   */
  const handlePageExport = async () => {
    if (!pdfDoc || !file) return;
    if (resolvedPageSelection === null) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Check the page range. Use values such as 1,3-5.' });
      return;
    }
    if (requiresLargeJobConfirmation && !largeJobConfirmed) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'Review the large-export memory warning before continuing.',
      });
      return;
    }
    setStatus({ isProcessing: true, progress: 0, message: 'Starting export...' });

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
        setStatus({ isProcessing: true, progress: 50, message: `Rendering page ${exportIndices[0] + 1}...` });
        const { blob } = await renderPage(exportIndices[0]);
        downloadBlob(
          blob,
          androidExportFileName('pdf_to_jpg', file.name, extension),
          config.format,
        );
        setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
        return;
      }

      const zip = new JSZip();
      for (let index = 0; index < exportIndices.length; index += 1) {
        const pageIndex = exportIndices[index];
        setStatus({
          isProcessing: true,
          progress: (index / exportIndices.length) * 100,
          message: `Rendering page ${pageIndex + 1} (${index + 1}/${exportIndices.length})...`,
        });
        const { blob } = await renderPage(pageIndex);
        zip.file(imageExportPageFileName(pageIndex, extension, highestPageIndex), blob);
      }

      setStatus({ isProcessing: true, progress: 100, message: 'Zipping...' });
      const content = await zip.generateAsync({ type: 'blob' });
      downloadBlob(content, `${androidExportDirectoryName(file.name, 'images')}.zip`);
      setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
    } catch (error) {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof Error ? error.message : 'Export failed',
      });
    }
  };

  const selectedEmbeddedImages = useMemo(
    () => embeddedImages.filter((image) => selectedEmbeddedIds.includes(image.id)),
    [embeddedImages, selectedEmbeddedIds],
  );

  const downloadEmbeddedImages = async (images: EmbeddedPdfImageAsset[]) => {
    if (!file || images.length === 0) return;

    const baseName = getBaseName(file.name);
    if (images.length === 1) {
      const image = images[0];
      downloadBlob(image.blob, `${baseName}-embedded-image-pages-${image.pageNumbers.join('-')}.png`, 'image/png');
      setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
      return;
    }

    setStatus({ isProcessing: true, progress: 10, message: 'Preparing embedded images...' });

    try {
      const zip = new JSZip();
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        setStatus({
          isProcessing: true,
          progress: ((index + 1) / images.length) * 100,
          message: `Packing image ${index + 1}/${images.length}...`,
        });
        zip.file(
          `embedded-image-${String(index + 1).padStart(2, '0')}-pages-${image.pageNumbers.join('-')}.png`,
          image.blob,
        );
      }

      const content = await zip.generateAsync({ type: 'blob' });
      downloadBlob(content, `${baseName}-embedded-images.zip`);
      setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Embedded image export failed' });
    }
  };

  const handleEmbeddedExport = async () => {
    await downloadEmbeddedImages(selectedEmbeddedImages);
  };

  const handleStartOver = () => {
    scanRunIdRef.current += 1;
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

  // The export workspace earns the whole screen; the drop zone that precedes it
  // does not. Until a PDF is chosen this is an ordinary tool screen, with the
  // shell's Tools navigation above it and the tab bar below it.
  useImmersiveWorkspace(Boolean(file));

  const pageActionLabel = resolvedPageSelection === null
    ? 'Check page range'
    : `Convert ${exportPageCount} ${exportPageCount === 1 ? 'Page' : 'Pages'}`;
  const primaryActionLabel = exportMode === 'embedded-images'
    ? `Download Selected${selectedEmbeddedImages.length > 0 ? ` (${selectedEmbeddedImages.length})` : ''}`
    : pageActionLabel;

  if (!file) {
    return (
      <ToolShell centered>
        <ToolHeader title="PDF to Image" />
        <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to convert" />
        <StatusToast status={status} />
      </ToolShell>
    );
  }

  return (
    <div className="chef-safe-bottom flex h-[100dvh] min-h-[100dvh] w-full flex-col overflow-hidden bg-[var(--surface-canvas)]">

      {/* An immersive route gets no shell chrome, so it consumes the status-bar
          inset itself rather than painting under the clock. */}
      <div className="chef-safe-top z-30 flex min-h-16 flex-shrink-0 flex-col items-start justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2 sm:flex-row sm:items-center sm:px-6 sm:py-0">
        <div className="flex items-center gap-4">
          {/* This route has no app nav bar, so this is the only way out. It
              needs a name and a full target, not a bare glyph. */}
          <Link
            to="/"
            aria-label="Back to tools"
            className="chef-target grid place-items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-sunken)]"
          >
            <Undo2 aria-hidden size={20} />
          </Link>
          <div className="flex items-center gap-2">
            {PDF_TO_IMAGE_TOOL && (
              <ToolIdentity tool={PDF_TO_IMAGE_TOOL} size={20} assetSize={30} assetClassName="h-[30px] w-[30px] shrink-0 object-contain" />
            )}
            {/* The mode is stated by the Mode control and by the export
                button's own label; it does not need a third voice here. */}
            <h1 className="text-lg font-bold leading-none text-[var(--text-primary)]">PDF to Image</h1>
          </div>
        </div>

        {file && (
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto sm:gap-3">
            {hasDetectedEmbeddedImages && (
              <div className="type-caption hidden rounded-full bg-[var(--status-success-quiet)] px-3 py-1 uppercase text-[var(--status-success-text)] sm:block">
                {embeddedImages.length} images detected
              </div>
            )}
            <button
              onClick={handleStartOver}
              className="chef-target chef-pressable rounded-[var(--radius-control)] px-3 text-xs font-bold text-[var(--status-danger-text)] transition-colors hover:bg-[var(--status-danger-quiet)] sm:px-4 sm:text-sm"
            >
              Start over
            </button>
            <button
              onClick={handlePrimaryAction}
              disabled={
                status.isProcessing ||
                (exportMode === 'embedded-images'
                  ? selectedEmbeddedImages.length === 0
                  : !preview || resolvedPageSelection === null || (requiresLargeJobConfirmation && !largeJobConfirmed))
              }
              className="chef-target chef-pressable flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 text-xs font-bold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-55 sm:px-6 sm:text-sm"
            >
              {status.isProcessing ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />}
              <span>{primaryActionLabel}</span>
            </button>
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="chef-gesture-clear flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 sm:p-4 md:flex-row">
            <div className="custom-scrollbar flex max-h-[46dvh] w-full flex-shrink-0 flex-col gap-3 overflow-y-auto md:h-full md:max-h-none md:w-80 md:max-w-80">
              <div className="space-y-2 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3">
                <div className="flex items-center gap-2 border-b border-[var(--border-hairline)] pb-2 text-sm font-bold text-[var(--text-primary)]">
                  <Settings2 aria-hidden size={18} className="text-[var(--accent-text)]" /> Export settings
                </div>

                {hasImageModeOption && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Mode</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setExportMode('pages')}
                        className={`chef-pressable chef-hit-y grid min-h-11 place-items-center rounded-[var(--radius-control)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                          exportMode === 'pages'
                            ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                            : 'border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]'
                        }`}
                      >
                        Pages
                      </button>
                      <button
                        onClick={() => hasDetectedEmbeddedImages && setExportMode('embedded-images')}
                        disabled={!hasDetectedEmbeddedImages}
                        className={`chef-pressable chef-hit-y grid min-h-11 place-items-center rounded-[var(--radius-control)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                          exportMode === 'embedded-images'
                            ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                            : 'border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]'
                        } disabled:cursor-not-allowed disabled:opacity-55`}
                      >
                        {isScanningImages ? 'Scanning…' : `Images${hasDetectedEmbeddedImages ? ` (${embeddedImages.length})` : ''}`}
                      </button>
                    </div>
                  </div>
                )}

                {exportMode === 'pages' ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Format</label>
                      <div className="grid grid-cols-3 gap-2">
                        {['image/jpeg', 'image/png', 'image/webp'].map((format) => (
                          <button
                            key={format}
                            onClick={() => setConfig({ ...config, format: format as ImageExportConfig['format'] })}
                            className={`chef-pressable chef-hit-y grid min-h-11 place-items-center rounded-[var(--radius-control)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                              config.format === format
                                ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                                : 'border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]'
                            }`}
                          >
                            {format.split('/')[1].toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {config.format !== 'image/png' && (
                        <ChefSliderField
                          label="Quality"
                          suffix="%"
                          min={MIN_IMAGE_EXPORT_QUALITY}
                          max={100}
                          step={1}
                          value={Math.round(config.quality * 100)}
                          onChange={(next) => setConfig({ ...config, quality: next / 100 })}
                          ariaLabel="Image quality"
                        />
                      )}

                      <div className={config.format === 'image/png' ? 'col-span-2' : undefined}>
                        <ChefSliderField
                          label="Resolution"
                          suffix="×"
                          decimals={2}
                          fixedDecimals
                          min={MIN_IMAGE_EXPORT_SCALE}
                          max={MAX_IMAGE_EXPORT_SCALE}
                          step={0.05}
                          value={config.scale}
                          onChange={(next) => setConfig({ ...config, scale: next })}
                          ariaLabel="Image resolution"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]" htmlFor="pdf-to-image-pages">
                        Pages
                      </label>
                      <input
                        id="pdf-to-image-pages"
                        value={pageSelection}
                        onChange={(event) => setPageSelection(event.target.value)}
                        placeholder="All pages — or 1,3-5"
                        className="chef-field"
                      />
                      {resolvedPageSelection === null && (
                        <p role="alert" className="text-xs font-medium text-rose-600 dark:text-rose-300">
                          Use page numbers or ranges such as 1,3-5.
                        </p>
                      )}
                    </div>

                    {requiresLargeJobConfirmation && (
                      /* Kept in full: this is the one place the tool can warn
                         that a large export may exhaust the tab's memory. */
                      <div role="note" className="rounded-[var(--radius-field)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500 dark:bg-amber-500/10 dark:text-amber-100">
                        <p className="font-bold">Large browser export</p>
                        <p className="mt-1 leading-relaxed">
                          Exporting {exportPageCount} pages needs roughly {estimatedWorkingMemoryMb} MB of browser memory, and complex pages can need much more.
                        </p>
                        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 font-semibold">
                          <input
                            type="checkbox"
                            checked={largeJobConfirmed}
                            onChange={(event) => setLargeJobConfirmed(event.target.checked)}
                            className="h-5 w-5 accent-blue-600"
                          />
                          Continue with this export
                        </label>
                      </div>
                    )}

                  </>
                ) : (
                  hasDetectedEmbeddedImages && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                        <span>Selection</span>
                        <span>{selectedEmbeddedImages.length} / {embeddedImages.length}</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedEmbeddedIds(embeddedImages.map((image) => image.id))}
                          className="chef-target chef-pressable rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedEmbeddedIds([])}
                          className="chef-target chef-pressable rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>

            {exportMode === 'pages' ? (
              <div className="relative flex min-h-[30dvh] flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] md:min-h-0">
                <div className="absolute right-2 top-2 z-20 sm:right-4 sm:top-4">
                  <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
                </div>

                <div
                  className={`relative flex flex-1 items-center justify-center overflow-hidden ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  onPointerDown={handlePointerDown}
                >
                  {isGeneratingPreview && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface-raised)]/70 backdrop-blur-sm">
                      <Loader2 className="animate-spin text-[var(--accent-text)]" size={40} />
                    </div>
                  )}
                  {preview ? (
                    <div
                      className="relative"
                      style={zoom === 1 ? undefined : { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                    >
                      <PageImagePreview pdfDoc={pdfDoc} scale={config.scale} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center text-[var(--text-tertiary)]">
                      <FileImage size={48} className="mb-2 opacity-50" />
                      <p>Generating preview...</p>
                    </div>
                  )}
                </div>


              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]">
                <div className="border-b border-[var(--border-hairline)] px-3 py-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
                    <ImageIcon aria-hidden size={18} className="text-[var(--accent-text)]" />
                    Embedded images
                  </div>
                </div>

                <div className="custom-scrollbar flex-1 overflow-y-auto p-3">
                  {isScanningImages ? (
                    <div className="flex h-full flex-col items-center justify-center text-[var(--text-secondary)]">
                      <Loader2 className="mb-4 animate-spin" size={32} />
                      <p>Scanning PDF for embedded images…</p>
                    </div>
                  ) : embeddedImages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center text-[var(--text-secondary)]">
                      <ImageIcon size={40} className="mb-3 opacity-50" />
                      <p>No embedded raster images were detected.</p>
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {embeddedImages.map((image, index) => {
                        const isSelected = selectedEmbeddedIds.includes(image.id);
                        return (
                          <article
                            key={image.id}
                            className={`overflow-hidden rounded-2xl border text-left transition-all ${
                              isSelected
                                ? 'border-[var(--accent-rest)] shadow-lg'
                                : 'border-[var(--border-strong)]'
                            }`}
                          >
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              aria-label={`Image ${index + 1}${isSelected ? ', selected' : ''}`}
                              onClick={() => toggleEmbeddedSelection(image.id)}
                              className="chef-pressable block w-full"
                            >
                              <div className="flex aspect-[4/3] items-center justify-center bg-[var(--surface-sunken)] p-3">
                                <img src={image.objectUrl} alt="" aria-hidden className="max-h-full max-w-full object-contain" />
                              </div>
                            </button>

                            <div className="space-y-2 bg-[var(--surface-raised)] p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-bold text-[var(--text-primary)]">Image {index + 1}</div>
                                  <div className="text-xs text-[var(--text-secondary)]">
                                    Pages {image.pageNumbers.join(', ')}
                                  </div>
                                </div>
                                <div className={`type-caption rounded-full px-2 py-1 uppercase ${
                                  isSelected
                                    ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                                    : 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]'
                                }`}>
                                  {isSelected ? 'Selected' : 'Not selected'}
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-xs text-[var(--text-secondary)]">
                                <div className="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2">
                                  <div className="font-semibold text-[var(--text-body)]">{image.width} × {image.height}</div>
                                  <div>pixels</div>
                                </div>
                                <div className="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2">
                                  <div className="font-semibold text-[var(--text-body)]">{formatBytes(image.byteSize)}</div>
                                  <div>lossless PNG</div>
                                </div>
                              </div>

                              <button
                                type="button"
                                aria-label={`Download image ${index + 1}`}
                                onClick={() => void downloadEmbeddedImages([image])}
                                className="chef-target chef-pressable flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] text-sm font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)]"
                              >
                                <Download aria-hidden size={16} /> Download image
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
        </motion.div>
      </AnimatePresence>
      <StatusToast status={status} />
    </div>
  );
};
