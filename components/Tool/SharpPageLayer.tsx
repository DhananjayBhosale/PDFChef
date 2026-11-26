import React, { createContext, useContext, useEffect, useRef } from 'react';
import { loadDisposablePDFDocument } from '../../services/pdfLazy';
import {
  SHARP_ZOOM_SETTLE_MS,
  planSharpRender,
  sharpPlanCovers,
  sharpViewport,
  sharpZoomBudget,
  type SharpPlan,
  type SharpRect,
} from '../../services/pdfSharpZoom';

/**
 * Sharp zoom for every page preview that zooms (`services/pdfSharpZoom.ts` has the reasons and the
 * arithmetic). Put it directly after the page's own `<canvas>` or `<img>`, inside the positioned
 * box that is the page (or, with `fitted`, the box the picture is fitted in), and before every overlay (signatures, text boxes, the watermark, the crop
 * frame, form fields): it paints an opaque page, so anything before it in the markup is hidden and
 * anything after it stays on top. It takes no pointer events and changes no layout.
 *
 * Once zoom and scroll have rested it draws the part of the page in sight at the screen's own
 * resolution into one canvas (`canvas[data-sharp-zoom]`). The canvas goes when the zoom comes back
 * down, the page leaves the screen, the tab is hidden or the layer unmounts.
 */

interface PdfPage {
  getViewport: (options: { scale: number; offsetX?: number; offsetY?: number }) => { width: number; height: number };
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<unknown>; cancel: () => void };
  cleanup: () => unknown;
}
export interface SharpPdfDocument {
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy?: () => unknown;
}

/** The open document the page was drawn from, or the file to open when detail is first needed. */
export type SharpSource = { pdfDoc: SharpPdfDocument | null } | { file: File | null };

/** The zoom of the large preview around a layer (`LargePagePreview`). */
export const SharpZoomContext = createContext<number | null>(null);

/* One set of listeners for every layer on screen. */
const layers = new Set<{ look: () => void; drop: () => void }>();
let timer: number | null = null;
let fingers = 0;
/** Halved for the session each time a detail canvas cannot be made (out of memory). */
let budgetScale = 1;

const lookAll = () => {
  timer = null;
  // Two fingers down is a pinch in progress: wait for it to end.
  if (fingers >= 2) return;
  layers.forEach((layer) => layer.look());
};
/** Look again once zoom and scroll have rested. */
const settle = () => {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(lookAll, SHARP_ZOOM_SETTLE_MS);
};
const onTouch = (event: TouchEvent) => {
  fingers = event.touches.length;
  settle();
};
const dropAll = () => layers.forEach((layer) => layer.drop());
/** A page moved by an eased CSS transform (the preview dialog) has its final place only once the easing ends. */
const onTransitionEnd = (event: TransitionEvent) => { if (event.propertyName === 'transform') settle(); };
/** A hidden tab gives its detail canvases back at once. */
const onVisibility = () => { if (document.hidden) dropAll(); else settle(); };
const passive: AddEventListenerOptions = { capture: true, passive: true };
const join = (layer: { look: () => void; drop: () => void }) => {
  if (layers.size === 0) {
    // Scroll events do not bubble; capture on the document hears every scroller.
    document.addEventListener('scroll', settle, passive);
    window.addEventListener('resize', settle);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', dropAll);
    window.addEventListener('pageshow', settle);
    document.addEventListener('transitionend', onTransitionEnd, passive);
    ['touchstart', 'touchend', 'touchcancel'].forEach((type) => document.addEventListener(type, onTouch as EventListener, passive));
  }
  layers.add(layer);
  return () => {
    layers.delete(layer);
    if (layers.size > 0) return;
    document.removeEventListener('scroll', settle, passive);
    window.removeEventListener('resize', settle);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', dropAll);
    window.removeEventListener('pageshow', settle);
    document.removeEventListener('transitionend', onTransitionEnd, passive);
    ['touchstart', 'touchend', 'touchcancel'].forEach((type) => document.removeEventListener(type, onTouch as EventListener, passive));
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    fingers = 0;
  };
};

