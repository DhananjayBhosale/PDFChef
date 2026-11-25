import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, FileText, GripVertical, X } from 'lucide-react';
import { formatNumber, t } from '../../services/i18n/core.ts';
import { useToolAnnounce } from './parts';
import { useLongName } from '../../hooks/useLongName';
import { loadPDFDocument, releasePDFDocument, renderPageAsImage } from '../../services/pdfLazy';
import { PeekButton, usePagePreview } from './PagePeek';

// One file at a time, so a long queue does not open every document at once.
let turn: Promise<unknown> = Promise.resolve();
const inTurn = (job: () => Promise<void>) => {
  const run = turn.then(job, job);
  turn = run.catch(() => undefined);
};

/** The first page of a queued PDF, drawn small (larger in a short queue). A file that cannot be drawn keeps the file glyph. */
const FileThumb: React.FC<{ file: File; large?: boolean; onPages?: (count: number) => void }> = ({ file, large = false, onPages }) => {
  const [url, setUrl] = useState<string | null>(null);
  const pagesRef = useRef(onPages);
  pagesRef.current = onPages;

  useEffect(() => {
    let active = true;
    let created: string | null = null;
    setUrl(null);
    inTurn(async () => {
      if (!active) return;
      try {
        const pdf = await loadPDFDocument(file);
        if (active) pagesRef.current?.(pdf.numPages);
        const scale = (large ? 0.3 : 0.16) * Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const { objectUrl } = await renderPageAsImage(pdf, 0, { scale, format: 'image/jpeg', quality: 0.8 });
        if (!active) { URL.revokeObjectURL(objectUrl); return; }
        created = objectUrl;
        setUrl(objectUrl);
      } catch {
        // Locked or damaged: the glyph stays, and the tool's own messages cover real failures.
      } finally {
        void releasePDFDocument(file).catch(() => undefined);
      }
    });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [file, large]);

  return (
    <span className="tk-qthumb">
      {url ? <img src={url} alt="" draggable={false} /> : <FileText size={16} />}
    </span>
  );
};

/** The name needs more than its two lines, or the meta ("3 pages · 1.5 kB") is wider than its column. */
const nameOrMetaTooLong = (name: HTMLElement) => {
  const meta = name.parentElement?.querySelector<HTMLElement>('.tk-qrow-meta');
  return name.scrollHeight > name.clientHeight + 1 || Boolean(meta && meta.scrollWidth > meta.clientWidth + 1);
};

export interface QueueRowLabels {
  drag: string;
  up: string;
  down: string;
  remove: string;
  /** Short words for the pointer tooltip. */
  upTip?: string;
  downTip?: string;
  removeTip?: string;
}

/**
 * One file in a Merge or Batch queue (T-12): the first page (also the drag handle), the
 * position, the name, its meta, and Up, Down and Remove as icon buttons that keep their
 * full accessible names. `children` sits under the row (Batch's progress and failure).
 */
export const QueueRow: React.FC<{
  file: File;
  name: string;
  index: number;
  total: number;
  meta: React.ReactNode;
  busy: boolean;
  dragging: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onGrab: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onPages?: (count: number) => void;
  labels: QueueRowLabels;
  /** A short queue (three files or fewer): the first page is drawn large enough to read (pass 3). */
  roomy?: boolean;
  children?: React.ReactNode;
}> = ({ file, name, index, total, meta, busy, dragging, rowRef, onGrab, onMove, onRemove, onPages, labels, roomy = false, children }) => {
  // A name too long for two lines beside the buttons takes the row's whole width (research r2, mobile-04);
  // so does a meta line that does not fit there on one line (review 2, item 9).
  const mainRef = useLongName<HTMLDivElement>('.tk-qrow-name', name, nameOrMetaTooLong);
  // A move that takes the row to the first or last place disables the button just pressed, and
  // the browser would drop focus to the page: it goes to the other move button (desktop-07).
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const moved = useRef<-1 | 1 | 0>(0);
  useLayoutEffect(() => {
    const direction = moved.current;
    moved.current = 0;
    if (!direction) return;
    const pressed = direction < 0 ? upRef.current : downRef.current;
    const other = direction < 0 ? downRef.current : upRef.current;
    if (pressed?.disabled && other && !other.disabled) other.focus();
  }, [index]);
  const move = (direction: -1 | 1) => {
    moved.current = direction;
    onMove(direction);
  };
  // The row leaves with the button that had focus: the screen moves focus to a neighbour and says
  // what went (path to 9, item 6).
  const announce = useToolAnnounce();
  const remove = () => {
    onRemove();
    announce(t('tool.removed', { v0: name }));
  };
  // The first page large (pass 5, "PDFs are always zoomable"): the thumbnail is the drag handle, so
  // its eye opens the preview, where − and + and two fingers zoom. Two fingers spread on the row
  // open it too (fable-2 item 7); one finger still drags the row.
  const preview = usePagePreview(file, name);
  const { pinchRef } = preview;
  const attachMain = useCallback((node: HTMLDivElement | null) => {
    (mainRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    pinchRef(node);
  }, [mainRef, pinchRef]);
  return (
  // The files and their order are inputs of the result (workSignature.ts).
  <li ref={rowRef} className="tk-qrow" data-roomy={roomy ? '' : undefined} data-dragging={dragging || undefined} data-work-item={`${name}:${file.size}`}>
    <div ref={attachMain} className="tk-qrow-main" data-peek-page="0">
      <div className="tk-qrow-handle">
        <button
          type="button"
          onPointerDown={onGrab}
          disabled={busy}
          aria-label={labels.drag}
          className="tk-qrow-grab"
        >
          <GripVertical aria-hidden size={12} />
          <span className="tk-qrow-pic" aria-hidden>
            <FileThumb file={file} large={roomy} onPages={onPages} />
            <span className="tk-qrow-pos tabular">{formatNumber(index + 1)}</span>
          </span>
        </button>
        <PeekButton page={1} label={t('queue-row.preview.file', { v0: name })} onOpen={() => preview.open(0)} className="tk-qrow-peek" />
      </div>
      <div className="tk-qrow-text">
        <p className="tk-qrow-name" title={name}><bdi>{name}</bdi></p>
        <div className="tk-qrow-meta">{meta}</div>
      </div>
      <div className="tk-qrow-btns">
        <button
          type="button"
          ref={upRef}
          onClick={() => move(-1)}
          disabled={busy || index === 0}
          aria-label={labels.up}
          title={labels.upTip}
          className="tk-iconbtn chef-pressable"
        >
          <ArrowUp aria-hidden size={18} />
        </button>
        <button
          type="button"
          ref={downRef}
          onClick={() => move(1)}
          disabled={busy || index === total - 1}
          aria-label={labels.down}
          title={labels.downTip}
          className="tk-iconbtn chef-pressable"
        >
          <ArrowDown aria-hidden size={18} />
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={labels.remove}
          title={labels.removeTip}
          className="tk-iconbtn tk-iconbtn-danger chef-pressable"
        >
          <X aria-hidden size={18} />
        </button>
      </div>
    </div>
    {children}
    {preview.modal}
  </li>
  );
};

/** The row that follows the finger while a queue row is dragged. */
export const QueueGhost: React.FC<{ name: string; style: { top: number; left: number; width: number; height: number } }> = ({ name, style }) => createPortal(
  <div
    className="tk-qghost"
    style={{ top: style.top, left: style.left, width: style.width, height: style.height }}
  >
    <GripVertical aria-hidden size={16} />
    <span className="truncate">{name}</span>
  </div>,
  document.body,
);
