import React, { useState, useRef, useCallback } from 'react';

interface Slot {
  id: string; // The ID of the item currently in this slot (at start of drag)
  top: number;
  bottom: number;
  left: number;
  right: number;
  centerX: number;
  centerY: number;
  /** Another item sits beside this one, as in a grid of thumbnails. */
  sharesRow: boolean;
}

interface UseDragReorderOptions<T> {
  items: T[];
  onReorder: (newItems: T[]) => void;
  keyExtractor: (item: T) => string;
  /**
   * The element that actually scrolls the list. Omit it and the page scrolls,
   * which is what Merge and Reorder do. Image to PDF lays its pages out inside
   * a bounded canvas, so the page never moves and its own scroller has to be
   * the one that drives auto-scroll and slot geometry.
   */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  /**
   * Called once when the finger lifts, with the order the drag left behind.
   * `onReorder` fires on every step of a drag; Reorder Pages keeps one undo
   * step per drag, so it records history here instead.
   */
  onDragEnd?: (items: T[]) => void;
}

export function useDragReorder<T>({
  items,
  onReorder,
  keyExtractor,
  scrollContainerRef,
  onDragEnd,
}: UseDragReorderOptions<T>) {
  // State
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overlayStyle, setOverlayStyle] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  /**
   * The pointer, as something the overlay can render from. `pointerRef` alone is
   * a mutation, so the overlay stayed where the drag began; the drag has to be
   * visible under the finger from the first move.
   */
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  // Refs
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  /**
   * The native pointermove listener is installed once, on pointer down, so it
   * keeps the closure from the render that started the drag. Everything that
   * changes during a drag is therefore read from a ref, not from that closure:
   * `setActiveId` had not committed yet when the listener was installed, so the
   * reorder guard saw null and returned on every move of the first drag.
   */
  const draggedIdRef = useRef<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const keyExtractorRef = useRef(keyExtractor);
  keyExtractorRef.current = keyExtractor;
  /** A reorder moved the nodes, so the frozen slots describe the old order. */
  const needsRemeasureRef = useRef(false);
  const slotsRef = useRef<Slot[]>([]);
  /**
   * A grid of tiles (Reorder Pages, Image to PDF): the centre of each place in the grid, in order
   * and in content space, read once when the drag starts. The places do not move while the items
   * trade them, so the drop needs no re-measuring. Null for a one-column list.
   */
  const placesRef = useRef<{ x: number; y: number }[] | null>(null);
  /** From the finger to the centre of the dragged tile as drawn under it. */
  const centreShiftRef = useRef({ x: 0, y: 0 });
  const scrollIntervalRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number, y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const moveHandlerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const upHandlerRef = useRef<((event: PointerEvent) => void) | null>(null);

  const getScroller = useCallback((): HTMLElement | null => scrollContainerRef?.current ?? null, [scrollContainerRef]);

  /**
   * Viewport coordinates converted into the scroller's own content space, so a
   * slot recorded before the scroll still describes the same content after it.
   */
  const toContentSpace = useCallback((clientX: number, clientY: number) => {
    const scroller = getScroller();
    if (!scroller) {
      return { x: clientX + window.scrollX, y: clientY + window.scrollY };
    }
    const bounds = scroller.getBoundingClientRect();
    return {
      x: clientX - bounds.left + scroller.scrollLeft,
      y: clientY - bounds.top + scroller.scrollTop,
    };
  }, [getScroller]);

  // Helper to register refs
  const registerItem = useCallback((id: string, node: HTMLElement | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
  }, []);

  // --- CORE LOGIC ---

  /**
   * In a grid the dragged tile takes the place whose centre is nearest the centre of the tile under
   * the finger (research r1, H2-01): drop it on page 1 and it becomes page 1, wherever on the tile
   * the grip is. The finger alone landed one row off when the grip sat in a tile's corner.
   */
  const nearestPlace = (places: { x: number; y: number }[], x: number, y: number) => {
    let best = 0;
    let bestDistance = Infinity;
    places.forEach((place, index) => {
      const distance = (place.x - x) ** 2 + (place.y - y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    return best;
  };

  const calculateTargetIndex = (docX: number, docY: number): number => {
    const slots = slotsRef.current;
    if (slots.length === 0) return 0;

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];

      if (s.sharesRow) {
        // A grid: above the row, or left of a tile's midpoint, lands before that tile.
        if (docY < s.top) return i;
        if (docY <= s.bottom && docX < s.centerX) return i;
      } else if (docY < s.centerY) {
        // A one-column list: the item passes a row once the finger passes that
        // row's midpoint, the same going up as going down, wherever the grip is.
        return i;
      }
    }

    return slots.length;
  };

  const performReorder = useCallback((clientX: number, clientY: number) => {
    const draggedId = draggedIdRef.current;
    if (!isDraggingRef.current || !draggedId) return;

    const places = placesRef.current;
    const { x: docX, y: docY } = places
      ? toContentSpace(clientX + centreShiftRef.current.x, clientY + centreShiftRef.current.y)
      : toContentSpace(clientX, clientY);

    // The live list, not the one this drag started with: a multi-position drag
    // reorders as it goes, and each further move works from the new order.
    const currentItems = itemsRef.current;
    const key = keyExtractorRef.current;

    const fromIndex = currentItems.findIndex(item => key(item) === draggedId);
    if (fromIndex === -1) return;

    // A grid moves the tile into the place it is over (before that tile going back, after it going
    // forward); a list moves it past each row's middle.
    const targetIndex = places && places.length === currentItems.length
      ? nearestPlace(places, docX, docY)
      : calculateTargetIndex(docX, docY);

    if (targetIndex !== fromIndex && targetIndex <= currentItems.length) {
      const newItems = [...currentItems];
      const [moved] = newItems.splice(fromIndex, 1);
      newItems.splice(targetIndex, 0, moved);
      needsRemeasureRef.current = true;
      // The next move, or the lift, can arrive before React renders this
      // order, so it is the live list from here on.
      itemsRef.current = newItems;
      onReorderRef.current(newItems);
    }
  }, [toContentSpace]);

  /** Re-reads every slot in content space. Cheap enough to run while scrolling. */
  const measureSlots = useCallback((draggedId: string) => {
    const slots: Slot[] = [];
    itemsRef.current.forEach(item => {
      const itemId = keyExtractorRef.current(item);
      if (itemId === draggedId) return; // No slot for the dragged item itself.

      const node = itemRefs.current.get(itemId);
      if (!node) return;
      const r = node.getBoundingClientRect();
      const topLeft = toContentSpace(r.left, r.top);
      const bottomRight = toContentSpace(r.right, r.bottom);
      slots.push({
        id: itemId,
        top: topLeft.y,
        bottom: bottomRight.y,
        left: topLeft.x,
        right: bottomRight.x,
        centerX: topLeft.x + r.width / 2,
        centerY: topLeft.y + r.height / 2,
        sharesRow: false,
      });
    });

    // Sort visually so linear index mapping matches visual flow.
    const sameRow = (a: Slot, b: Slot) => Math.abs(a.top - b.top) <= 10;
    slots.sort((a, b) => {
      if (!sameRow(a, b)) return a.top - b.top;
      return a.left - b.left;
    });
    for (const slot of slots) slot.sharesRow = slots.some(other => other !== slot && sameRow(other, slot));

    slotsRef.current = slots;
    needsRemeasureRef.current = false;
  }, [toContentSpace]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const draggedId = draggedIdRef.current;
    if (!isDraggingRef.current || !draggedId) return;
    pointerRef.current = { x: e.clientX, y: e.clientY };
    setPointer({ x: e.clientX, y: e.clientY });
    // The previous move reordered the list, and the browser has painted it
    // since, so re-read the slots before deciding where this move lands.
    if (needsRemeasureRef.current) measureSlots(draggedId);
    performReorder(e.clientX, e.clientY);
  }, [measureSlots, performReorder]);

  const handlePointerUp = useCallback(() => {
    const wasDragging = isDraggingRef.current;
    isDraggingRef.current = false;
    stopAutoScroll();
    draggedIdRef.current = null;
    needsRemeasureRef.current = false;
    setActiveId(null);
    slotsRef.current = [];
    placesRef.current = null;
    pointerRef.current = null;
    setPointer(null);

    if (moveHandlerRef.current) window.removeEventListener('pointermove', moveHandlerRef.current);
    if (upHandlerRef.current) {
      window.removeEventListener('pointerup', upHandlerRef.current);
      window.removeEventListener('pointercancel', upHandlerRef.current);
    }
    moveHandlerRef.current = null;
    upHandlerRef.current = null;

    if (wasDragging) onDragEndRef.current?.(itemsRef.current);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent | React.MouseEvent, id: string) => {
    // Only left click
    if ('button' in e && e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    const el = itemRefs.current.get(id);
    if (!el) return;

    const rect = el.getBoundingClientRect();

    // Capture Drag Start. The ref is set before the listener is installed, so
    // the very first pointermove already knows what is being dragged.
    isDraggingRef.current = true;
    draggedIdRef.current = id;
    needsRemeasureRef.current = false;
    setActiveId(id);
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setOverlayStyle({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    });
    pointerRef.current = { x: e.clientX, y: e.clientY };
    setPointer({ x: e.clientX, y: e.clientY });

    measureSlots(id);
    centreShiftRef.current = { x: rect.left + rect.width / 2 - e.clientX, y: rect.top + rect.height / 2 - e.clientY };
    // Every item's place, the dragged one included, in the list's own order (so right-to-left needs
    // nothing more). A grid is two places on one row.
    const places = itemsRef.current.map((item) => {
      const node = itemRefs.current.get(keyExtractorRef.current(item));
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { ...toContentSpace(r.left + r.width / 2, r.top + r.height / 2), top: r.top };
    });
    const complete = places.every(Boolean) ? (places as { x: number; y: number; top: number }[]) : [];
    const isGrid = complete.some((place, index) => complete.some((other, j) => j !== index && Math.abs(other.top - place.top) <= 10));
    placesRef.current = isGrid ? complete.map(({ x, y }) => ({ x, y })) : null;

    // Attach Listeners. Held in refs so the exact same function is removed,
    // whichever render produced it.
    moveHandlerRef.current = handlePointerMove;
    upHandlerRef.current = handlePointerUp;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    startAutoScroll(id);
  }, [measureSlots, handlePointerMove, handlePointerUp, toContentSpace]);

  // --- AUTO SCROLL ---

  const startAutoScroll = (draggedId: string) => {
    if (scrollIntervalRef.current) return;

    const scrollLoop = () => {
      if (!pointerRef.current || !isDraggingRef.current) return;

      const { x, y } = pointerRef.current;
      const scroller = getScroller();
      const zone = 100;

      // The edges that matter are the scroller's own edges, not the window's.
      const topEdge = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottomEdge = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;

      let speed = 0;
      if (y < topEdge + zone) speed = -((topEdge + zone) - y) * 0.3;
      else if (y > bottomEdge - zone) speed = (y - (bottomEdge - zone)) * 0.3;

      if (speed !== 0) {
        if (scroller) scroller.scrollBy(0, speed);
        else window.scrollBy(0, speed);
        // Content moved under the pointer, so the frozen slots are stale.
        measureSlots(draggedIdRef.current ?? draggedId);
        performReorder(x, y);
      }

      scrollIntervalRef.current = requestAnimationFrame(scrollLoop);
    };

    scrollIntervalRef.current = requestAnimationFrame(scrollLoop);
  };

  const stopAutoScroll = () => {
    if (scrollIntervalRef.current) cancelAnimationFrame(scrollIntervalRef.current);
    scrollIntervalRef.current = null;
  };

  return {
    activeId,
    dragHandlers: { onPointerDown: handlePointerDown },
    registerItem,
    overlayStyle: {
      ...overlayStyle,
      top: pointer ? pointer.y - dragOffset.y : overlayStyle.top,
      left: pointer ? pointer.x - dragOffset.x : overlayStyle.left,
    }
  };
}
