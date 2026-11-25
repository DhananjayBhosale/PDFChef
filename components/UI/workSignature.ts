import { useEffect, useId, useRef } from 'react';
import { MQ_LG } from '../../hooks/useMediaQuery.ts';

/**
 * What the tool on screen is set to do: a snapshot of every input its next result would be made
 * from (final fix, item 3; fix round 2, item 1). The result strip compares it with the snapshot
 * taken when its result arrived: once any input differs, the result is an earlier one, not the
 * current one, and when every input is back the result is current again.
 *
 * The snapshot is read from the screen itself, so no tool keeps a list of the settings to watch:
 *  - the tool's file (ToolScreen) and its sentence and chip values, as text (`setWorkPart`);
 *  - every field on the tool screen and in its cards (text, number, slider, checkbox, select): a
 *    card is portalled to the body and stays mounted while closed, so its fields are read there;
 *  - every pressed, checked or selected choice and every `role="slider"` value (`aria-pressed`,
 *    `aria-checked`, `aria-selected`, `aria-valuenow`);
 *  - the order and state of the things the result is built from (`data-work-item`: Merge and
 *    Batch rows, page tiles with their turn; `data-page-item`: Reorder's pages).
 * An editor (Edit PDF, Sign, Make Fillable, Image to PDF) shows the selected object's values in
 * its fields, which change when nothing else does, so its fields are not read: it hands over its
 * document model instead (`useWorkInput`). Entries are compared by the control's name, not by
 * their order, so the same settings drawn in another layout (a card or the band) are the same work.
 * Controls that change the view and not the result say
 * so with `data-work-ignore` (zoom, the reader's search).
 */
const parts = new Map<string, string>();
const listeners = new Set<() => void>();

/** The key of the tool's file (ToolScreen's file line). */
export const SOURCE_PART = 'source';

const emit = () => listeners.forEach((listener) => listener());

export const setWorkPart = (key: string, value: string | null) => {
  if (value === null ? !parts.has(key) : parts.get(key) === value) return;
  if (value === null) parts.delete(key);
  else parts.set(key, value);
  emit();
};

export const workPart = (key: string) => parts.get(key) ?? '';

/**
 * An editor's document model as an input: every new value (a new array or object after an edit)
 * is a change. Pass the state the editor saves from.
 */
export const useWorkInput = (value: unknown) => {
  const key = `model:${useId()}`;
  const seen = useRef({ value, revision: 0 });
  if (seen.current.value !== value) seen.current = { value, revision: seen.current.revision + 1 };
  const revision = typeof value === 'string' ? value : String(seen.current.revision);
  useEffect(() => { setWorkPart(key, revision); }, [key, revision]);
  useEffect(() => () => setWorkPart(key, null), [key]);
};

const SKIP = '[data-work-ignore], .chef-result-face, .tk-measure, [role="tab"]';
const NOT_INPUTS = new Set(['file', 'hidden', 'button', 'submit', 'reset', 'image']);
const READ = 'input, select, textarea, [role="slider"], [aria-pressed], [aria-checked], [aria-selected], [data-work-item], [data-page-item]';
const ITEMS = ['data-work-item', 'data-page-item'] as const;
const STATES = ['aria-pressed', 'aria-checked', 'aria-selected', 'aria-valuenow'] as const;
/** The tool's cards: portalled to the body, mounted while closed (Popover). */
const CARDS = '.tk-scrim[data-tk-editor]';
const WIDE = MQ_LG;

/**
 * A control's name, the same wherever the layout draws it (in a card on a phone, in the band at
 * 768 px and wider), so entries are compared by name and not by their place in the document.
 */
const nameOf = (node: HTMLElement) => {
  const labelled = node.getAttribute('aria-labelledby');
  const byIds = labelled
    ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    : '';
  const label = node.getAttribute('data-work-key') || node.getAttribute('aria-label') || byIds
    || ((node as HTMLInputElement).labels?.[0]?.textContent ?? '') || node.getAttribute('name')
    || node.getAttribute('placeholder') || node.textContent || node.id;
  return `${node.tagName}:${label.replace(/\s+/g, ' ').trim()}`;
};