const isPhone = () =>
  Boolean((window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())
  || window.matchMedia?.('(pointer: coarse)').matches === true;

/** The part of the window `node` can show through: the window, cut by every ancestor that clips. */
const visibleThrough = (node: HTMLElement): SharpRect => {
  let left = 0;
  let top = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

const freeCanvas = (canvas: HTMLCanvasElement) => {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
};

export const SharpPageLayer: React.FC<{
  source: SharpSource;
  /** 0-based. */
  pageIndex: number;
  /**
   * The page's zoom: only the signal to look again. Left out, it is the zoom of the large preview
   * around the layer; with neither, the layer does nothing (a small inline preview).
   */
  zoom?: number;
  /** The page's CSS transform, when it is panned rather than scrolled: another signal to look again. */
  transform?: string;
  /**
   * The page picture is fitted inside its box (an `<img>` with max-width and max-height) instead of
   * filling it: the layer is laid exactly over the picture.
   */
  fitted?: boolean;
}> = ({ source, pageIndex, zoom, transform, fitted = false }) => {
  const scopeZoom = useContext(SharpZoomContext);
  const signal = zoom ?? scopeZoom;
  const on = signal !== null;
  const boxRef = useRef<HTMLDivElement>(null);
  const pdfDoc = 'pdfDoc' in source ? source.pdfDoc : null;
  const file = 'file' in source ? source.file : null;

  useEffect(() => {
    const box = boxRef.current;
    if (!on || !box || (!pdfDoc && !file)) return undefined;
    let shown: { canvas: HTMLCanvasElement; plan: SharpPlan } | null = null;
    let drawing: { plan: SharpPlan; task: { cancel: () => void } | null } | null = null;
    let run = 0;
    // Set by the observer below, which reports once as soon as it starts.
    let onScreen = typeof IntersectionObserver === 'undefined';
    let opened: Promise<SharpPdfDocument> | null = null;
    let waits = 0;
    let waitTimer: number | null = null;

    const stopDrawing = () => {
      run += 1;
      try { drawing?.task?.cancel(); } catch { /* already over */ }
      drawing = null;
    };
    const drop = () => {
      stopDrawing();
      if (shown) freeCanvas(shown.canvas);
      shown = null;
    };
    const document_ = () => {
      if (pdfDoc) return Promise.resolve(pdfDoc);
      opened ??= loadDisposablePDFDocument(file as File) as Promise<SharpPdfDocument>;
      return opened;
    };

    const look = () => {
      if (waitTimer !== null) window.clearTimeout(waitTimer);
      waitTimer = null;
      if (document.hidden || !onScreen || !box.isConnected) { drop(); return; }
      const base = box.previousElementSibling;
      const baseWidth = base instanceof HTMLCanvasElement ? base.width : base instanceof HTMLImageElement ? base.naturalWidth : 0;
      if (!baseWidth) {
        // The page's own drawing is not there yet; nothing else says when it arrives.
        drop();
        if (waits < 20) { waits += 1; waitTimer = window.setTimeout(look, 300); }
        return;
      }
      waits = 0;
      if (fitted && base instanceof HTMLElement && box.parentElement) {
        // In percent of the box, so the layer stays on the picture while the box changes size.
        const outer = box.parentElement.getBoundingClientRect();
        const inner = base.getBoundingClientRect();
        const scale = outer.width / (box.parentElement.offsetWidth || outer.width);
        if (outer.width > 0 && outer.height > 0 && inner.width > 0) {
          const right = base.offsetWidth - base.clientWidth - base.clientLeft;
          const bottom = base.offsetHeight - base.clientHeight - base.clientTop;
          const percent = (value: number, of: number) => `${(value / of) * 100}%`;
          box.style.inset = [
            percent(inner.top + base.clientTop * scale - outer.top, outer.height),
            percent(outer.right - inner.right + right * scale, outer.width),
            percent(outer.bottom - inner.bottom + bottom * scale, outer.height),
            percent(inner.left + base.clientLeft * scale - outer.left, outer.width),
          ].join(' ');
        }
      }
      const pageBox = box.getBoundingClientRect();
      const budget = sharpZoomBudget(isPhone());
      const plan = planSharpRender({
        page: pageBox,
        view: visibleThrough(box),
        baseWidth,
        dpr: window.devicePixelRatio || 1,
        budget: { maxPixels: budget.maxPixels * budgetScale, maxSide: budget.maxSide },
        windowArea: window.innerWidth * window.innerHeight,
        active: shown !== null,
      });
      if (!plan) { drop(); return; }
      if (drawing && sharpPlanCovers(drawing.plan, plan)) return;
      if (shown && sharpPlanCovers(shown.plan, plan)) { stopDrawing(); return; }
      stopDrawing();
      const mine = run;
      const job: { plan: SharpPlan; task: { cancel: () => void } | null } = { plan, task: null };
      drawing = job;
      void (async () => {
        let page: PdfPage | null = null;
        const canvas = document.createElement('canvas');
        try {
          page = await (await document_()).getPage(pageIndex + 1);
        } catch {
          // A file that does not open (a password) keeps its own drawing.
          if (mine === run) drop();
          return;
        }
        try {
          if (mine !== run) return;
          const unit = page.getViewport({ scale: 1 });
          // A base drawn in another shape than the page (a rotated copy) would show a seam.
          if (Math.abs((unit.width / unit.height) / (pageBox.width / pageBox.height) - 1) > 0.01) { drop(); return; }
          canvas.width = plan.width;
          canvas.height = plan.height;
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('No canvas');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          const task = page.render({ canvasContext: context, viewport: page.getViewport(sharpViewport(plan, unit.width)) });
          job.task = task;
          await task.promise;
          if (mine !== run) return;
          canvas.setAttribute('data-sharp-zoom', '');
          canvas.setAttribute('aria-hidden', 'true');
          // In percent of the page, so the canvas stays in place while the next zoom is on its way.
          Object.assign(canvas.style, {
            position: 'absolute',
            left: `${(plan.clip.x / pageBox.width) * 100}%`,
            top: `${(plan.clip.y / pageBox.height) * 100}%`,
            width: `${(plan.clip.width / pageBox.width) * 100}%`,
            height: `${(plan.clip.height / pageBox.height) * 100}%`,
            pointerEvents: 'none',
          });
          // The new canvas goes in before the old one leaves: no blank flash.
          box.appendChild(canvas);
          if (shown) freeCanvas(shown.canvas);
          shown = { canvas, plan };
          drawing = null;
        } catch (error) {
          if (mine !== run || (error as { name?: string } | null)?.name === 'RenderingCancelledException') return;
          // No message: the page's own drawing stays, and the next try asks for half as much.
          budgetScale = Math.max(1 / 8, budgetScale / 2);
          drop();
        } finally {
          if (shown?.canvas !== canvas) { canvas.width = 0; canvas.height = 0; }
          try { page?.cleanup(); } catch { /* nothing cached */ }
        }
      })();
    };

    const leave = join({ look, drop });
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) settle(); else drop();
    });
    observer?.observe(box);
    settle();
    return () => {
      leave();
      observer?.disconnect();
      if (waitTimer !== null) window.clearTimeout(waitTimer);
      drop();
      void opened?.then((doc) => doc.destroy?.()).catch(() => undefined);
    };
  }, [on, pdfDoc, file, pageIndex, fitted]);

  useEffect(() => { if (on) settle(); }, [on, signal, transform]);

  if (!on) return null;
  return <div ref={boxRef} data-sharp-zoom-layer="" aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }} />;
};
