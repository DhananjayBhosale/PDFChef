import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { useDragReorder } from '../../hooks/useDragReorder.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const between = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from > -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};

interface Page { id: string }
type PointerListener = (event: { clientX: number; clientY: number }) => void;

/**
 * A phone-sized page with no DOM: 40 rows of 60px plus an 8px gap, a window
 * that scrolls and frames that run when the test says so. Rows are placed by
 * the current order, as React would place them after each reorder.
 */
const phone = (count: number) => {
  const listeners = new Map<string, Set<PointerListener>>();
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  let scrollY = 0;
  const maxScroll = 100 + count * 68 - 784;
  const fakeWindow = {
    get scrollX() { return 0; },
    get scrollY() { return scrollY; },
    innerHeight: 784,
    scrollBy: (_x: number, y: number) => { scrollY = Math.min(maxScroll, Math.max(0, scrollY + y)); },
    addEventListener: (type: string, listener: PointerListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: PointerListener) => { listeners.get(type)?.delete(listener); },
  };
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window = fakeWindow;
  scope.requestAnimationFrame = (callback: () => void) => { frames.set(nextFrame, callback); return nextFrame++; };
  scope.cancelAnimationFrame = (id: number) => { frames.delete(id); };

  let pages: Page[] = Array.from({ length: count }, (_, index) => ({ id: `page-${index}` }));
  const node = (id: string) => ({
    getBoundingClientRect: () => {
      const top = 100 + pages.findIndex((page) => page.id === id) * 68 - scrollY;
      return { top, bottom: top + 60, left: 16, right: 344, width: 328, height: 60 };
    },
  });

  return {
    get pages() { return pages; },
    set pages(next: Page[]) { pages = next; },
    get scrollY() { return scrollY; },
    set scrollY(next: number) { scrollY = next; },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    dispatch: (type: string, clientX: number, clientY: number) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ clientX, clientY });
    },
    runFrames: (times: number) => {
      for (let i = 0; i < times; i += 1) {
        const due = [...frames.entries()];
        frames.clear();
        for (const [, callback] of due) callback();
      }
    },
    node,
  };
};

/** Runs the hook once, the way a component would, and hands back what it returned. */
const mountHook = (options: Parameters<typeof useDragReorder<Page>>[0]) => {
  let api: ReturnType<typeof useDragReorder<Page>> | undefined;
  const Harness = () => {
    api = useDragReorder<Page>(options);
    return null;
  };
  ReactDOMServer.renderToString(React.createElement(Harness));
  assert.ok(api);
  return api;
};

const pointerDown = (clientX: number, clientY: number) => ({
  button: 0,
  clientX,
  clientY,
  preventDefault: () => {},
  stopPropagation: () => {},
}) as unknown as React.PointerEvent;

test('a drag held at the top edge scrolls the list and carries page 12 to the top in one drag (ORG-22)', () => {
  const screen = phone(40);
  const reorders: Page[][] = [];
  const ends: Page[][] = [];
  const api = mountHook({
    items: screen.pages,
    onReorder: (next) => { screen.pages = next; reorders.push(next); },
    keyExtractor: (page) => page.id,
    onDragEnd: (final) => ends.push(final),
  });
  for (const page of screen.pages) api.registerItem(page.id, screen.node(page.id) as unknown as HTMLElement);

  // Page 12 is on screen and page 1 is far above it.
  screen.scrollY = 600;
  const row = screen.node('page-11').getBoundingClientRect();
  assert.ok(row.top > 0 && row.bottom < 784);
  api.dragHandlers.onPointerDown(pointerDown(30, row.top + 30), 'page-11');

  // The finger moves to the top edge and stays there.
  screen.dispatch('pointermove', 30, 20);
  screen.runFrames(120);

  assert.equal(screen.scrollY, 0, 'the list scrolled up under the held finger');
  assert.equal(screen.pages[0].id, 'page-11');
  assert.ok(reorders.length > 1);
  assert.equal(ends.length, 0, 'the drag is not over until the finger lifts');

  screen.dispatch('pointerup', 30, 20);
  assert.equal(ends.length, 1, 'one drag ends once');
  assert.deepEqual(ends[0].map((page) => page.id), screen.pages.map((page) => page.id));
  assert.equal(ends[0][0].id, 'page-11');
  assert.equal(screen.listenerCount(), 0);

  // After the lift, a held edge no longer scrolls anything.
  screen.scrollY = 300;
  screen.runFrames(10);
  assert.equal(screen.scrollY, 300);
});

