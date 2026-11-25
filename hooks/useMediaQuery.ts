import { useSyncExternalStore } from 'react';

/**
 * The wide (desktop) layout of a tool screen starts at 768 px, so a tablet in portrait gets it too
 * (owner decision, 2026-11-14); below it a tool screen uses the phone layout. A phone on its side
 * (784 x 360 and the like) is wide but short, so the wide layout also needs 480 px of height:
 * the phone layout keeps the page and the settings on screen there (Android sync, 2026-11-15).
 * Tailwind's `md:` (tailwind.config.cjs) and the CSS media queries use the same rule.
 */
export const MQ_LG = '(min-width: 768px) and (min-height: 480px)';

/** True while `query` matches. Updates on change without an extra render pass. */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );

/** Tablet portrait and wider: tool headers carry Recent and Settings (research r2, mobile-05). */
export const MQ_MD = MQ_LG;

/** The wide layout of a tool screen (768 px and wider: tablets and desktops). */
export const useWide = () => useMediaQuery(MQ_LG);

/** 768 px and wider: phones keep only Tools in a tool's header; tablets and desktops add Recent and Settings. */
export const useHeaderLinks = () => useMediaQuery(MQ_MD);
