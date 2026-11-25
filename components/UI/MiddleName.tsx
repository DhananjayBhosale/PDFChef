import React, { useLayoutEffect, useRef, useState } from 'react';
import { fitMiddleName } from './format';

/**
 * How `name` fits `box` on one line in the box's own font, cut in the middle, or null when it
 * fits whole. Measured with a hidden line inside the box, so the font, its optical size and its
 * features are exactly the ones drawn (a canvas measured a name that fits as too wide). The box's
 * width must not depend on the cut text (MiddleName keeps the full name's width in an invisible
 * line, so it never does).
 */
export const middleFit = (box: HTMLElement, name: string): string | null => {
  const room = box.clientWidth;
  if (room <= 0 || typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;inset-inline-start:0;top:0;pointer-events:none';
  box.appendChild(probe);
  try {
    return fitMiddleName(name, room, (text) => {
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    });
  } finally {
    probe.remove();
  }
};

/**
 * A file name on one line, cut in the middle with "…" when it does not fit: the end of the name
 * and its extension stay readable ("compress-quarterly-rep…final.pdf", "Merge P… 16 Nov.pdf").
 * The full name stays the accessible text. `result` marks the result strip's name.
 */
export const MiddleName: React.FC<{ name: string; className?: string; result?: boolean }> = ({ name, className, result = false }) => {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState<string | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    let live = true;
    const fit = () => { if (live) setShown(middleFit(box, name)); };
    fit();
    void document.fonts?.ready.then(fit);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(box);
    return () => { live = false; observer?.disconnect(); };
  }, [name]);
  return (
    <bdi ref={ref} dir="auto" data-result-name={result ? '' : undefined} className={`chef-filename relative block min-w-0 overflow-hidden whitespace-pre${className ? ` ${className}` : ''}`}>
      {shown === null ? name : (
        <>
          {/* Keeps the full name's width, so the room it is measured against stays the same. */}
          <span aria-hidden className="invisible block h-0 overflow-hidden">{name}</span>
          <span aria-hidden className="block">{shown}</span>
          <span className="sr-only">{name}</span>
        </>
      )}
    </bdi>
  );
};
