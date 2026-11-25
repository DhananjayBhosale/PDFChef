import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { useWide } from '../../hooks/useMediaQuery';
import { Portal } from '../UI/Primitives';
import { EditorNoticeContext, holdNoticeCopy } from './parts';

/**
 * The editor a slot opens. Desktop: a popover anchored to its opener, the page stays
 * visible. Phone: a card at the foot of the screen, with no dim scrim. Every card closes
 * the same way (owner decision 2026-11-15, item 5): its one close button, Escape, or a tap
 * outside it, which closes the card and goes on to what it landed on. Focus moves in and
 * is trapped while it is open, and returns to the opener. While closed it stays mounted
 * but hidden, so a typed draft inside it survives.
 */

export interface PopState {
  open: boolean;
  openerKey: string | null;
  anchor: DOMRect | null;
  show: (opener: HTMLElement, key?: string) => void;
  hide: () => void;
  toggle: (opener: HTMLElement, key?: string) => void;
  openerRef: React.MutableRefObject<HTMLElement | null>;
}

export const usePop = (): PopState => {
  const [open, setOpen] = useState(false);
  const [openerKey, setOpenerKey] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const show = useCallback((opener: HTMLElement, key = 'main') => {
    openerRef.current = opener;
    setAnchor(opener.getBoundingClientRect());
    setOpenerKey(key);
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback((opener: HTMLElement, key = 'main') => {
    setOpen((current) => {
      if (current && openerRef.current === opener) return false;
      openerRef.current = opener;
      setAnchor(opener.getBoundingClientRect());
      setOpenerKey(key);
      return true;
    });
  }, []);
  return { open, openerKey, anchor, show, hide, toggle, openerRef };
};

/** Props for any element that opens an editor. */
export const openerProps = (pop: PopState, id: string, key = 'main') => ({
  type: 'button' as const,
  'aria-haspopup': 'dialog' as const,
  'aria-expanded': pop.open && pop.openerKey === key,
  'aria-controls': id,
  onClick: (event: React.MouseEvent<HTMLElement>) => pop.toggle(event.currentTarget, key),
});

/**
 * Closes the editor a control sits in (focus goes back to its slot). A field that
 * applies a valid value with Enter or Select calls it, so the result and the main
 * action are in view again. Null outside an editor.
 */
const PopCloseContext = createContext<(() => void) | null>(null);
export const useCloseEditor = () => useContext(PopCloseContext);
/** The open card's visible title, so a field whose label says the same thing can drop it (pass 3). */
const PopTitleContext = createContext<string | null>(null);
export const useEditorTitle = () => useContext(PopTitleContext);
/** A field's label that only assistive technology reads when the card's title already says it. */
export const FieldLabel: React.FC<{ children: string }> = ({ children }) => (
  <span className={useEditorTitle() === children ? 'sr-only' : undefined}>{children}</span>
);

/**
 * A button that applies what its editor holds (Delete's Mark): when `apply` accepts the value, the
 * editor closes, as Enter does, so the marked pages and the main action are in view (judge B, F2).
 */
export const ApplyButton: React.FC<{ apply: () => boolean; className?: string; children: React.ReactNode }> = ({ apply, className, children }) => {
  const close = useCloseEditor();
  return <button type="button" onClick={() => { if (apply() && close) close(); }} className={className}>{children}</button>;
};

/**
 * Wraps an editor's field: Enter in a text or number field closes the editor when the
 * value is valid (M-02). Outside an editor it does nothing.
 */
export const EnterCloses: React.FC<{ valid?: boolean; children: React.ReactNode }> = ({ valid = true, children }) => {
  const close = useCloseEditor();
  return (
    <div
      className="tk-enter-closes"
      // An invalid value keeps the editor open: the editor's own Enter rule (Pop) skips it too.
      data-enter-invalid={valid ? undefined : ''}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !close || !valid || event.nativeEvent.isComposing) return;
        if (!(event.target instanceof HTMLInputElement)) return;
        event.preventDefault();
        close();
      }}
    >
      {children}
    </div>
  );
};

