import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  Download,
  LayoutGrid,
  LockKeyhole,
  Loader2,
  Search,
  Share2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useShellOwnChrome } from '../Layout/AppShell';
import { FileUpload } from '../UI/FileUpload';
import { ZoomControls } from '../UI/ZoomControls';
import { StatusToast } from '../UI/StatusToast';
import { ErrorText } from '../UI/ErrorText';
import { loadDisposablePDFDocument, loadProtectedPDFDocument, pdfFileProblem } from '../../services/pdfLazy';
import { getPdfRenderScale } from '../../services/pdfPageGeometry';
import { downloadBlob } from '../../services/pdfShared';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import type { ProcessingStatus } from '../../types';
import { tools } from './toolCatalog';
import type { ToolCardData } from './toolCatalog';
import { ToolIdentity } from './ToolIdentity';
import { ToolScreen } from '../Tool/ToolScreen';
import { DesktopNavLinks, useNavFit } from '../Tool/ToolTop';
import { useHeaderLinks, useWide } from '../../hooks/useMediaQuery';
import { useLongName } from '../../hooks/useLongName';
import { MiddleName, middleFit } from '../UI/MiddleName';
import { useHideOnScroll } from '../../hooks/useHideOnScroll';
import { Badge, Portal } from '../UI/Primitives';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { useMonetization } from '../../hooks/useMonetization';
import { isConfirmEnter } from '../UI/keys';

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

/** The reader zooms to 400%, as Edit PDF does (fable-2 item 20). */
const READER_MAX_ZOOM = 4;

