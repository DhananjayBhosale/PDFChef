import React, { useLayoutEffect, useRef, useState } from 'react';
import { CROP_EDGES, CROP_MAX, CROP_MIN, dragMargins, keyMargin, type CropCorner, type CropEdge, type CropHandle, type CropMargins } from './cropMath.ts';

/**
 * The live crop preview (plan 2.13): one page, fitted in the canvas, with a frame inset
 * from each edge by that edge's margin. Outside the frame the page is dimmed; what is
 * inside is what every page keeps.
 *
 * - Edge handles move one edge; corner handles move their two edges together. Dragging
 *   inside the frame does nothing. Pointer events with capture; `touch-action: none` on
 *   the handles, so a finger drag never scrolls the page.
 * - Each edge handle is a slider for keyboards and screen readers (0–40, arrows by 1,
 *   Shift + arrows by 5, Home and End). Corner handles are pointer-only and hidden from
 *   assistive technology.
 * - Left and right are sides of the page: they do not mirror in right-to-left languages.
 * - The frame and the sentence show the same four numbers: `onChange` runs on every move.
 */

const CORNERS: readonly CropCorner[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

interface DragState {
  pointerId: number;
  handle: CropHandle;
  startX: number;
  startY: number;
  start: CropMargins;
}

export const CropFrame: React.FC<{
  /** The rendered page. */
  src: string;
  /** The rendered page's size in pixels (only its shape matters). */
  pageWidth: number;
  pageHeight: number;
  margins: CropMargins;
  onChange: (next: CropMargins) => void;
  /** The handles' names: "Top", "Right", "Bottom", "Left". */
  labels: Record<CropEdge, string>;
  /** "5% of page" for a value. */
  valueText: (value: number) => string;
  alt: string;
  disabled?: boolean;
}> = ({ src, pageWidth, pageHeight, margins, onChange, labels, valueText, alt, disabled = false }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState<CropHandle | null>(null);

  // Fit the page inside the stage, as large as it can be.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || pageWidth <= 0 || pageHeight <= 0) return undefined;
    const measure = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(width / pageWidth, height / pageHeight);
      const next = { width: Math.floor(pageWidth * scale), height: Math.floor(pageHeight * scale) };
      setBox((current) => (current && current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, [pageWidth, pageHeight]);

  const startDrag = (handle: CropHandle) => (event: React.PointerEvent<HTMLElement>) => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, handle, startX: event.clientX, startY: event.clientY, start: { ...margins } };
    setDragging(handle);
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const page = pageRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !page) return;
    const rect = page.getBoundingClientRect();
    const next = dragMargins(drag.start, drag.handle, event.clientX - drag.startX, event.clientY - drag.startY, rect.width, rect.height);
    if (CROP_EDGES.some((edge) => next[edge] !== margins[edge])) onChange(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setDragging(null);
  };

  // A second finger is a pinch (the large preview opens or zooms): it moves no edge, and an edge
  // the first finger was dragging goes back where it was.
  const fingersRef = useRef(new Set<number>());
  const cancelOnSecondFinger = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse') return;
    const fingers = fingersRef.current;
    const second = fingers.size > 0;
    fingers.add(event.pointerId);
    if (!second) return;
    event.stopPropagation();
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(null);
    onChange(drag.start);
  };
  const fingerUp = (event: React.PointerEvent<HTMLElement>) => { fingersRef.current.delete(event.pointerId); };

  const onKey = (edge: CropEdge) => (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const value = keyMargin(margins[edge], event.key, event.shiftKey);
    if (value === null) return;
    event.preventDefault();
    if (value !== margins[edge]) onChange({ ...margins, [edge]: value });
  };

  const pointerHandlers = (handle: CropHandle) => ({
    onPointerDown: startDrag(handle),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  });

  const frameStyle = {
    top: `${margins.top}%`,
    right: `${margins.right}%`,
    bottom: `${margins.bottom}%`,
    left: `${margins.left}%`,
  } as React.CSSProperties;

  return (
    <div ref={stageRef} className="tk-crop-stage" onPointerDownCapture={cancelOnSecondFinger} onPointerUpCapture={fingerUp} onPointerCancelCapture={fingerUp}>
      <div
        ref={pageRef}
        className="tk-crop-page"
        data-dragging={dragging ?? undefined}
        style={box ? { width: box.width, height: box.height } : { visibility: 'hidden' }}
        dir="ltr"
      >
        <img src={src} alt={alt} draggable={false} className="tk-crop-img" />
        <div aria-hidden className="tk-crop-clip"><div className="tk-crop-shade" style={frameStyle} /></div>
        <div className="tk-crop-frame" style={frameStyle} data-crop-frame="">
          {CROP_EDGES.map((edge) => (
            <div
              key={edge}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={labels[edge]}
              aria-orientation={edge === 'top' || edge === 'bottom' ? 'vertical' : 'horizontal'}
              aria-valuemin={CROP_MIN}
              aria-valuemax={CROP_MAX}
              aria-valuenow={margins[edge]}
              aria-valuetext={valueText(margins[edge])}
              aria-disabled={disabled || undefined}
              data-crop-handle={edge}
              className="tk-crop-handle tk-crop-edge"
              onKeyDown={onKey(edge)}
              {...pointerHandlers(edge)}
            >
              <span aria-hidden className="tk-crop-pill" />
            </div>
          ))}
          {CORNERS.map((corner) => (
            <div
              key={corner}
              aria-hidden
              data-crop-handle={corner}
              className="tk-crop-handle tk-crop-corner"
              {...pointerHandlers(corner)}
            >
              <span aria-hidden className="tk-crop-l" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
