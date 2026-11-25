import { useCallback, useEffect, useRef, useState } from 'react';
import { getPdfPagePreviews } from '../../services/pdfLazy';
import { revokeObjectUrls } from '../../services/pdfShared';
import type { GridFit } from './gridFit.ts';

/**
 * Sharper thumbnails when the grid draws tiles wider than the preview bitmap (plan 2.4).
 * The first load is the tool's own, at `PREVIEW_SCALES[0]`; when the grid reports a tile
 * that needs more, this draws the pages again at the next scale and hands the new URLs
 * to `apply`. Only the pictures are replaced. Above 24 pages the scale never changes.
 */
export const PREVIEW_SCALES = [0.3, 0.6, 1, 1.5] as const;
const SHARP_PREVIEW_LIMIT = 24;

export const useSharpPreviews = (
  source: File | null,
  previews: readonly string[],
  apply: (urls: string[]) => void,
  ready: boolean,
) => {
  const loadedScaleRef = useRef<number>(PREVIEW_SCALES[0]);
  const [wantedScale, setWantedScale] = useState<number>(PREVIEW_SCALES[0]);
  const [pageWidthPoints, setPageWidthPoints] = useState(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const count = previews.length;

  useEffect(() => {
    loadedScaleRef.current = PREVIEW_SCALES[0];
    setWantedScale(PREVIEW_SCALES[0]);
    setPageWidthPoints(0);
  }, [source]);

  const first = previews[0];
  useEffect(() => {
    if (!first) return undefined;
    let alive = true;
    const image = new Image();
    image.onload = () => { if (alive && image.naturalWidth) setPageWidthPoints(image.naturalWidth / loadedScaleRef.current); };
    image.src = first;
    return () => { alive = false; };
  }, [first]);

  const onGridFit = useCallback((fit: GridFit) => {
    if (count > SHARP_PREVIEW_LIMIT || !pageWidthPoints) return;
    const needed = (fit.tile * (window.devicePixelRatio || 1)) / pageWidthPoints;
    const next = PREVIEW_SCALES.find((scale) => scale >= needed) ?? PREVIEW_SCALES[PREVIEW_SCALES.length - 1];
    setWantedScale((current) => Math.max(current, next));
  }, [pageWidthPoints, count]);

  useEffect(() => {
    if (!source || !ready || !count || wantedScale <= loadedScaleRef.current) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    const scale = wantedScale;
    getPdfPagePreviews(source, { scale, signal: controller.signal })
      .then((urls) => {
        if (cancelled || urls.length !== count) { revokeObjectUrls(urls); return; }
        loadedScaleRef.current = scale;
        applyRef.current(urls);
      })
      .catch(() => { /* the smaller previews stay */ });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `count` and `ready` change when the first load ends; the scale check stops a second run.
  }, [source, ready, count, wantedScale]);

  return onGridFit;
};
