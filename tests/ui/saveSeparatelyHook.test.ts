// The "Save N files separately" hook, run for real in Node with a small hook scheduler (built on
// the S2 review's harness, overnight 2026-11-24). Dependencies, DOM and IO are explicit stubs; no
// browser or React DOM is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { saveParts, separatePartName } from '../../services/saveSeparately.ts';

type Cell = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: (() => void) | undefined };

function hookHarness() {
  const cells: Cell[] = [];
  let cursor = 0;
  let dirty = true;
  let renderBody: () => unknown = () => undefined;
  let result: unknown;
  let effects: Array<() => void> = [];
  const equal = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i])));
  const hooks = {
    useState(initial: unknown) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      return [cells[i].value, (value: unknown) => {
        const next = typeof value === 'function' ? (value as (old: unknown) => unknown)(cells[i].value) : value;
        if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true; }
      }];
    },
    useRef(initial: unknown) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { current: initial };
      return cells[i];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const i = cursor++;
      if (!cells[i] || !equal(cells[i].deps, deps)) cells[i] = { deps, value: fn };
      return cells[i].value;
    },
    useMemo(fn: () => unknown, deps: unknown[]) { return hooks.useCallback(fn(), deps); },
    useEffect(fn: () => (() => void) | void, deps: unknown[]) {
      const i = cursor++;
      const old = cells[i];
      if (!old || !equal(old.deps, deps)) {
        cells[i] = { deps, cleanup: old?.cleanup };
        effects.push(() => { cells[i].cleanup?.(); const cleanup = fn(); cells[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined; });
      }
    },
  };
  const React = {
    ...hooks,
    createElement(type: unknown, props: Record<string, unknown>, ...children: unknown[]) {
      return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
    },
    Fragment: 'Fragment',
  };
  return {
    React,
    run(fn: () => unknown) { renderBody = fn; dirty = true; return this.render(); },
    render() {
      for (let count = 0; dirty && count < 30; count++) {
        dirty = false; cursor = 0; result = renderBody();
        const queued = effects; effects = []; queued.forEach((effect) => effect());
      }
      if (dirty) throw new Error('Hook render did not settle');
      return result;
    },
    async settle() {
      for (let i = 0; i < 8; i++) { await new Promise((resolve) => setImmediate(resolve)); this.render(); }
      return result;
    },
    get value() { return result as SeparateSaveValue; },
    dispose() { for (const cell of cells) if (typeof cell?.cleanup === 'function') cell.cleanup(); },
  };
}

interface SeparateSaveValue { count: number; saving: boolean; done: boolean; status: string; run: () => void; offered: boolean }