test('a drag held at the bottom edge scrolls down and ends with the order it left behind', () => {
  const screen = phone(40);
  const ends: Page[][] = [];
  const api = mountHook({
    items: screen.pages,
    onReorder: (next) => { screen.pages = next; },
    keyExtractor: (page) => page.id,
    onDragEnd: (final) => ends.push(final),
  });
  for (const page of screen.pages) api.registerItem(page.id, screen.node(page.id) as unknown as HTMLElement);

  const row = screen.node('page-1').getBoundingClientRect();
  api.dragHandlers.onPointerDown(pointerDown(30, row.top + 30), 'page-1');
  screen.dispatch('pointermove', 30, 770);
  screen.runFrames(200);
  assert.ok(screen.scrollY > 1000, 'the list scrolled down under the held finger');
  assert.ok(screen.pages.findIndex((page) => page.id === 'page-1') > 20);

  screen.dispatch('pointerup', 30, 770);
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].map((page) => page.id), screen.pages.map((page) => page.id));
});

test('in a one-column list a page moves once the finger passes the next row\'s middle, up or down alike', () => {
  // Rows are 60px tall with an 8px gap: page-1's middle is at 198, page-3's at 334.
  const drag = (toY: number) => {
    const screen = phone(6);
    const api = mountHook({
      items: screen.pages,
      onReorder: (next) => { screen.pages = next; },
      keyExtractor: (page) => page.id,
    });
    for (const page of screen.pages) api.registerItem(page.id, screen.node(page.id) as unknown as HTMLElement);
    // The grip is at the left edge of page-2, as in Reorder Pages.
    api.dragHandlers.onPointerDown(pointerDown(30, 266), 'page-2');
    screen.dispatch('pointermove', 30, toY);
    screen.dispatch('pointerup', 30, toY);
    return screen.pages.findIndex((page) => page.id === 'page-2');
  };
  assert.equal(drag(333), 2, 'not yet past page-3\'s middle');
  assert.equal(drag(335), 3, 'past page-3\'s middle, so it moves down one');
  assert.equal(drag(199), 2, 'not yet past page-1\'s middle');
  assert.equal(drag(197), 1, 'past page-1\'s middle, so it moves up one');
});

test('a drag that leaves nothing changed still ends once, and Merge needs no end callback', () => {
  const screen = phone(5);
  const ends: Page[][] = [];
  const api = mountHook({
    items: screen.pages,
    onReorder: (next) => { screen.pages = next; },
    keyExtractor: (page) => page.id,
    onDragEnd: (final) => ends.push(final),
  });
  for (const page of screen.pages) api.registerItem(page.id, screen.node(page.id) as unknown as HTMLElement);
  const before = screen.pages;
  api.dragHandlers.onPointerDown(pointerDown(30, 230), 'page-1');
  screen.dispatch('pointerup', 30, 230);
  assert.equal(ends.length, 1);
  assert.equal(ends[0], before);
  // A second lift with no drag in progress is not a second drag end.
  screen.dispatch('pointerup', 30, 230);
  assert.equal(ends.length, 1);

  const merge = phone(5);
  const mergeApi = mountHook({
    items: merge.pages,
    onReorder: (next) => { merge.pages = next; },
    keyExtractor: (page) => page.id,
  });
  for (const page of merge.pages) mergeApi.registerItem(page.id, merge.node(page.id) as unknown as HTMLElement);
  mergeApi.dragHandlers.onPointerDown(pointerDown(300, 130), 'page-0');
  merge.dispatch('pointermove', 300, 240);
  assert.notEqual(merge.pages[0].id, 'page-0');
  assert.doesNotThrow(() => merge.dispatch('pointerup', 300, 240));
  assert.equal(merge.listenerCount(), 0);
});

test('Reorder Pages drags with the shared hook and records one undo step per drag', () => {
  const source = read('components/Tools/ReorderPDF.tsx');
  const hook = between(source, 'useDragReorder<PageItem>({', '});');
  assert.match(hook, /onReorder: setItems/);
  assert.match(hook, /onDragEnd: commitToHistory/);
  assert.match(source, /ref=\{\(element\) => registerItem\(item\.id, element\)\}/);
  assert.match(source, /onPointerDown=\{\(e\) => dragHandlers\.onPointerDown\(e, item\.id\)\}/);
  assert.match(source, /top: overlayStyle\.top/);
  // The hand-rolled drag that never scrolled is gone.
  assert.doesNotMatch(source, /requestAnimationFrame|data-pageid|addEventListener\('pointermove'/);
  // The buttons still move a page one place without dragging.
  assert.match(source, /onClick=\{\(\) => moveItem\(i, i - 1\)\}/);
  assert.match(source, /onClick=\{\(\) => moveItem\(i, i \+ 1\)\}/);
});