/** The bottom of what can be seen: above an on-screen keyboard that overlays the page. */
const visibleBottom = () => {
  const viewport = window.visualViewport;
  return viewport && Math.abs(viewport.scale - 1) <= 0.05 ? viewport.offsetTop + viewport.height : window.innerHeight;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** What an editor focuses when it opens: its first control. */
const FIRST_CONTROL = 'input:not([disabled]):not([type="color"]), [role="radio"][tabindex="0"], [role="slider"], select, button:not([disabled])';
const TYPING = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea';
const SLIDER = '[role="slider"]:not([aria-disabled="true"])';
/** A − / + stepper button: another way to set the number the box holds. */
const STEP = '.tk-step:not([disabled])';
/** One option of a choice: a radio, a pressed-or-not button, or a slider's tap choice. */
const CHOICE = '[role="radio"], input[type="radio"], button[aria-pressed], [data-tk-preset]';
/** The share of the screen a live preview keeps while a card is open on a phone (item 4). */
export const PREVIEW_SHARE = 0.4;
/**
 * A card whose controls need more room (fine position sliders, Crop's four edges, a custom format)
 * may grow past that line until the preview keeps this share; beyond it the card's body scrolls
 * under its fixed head (polish 2026-11-15, item 2). A card that fits stays content-sized, so
 * most cards still leave the preview 40% or more.
 */
export const PREVIEW_FLOOR = 0.3;
/**
 * Page Numbers' Position card (pass 5, item 10): its six places and two sliders
 * show whole, without scrolling inside the card, on a 360×800 phone. It stays content-sized, so the
 * preview keeps all the rest; this is only how far it may grow.
 */
export const PREVIEW_FLOOR_TALL = 0.2;
/** The smallest height a card keeps, so its controls stay usable at very large text. */
const CARD_FLOOR = 136;

/**
 * Whether a tap on `option` settles the editor (path to 9, item 1): a slider's tap choice does
 * when it is the editor's only group of tap choices; a radio or pressed button does when its group
 * is the editor's only control, so a choice slot closes after one pick. Arrow keys inside a radio
 * group change the value without a click, so a keyboard user can still move through the options.
 * A card that holds two settings, each with its own tap choices (Watermark's "Opacity · Rotation"),
 * stays open after a pick until Close, Escape or a tap outside (overnight 2026-11-24, C1).
 */
export const pickCloses = (body: HTMLElement, option: Element): boolean => {
  const tapGroups = Array.from(body.querySelectorAll('.tk-taps')).filter((group) => !group.closest('[hidden]'));
  if (option.matches('[data-tk-preset]') && tapGroups.length > 1) return false;
  if (option.matches('[data-tk-preset]')) return true;
  const group = option.closest('[role="radiogroup"], [role="group"], fieldset');
  if (!group || !body.contains(group)) return false;
  const controls = Array.from(body.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => !item.closest('[hidden]'));
  return controls.length > 0 && controls.every((item) => group.contains(item));
};


export const Pop: React.FC<{
  pop: PopState;
  id: string;
  title: string;
  /** Show the title as a visible heading (default) or for assistive technology only. */
  showTitle?: boolean;
  width?: number;
  className?: string;
  /** Phone, live-preview tools: the page shrinks into the room above the open card. */
  quiet?: boolean;
  /** The tool's notice line, repeated under the controls while the editor covers it. */
  notice?: React.ReactNode;
  /** The share of the screen the live preview keeps at least (`PREVIEW_FLOOR` unless a card needs more room). */
  previewFloor?: number;
  children: React.ReactNode;
}> = ({ pop, id, title, showTitle = true, width = 320, className, quiet: quietProp = false, notice, previewFloor = PREVIEW_FLOOR, children }) => {
  useI18n();
  const wide = useWide();
  const { open, hide, anchor, openerRef } = pop;
  // Phone: a sentence drawn in the band above the page (a live-preview tool) has the editor open
  // at the foot, below it; the page shrinks into the room above the card (`quiet`).
  const inTopBand = open && !wide && Boolean(openerRef.current?.closest('.tk-band-top'));
  const quiet = quietProp || inTopBand;
  // Phone, live-preview tool: the card never takes the preview below 40% of the screen (owner
  // decision 2026-11-15, item 4). Its height is capped; what does not fit scrolls inside it.
  const [cardCap, setCardCap] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // When the last pointer press inside the card happened (a native radio's pick, item 1).
  const pointerAt = useRef(0);
  // Text being composed by an input method: its Enter belongs to the composition, not the card.
  const composing = useRef(false);
  const titleId = useId();
  const [style, setStyle] = useState<React.CSSProperties>({});
  // Phone: the editor ends above the tool's main action, which stays in view and tappable
  // (owner decision 1: an editor never covers the main action).
  const [actionInset, setActionInset] = useState<number | null>(null);

  // While this editor shows its copy of the tool's notice line, the copy is the live one and
  // the line behind it goes quiet (verify V-06). Held before paint, so no frame has two alerts.
  const showsNotice = open && Boolean(notice);
  useLayoutEffect(() => (showsNotice ? holdNoticeCopy() : undefined), [showsNotice]);

  useLayoutEffect(() => {
    if (!open || wide) {
      setActionInset(null);
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const tool = openerRef.current?.closest('.tk-tool') as HTMLElement | null | undefined;
      const rows = tool ? Array.from(tool.querySelectorAll<HTMLElement>(':scope > .tk-sheet > .tk-actions, :scope > .tk-sheet > .tk-progress-block, :scope > .tk-footbar > .tk-actions, :scope > .tk-footbar > .tk-progress-block')) : [];
      const actionRow = rows.find((item) => item.getClientRects().length > 0);
      // A sentence in the foot sheet sits above the main action: the editor then ends above the
      // sentence, so the next slot stays in view and tappable as well as the main action.
      const sentence = openerRef.current?.closest('.tk-sheet > .tk-sentence-group') as HTMLElement | null | undefined;
      const row = sentence && sentence.getClientRects().length > 0 ? sentence : actionRow;
      const top = row?.getBoundingClientRect().top ?? window.innerHeight;
      // An on-screen keyboard that overlays the page (iOS Safari) shrinks only the visual
      // viewport: the editor then ends above the keyboard, so the field being typed in shows.
      const keyboard = Math.max(0, window.innerHeight - visibleBottom());
      const inset = Math.round(Math.max(window.innerHeight - top + 4, keyboard ? keyboard + 8 : 0));
      // Only when it leaves the editor a usable height; otherwise the card covers the foot as before.
      setActionInset(row && top < window.innerHeight && window.innerHeight - inset > 220 ? inset : null);
      const field = document.activeElement;
      if (keyboard && field instanceof HTMLElement && panel.current?.contains(field)) field.scrollIntoView({ block: 'nearest' });
    };
    // After the shell has measured the keyboard (its own frame), so the foot rows have moved.
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open, wide, openerRef]);

  // Phone, live-preview tool (a quiet editor): the page shrinks into the room above the open
  // editor, so the stamp, number or frame being changed stays in view. On a 375×667 phone the
  // editor covered all but the top of the page (round 6, mobile-03). Make Fillable's stage too:
  // its New field card covered the page's lower part, where a drag drew nothing (h1-03).
  useLayoutEffect(() => {
    const node = panel.current;
    const tool = openerRef.current?.closest('.tk-tool') as HTMLElement | null | undefined;
    const frame = tool?.querySelector<HTMLElement>('.tk-pframe, .tk-fill-stage');
    if (!open || wide || !quiet || !node || !tool || !frame) {
      setCardCap(null);
      return undefined;
    }
    const measure = () => {
      const room = frame.getBoundingClientRect();
      // The live preview (`.tk-pframe`) keeps at least 30% of the screen above the card (40% or
      // more for every card whose controls fit there): the card's top may not rise above the
      // frame's top plus that share.
      if (frame.classList.contains('tk-pframe')) {
        const bottom = node.getBoundingClientRect().bottom;
        // With the on-screen keyboard up, the field being typed in matters more than the page:
        // the card may cover the page and the rows above it, up to the top of the tool (Android
        // sync, 2026-11-15: at 200% text the From and To boxes had 36 px to scroll in).
        const typing = document.documentElement.hasAttribute('data-chef-keyboard');
        const top = typing ? Math.max(0, tool.getBoundingClientRect().top) : room.top + window.innerHeight * previewFloor;
        const cap = Math.max(CARD_FLOOR, Math.floor(bottom - top - 8));
        setCardCap((current) => (current === cap ? current : cap));
      }
      // Never below a small page: with the keyboard up, the editor can reach the band.
      const cover = Math.max(0, Math.min(room.height - 120, Math.round(room.bottom - node.getBoundingClientRect().top + 8)));
      tool.style.setProperty('--tk-editor-cover', `${cover}px`);
      tool.dataset.editorCover = '';
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    const keyboard = new MutationObserver(measure);
    keyboard.observe(document.documentElement, { attributes: true, attributeFilter: ['data-chef-keyboard'] });
    return () => {
      observer?.disconnect();
      keyboard.disconnect();
      tool.style.removeProperty('--tk-editor-cover');
      delete tool.dataset.editorCover;
    };
  }, [open, wide, quiet, actionInset, openerRef, previewFloor]);

  // Desktop and tablet: the anchored editor is placed again when an on-screen keyboard comes or goes.
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !wide || !viewport) return undefined;
    const bump = () => setViewportTick((tick) => tick + 1);
    viewport.addEventListener('resize', bump);
    return () => viewport.removeEventListener('resize', bump);
  }, [open, wide]);

  // Every card is a light layer (owner decision 2026-11-15, item 5: one way to close every card):
  // the page stays undimmed, and a tap outside the card closes it and goes on to what it landed on
  // (the next slot, a page, the main action), on a phone as on desktop (round 4, h1-02, h1-03).
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panel.current?.contains(target) || openerRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-tk-editor]')) return;
      hide();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, hide, openerRef]);

  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    if (!wide || !anchor) {
      setStyle({});
      return;
    }
    const rect = panel.current.getBoundingClientRect();
    const margin = 12;
    const rtl = document.documentElement.dir === 'rtl';
    const panelWidth = Math.min(width, window.innerWidth - margin * 2);
    let left = rtl ? anchor.left : anchor.right - panelWidth;
    if (anchor.width >= panelWidth * 0.8) left = anchor.left;
    left = Math.min(Math.max(left, margin), window.innerWidth - panelWidth - margin);
    const bottom = visibleBottom();
    const below = bottom - anchor.bottom - margin >= Math.min(rect.height, 360) || anchor.top < rect.height;
    setStyle({
      position: 'fixed',
      width: panelWidth,
      left,
      ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
      // Never under an on-screen keyboard: the editor scrolls inside instead.
      ...(below ? { maxHeight: Math.max(160, bottom - anchor.bottom - 6 - margin) } : {}),
      transformOrigin: `${Math.round(anchor.left + anchor.width / 2 - left)}px ${below ? '0%' : '100%'}`,
    });
  }, [open, anchor, wide, width, viewportTick]);

  useEffect(() => {
    if (!open) return undefined;
    const node = panel.current;
    const opener = openerRef.current;
    const body = node?.querySelector<HTMLElement>('.tk-pop-body');
    let target = body?.querySelector<HTMLElement>(FIRST_CONTROL) ?? node?.querySelector<HTMLElement>('button');
    // On a touch screen a focused box raises the keyboard. When the editor also has a slider
    // or − / + buttons for the same value, one of those takes the focus instead, so the keyboard
    // comes up only when the person taps the box (round 5, mobile-02; round 6, mobile-06: Crop's
    // edges, Header & Footer's font size). A box that is the only way to set its value keeps the
    // focus. Focus stays inside the editor for keyboard and screen-reader users.
    if (target?.matches(TYPING) && window.matchMedia?.('(pointer: coarse)').matches) {
      target = body?.querySelector<HTMLElement>(SLIDER) ?? body?.querySelector<HTMLElement>(STEP) ?? target;
    }
    // An editor that opens on tap choices (Page Numbers' format and position) starts on the one
    // already chosen, so it is read out first; no keyboard comes up (path to 9, part 2).
    if (target?.matches('[data-tk-preset]')) {
      target = target.parentElement?.querySelector<HTMLElement>('[data-tk-preset][aria-pressed="true"]') ?? target;
    }
    target?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        hide();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const items = Array.from<HTMLElement>(node.querySelectorAll(FOCUSABLE)).filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, hide, openerRef]);

  return (
    <Portal>
      <div
        className="tk-scrim"
        data-wide={wide ? '' : undefined}
        data-quiet={quiet ? '' : undefined}
        data-tk-editor=""
        data-above-action={actionInset !== null ? '' : undefined}
        data-pass=""
        style={actionInset !== null ? { bottom: actionInset } : undefined}
        hidden={!open}
      >
        <div
          ref={panel}
          id={id}
          onPointerDown={() => { pointerAt.current = Date.now(); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          // A pick that settles the editor closes it, after the option's own handler has run.
          onClick={(event) => {
            const body = panel.current?.querySelector<HTMLElement>('.tk-pop-body');
            const option = (event.target as Element).closest?.(CHOICE);
            if (!open || !body || !option || !body.contains(option) || (option as HTMLButtonElement).disabled) return;
            // A native radio also clicks when an arrow key moves through its group: only a pointer
            // pick settles the editor, so a keyboard user can still move through the options.
            if (option.matches('input[type="radio"]') && Date.now() - pointerAt.current > 1000) return;
            if (pickCloses(body, option)) hide();
          }}
          // Enter in a field applies its value and closes the editor, unless the value is invalid
          // (the field says so) or the field already handled the key (a slider's box, EnterCloses).
          onKeyDown={(event) => {
            const field = event.target;
            if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing || composing.current) return;
            if (!(field instanceof HTMLInputElement) || !field.matches(TYPING)) return;
            // A field in its own form (the page range) submits it: the form applies the value and
            // closes the card, or keeps it open with the error, and waits out an input method.
            if (field.form) return;
            if (field.getAttribute('aria-invalid') === 'true' || field.closest('[data-enter-invalid]')) return;
            event.preventDefault();
            hide();
          }}
          role={open ? 'dialog' : undefined}
          aria-modal={open ? 'true' : undefined}
          // A closed editor has no role, and a plain region cannot carry a name (ARIA forbids it,
          // and a test looking a field up by its label would find the region as well).
          aria-labelledby={open ? titleId : undefined}
          className={`tk-pop${className ? ` ${className}` : ''}`}
          style={cardCap !== null ? { ...style, maxHeight: cardCap } : style}
        >
          <div className="tk-pop-head" data-hidden-title={showTitle ? undefined : ''}>
            <h2 id={titleId} className={showTitle ? undefined : 'sr-only'}>{title}</h2>
            {/* The one close control, the same on every card (item 5). */}
            <button type="button" onClick={hide} aria-label={t('primitives.close.7d9eb7')} className="tk-pop-close chef-pressable">
              <X aria-hidden size={16} strokeWidth={1.75} />
            </button>
          </div>
          <PopCloseContext.Provider value={hide}>
            <PopTitleContext.Provider value={showTitle ? title : null}>
              <div className="tk-pop-body">{children}</div>
            </PopTitleContext.Provider>
          </PopCloseContext.Provider>
          {open && notice && (
            <EditorNoticeContext.Provider value>
              <div className="tk-pop-notice">{notice}</div>
            </EditorNoticeContext.Provider>
          )}
        </div>
      </div>
    </Portal>
  );
};
