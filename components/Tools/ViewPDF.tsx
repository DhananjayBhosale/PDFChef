import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  Download,
  LockKeyhole,
  Loader2,
  Search,
  Share2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useImmersiveWorkspace } from '../Layout/AppShell';
import { FileUpload } from '../UI/FileUpload';
import { ZoomControls } from '../UI/ZoomControls';
import { StatusToast } from '../UI/StatusToast';
import { loadDisposablePDFDocument, loadProtectedPDFDocument } from '../../services/pdfBrowser';
import { downloadBlob } from '../../services/pdfShared';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import type { ProcessingStatus } from '../../types';
import { tools } from './toolCatalog';
import type { ToolCardData } from './toolCatalog';
import { ToolIdentity } from './ToolIdentity';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { Badge, Portal } from '../UI/Primitives';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { useMonetization } from '../../hooks/useMonetization';

const VIEWER_TOOL_PATHS = [
  '/compress',
  '/merge',
  '/split',
  '/edit',
  '/make-fillable',
  '/sign',
  '/watermark',
  '/protect',
  '/unlock',
  '/delete-pages',
  '/page-numbers',
  '/reorder',
  '/rotate',
  '/flatten',
  '/extract',
  '/pdf-to-jpg',
  '/pdf-to-word',
  '/ocr',
  '/metadata',
  '/repair',
  '/compare',
] as const;

const viewerTools = VIEWER_TOOL_PATHS
  .map((path) => tools.find((tool) => tool.path === path))
  .filter((tool): tool is ToolCardData => Boolean(tool));

