
import { useState, useCallback } from 'react';

export const useZoom = (initial = 1, min = 0.5, max = 2.0, step = 0.25) => {
  const [zoom, setZoom] = useState(initial);

  // Steps land on the step grid, so a zoom set by a pinch or a paragraph tap (say 249%) goes to
  // 225% or 275% rather than wandering through 224%, 199%… on its way back to 100%.
  const zoomIn = useCallback(() => setZoom(z => Math.min(max, (Math.floor(z / step + 1e-6) + 1) * step)), [max, step]);
  const zoomOut = useCallback(() => setZoom(z => Math.max(min, (Math.ceil(z / step - 1e-6) - 1) * step)), [min, step]);
  const resetZoom = useCallback(() => setZoom(initial), [initial]);
  const setExactZoom = useCallback((z: number) => setZoom(Math.max(min, Math.min(max, z))), [min, max]);

  return { zoom, zoomIn, zoomOut, resetZoom, setExactZoom };
};
