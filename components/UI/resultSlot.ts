import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Where the result-ready strip (OutputCenter) is drawn.
 *
 * By default the strip floats at the foot of the screen. A tool screen that has a
 * place for it (the foot sheet or foot bar on a phone, under the main action on
 * desktop) registers an element here and the strip is portalled into it instead,
 * with the same controls and the same names. The most recently registered element
 * wins, so a nested layout can take over from its parent.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let stack: HTMLElement[] = [];

const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const currentSlot = () => stack[stack.length - 1] ?? null;

/** The element the strip should render into, or null for the floating default. */
export const useResultSlotTarget = (): HTMLElement | null =>
  useSyncExternalStore(subscribe, currentSlot, () => null);

/**
 * A ref callback that registers its element as the result slot while it is
 * mounted. Pass `enabled = false` to leave the strip where it is.
 */
export const useResultSlotRef = (enabled = true) => {
  const element = useRef<HTMLElement | null>(null);
  // The element the ref was last given, registered or not.
  const latest = useRef<HTMLElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const release = () => {
    if (!element.current) return;
    const before = currentSlot();
    stack = stack.filter((item) => item !== element.current);
    element.current = null;
    if (before !== currentSlot()) emit();
  };
  const register = (node: HTMLElement) => {
    element.current = node;
    stack = [...stack, node];
    emit();
  };
  useEffect(() => {
    // React's StrictMode (development) unmounts and mounts a new component once more without
    // setting its ref again: the element is registered again here, or an editor's slot (Image to
    // PDF's foot bar) stayed empty and the strip floated over its Save button (pass 5, item 1).
    if (latest.current && !element.current && enabledRef.current) register(latest.current);
    return release;
  }, []);
  return useCallback((node: HTMLElement | null) => {
    latest.current = node;
    if (node === element.current) return;
    release();
    if (!node || !enabled) return;
    register(node);
  }, [enabled]);
};