/** What the tool on screen is set to do, by name; see `workSignature`. */
export interface WorkSnapshot {
  /** Whether the wide layout (768 px and up) was drawn when it was taken. */
  wide: boolean;
  entries: Map<string, string>;
}

/**
 * The inputs drawn on a tool screen and in its cards, by name; the items (`data-work-item`,
 * `data-page-item`) in document order, as one entry. Empty for an editor (see above).
 */
export const screenInputs = (screen: Element | null = typeof document === 'undefined' ? null : document.querySelector('.tk-screen')): Map<string, string> => {
  const found = new Map<string, Set<string>>();
  if (!screen) return new Map();
  const tool = screen.querySelector('.tk-tool');
  if (tool?.getAttribute('data-kind') === 'editor') return new Map();
  const add = (key: string, value: string) => {
    const values = found.get(key) ?? new Set<string>();
    values.add(value);
    found.set(key, values);
  };
  const items: string[] = [];
  const roots: Element[] = [screen, ...Array.from(screen.ownerDocument.querySelectorAll(CARDS))];
  roots.forEach((root) => root.querySelectorAll<HTMLElement>(READ).forEach((node) => {
    if (node.closest(SKIP)) return;
    ITEMS.forEach((name) => {
      const value = node.getAttribute(name);
      if (value !== null) items.push(`${name}=${value}`);
    });
    const key = nameOf(node);
    if (node instanceof HTMLInputElement) {
      if (NOT_INPUTS.has(node.type)) return;
      add(key, node.type === 'checkbox' || node.type === 'radio' ? `c${node.checked ? 1 : 0}` : `v${node.value}`);
    } else if (node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) {
      add(key, `v${node.value}`);
    }
    STATES.forEach((name) => {
      const value = node.getAttribute(name);
      if (value !== null) add(`${key}|${name}`, value);
    });
  }));
  // The same control drawn twice in the same state (a value and its card) counts once.
  const entries = new Map([...found].map(([key, values]) => [key, [...values].sort().join('\u0000')]));
  if (items.length) entries.set('items', items.join('\u0000'));
  return entries;
};

/** The whole snapshot: the parts by key, then the screen's inputs by name. */
export const workSignature = (): WorkSnapshot => {
  const entries = new Map<string, string>();
  parts.forEach((value, key) => entries.set(`part:${key}`, value));
  screenInputs().forEach((value, key) => entries.set(key, value));
  const wide = typeof window !== 'undefined' && (window.matchMedia?.(WIDE).matches ?? false);
  return { wide, entries };
};

/**
 * Whether two snapshots describe the same work. Across a layout change (768 px) a control can be
 * drawn in one layout and not the other, and the sentence is a new one, so only the entries both
 * have are compared; in the same layout an entry that came or went is a change too.
 */
export const sameWork = (left: WorkSnapshot, right: WorkSnapshot) => {
  const sameLayout = left.wide === right.wide;
  if (sameLayout && left.entries.size !== right.entries.size) return false;
  for (const [key, value] of left.entries) {
    const other = right.entries.get(key);
    if (other === undefined ? sameLayout : other !== value) return false;
  }
  return true;
};

/**
 * Calls `listener` when the snapshot may have changed: a part changed, a field was edited, or a
 * choice, an item or the list of fields on the page changed. Calls come at most once a frame.
 */
export const subscribeWork = (listener: () => void) => {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => { frame = 0; listener(); });
  };
  listeners.add(schedule);
  const events = ['input', 'change'] as const;
  events.forEach((name) => document.addEventListener(name, schedule, true));
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
  observer?.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'aria-checked', 'aria-selected', 'aria-valuenow', 'data-work-item', 'data-page-item', 'value', 'data-kind'],
  });
  return () => {
    listeners.delete(schedule);
    events.forEach((name) => document.removeEventListener(name, schedule, true));
    observer?.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
  };
};