const ViewerPage: React.FC<{
  pdfDoc: any;
  pageIndex: number;
  zoom: number;
  onActivePage: (page: number) => void;
}> = ({ pdfDoc, pageIndex, zoom, onActivePage }) => {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 });
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === 'undefined' ? 612 : Math.max(240, window.innerWidth - 32),
  );

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, { rootMargin: '600px' });

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateAvailableWidth = () => setAvailableWidth(Math.max(240, window.innerWidth - 32));
    window.addEventListener('resize', updateAvailableWidth);
    return () => window.removeEventListener('resize', updateAvailableWidth);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onActivePage(pageIndex + 1);
    }, { rootMargin: '-30% 0px -60% 0px' });

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [onActivePage, pageIndex]);

  useEffect(() => {
    if (!isVisible || !pdfDoc || !canvasRef.current) return;

    let cancelled = false;
    let renderTask: { promise: Promise<unknown>; cancel?: () => void } | null = null;
    const canvas = canvasRef.current;
    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 2 });
        if (!canvas || cancelled) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        setDimensions({ width: viewport.width / 2, height: viewport.height / 2 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (error: any) {
        if (!cancelled && error?.name !== 'RenderingCancelledException') {
          console.error(error);
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [isVisible, pageIndex, pdfDoc]);

  const fittedZoom = Math.min(1, availableWidth / dimensions.width) * zoom;

  return (
    <section
      id={`viewer-page-${pageIndex + 1}`}
      ref={containerRef}
      aria-label={t("view-pdf.page.c140ba", { v0: pageIndex + 1 })}
      className="mb-3 scroll-mt-40 rounded border border-paper-300 bg-white shadow-[var(--elevation-raised)]"
    >
      {/* The page mark sits above the page, not on it. Floated into the corner
          it landed on whatever the document put at its own top left, which on a
          normal document is the first line of the page. */}
      <div aria-hidden className="border-b border-paper-200 px-2 py-1 text-xs font-semibold text-paper-600">
        {formatNumber(pageIndex + 1)}
      </div>
      <div
        dir="ltr"
        className="origin-top-left"
        style={{
          width: dimensions.width * fittedZoom,
          height: dimensions.height * fittedZoom,
        }}
      >
        <canvas
          ref={canvasRef}
          width={0}
          height={0}
          className="block origin-top-left"
          style={{
            width: dimensions.width,
            height: dimensions.height,
            transform: `scale(${fittedZoom})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </section>
  );
};

export const ViewPDF: React.FC = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const { access, runWithExportAccess } = useMonetization();
  const {
    openedPdf,
    setOpenedPdfFile,
    stageProtectedPdfPassword,
    clearOpenedPdf,
  } = useOpenedPdf();
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const pdfDocRef = useRef<any>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsCloseRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [verifiedPassword, setVerifiedPassword] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [signatureReportOpening, setSignatureReportOpening] = useState(false);
  const passwordAttemptRef = useRef(0);
  const activeOpenedPdfIdRef = useRef(openedPdf?.id);
  activeOpenedPdfIdRef.current = openedPdf?.id;
  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1, 0.5, 2, 0.25);
  const setPdfZoomViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom });
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const state = location.state as { openTools?: boolean; openedPdfId?: string } | null;
    if (state?.openTools && openedPdf?.id === state.openedPdfId && !openedPdf.previewOnly) {
      setToolsOpen(true);
    }
  }, [location.key, location.state, openedPdf?.id, openedPdf?.previewOnly]);
  // The Read PDF card starts a new read. A file left open from an earlier visit would
  // otherwise come back every time, with no way to choose another. The flag is dropped
  // from history so Back from a tool returns to the file, not to the picker.
  const readAnother = (location.state as { readAnother?: boolean } | null)?.readAnother === true;
  useEffect(() => {
    if (!readAnother) return;
    clearOpenedPdf();
    navigate(location.pathname, { replace: true, state: null });
  }, [clearOpenedPdf, location.pathname, navigate, readAnother]);
  const handleActivePage = useCallback((page: number) => setCurrentPage(page), []);
  const replacePdfDoc = useCallback((nextDocument: any | null) => {
    const previousDocument = pdfDocRef.current;
    pdfDocRef.current = nextDocument;
    setPdfDoc(nextDocument);
    if (previousDocument && previousDocument !== nextDocument && previousDocument.destroy) {
      void previousDocument.destroy();
    }
  }, []);

  useEffect(() => () => {
    passwordAttemptRef.current += 1;
    const currentDocument = pdfDocRef.current;
    pdfDocRef.current = null;
    if (currentDocument?.destroy) void currentDocument.destroy();
  }, []);

  // The reader takes the whole screen, but only once there is something to
  // read. Before that this is an ordinary tool screen with the shell's own
  // Tools navigation and the tab bar.
  useImmersiveWorkspace(Boolean(openedPdf));

  useEffect(() => {
    passwordAttemptRef.current += 1;
    replacePdfDoc(null);
    if (!openedPdf) {
      return;
    }

    let cancelled = false;
    setStatus({ isProcessing: true, progress: 20, message: t("view-pdf.opening.pdf.3b7ab1") });
    setNeedsPassword(false);
    setPassword('');
    setVerifiedPassword(null);
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setCurrentPage(1);

    loadDisposablePDFDocument(openedPdf.file)
      .then((doc) => {
        if (cancelled) {
          if (doc?.destroy) void doc.destroy();
          return;
        }
        replacePdfDoc(doc);
        setStatus({ isProcessing: false, progress: 100, message: '' });
      })
      .catch((error) => {
        if (!cancelled) {
          const passwordRequired = error?.name === 'PasswordException' || /password/i.test(String(error?.message || ''));
          setNeedsPassword(passwordRequired);
          setStatus({ isProcessing: false, progress: 0, message: '', error: passwordRequired ? undefined : t("view-pdf.could.not.open.this.pdf.90d31c") });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [openAttempt, openedPdf, replacePdfDoc]);

  // The tools sheet closes on Escape and puts focus on its Close control, the
  // same contract every other modal in the product follows.
  useEffect(() => {
    if (!toolsOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setToolsOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    toolsCloseRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [toolsOpen]);

  const handleFilesSelected = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setOpenedPdfFile(file);
  };

  const openToolWithAccess = (path: string) => {
    setToolsOpen(false);
    if (path === '/ocr' && openedPdf && verifiedPassword !== null) {
      stageProtectedPdfPassword(openedPdf.id, verifiedPassword);
    }
    navigate(path, { state: { useOpenedPdf: true, openedPdfId: openedPdf?.id } });
  };

  const openTool = (path: string) => {
    if (openedPdf?.previewOnly && !access?.unlocked) {
      void runWithExportAccess(() => openToolWithAccess(path));
      return;
    }
    openToolWithAccess(path);
  };

  const canShare = Boolean(
    openedPdf &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [openedPdf.file] })),
  );

  const sharePdf = async () => {
    if (!openedPdf || !canShare) return;
    const performShare = async () => {
      await navigator.share({ files: [openedPdf.file], title: openedPdf.name });
    };
    try {
      if (openedPdf.previewOnly && !access?.unlocked) {
        await runWithExportAccess(performShare);
        return;
      }
      await performShare();
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: '', error: t("view-pdf.this.pdf.could.not.be.shared.save.52d5e3") });
      }
    }
  };

  const signatureVerification = platform.pdfSignatureVerification;
  const canVerifySignatures = Boolean(
    openedPdf && signatureVerification?.isEligible(openedPdf.file),
  );

  const openSignatureReport = async () => {
    if (!openedPdf || !signatureVerification || !canVerifySignatures || signatureReportOpening) return;
    setSignatureReportOpening(true);
    try {
      await signatureVerification.present(openedPdf.file);
    } catch {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: t("view-pdf.signature.details.could.not.be.opened.for.2e56bb"),
      });
    } finally {
      setSignatureReportOpening(false);
    }
  };

  const openWithPassword = async () => {
    if (!openedPdf || !password) return;
    const openedPdfId = openedPdf.id;
    const passwordAttempt = passwordAttemptRef.current + 1;
    passwordAttemptRef.current = passwordAttempt;
    setStatus({ isProcessing: true, progress: 20, message: t("view-pdf.checking.password.4752fe") });
    try {
      const doc = await loadProtectedPDFDocument(openedPdf.file, password);
      if (
        passwordAttemptRef.current !== passwordAttempt ||
        activeOpenedPdfIdRef.current !== openedPdfId
      ) {
        if (doc?.destroy) void doc.destroy();
        return;
      }
      replacePdfDoc(doc);
      setNeedsPassword(false);
      setVerifiedPassword(password);
      setPassword('');
      setStatus({ isProcessing: false, progress: 100, message: t("view-pdf.pdf.opened.43755c") });
    } catch {
      if (
        passwordAttemptRef.current !== passwordAttempt ||
        activeOpenedPdfIdRef.current !== openedPdfId
      ) return;
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("view-pdf.that.password.did.not.open.this.pdf.a7fcc9") });
    }
  };

  const searchDocument = async () => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!pdfDoc || !query) {
      setSearchResults([]);
      return;
    }
    setStatus({ isProcessing: true, progress: 5, message: t("view-pdf.searching.document.235a54") });
    const matches: number[] = [];
    try {
      for (let index = 0; index < pdfDoc.numPages; index += 1) {
        const page = await pdfDoc.getPage(index + 1);
        const content = await page.getTextContent();
        const text = content.items.map((item: any) => item.str || '').join(' ').toLocaleLowerCase();
        if (text.includes(query)) matches.push(index + 1);
        setStatus({ isProcessing: true, progress: Math.round((index + 1) / pdfDoc.numPages * 95), message: t("view-pdf.searching.page.of.5a1f8e", { v0: index + 1, v1: pdfDoc.numPages }) });
      }
      setSearchResults(matches);
      setSearchIndex(0);
      if (matches[0]) document.getElementById(`viewer-page-${matches[0]}`)?.scrollIntoView({ behavior: 'smooth' });
      setStatus({ isProcessing: false, progress: 100, message: matches.length ? t("view-pdf.matching.page.36e5c7", { count: matches.length }) : t("view-pdf.no.pages.contain.that.check.the.spelling.a2d06b") });
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("view-pdf.search.is.unavailable.for.this.pdf.but.1766a0") });
    }
  };

  const moveSearch = (direction: number) => {
    if (!searchResults.length) return;
    const next = (searchIndex + direction + searchResults.length) % searchResults.length;
    setSearchIndex(next);
    document.getElementById(`viewer-page-${searchResults[next]}`)?.scrollIntoView({ behavior: 'smooth' });
  };

  if (!openedPdf) {
    // The shell's navigation bar names the tool and carries the way back, so
    // the page states its own heading once and puts the source picker directly
    // under it, exactly as every other tool screen does.
    return (
      <ToolShell centered>
        <ToolHeader title={t("view-pdf.read.pdf.b00d88")} />
        <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf,application/pdf" label={t("view-pdf.choose.a.pdf.to.read.33816d")} />
      </ToolShell>
    );
  }

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] flex-col bg-[var(--surface-sunken)] text-[var(--text-primary)]">
      {/* An immersive route is handed no shell chrome, so it consumes the
          platform insets itself. Without this the header and the Tools action
          paint underneath the status bar and the camera cutout. */}
      <header className="chef-chrome chef-safe-top chef-safe-x z-20 shrink-0 border-b px-4 py-2">
        <div className="mx-auto flex max-w-7xl flex-col gap-2">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Link
                to="/"
                aria-label={t("view-pdf.back.to.tools.e42d59")}
                className="chef-hit-y -ml-1 inline-flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <img src="/pdf-chef-logo-exact.webp" alt="" className="h-5 w-5 object-contain" />
                <span>PDF Chef</span>
              </Link>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="chef-filename text-base font-bold text-[var(--text-primary)]">{openedPdf.name}</h1>
                {openedPdf.previewOnly && !access?.unlocked && <Badge tone="caution">{t("view-pdf.preview.only.3673f9")}</Badge>}
              </div>
              <p aria-live="polite" className="text-xs font-medium text-[var(--text-secondary)]">
                {openedPdf.previewOnly && !access?.unlocked
                  ? t("view-pdf.unlock.to.save.share.or.use.tools.5c4c2a", { v0: pdfDoc ? t("view-pdf.page.of.477c22", { v0: currentPage, v1: pdfDoc.numPages }) : t("view-pdf.opening.c926c2") })
                  : pdfDoc ? t("view-pdf.page.of.477c22", { v0: currentPage, v1: pdfDoc.numPages }) : t("view-pdf.opening.c926c2")}
              </p>
            </div>

            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  if (openedPdf.previewOnly && !access?.unlocked) {
                    void runWithExportAccess(() => setToolsOpen(true));
                    return;
                  }
                  setToolsOpen((open) => !open);
                }}
                className="chef-pressable chef-hit inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3.5 text-sm font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]"
                aria-expanded={openedPdf.previewOnly && !access?.unlocked ? undefined : toolsOpen}
                aria-controls="viewer-tools-menu"
              >
                {openedPdf.previewOnly && !access?.unlocked ? t("view-pdf.unlock.to.use.tools.67bb7a") : t("view-pdf.tools.ea93d6")}
                <ChevronDown size={16} />
              </button>

              {toolsOpen && (
                <Portal>
                  {/* A true modal layer: full backdrop above the shell, a named
                      44pt Close, and Escape. It had been an absolute popover
                      inside the transformed route, so its backdrop covered only
                      part of the screen. */}
                  <div className="chef-safe-x fixed inset-0 z-[100] flex items-end justify-center sm:items-center" style={{ background: 'var(--surface-scrim)' }}>
                    <button
                      type="button"
                      aria-label={t("view-pdf.close.tools.3f06b7")}
                      onClick={() => setToolsOpen(false)}
                      className="absolute inset-0 cursor-default"
                    />
                    <div
                      id="viewer-tools-menu"
                      role="menu"
                      aria-label={t("view-pdf.use.a.pdf.tool.7e5549")}
                      className="chef-safe-bottom chef-scroller relative w-full max-w-lg overflow-y-auto rounded-t-[var(--radius-sheet)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] shadow-[var(--elevation-sheet)] sm:max-h-[70dvh] sm:rounded-[var(--radius-sheet)]"
                      style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top) - 2rem)' }}
                    >
                      <div className="sticky top-0 z-10 flex items-start gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-[var(--text-primary)]">{t("view-pdf.use.a.pdf.tool.7e5549")}</p>
                        </div>
                        <button
                          type="button"
                          ref={toolsCloseRef}
                          onClick={() => setToolsOpen(false)}
                          aria-label={t("view-pdf.close.tools.3f06b7")}
                          className="chef-pressable chef-target -mr-2 -mt-1 grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)]"
                        >
                          <X aria-hidden size={20} />
                        </button>
                      </div>
                      {viewerTools.map((tool) => (
                        <button
                          key={tool.path}
                          type="button"
                          role="menuitem"
                          onClick={() => openTool(tool.path)}
                          className="chef-pressable flex min-h-touch w-full items-center gap-3 px-4 py-2.5 text-start text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
                        >
                          <ToolIdentity tool={tool} size={16} assetSize={28} assetClassName="h-7 w-7 shrink-0 object-contain" />
                          <span>{tool.name}</span>
                        </button>
                      ))}
                      <Link
                        to="/"
                        onClick={() => setToolsOpen(false)}
                        className="chef-target flex items-center border-t border-[var(--border-hairline)] px-4 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--surface-sunken)]"
                      >{t("view-pdf.all.tools.81c151")}</Link>
                    </div>
                  </div>
                </Portal>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {pdfDoc && (
              <button
                type="button"
                onClick={() => setSearchOpen((open) => !open)}
                className="chef-pressable chef-hit inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
                aria-label={searchOpen ? t("view-pdf.close.pdf.search.2d77e1") : t("view-pdf.search.pdf.f89d76")}
                aria-expanded={searchOpen}
              >
                {searchOpen ? <X size={18} /> : <Search size={18} />}
              </button>
            )}
            {canVerifySignatures && (
              <button
                type="button"
                onClick={() => void openSignatureReport()}
                disabled={signatureReportOpening}
                className="chef-pressable chef-target inline-flex min-h-touch items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-sunken)] disabled:opacity-55"
                aria-label={t("view-pdf.verify.pdf.signatures.93bd01")}
              >
                <ShieldCheck aria-hidden size={18} />
                <span>{t("view-pdf.signatures.d348ac")}</span>
              </button>
            )}
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
            {canShare && (
              <button
                type="button"
                onClick={() => void sharePdf()}
                className="chef-pressable chef-hit inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
                title={t("view-pdf.share.pdf.ec74b2")}
                aria-label={t("view-pdf.share.pdf.ec74b2")}
              >
                <Share2 size={18} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (openedPdf.previewOnly && !access?.unlocked) {
                  void runWithExportAccess(() => downloadBlob(openedPdf.file, openedPdf.name, 'application/pdf'));
                  return;
                }
                downloadBlob(openedPdf.file, openedPdf.name, 'application/pdf', { accessScope: 'source' });
              }}
              className="chef-pressable chef-hit inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
              title={t("view-pdf.download.original.9f82c2")}
              aria-label={t("view-pdf.download.original.9f82c2")}
            >
              <Download size={18} />
            </button>
          </div>

          {/* The row's controls keep the reader cluster's density — a 40px
              visual box whose pressable region is extended on the vertical
              axis only, width held at the floor, because they sit shoulder to
              shoulder. They had been plain 40px targets beside a zoom cluster
              that already cleared the floor. */}
          {searchOpen && pdfDoc && (
            <form onSubmit={(event) => { event.preventDefault(); void searchDocument(); }} className="flex w-full items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-1.5">
              <Search aria-hidden size={18} className="ml-2 shrink-0 text-[var(--text-tertiary)]" />
              <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("view-pdf.search.in.pdf.5ef72d")} aria-label={t("view-pdf.search.in.pdf.5ef72d")} className="h-10 min-w-0 flex-1 bg-transparent px-1 text-base outline-none" autoFocus />
              {searchQuery.trim() && <span aria-live="polite" className="hidden whitespace-nowrap text-xs text-[var(--text-secondary)] sm:block">{searchResults.length ? t("view-pdf.pages.6bef20", { v0: searchIndex + 1, v1: searchResults.length }) : t("view-pdf.0.pages.a26a25")}</span>}
              {searchResults.length > 0 && (
                <>
                  <button type="button" onClick={() => moveSearch(-1)} aria-label={t("view-pdf.previous.matching.page.a1d1dd")} className="chef-hit-y inline-flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"><ChevronUp size={18} /></button>
                  <button type="button" onClick={() => moveSearch(1)} aria-label={t("view-pdf.next.matching.page.96922b")} className="chef-hit-y inline-flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"><ChevronDown size={18} /></button>
                </>
              )}
              <button type="submit" disabled={!searchQuery.trim() || status.isProcessing} className="chef-hit-y h-10 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55">{t("view-pdf.find.822b2a")}</button>
            </form>
          )}
        </div>
      </header>

      <main
        ref={setPdfZoomViewport}
        data-testid="pdf-zoom-viewport"
        data-pdf-zoom={zoom.toFixed(3)}
        className="chef-pdf-zoom-viewport chef-safe-x chef-safe-bottom chef-gesture-clear flex-1 overflow-auto p-4"
      >
        {needsPassword && !pdfDoc ? (
          <div className="mx-auto mt-6 max-w-sm rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 text-center">
            <LockKeyhole aria-hidden className="mx-auto h-8 w-8 text-[var(--status-caution-text)]" />
            <h2 className="mt-2 text-xl font-bold">{t("view-pdf.password.required.d89f81")}</h2>
            {/* Kept: whitespace in a PDF password is significant. */}
            <p className="type-footnote mt-1 text-[var(--text-secondary)]">{t("view-pdf.spaces.are.preserved.exactly.876f4a")}</p>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void openWithPassword(); }} aria-label={t("view-pdf.pdf.password.e5cca6")} autoFocus className="chef-field mt-3 w-full px-3.5" />
            <button type="button" onClick={() => void openWithPassword()} disabled={password === '' || status.isProcessing} className="chef-target chef-pressable mt-3 w-full rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55">{t("view-pdf.open.pdf.5b1034")}</button>
            <button type="button" onClick={clearOpenedPdf} className="chef-target chef-pressable mt-2 w-full rounded-[var(--radius-control)] px-4 font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]">{t("view-pdf.close.7d9eb7")}</button>
          </div>
        ) : status.error && !pdfDoc ? (
          <div className="mx-auto mt-6 max-w-md rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 text-center">
            <h2 className="text-xl font-bold">{t("view-pdf.couldn.t.open.pdf.9b9355")}</h2>
            <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{status.error}</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button type="button" onClick={clearOpenedPdf} className="chef-target chef-pressable rounded-[var(--radius-control)] border border-[var(--border-strong)] px-5 font-semibold text-[var(--text-primary)] hover:border-[var(--accent-rest)]">{t("view-pdf.close.7d9eb7")}</button>
              <button type="button" onClick={() => setOpenAttempt((attempt) => attempt + 1)} className="chef-target chef-pressable rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-5 font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]">{t("view-pdf.retry.942087")}</button>
            </div>
          </div>
        ) : !pdfDoc ? (
          <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />{t("view-pdf.opening.pdf.9ad4dc")}</div>
        ) : (
          <div className="mx-auto flex w-max min-w-0 flex-col items-center">
            {Array.from({ length: pdfDoc.numPages || 0 }).map((_, index) => (
              <ViewerPage key={index} pdfDoc={pdfDoc} pageIndex={index} zoom={zoom} onActivePage={handleActivePage} />
            ))}
          </div>
        )}
      </main>

      {(pdfDoc || needsPassword) && <StatusToast status={status} />}
    </div>
  );
};
