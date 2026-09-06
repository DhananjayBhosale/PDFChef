import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  Loader2,
  Plus,
  RotateCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { FileUpload } from '../UI/FileUpload';
import { ChefSliderField } from '../UI/ChefSlider';
import { ZoomControls } from '../UI/ZoomControls';
import { Portal } from '../UI/Primitives';
import { PDFFile, ProcessingStatus } from '../../types';
import { useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import { loadPDFDocument } from '../../services/pdfBrowser';
import { applySignaturesToPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { androidExportFileName } from '../../services/androidParity';
import { SegmentedControl } from '../UI/Primitives';
import { StatusToast } from '../UI/StatusToast';

interface SignatureItem {
  localId: string;
  id: string;
  pageIndex: number;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  aspectRatio: number;
}

type EditMode = 'drag' | 'resize' | null;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clampWidth = (value: number) => clamp(value, 0.1, 0.8);

const getPoint = (event: PointerEvent | React.PointerEvent) => ({ x: event.clientX, y: event.clientY });

const createTransparentSignature = async (dataUrl: string, threshold = 242) => {
  const image = new Image();
  image.decoding = 'async';

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to process signature image.'));
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext('2d');
  if (!context) {
    return dataUrl;
  }

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const softness = 18;

  for (let index = 0; index < pixels.length; index += 4) {
    const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    if (brightness >= threshold) {
      pixels[index + 3] = 0;
      continue;
    }

    if (brightness > threshold - softness) {
      const distance = threshold - brightness;
      pixels[index + 3] = Math.round((distance / softness) * pixels[index + 3]);
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
};

const rotateSignatureImage = async (dataUrl: string) => {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to rotate signature image.'));
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.height;
  canvas.height = image.width;
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
};

const typedSignatureImage = (text: string, color: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 280;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = 'italic 118px "Cormorant Garamond", Georgia, serif';
  context.fillStyle = color;
  context.textBaseline = 'middle';
  context.fillText(text.trim(), 36, canvas.height / 2, canvas.width - 72);
  return canvas.toDataURL('image/png');
};

const SignatureOverlay: React.FC<{
  item: SignatureItem;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (id: string, updates: Partial<SignatureItem>) => void;
  onDelete: (id: string) => void;
}> = ({ item, containerRef, isSelected, onSelect, onUpdate, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const modeRef = useRef<EditMode>(null);
  const originRef = useRef({
    clientX: 0,
    clientY: 0,
    x: item.x,
    y: item.y,
    width: item.width,
    aspectRatio: item.aspectRatio,
  });

  const startEdit = (event: React.PointerEvent, mode: Exclude<EditMode, null>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const point = getPoint(event);
    modeRef.current = mode;
    originRef.current = {
      clientX: point.x,
      clientY: point.y,
      x: item.x,
      y: item.y,
      width: item.width,
      aspectRatio: item.aspectRatio,
    };
    setEditing(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const height = item.width / item.aspectRatio;
    const movement = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];

    if (movement) {
      event.preventDefault();
      onSelect();
      onUpdate(item.localId, {
        x: clamp(item.x + movement.x, 0, 1 - item.width),
        y: clamp(item.y + movement.y, 0, 1 - height),
      });
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onDelete(item.localId);
    }
  };

  useEffect(() => {
    if (!editing) return;

    const handleMove = (event: PointerEvent) => {
      if (!containerRef.current || !modeRef.current) return;
      const point = getPoint(event);
      const dx = point.x - originRef.current.clientX;
      const dy = point.y - originRef.current.clientY;
      const rect = containerRef.current.getBoundingClientRect();

      if (modeRef.current === 'drag') {
        const nextX = clamp(originRef.current.x + dx / rect.width, 0, 1 - originRef.current.width);
        const nextY = clamp(
          originRef.current.y + dy / rect.height,
          0,
          1 - originRef.current.width / originRef.current.aspectRatio,
        );
        onUpdate(item.localId, { x: nextX, y: nextY });
      } else if (modeRef.current === 'resize') {
        const rawWidth = originRef.current.width + dx / rect.width;
        const maxWidthByX = 1 - originRef.current.x;
        const maxWidthByY = (1 - originRef.current.y) * originRef.current.aspectRatio;
        const maxWidth = Math.max(0.1, Math.min(0.9, maxWidthByX, maxWidthByY));
        const nextWidth = clampWidth(clamp(rawWidth, 0.1, maxWidth));
        onUpdate(item.localId, { width: nextWidth });
      }
    };

    const handleUp = () => {
      modeRef.current = null;
      setEditing(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [containerRef, editing, item.localId, onUpdate]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Signature stamp. Drag to move, use arrow keys for precise movement."
      className={`absolute z-20 cursor-move touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-500 ${isSelected ? 'ring-2 ring-ink-500' : 'ring-ink-400 hover:ring-1'}`}
      style={{
        left: `${item.x * 100}%`,
        top: `${item.y * 100}%`,
        width: `${item.width * 100}%`,
        aspectRatio: item.aspectRatio,
      }}
      onPointerDown={(event) => startEdit(event, 'drag')}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <img src={item.dataUrl} alt="" aria-hidden className="pointer-events-none h-full w-full object-contain" />
      {isSelected && (
        <>
          <button
            type="button"
            aria-label="Remove signature stamp"
            className="absolute -right-6 -top-6 grid h-12 w-12 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(item.localId);
            }}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-danger-600 text-paper-25 shadow">
              <X aria-hidden size={14} />
            </span>
          </button>
          <button
            type="button"
            aria-label="Resize signature stamp"
            className="absolute -bottom-6 -right-6 grid h-12 w-12 touch-none place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
            onPointerDown={(event) => startEdit(event, 'resize')}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-ink-600 text-paper-25 shadow">
              <Expand aria-hidden size={14} />
            </span>
          </button>
        </>
      )}
    </div>
  );
};

const PDFPageCanvas: React.FC<{
  pdfDoc: any;
  pageIndex: number;
  zoom: number;
  signatures: SignatureItem[];
  selectedSignatureId: string | null;
  onSelectSignature: (id: string) => void;
  onUpdateSignature: (id: string, updates: Partial<SignatureItem>) => void;
  onDeleteSignature: (id: string) => void;
  onBackgroundClick: () => void;
}> = ({
  pdfDoc,
  pageIndex,
  zoom,
  signatures,
  selectedSignatureId,
  onSelectSignature,
  onUpdateSignature,
  onDeleteSignature,
  onBackgroundClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 600, height: 850 });

  useEffect(() => {
    setRendered(false);
  }, [pageIndex]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: '500px' },
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const render = async () => {
      if (!visible || rendered || !canvasRef.current || !pdfDoc) return;
      const page = await pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 2 });
      setDimensions({ width: viewport.width / 2, height: viewport.height / 2 });

      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      setRendered(true);
    };
    void render();
  }, [pageIndex, pdfDoc, rendered, visible]);

  return (
    <div
      className="relative mb-3 bg-white shadow-[var(--elevation-panel)]"
      style={{ width: dimensions.width * zoom, height: dimensions.height * zoom }}
    >
      <div
        ref={containerRef}
        className="relative origin-top-left bg-white"
        style={{ width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})` }}
        onClick={onBackgroundClick}
      >
        {!rendered && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper-100 text-paper-600">
            <Loader2 className="animate-spin" />
          </div>
        )}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        {signatures.map((signature) => (
          <SignatureOverlay
            key={signature.localId}
            item={signature}
            containerRef={containerRef}
            isSelected={selectedSignatureId === signature.localId}
            onSelect={() => onSelectSignature(signature.localId)}
            onUpdate={onUpdateSignature}
            onDelete={onDeleteSignature}
          />
        ))}
      </div>
    </div>
  );
};

export const SignPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [signatures, setSignatures] = useState<SignatureItem[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<'document' | 'stamps'>('document');

  const [showModal, setShowModal] = useState(false);

  const addSignatureRef = useRef<HTMLButtonElement>(null);

  const signatureDialogRef = useRef<HTMLDivElement>(null);
  const [signatureMode, setSignatureMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [inkColor, setInkColor] = useState('#111827');
  const [typedSignature, setTypedSignature] = useState('');
  const [uploadedSignatureSource, setUploadedSignatureSource] = useState('');
  const [uploadedSignature, setUploadedSignature] = useState('');
  const [transparentUpload, setTransparentUpload] = useState(true);
  const [isPreparingUpload, setIsPreparingUpload] = useState(false);
  const [hasDrawnSignature, setHasDrawnSignature] = useState(false);
  const signatureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1.0);
  const setPdfZoomViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom });

  const pageCount = pdfDoc?.numPages || 0;
  const selectedSignature = signatures.find((signature) => signature.localId === selectedSignatureId) || null;
  const pageSignatures = useMemo(
    () => signatures.filter((signature) => signature.pageIndex === currentPageIndex),
    [currentPageIndex, signatures],
  );

  useEffect(() => {
    if (!selectedSignatureId) return;
    if (!signatures.some((signature) => signature.localId === selectedSignatureId)) {
      setSelectedSignatureId(null);
    }
  }, [selectedSignatureId, signatures]);

  useEffect(() => {
    return () => {
      if (pdfDoc?.destroy) void pdfDoc.destroy();
    };
  }, [pdfDoc]);

  useEffect(() => {
    let cancelled = false;

    if (!uploadedSignatureSource) {
      setUploadedSignature('');
      setIsPreparingUpload(false);
      return undefined;
    }

    if (!transparentUpload) {
      setUploadedSignature(uploadedSignatureSource);
      setIsPreparingUpload(false);
      return undefined;
    }

    setIsPreparingUpload(true);

    void createTransparentSignature(uploadedSignatureSource)
      .then((nextSignature) => {
        if (!cancelled) {
          setUploadedSignature(nextSignature);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUploadedSignature(uploadedSignatureSource);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsPreparingUpload(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transparentUpload, uploadedSignatureSource]);

  const selectSignature = (id: string | null) => {
    setSelectedSignatureId(id);
    if (!id) return;
    const target = signatures.find((signature) => signature.localId === id);
    if (target) setCurrentPageIndex(target.pageIndex);
  };

  const updateSignature = (id: string, updates: Partial<SignatureItem>) => {
    setSignatures((previous) =>
      previous.map((signature) =>
        signature.localId === id
          ? {
              ...signature,
              ...updates,
              width: updates.width !== undefined ? clampWidth(updates.width) : signature.width,
            }
          : signature,
      ),
    );
  };

  const deleteSignature = (id: string) => {
    setSignatures((previous) => previous.filter((signature) => signature.localId !== id));
    if (selectedSignatureId === id) setSelectedSignatureId(null);
  };

  const jumpToPage = (nextIndex: number) => {
    if (!pageCount) return;
    setCurrentPageIndex(clamp(nextIndex, 0, pageCount - 1));
  };

  const updateSelectedSignaturePage = (nextIndex: number) => {
    if (!selectedSignature) return;
    const clampedIndex = clamp(nextIndex, 0, Math.max(0, pageCount - 1));
    updateSignature(selectedSignature.localId, { pageIndex: clampedIndex });
    setCurrentPageIndex(clampedIndex);
  };

  // The signature dialog is a real modal: focus moves in, Tab stays inside,
  // Escape closes it, and focus returns to the control that opened it.
  useEffect(() => {
    if (!showModal) return undefined;
    const opener = addSignatureRef.current;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, canvas, [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      signatureDialogRef.current ? Array.from(signatureDialogRef.current.querySelectorAll<HTMLElement>(selector)) : [];
    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowModal(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [showModal]);

  const handleFilesSelected = async (files: File[]) => {
    if (!files.length || !isPdfFile(files[0])) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Choose a PDF file to sign.' });
      return;
    }
    const selected = files[0];
    setStatus({ isProcessing: true, progress: 5, message: 'Opening PDF...' });

    try {
      const doc = await loadPDFDocument(selected);
      setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size });
      setPdfDoc(doc);
      setSignatures([]);
      setSelectedSignatureId(null);
      setCurrentPageIndex(0);
      setMobilePanel('document');
      setExactZoom(window.matchMedia('(max-width: 767px)').matches ? 0.5 : 1);
      setStatus({ isProcessing: false, progress: 0, message: '' });
    } catch {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'Unable to open this PDF. Unlock password-protected files first.',
      });
    }
  };

  const addSignature = (dataUrl: string) => {
    const nextSignature: SignatureItem = {
      localId: uuidv4(),
      id: uuidv4(),
      pageIndex: currentPageIndex,
      dataUrl,
      x: 0.35,
      y: 0.45,
      width: 0.28,
      aspectRatio: 2,
    };

    const image = new Image();
    image.onload = () => {
      nextSignature.aspectRatio = image.width / Math.max(1, image.height);
      setSignatures((previous) => [...previous, nextSignature]);
      setSelectedSignatureId(nextSignature.localId);
      setMobilePanel('document');
    };
    image.onerror = () => {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to use this signature image.' });
    };
    image.src = dataUrl;
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Applying signatures...' });
    try {
      const bytes = await applySignaturesToPDF(file.file, signatures);
      const outputName = androidExportFileName('sign', file.name, 'pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), outputName);
      setStatus({ isProcessing: false, progress: 100, message: `Signed copy ready: ${outputName}.` });
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Failed to export signed PDF.' });
    }
  };

  const clearSignatureCanvas = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    context.lineWidth = 2.6;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = inkColor;
    setHasDrawnSignature(false);
  };

  useEffect(() => {
    if (!showModal) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const initializeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const targetHeight = window.innerWidth < 640 ? 180 : 220;
      canvas.style.width = '100%';
      canvas.style.height = `${targetHeight}px`;

      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.floor(rect.width));
      const cssHeight = Math.max(1, Math.floor(rect.height));

      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(dpr, dpr);
      clearSignatureCanvas();
    };

    const raf = window.requestAnimationFrame(initializeCanvas);
    window.addEventListener('resize', initializeCanvas);
    setSignatureMode('draw');
    setTransparentUpload(true);
    setUploadedSignatureSource('');
    setUploadedSignature('');
    setTypedSignature('');

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', initializeCanvas);
    };
  }, [showModal]);

  useEffect(() => {
    const context = signatureCanvasRef.current?.getContext('2d');
    if (context) context.strokeStyle = inkColor;
  }, [inkColor]);

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onDrawStart = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (signatureMode !== 'draw') return;
    event.preventDefault();
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const point = getCanvasPoint(event);
    if (!context || !point) return;
    drawingRef.current = true;
    canvas.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(point.x, point.y);
  };

  const onDrawMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || signatureMode !== 'draw') return;
    event.preventDefault();
    const context = signatureCanvasRef.current?.getContext('2d');
    const point = getCanvasPoint(event);
    if (!context || !point) return;
    context.lineTo(point.x, point.y);
    context.stroke();
    setHasDrawnSignature(true);
  };

  const onDrawEnd = (event?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    if (event && signatureCanvasRef.current?.hasPointerCapture(event.pointerId)) {
      signatureCanvasRef.current.releasePointerCapture(event.pointerId);
    }
    drawingRef.current = false;
  };

  const handleSignatureUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setUploadedSignatureSource(reader.result);
    };
    reader.readAsDataURL(selected);
  };

  const applySignatureFromModal = () => {
    const drawn = signatureCanvasRef.current?.toDataURL('image/png') || '';
    const selected = signatureMode === 'upload'
      ? uploadedSignature
      : signatureMode === 'type'
        ? typedSignatureImage(typedSignature, inkColor)
        : hasDrawnSignature ? drawn : '';
    if (!selected) return;
    addSignature(selected);
    setShowModal(false);
  };

  const rotateSelectedSignature = async () => {
    if (!selectedSignature) return;
    try {
      const dataUrl = await rotateSignatureImage(selectedSignature.dataUrl);
      const image = new Image();
      image.onload = () => updateSignature(selectedSignature.localId, {
        dataUrl,
        aspectRatio: image.width / Math.max(1, image.height),
      });
      image.src = dataUrl;
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Unable to rotate this signature.' });
    }
  };

  return (
    // The workspace claims the shell's own content box, and only once it has a
    // document to put in it. `100dvh` inside a route that already spends a nav
    // bar and a tab bar overflowed the page by exactly that chrome, and centred
    // the empty drop zone a screen below the fold.
    <div className={`mx-auto w-full max-w-7xl px-4 py-4 sm:py-6 ${file ? 'chef-workspace-fill flex flex-col' : 'chef-tool-landing-centered'}`}>
      <div className="mb-2 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Sign PDF</h1>
        {file && (
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <button
              ref={addSignatureRef}
              onClick={() => setShowModal(true)}
              className="chef-target chef-pressable flex min-w-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-bold text-[var(--text-primary)] transition-colors hover:border-[var(--accent-rest)] sm:px-4"
            >
              <Plus size={18} /> Add signature
            </button>
            <button
              onClick={handleSave}
              disabled={status.isProcessing || signatures.length === 0}
              className="chef-target chef-pressable flex min-w-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:border disabled:border-[var(--border-hairline)] disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-tertiary)] disabled:opacity-100 sm:px-6"
            >
              {status.isProcessing ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
              Export
            </button>
          </div>
        )}
      </div>

      {file && (
        <div className="mb-2 md:hidden">
          <SegmentedControl
            label="Sign PDF workspace"
            value={mobilePanel}
            options={[
              { value: 'document', label: 'Document' },
              { value: 'stamps', label: `Stamps (${signatures.length})` },
            ]}
            onChange={setMobilePanel}
          />
        </div>
      )}

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-xl">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to sign" />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="grid min-h-0 flex-1 gap-2 md:grid-cols-[minmax(0,1fr)_320px]"
          >
            <div className={`relative min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] ${mobilePanel === 'document' ? 'flex' : 'hidden'} md:flex`}>
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2 sm:px-4">
                <div className="chef-filename min-w-[8rem] flex-1 text-sm font-semibold text-[var(--text-body)]">{file.name}</div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => jumpToPage(currentPageIndex - 1)}
                    disabled={currentPageIndex <= 0}
                    aria-label="Previous page"
                    className="chef-hit-y chef-pressable grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <div className="tabular rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-1 text-xs font-semibold text-[var(--text-body)]">
                    Page {currentPageIndex + 1} / {Math.max(1, pageCount)}
                  </div>
                  <button
                    onClick={() => jumpToPage(currentPageIndex + 1)}
                    disabled={!pageCount || currentPageIndex >= pageCount - 1}
                    aria-label="Next page"
                    className="chef-hit-y chef-pressable grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
                <ZoomControls
                  className="w-fit max-w-full"
                  zoom={zoom}
                  onZoomIn={zoomIn}
                  onZoomOut={zoomOut}
                  onReset={resetZoom}
                />
              </div>

              <div
                ref={setPdfZoomViewport}
                data-testid="pdf-zoom-viewport"
                data-pdf-zoom={zoom.toFixed(3)}
                className="chef-pdf-zoom-viewport custom-scrollbar flex-1 overflow-auto p-3 sm:p-6"
              >
                {pdfDoc ? (
                  <div className="flex flex-col items-center">
                    <PDFPageCanvas
                      key={currentPageIndex}
                      pdfDoc={pdfDoc}
                      pageIndex={currentPageIndex}
                      zoom={zoom}
                      signatures={pageSignatures}
                      selectedSignatureId={selectedSignatureId}
                      onSelectSignature={selectSignature}
                      onUpdateSignature={updateSignature}
                      onDeleteSignature={deleteSignature}
                      onBackgroundClick={() => selectSignature(null)}
                    />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
                    <Loader2 className="mr-2 animate-spin" /> Loading pages...
                  </div>
                )}
              </div>

            </div>

            <aside className={`min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] ${mobilePanel === 'stamps' ? 'flex' : 'hidden'} md:flex`}>
              <div className="border-b border-[var(--border-hairline)] px-3 py-2">
                <div className="text-sm font-semibold text-[var(--text-primary)]">Signature stamps</div>
              </div>

              <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto p-3">
                {signatures.length === 0 ? (
                  <p className="type-footnote py-2 text-center text-[var(--text-secondary)]">No stamps yet.</p>
                ) : (
                  <div className="space-y-2">
                    {signatures.map((signature, index) => (
                      <button
                        key={signature.localId}
                        onClick={() => selectSignature(signature.localId)}
                        className={`w-full rounded-xl border px-3 py-2 text-left ${
                          selectedSignatureId === signature.localId
                            ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                            : 'border-[var(--border-strong)] text-[var(--text-body)] hover:border-[var(--accent-rest)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold">Stamp {index + 1}</div>
                          <div className="text-xs opacity-70">Page {signature.pageIndex + 1}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {selectedSignature && (
                  <div className="space-y-2.5 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-3">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">Selected stamp</div>

                    <div>
                      <label className="mb-1 block text-xs font-semibold text-[var(--text-secondary)]">Page</label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Move stamp to previous page"
                          onClick={() => updateSelectedSignaturePage(selectedSignature.pageIndex - 1)}
                          disabled={selectedSignature.pageIndex <= 0}
                          className="chef-target chef-pressable grid shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:border-[var(--accent-rest)] disabled:opacity-55"
                        >
                          <ChevronLeft aria-hidden size={18} />
                        </button>
                        <select
                          value={selectedSignature.pageIndex}
                          onChange={(event) => updateSelectedSignaturePage(Number(event.target.value))}
                          className="flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-rest)]"
                        >
                          {Array.from({ length: Math.max(1, pageCount) }, (_, index) => (
                            <option key={index} value={index}>
                              Page {index + 1}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label="Move stamp to next page"
                          onClick={() => updateSelectedSignaturePage(selectedSignature.pageIndex + 1)}
                          disabled={!pageCount || selectedSignature.pageIndex >= pageCount - 1}
                          className="chef-target chef-pressable grid shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:border-[var(--accent-rest)] disabled:opacity-55"
                        >
                          <ChevronRight aria-hidden size={18} />
                        </button>
                      </div>
                    </div>

                    <div>
                      <ChefSliderField
                        label="Stamp width"
                        suffix="%"
                        decimals={2}
                        min={10}
                        max={80}
                        step={0.25}
                        value={Number((selectedSignature.width * 100).toFixed(2))}
                        onChange={(next) => updateSignature(selectedSignature.localId, { width: next / 100 })}
                        ariaLabel="Signature width"
                      />
                    </div>

                    <button
                      onClick={() => void rotateSelectedSignature()}
                      className="chef-pressable chef-hit-y flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--accent-quiet)] px-3 text-sm font-semibold text-[var(--accent-on-quiet)]"
                    >
                      <RotateCw aria-hidden size={18} /> Rotate stamp 90°
                    </button>

                    <button
                      onClick={() => deleteSignature(selectedSignature.localId)}
                      className="chef-pressable chef-hit-y flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-sm font-semibold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"
                    >
                      <Trash2 aria-hidden size={18} /> Remove stamp
                    </button>
                  </div>
                )}
              </div>

            </aside>
          </motion.div>
        )}
      </AnimatePresence>

      {showModal && (
        <Portal>
        <div className="chef-safe-x fixed inset-0 z-[100] flex items-end justify-center bg-black/50 sm:items-center sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            ref={signatureDialogRef}
            aria-labelledby="create-signature-title"
            className="chef-scroller max-h-[calc(100dvh-env(safe-area-inset-top))] w-full max-w-2xl overflow-y-auto rounded-t-[var(--radius-sheet)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[var(--elevation-sheet)] sm:max-h-[calc(100dvh-2rem)] sm:rounded-[var(--radius-sheet)] sm:p-5"
          >
            <h3 id="create-signature-title" className="mb-3 font-bold text-[var(--text-primary)]">
              Create signature stamp
            </h3>

            <div className="mb-3">
              <SegmentedControl
                label="Signature source"
                value={signatureMode}
                columns={3}
                options={[
                  { value: 'draw', label: 'Draw' },
                  { value: 'upload', label: 'Upload' },
                  { value: 'type', label: 'Type' },
                ]}
                onChange={setSignatureMode}
              />
            </div>

            {signatureMode === 'draw' ? (
              <div className="mb-3">
                <canvas
                  ref={signatureCanvasRef}
                  onPointerDown={onDrawStart}
                  onPointerMove={onDrawMove}
                  onPointerUp={onDrawEnd}
                  onPointerLeave={onDrawEnd}
                  onPointerCancel={onDrawEnd}
                  className="h-[220px] w-full touch-none rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-white"
                />
                <div className="mt-2 flex justify-end">
                  <label className="mr-auto inline-flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">Ink color<input type="color" value={inkColor} onChange={(event) => setInkColor(event.target.value)} className="h-8 w-10 rounded border-0 bg-transparent" /></label>
                  <button
                    onClick={clearSignatureCanvas}
                    className="chef-hit-y rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)]"
                  >
                    Clear
                  </button>
                </div>
              </div>
            ) : signatureMode === 'type' ? (
              <div className="mb-3 space-y-2.5">
                <label className="block text-sm font-semibold text-[var(--text-secondary)]">Signature text<input value={typedSignature} onChange={(event) => setTypedSignature(event.target.value)} placeholder="Your name" className="chef-field mt-2 text-2xl italic" /></label>
                <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">Ink color<input type="color" value={inkColor} onChange={(event) => setInkColor(event.target.value)} className="h-8 w-10 rounded border-0 bg-transparent" /></label>
                {typedSignature.trim() && <div className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-white p-3"><img src={typedSignatureImage(typedSignature, inkColor)} alt="Typed signature preview" className="max-h-28" /></div>}
              </div>
            ) : (
              <div className="mb-3 space-y-2.5">
                <label className="chef-target block w-full cursor-pointer content-center rounded-[var(--radius-field)] border-2 border-dashed border-[var(--border-strong)] p-3 text-center text-sm text-[var(--text-secondary)] hover:border-[var(--accent-rest)]">
                  Choose signature image
                  <input type="file" accept="image/*" onChange={handleSignatureUpload} className="hidden" />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
                  <span className="font-medium">Transparent background</span>
                  <input
                    type="checkbox"
                    checked={transparentUpload}
                    onChange={(event) => setTransparentUpload(event.target.checked)}
                    className="h-5 w-5 rounded border-[var(--border-strong)]"
                  />
                </label>
                {uploadedSignature && (
                  <div
                    className="flex items-center justify-center rounded-[var(--radius-field)] border border-[var(--border-hairline)] p-3"
                    style={{
                      backgroundColor: '#f8fafc',
                      backgroundImage:
                        'linear-gradient(45deg, rgba(148,163,184,0.14) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,0.14) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,0.14) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,0.14) 75%)',
                      backgroundSize: '18px 18px',
                      backgroundPosition: '0 0, 0 9px, 9px -9px, -9px 0px',
                    }}
                  >
                    <img src={uploadedSignature} alt="Uploaded signature" className="max-h-28 object-contain" />
                  </div>
                )}
                {isPreparingUpload && (
                  <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Loader2 className="animate-spin" size={14} />
                    Preparing transparent preview...
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="chef-target chef-pressable rounded-[var(--radius-control)] px-4 font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]">
                Cancel
              </button>
              <button
                onClick={applySignatureFromModal}
                disabled={signatureMode === 'upload' ? !uploadedSignature || isPreparingUpload : signatureMode === 'type' ? !typedSignature.trim() : !hasDrawnSignature}
                className="chef-target chef-pressable rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-semibold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                Add Stamp
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <StatusToast status={status} />
    </div>
  );
};
