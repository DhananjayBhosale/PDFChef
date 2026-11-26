import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * A page-shaped box fitted inside the room the canvas leaves, as large as it can be
 * (Watermark, Page Numbers and the Large preview). The stage takes the height it is
 * given; the page keeps its shape and never overflows either way.
 */
export const FitStage: React.FC<{
  /** The page's shape (any unit; only the ratio matters). */
  width: number;
  height: number;
  children: React.ReactNode;
  className?: string;
  pageClassName?: string;
}> = ({ width, height, children, className, pageClassName }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || width <= 0 || height <= 0) return undefined;
    const measure = () => {
      const style = getComputedStyle(stage);
      const room = {
        width: stage.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
        height: stage.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0),
      };
      // No room (Watermark at 200% text on a 320 px phone: the settings leave the stage 8 px): no
      // page, rather than the last size spilling over the position chip under the stage.
      const scale = Math.max(0, Math.min(room.width / width, room.height / height));
      const next = { width: Math.floor(width * scale), height: Math.floor(height * scale) };
      setBox((current) => (current && current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, [width, height]);

  return (
    <div ref={stageRef} className={`tk-fit-stage${className ? ` ${className}` : ''}`}>
      <div
        className={`tk-fit-page${pageClassName ? ` ${pageClassName}` : ''}`}
        style={box ? { width: box.width, height: box.height } : { visibility: 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
};