function loadSource(file: string, mocks: Record<string, unknown>) {
  const filename = path.resolve(process.cwd(), file);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(output, {
    module, exports: module.exports,
    require(specifier: string) {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      throw new Error(`Unmocked import ${specifier} in ${file}`);
    },
    console, Blob, File, Error, DOMException, Promise, Map, Set, setTimeout, clearTimeout,
    window: { confirm: () => true },
  }, { filename });
  return module.exports;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

type Part = { name: string; blob: Blob };
const partsOf = (id: string): Part[] => [1, 2].map((n) => ({ name: `${id}-${n}.pdf`, blob: new Blob([`${id}${n}`]) }));

type HookExtra = { auto?: object; share?: (data: { files: File[] }) => Promise<void> };

/** Loads the hook with ZIP reads the test controls, saving through the real `saveParts` (sequential path by default). */
function loadHook(readZipParts: (zip: Blob, name: string) => Promise<Part[]>, path = 'sequential', extra: HookExtra = {}) {
  const h = hookHarness();
  const { useSeparateSave } = loadSource('components/UI/SaveSeparately.tsx', {
    react: h.React,
    'lucide-react': { Files: 'Files' },
    '../../services/i18n/core.ts': { t: (key: string, values?: object) => `${key}:${JSON.stringify(values ?? {})}` },
    '../../services/i18n/react': { useI18n() {} },
    '../../services/pdfShared': { triggerBrowserDownload() {} },
    '../../services/saveSeparately': {
      separatePath: () => path,
      countZipParts: async () => 2,
      readZipParts,
      separatePartName,
      saveParts: extra.share
        ? (parts: Part[], to: never, options: object) => saveParts(parts, to, { ...options, share: extra.share as never })
        : saveParts,
    },
  }) as { useSeparateSave: (args: object) => SeparateSaveValue };
  const writes: string[] = [];
  const platform = { capabilities: { durableDocuments: true, exportFolder: 'Downloads' }, saveFresh: async (result: { name: string }) => { writes.push(result.name); } };
  let id = 'A';
  const render = () => h.run(() => useSeparateSave({
    enabled: true, id, name: `${id}.zip`, platform,
    load: async () => new Blob(['zip']),
    guard: async (work: () => Promise<void>) => { await work(); return true; },
    auto: extra.auto ?? null,
  }));
  return { h, writes, render, setId: (next: string) => { id = next; } };
}

// s2-04 (overnight A2): a late save for result A cannot touch result B.
test('a save for an earlier result, still unpacking when a new result arrives, leaves the new result alone', async () => {
  const slowA = deferred<Part[]>();
  const { h, writes, render, setId } = loadHook((_zip, name) => (name === 'A.zip' ? slowA.promise : Promise.resolve(partsOf('B'))));
  render();
  await h.settle();
  assert.equal(h.value.count, 2);
  h.value.run();
  await h.settle();

  setId('B');
  render();
  await h.settle();
  assert.equal(h.value.done, false, 'B starts unsaved');

  slowA.resolve(partsOf('A'));
  await h.settle();
  assert.equal(h.value.done, false, 'A finishing late does not mark B saved');
  assert.equal(h.value.status, '', 'no status line about A on B');
  assert.equal(writes.some((name) => name.startsWith('B-')), false, 'nothing of B was saved without a tap');

  const before = writes.length;
  h.value.run();
  await h.settle();
  assert.deepEqual(writes.slice(before), ['B-1.pdf', 'B-2.pdf'], 'B’s save writes only B’s parts');
  assert.equal(h.value.done, true, 'B is saved after its own save');
  h.dispose();
});

test('a second tap while the parts are still being read does not start a second save', async () => {
  const slow = deferred<Part[]>();
  let reads = 0;
  const { h, writes, render } = loadHook(() => { reads += 1; return slow.promise; });
  render();
  await h.settle();
  h.value.run();
  await h.settle();
  h.value.run();
  await h.settle();
  slow.resolve(partsOf('A'));
  await h.settle();
  assert.equal(reads, 1, 'the ZIP is read once');
  assert.deepEqual(writes, ['A-1.pdf', 'A-2.pdf'], 'each part is saved once');
  assert.equal(h.value.done, true);
  h.dispose();
});

// s2-03 (overnight A5): a retry after a partial folder save writes into the same folder.
test('a retry after a partial folder save asks for no folder and finishes the set in the first one', async () => {
  const folders = new Map<string, Map<string, Blob>>();
  const picks: string[] = [];
  let failOnce = 'A/A-2.pdf';
  const makeFolder = (name: string) => {
    const files = folders.get(name) ?? new Map<string, Blob>();
    folders.set(name, files);
    return {
      name,
      getFileHandle: async (file: string, options?: { create?: boolean }) => {
        if (!files.has(file) && !options?.create) throw new DOMException(file, 'NotFoundError');
        return {
          createWritable: async () => {
            if (failOnce === `${name}/${file}`) { failOnce = ''; throw new Error('write failed'); }
            let pending: Blob | undefined;
            return { write: async (blob: Blob) => { pending = blob; }, close: async () => { files.set(file, pending!); } };
          },
        };
      },
    };
  };
  let next = 'A';
  const globals = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in globals;
  const previous = globals.window;
  globals.window = { showDirectoryPicker: async () => { picks.push(next); return makeFolder(next); } };
  try {
    const { h, render } = loadHook(async () => partsOf('A'), 'folder');
    render();
    await h.settle();
    h.value.run();
    await h.settle();
    assert.deepEqual(picks, ['A']);
    assert.deepEqual([...folders.get('A')!.keys()], ['A-1.pdf'], 'one part failed');
    assert.match(h.value.status, /^output\.separate\.partial/);

    next = 'B';
    h.value.run();
    await h.settle();
    assert.deepEqual(picks, ['A'], 'the retry asks for no second folder');
    assert.deepEqual([...folders.get('A')!.keys()].sort(), ['A-1.pdf', 'A-2.pdf'], 'the first folder holds every part');
    assert.equal(folders.has('B'), false);
    assert.equal(h.value.done, true);
    assert.match(h.value.status, /"folder":"A"/, 'the status names the first folder');
    h.dispose();
  } finally {
    if (hadWindow) globals.window = previous; else delete globals.window;
  }
});

// P5 (overnight A11): the share sheet needs the tap's user activation. A Split saved as separate
// PDFs on the share path reads its parts when the result arrives, so the tap shares at once.
test('on the share path the parts of a separate-PDF result are ready before the tap, which shares them at once', async () => {
  const shared: string[][] = [];
  let reads = 0;
  const { h, render } = loadHook(async () => { reads += 1; return partsOf('A'); }, 'share', {
    auto: {},
    share: async ({ files }) => { shared.push(files.map((file) => file.name)); },
  });
  render();
  await h.settle();
  assert.equal(reads, 1, 'the parts are read when the result arrives');
  assert.equal(h.value.count, 2);
  assert.equal(h.value.offered, true, 'the share button is offered first');
  h.value.run();
  assert.deepEqual(shared, [['A-1.pdf', 'A-2.pdf']], 'the share sheet opened before run() returned');
  await h.settle();
  assert.equal(h.value.done, true);
  assert.equal(reads, 1, 'the ZIP is read once');
  h.dispose();
});

test('on the share path a result not saved as separate PDFs reads no parts until the tap', async () => {
  let reads = 0;
  const shared: string[][] = [];
  const { h, render } = loadHook(async () => { reads += 1; return partsOf('A'); }, 'share', {
    share: async ({ files }) => { shared.push(files.map((file) => file.name)); },
  });
  render();
  await h.settle();
  assert.equal(reads, 0);
  h.value.run();
  await h.settle();
  assert.deepEqual(shared, [['A-1.pdf', 'A-2.pdf']]);
  assert.equal(reads, 1);
  h.dispose();
});

test('a part list read on arrival for an earlier result is not used for the next one', async () => {
  const slowA = deferred<Part[]>();
  const shared: string[][] = [];
  const { h, render, setId } = loadHook((_zip, name) => (name === 'A.zip' ? slowA.promise : Promise.resolve(partsOf('B'))), 'share', {
    auto: {},
    share: async ({ files }) => { shared.push(files.map((file) => file.name)); },
  });
  render();
  await h.settle();
  setId('B');
  render();
  await h.settle();
  slowA.resolve(partsOf('A'));
  await h.settle();
  h.value.run();
  await h.settle();
  assert.deepEqual(shared, [['B-1.pdf', 'B-2.pdf']], 'B shares only its own parts');
  h.dispose();
});

// Simplification step 5 (26 Nov 2026): a Split saved as separate PDFs hands its parts over in memory.
test('parts the split handed over are saved as they are: the ZIP is not read or counted', async () => {
  let reads = 0;
  const handed = [1, 2, 3].map((n) => ({ name: `part_${n}_${n}.pdf`, blob: new Blob([`p${n}`]) }));
  const { h, writes, render } = loadHook(async () => { reads += 1; return partsOf('A'); }, 'sequential', { auto: { parts: handed } });
  render();
  await h.settle();
  assert.equal(h.value.count, 3, 'counted from the handed parts, not the ZIP (the ZIP count stub says 2)');
  assert.equal(h.value.done, true, 'saved at once, as "separate PDFs" does');
  assert.equal(reads, 0, 'the ZIP is never read');
  assert.deepEqual(writes, ['A-part_1_1.pdf', 'A-part_2_2.pdf', 'A-part_3_3.pdf'], 'each part under the result name plus its entry name');
  h.dispose();
});