const ViewerPage: React.FC<{
  pdfDoc: any;
  pageIndex: number;
  zoom: number;
  onActivePage: (page: number) => void;
  /** Horizontal space around the page that is not available to it (the scroller's padding). */
  gutter?: number;
}> = ({ pdfDoc, pageIndex, zoom, onActivePage, gutter = 32 }) => {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 });
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === 'undefined' ? 612 : Math.max(240, window.innerWidth - gutter),
  );

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, { rootMargin: '600px' });

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateAvailableWidth = () => setAvailableWidth(Math.max(240, window.innerWidth - gutter));
    updateAvailableWidth();
    window.addEventListener('resize', updateAvailableWidth);
    return () => window.removeEventListener('resize', updateAvailableWidth);
  }, [gutter]);

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
      let page: any = null;
      try {
        page = await pdfDoc.getPage(pageIndex + 1);
        const scale = getPdfRenderScale(page);
        const viewport = page.getViewport({ scale });
        if (!canvas || cancelled) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        setDimensions({ width: viewport.width / scale, height: viewport.height / scale });
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
      } finally {
        // The canvas holds the drawn page; the decoded images PDF.js kept to draw it would
        // otherwise stay in memory for every page ever scrolled past.
        try {
          page?.cleanup();
        } catch {
          // A page with nothing cached is already where this wants it.
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
  // The query the shown results belong to: the count and Previous/Next show only for it, so typing
  // does not read "0 pages" before Find, nor keep the last query's count (round 5, desktop-04).
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [signatureReportOpening, setSignatureReportOpening] = useState(false);
  const [sharing, setSharing] = useState(false);
  const passwordAttemptRef = useRef(0);
  const activeOpenedPdfIdRef = useRef(openedPdf?.id);
  activeOpenedPdfIdRef.current = openedPdf?.id;
  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1, 0.5, READER_MAX_ZOOM, 0.25);
  const setPdfZoomViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom, max: READER_MAX_ZOOM });
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useWide();
  // Recent and Settings from 768 px, as on every tool header (research r2, mobile-05).
  const links = useHeaderLinks();
  const navFit = useNavFit(links);
  // A name too long for two lines beside the header's buttons gets a line of its own (phones).
  // The name keeps one line, cut in the middle (pass 5, item 8); only when the cut would hide half
  // of it beside the buttons does it take a line of its own.
  const titleName = openedPdf?.name ?? '';
  const topRowRef = useLongName<HTMLDivElement>('.tk-rtitle-name', openedPdf?.name, (title) => {
    const shown = middleFit(title, titleName);
    return shown !== null && Array.from(shown).length < Array.from(titleName).length / 2;
  });
  // The reader draws its own header (plan 2.3); before a file it is an ordinary ToolScreen.
  useShellOwnChrome(true);
  const readerRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);

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
      .catch(async (error) => {
        if (cancelled) return;
        const passwordRequired = error?.name === 'PasswordException' || /password/i.test(String(error?.message || ''));
        // Not a PDF, or damaged: say which, with Repair PDF as the way on (mobile-10).
        const problem = passwordRequired ? null : await pdfFileProblem(openedPdf.file, error).catch(() => null);
        if (cancelled) return;
        setNeedsPassword(passwordRequired);
        setStatus({ isProcessing: false, progress: 0, message: '', error: passwordRequired ? undefined : problem ?? t("view-pdf.could.not.open.this.pdf.90d31c") });
      });

    return () => {
      cancelled = true;
    };
  }, [openedPdf, replacePdfDoc]);

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

  // The platform shares: the system share sheet on Android, whose WebView has no
  // navigator.share, and Web Share in a browser. A browser can have Web Share and still
  // refuse files, so it is asked first.
  const shareFresh = platform.shareFresh;
  const canShare = Boolean(
    openedPdf &&
    shareFresh &&
    (typeof navigator === 'undefined' ||
      typeof navigator.canShare !== 'function' ||
      navigator.canShare({ files: [openedPdf.file] })),
  );

  const sharePdf = async () => {
    if (!openedPdf || !canShare || !shareFresh || sharing) return;
    const performShare = () => shareFresh({ blob: openedPdf.file, name: openedPdf.name, mimeType: 'application/pdf' });
    setSharing(true);
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
    } finally {
      setSharing(false);
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
      setSearchedQuery(searchQuery.trim());
      if (matches[0]) document.getElementById(`viewer-page-${matches[0]}`)?.scrollIntoView({ behavior: 'smooth' });
      setStatus({ isProcessing: false, progress: 100, message: matches.length ? t("view-pdf.matching.page.36e5c7", { count: matches.length }) : t("view-pdf.no.pages.contain.that.check.the.spelling.a2d06b") });
    } catch {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("view-pdf.search.is.unavailable.for.this.pdf.but.1766a0") });
    }
  };

  const searchCurrent = searchedQuery !== null && searchedQuery === searchQuery.trim() && searchedQuery !== '';
  const moveSearch = (direction: number) => {
    if (!searchResults.length) return;
    const next = (searchIndex + direction + searchResults.length) % searchResults.length;
    setSearchIndex(next);
    document.getElementById(`viewer-page-${searchResults[next]}`)?.scrollIntoView({ behavior: 'smooth' });
  };

  // Zoom hides while the pages scroll down on a phone, and comes back on the way up.
  const { hidden: zoomHidden, show: showZoom } = useHideOnScroll(readerRef, floatRef, {
    enabled: !wide && Boolean(openedPdf),
    zoom,
    keepShown: searchOpen,
    ready: pdfDoc?.numPages ?? 0,
  });

  if (!openedPdf) {
    return (
      <ToolScreen
        title={t("view-pdf.read.pdf.b00d88")}
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf,application/pdf" label={t("view-pdf.choose.a.pdf.to.read.33816d")} />
          </div>
        )}
      />
    );
  }

  const previewLocked = Boolean(openedPdf.previewOnly && !access?.unlocked);
  // After a failed open the card below says so; "Opening…" here would contradict it.
  const pageStatus = status.error && !pdfDoc ? null : previewLocked
    ? t("view-pdf.unlock.to.save.share.or.use.tools.5c4c2a", { v0: pdfDoc ? t("view-pdf.page.of.477c22", { v0: currentPage, v1: pdfDoc.numPages }) : t("view-pdf.opening.c926c2") })
    : pdfDoc ? t("view-pdf.page.of.477c22", { v0: currentPage, v1: pdfDoc.numPages }) : t("view-pdf.opening.c926c2");
  const key = 'tk-rkey chef-pressable chef-hit';
  // A file that could not be opened has nothing to download or zoom (T-09).
  const unreadable = Boolean(status.error && !pdfDoc && !needsPassword);
  const zoomCluster = <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={READER_MAX_ZOOM} bare dense className="tk-rzoom" />;
  const gutter = wide ? 64 : 24;

  return (
    <div ref={readerRef} className="tk-reader" data-wide={wide ? '' : undefined}>
      {/* The reader draws its own header, so it consumes the platform insets itself. */}
      <header className="tk-rtop chef-safe-top chef-safe-x">
        <div ref={topRowRef} className="tk-rtop-row">
          <Link
            to="/"
            aria-label={t("view-pdf.back.to.tools.e42d59")}
            title="PDF Chef"
            className="tk-rbrand chef-pressable"
          >
            <img src="/pdf-chef-logo-exact.webp" alt="" width={26} height={26} />
          </Link>
          <div className="tk-rtitle">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="tk-rtitle-name" title={openedPdf.name}><MiddleName name={openedPdf.name} /></h1>
              {previewLocked && <Badge tone="caution">{t("view-pdf.preview.only.3673f9")}</Badge>}
            </div>
            <p aria-live="polite" className="tk-rtitle-page">{pageStatus}</p>
          </div>
          <span className="tk-spacer" />
          <div className="tk-ractions">
            {pdfDoc && (
              <button
                ref={searchToggleRef}
                type="button"
                onClick={() => setSearchOpen((open) => !open)}
                className={key}
                aria-label={searchOpen ? t("view-pdf.close.pdf.search.2d77e1") : t("view-pdf.search.pdf.f89d76")}
                aria-expanded={searchOpen}
              >
                {searchOpen ? <X aria-hidden size={18} /> : <Search aria-hidden size={18} />}
              </button>
            )}
            {canVerifySignatures && (
              <button
                type="button"
                onClick={() => void openSignatureReport()}
                disabled={signatureReportOpening}
                className={`${key} min-h-touch`}
                aria-label={t("view-pdf.verify.pdf.signatures.93bd01")}
                title={t("view-pdf.signatures.d348ac")}
              >
                <ShieldCheck aria-hidden size={18} />
              </button>
            )}
            {canShare && (
              <button
                type="button"
                onClick={() => void sharePdf()}
                disabled={sharing}
                className={key}
                title={t("view-pdf.share.pdf.ec74b2")}
                aria-label={t("view-pdf.share.pdf.ec74b2")}
              >
                <Share2 aria-hidden size={18} />
              </button>
            )}
            {!unreadable && <button
              type="button"
              onClick={() => {
                if (previewLocked) {
                  void runWithExportAccess(() => downloadBlob(openedPdf.file, openedPdf.name, 'application/pdf'));
                  return;
                }
                downloadBlob(openedPdf.file, openedPdf.name, 'application/pdf', { accessScope: 'source' });
              }}
              className={key}
              title={t("view-pdf.download.original.9f82c2")}
              aria-label={t("view-pdf.download.original.9f82c2")}
            >
              <Download aria-hidden size={18} />
            </button>}
            {wide && !unreadable && <span aria-hidden className="tk-rsep" />}
            {wide && !unreadable && zoomCluster}
          </div>
          {/* Tablet and desktop: Recent and Settings before the Tools menu, as on every tool header (research r1, r2). */}
          {links && <span aria-hidden className="tk-rsep" />}
          {links && (
            <nav ref={navFit.ref} aria-label={t("app-shell.primary.efe10c")} className="tk-topnav">
              <DesktopNavLinks compact={navFit.level > 0} />
            </nav>
          )}
          <button
            type="button"
            onClick={() => {
              if (previewLocked) {
                void runWithExportAccess(() => setToolsOpen(true));
                return;
              }
              setToolsOpen((open) => !open);
            }}
            className="tk-tools tk-rtools chef-pressable"
            aria-haspopup={previewLocked ? undefined : 'menu'}
            aria-expanded={previewLocked ? undefined : toolsOpen}
            // Points at the menu only while it is in the page (r4 desktop-10).
            aria-controls={toolsOpen ? 'viewer-tools-menu' : undefined}
          >
            <LayoutGrid aria-hidden size={16} strokeWidth={1.75} />
            <span>{previewLocked ? t("view-pdf.unlock.to.use.tools.67bb7a") : t("view-pdf.tools.ea93d6")}</span>
            {/* The chevron says this Tools opens a menu, unlike the home Tools on other screens (upgrade review D-6). */}
            {!previewLocked && <ChevronDown aria-hidden size={14} strokeWidth={2} className={toolsOpen ? 'rotate-180' : undefined} />}
          </button>
        </div>

        {searchOpen && pdfDoc && (
          // The search finds text; it is not an input of a saved file (workSignature.ts).
          <div className="tk-rsearch" data-work-ignore="">
            <form onSubmit={(event) => { event.preventDefault(); void searchDocument(); }} className="flex w-full items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-1.5">
              <Search aria-hidden size={18} className="ml-2 shrink-0 text-[var(--text-tertiary)]" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                // Escape closes the search bar, as its close button does (desktop-04).
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  setSearchOpen(false);
                  searchToggleRef.current?.focus();
                }}
                placeholder={t("view-pdf.search.in.pdf.5ef72d")}
                aria-label={t("view-pdf.search.in.pdf.5ef72d")}
                className="h-10 min-w-0 flex-1 bg-transparent px-1 text-base outline-none"
                autoFocus
              />
              {searchCurrent && <span aria-live="polite" className="hidden whitespace-nowrap text-xs text-[var(--text-secondary)] sm:block">{searchResults.length ? t("view-pdf.pages.6bef20", { v0: searchIndex + 1, v1: searchResults.length }) : t("view-pdf.0.pages.a26a25")}</span>}
              {searchCurrent && searchResults.length > 0 && (
                <>
                  <button type="button" onClick={() => moveSearch(-1)} aria-label={t("view-pdf.previous.matching.page.a1d1dd")} className="chef-hit-y inline-flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"><ChevronUp size={18} /></button>
                  <button type="button" onClick={() => moveSearch(1)} aria-label={t("view-pdf.next.matching.page.96922b")} className="chef-hit-y inline-flex h-10 w-touch items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"><ChevronDown size={18} /></button>
                </>
              )}
              <button type="submit" disabled={!searchQuery.trim() || status.isProcessing} className="chef-hit-y h-10 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55">{t("view-pdf.find.822b2a")}</button>
            </form>
          </div>
        )}
      </header>

      {toolsOpen && (
        <Portal>
          {/* A true modal layer: full backdrop above the shell, a named
              Close, and Escape. */}
          <div className="tk-rmenu-scrim chef-safe-x" data-wide={wide ? '' : undefined}>
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
              className="tk-rmenu chef-safe-bottom chef-scroller"
            >
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-4 py-1">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-[var(--text-primary)]">{t("view-pdf.use.a.pdf.tool.7e5549")}</p>
                </div>
                <button
                  type="button"
                  ref={toolsCloseRef}
                  onClick={() => setToolsOpen(false)}
                  aria-label={t("view-pdf.close.tools.3f06b7")}
                  className="chef-pressable chef-target -me-2 grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)]"
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

      <main
        ref={setPdfZoomViewport}
        data-testid="pdf-zoom-viewport"
        data-pdf-zoom={zoom.toFixed(3)}
        // A click on the pages focuses the scroller itself, so Page Down, Space, the arrows, Home and
        // End scroll the document (round 5, desktop-05). Not a Tab stop: no extra stop before the pages.
        tabIndex={-1}
        className="tk-rpages chef-pdf-zoom-viewport chef-safe-x chef-safe-bottom chef-gesture-clear flex-1 overflow-auto focus:outline-none"
      >
        {needsPassword && !pdfDoc ? (
          <div className="mx-auto mt-6 max-w-sm rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 text-center">
            <LockKeyhole aria-hidden className="mx-auto h-8 w-8 text-[var(--status-caution-text)]" />
            <h2 className="mt-2 text-xl font-bold">{t("view-pdf.password.required.d89f81")}</h2>
            {/* Kept: whitespace in a PDF password is significant. */}
            <p className="type-footnote mt-1 text-[var(--text-secondary)]">{t("view-pdf.spaces.are.preserved.exactly.876f4a")}</p>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (isConfirmEnter(event)) void openWithPassword(); }} aria-label={t("view-pdf.pdf.password.e5cca6")} autoFocus className="chef-field mt-3 w-full px-3.5" />
            <button type="button" onClick={() => void openWithPassword()} disabled={password === '' || status.isProcessing} className="chef-target chef-pressable mt-3 w-full rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-4 font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55">{t("view-pdf.open.pdf.5b1034")}</button>
            <button type="button" onClick={clearOpenedPdf} className="chef-target chef-pressable mt-2 w-full rounded-[var(--radius-control)] px-4 font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]">{t("view-pdf.close.7d9eb7")}</button>
          </div>
        ) : status.error && !pdfDoc ? (
          <div className="mx-auto mt-6 max-w-md rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 text-center">
            <h2 className="text-xl font-bold">{t("view-pdf.couldn.t.open.pdf.9b9355")}</h2>
            <p className="mt-1.5 text-sm text-[var(--text-secondary)]"><ErrorText text={status.error} file={openedPdf?.file ?? null} /></p>
            {/* An unreadable file reads the same the second time: Close is the one way on (T-09). */}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button type="button" onClick={clearOpenedPdf} className="chef-target chef-pressable rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-5 font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]">{t("view-pdf.close.7d9eb7")}</button>
            </div>
          </div>
        ) : !pdfDoc ? (
          <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />{t("view-pdf.opening.pdf.9ad4dc")}</div>
        ) : (
          <div className="mx-auto flex w-max min-w-0 flex-col items-center">
            {Array.from({ length: pdfDoc.numPages || 0 }).map((_, index) => (
              <ViewerPage key={index} pdfDoc={pdfDoc} pageIndex={index} zoom={zoom} onActivePage={handleActivePage} gutter={gutter} />
            ))}
          </div>
        )}
      </main>

      {/* Phone: zoom floats at the bottom centre and steps aside while reading down. */}
      {!wide && !unreadable && (
        <div
          ref={floatRef}
          className="tk-rfloat"
          data-hidden={zoomHidden ? '' : undefined}
          data-zoom-float=""
          onFocusCapture={showZoom}
        >
          {zoomCluster}
        </div>
      )}

      {(pdfDoc || needsPassword) && <StatusToast status={status} />}
    </div>
  );
};
