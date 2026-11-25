import type JSZip from 'jszip';
import type { FreshResult, WorkspaceCapabilities } from './platform/contracts';

/**
 * "Save N files separately" for a Split result (plan 2.5).
 *
 * Reads the ZIP the result already holds (no second split run), names each part
 * "<zip name without .zip>-<entry name>", and saves through the one path the
 * platform allows:
 *  - native:     a platform with `saveFreshMany` (one folder pick for the whole set).
 *  - sequential: a native app that saves without a picker (Android): saveFresh per file.
 *  - folder:     desktop Chrome / Edge (showDirectoryPicker): one folder pick. Never Android.
 *  - share:      iPhone and iPad browsers: one share sheet with every PDF.
 *  - downloads:  every other browser: one download per file, 350 ms apart.
 * A native app that needs a picker per file (the iOS app today) has no path: the
 * action is hidden there until it implements `saveFreshMany`.
 */

export interface SeparatePart { name: string; blob: Blob }

export type SeparatePath = 'native' | 'sequential' | 'folder' | 'share' | 'downloads';

/** The parts of the platform the choice depends on. */
export interface SeparatePlatform {
  capabilities: WorkspaceCapabilities;
  saveFreshMany?: (results: FreshResult[]) => Promise<unknown>;
}

/** What the browser offers (read from `window` by default; tests pass their own). */
export interface BrowserSaveFeatures {
  directoryPicker: boolean;
  shareFiles: boolean;
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The longest file name the app writes: the limit `toolOutputName` keeps (components/UI/format.ts)
 * and the Android app enforces before a write (s2-08).
 */
const NAME_LIMIT = 180;

/** `stem` + `tail`, the stem cut (never inside a character) so the whole fits the limit. */
const fitName = (stem: string, tail: string) => {
  let kept = '';
  for (const character of stem) {
    if (kept.length + character.length + tail.length > NAME_LIMIT) return `${kept.trimEnd()}${tail}`;
    kept += character;
  }
  return `${kept}${tail}`;
};

/**
 * "report-split.zip" + "part_2.pdf" → "report-split-part_2.pdf". A long ZIP name is shortened, not
 * the part's own name, so every part keeps a different name within the limit.
 */
export const separatePartName = (zipName: string, entryName: string) =>
  fitName(zipName.replace(/\.zip$/i, ''), `-${entryName.split('/').pop() ?? entryName}`);

/** JSZip loads with the first archive it opens, not with the app. */
const loadZip = async (zip: Blob) => (await import('jszip')).default.loadAsync(await zip.arrayBuffer());

const pdfEntries = (archive: JSZip) => Object.values(archive.files)
  .filter((entry) => !entry.dir && /\.pdf$/i.test(entry.name))
  .sort((left, right) => natural.compare(left.name, right.name));

export const readZipParts = async (zip: Blob, zipName: string): Promise<SeparatePart[]> => {
  const archive = await loadZip(zip);
  return Promise.all(pdfEntries(archive).map(async (entry) => ({
    name: separatePartName(zipName, entry.name),
    blob: new Blob([await entry.async('arraybuffer')], { type: 'application/pdf' }),
  })));
};

/** How many PDFs a ZIP holds, without unpacking them. */
export const countZipParts = async (zip: Blob): Promise<number> =>
  pdfEntries(await loadZip(zip)).length;

const isAppleTouch = () => {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
};

/**
 * Chrome on Android has a folder picker, but it opens where Android allows no saving and then asks
 * two permission questions (overnight 2026-11-25). Plain downloads go to Download with at most one
 * "download multiple files" question, so an Android browser never uses the picker (owner, 25 Nov).
 */
export const usesFolderPicker = (userAgent: string, hasPicker: boolean) => hasPicker && !/Android/i.test(userAgent);

export const browserSaveFeatures = (): BrowserSaveFeatures => {
  const directoryPicker = typeof window !== 'undefined'
    && usesFolderPicker(navigator.userAgent, 'showDirectoryPicker' in window);
  let shareFiles = false;
  if (typeof navigator !== 'undefined' && isAppleTouch() && typeof navigator.canShare === 'function') {
    try {
      shareFiles = navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe.pdf', { type: 'application/pdf' })] });
    } catch { /* not shareable */ }
  }
  return { directoryPicker, shareFiles };
};

/** The path this platform uses, or null where the action is hidden. */
export const separatePath = (platform: SeparatePlatform, browser: BrowserSaveFeatures = browserSaveFeatures()): SeparatePath | null => {
  const { capabilities } = platform;
  if (capabilities.multipleFileExport && platform.saveFreshMany) return 'native';
  // A native app keeps durable documents. One that cannot save without a picker would
  // show a picker per file, which is not usable for a set.
  if (capabilities.durableDocuments) return capabilities.automaticExternalExport === false ? null : 'sequential';
  if (browser.directoryPicker) return 'folder';
  if (browser.shareFiles) return 'share';
  return 'downloads';
};

export interface SaveOutcome {
  /** Indices of the parts that are now saved. */
  saved: number[];
  /** The folder the user picked (folder path). */
  folder?: string;
  /** The picker or share sheet was dismissed: nothing changes. */
  cancelled?: boolean;
}

export interface SaveOptions {
  /** Parts already saved by an earlier, partial run. */
  skip?: number[];
  onProgress?: (current: number, total: number) => void;
  saveFresh?: (result: FreshResult) => Promise<unknown>;
  saveFreshMany?: (results: FreshResult[]) => Promise<unknown>;
  /** Starts one browser download. */
  download?: (blob: Blob, name: string) => void;
  /** Gap between browser downloads. */
  pauseMs?: number;
  showDirectoryPicker?: (options?: object) => Promise<FileSystemDirectoryHandle>;
  /** A folder already picked (at the tap that started the split): no picker is shown. */
  folder?: FileSystemDirectoryHandle;
  /** Told the folder the parts are written into, so a retry can use it again with no picker (s2-03). */
  onFolder?: (folder: FileSystemDirectoryHandle) => void;
  share?: (data: ShareData) => Promise<void>;
}

type DirectoryPicker = (options?: object) => Promise<FileSystemDirectoryHandle>;

const windowPicker = (): DirectoryPicker | undefined => (typeof window === 'undefined'
  ? undefined
  : (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker?.bind(window));

/**
 * Asks for the folder the parts go into. The picker needs the user's tap, so a split that saves
 * its parts automatically asks before it starts. Null when the picker is dismissed.
 */
export const pickSeparateFolder = async (picker: DirectoryPicker | undefined = windowPicker()): Promise<FileSystemDirectoryHandle | null> => {
  if (!picker) return null;
  try {
    return await picker({ mode: 'readwrite', id: 'pdf-chef-split' });
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
const errorName = (error: unknown) => (error as { name?: unknown } | null)?.name;

/** "report-split-part_1.pdf", 2 → "report-split-part_1 (2).pdf". */
export const numberedPartName = (name: string, number: number) => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const tail = ` (${number})${dot > 0 ? name.slice(dot) : ''}`;
  // Within the limit the ZIP's part of the name is shortened, never the part's own ("-part_2_…").
  const own = stem.lastIndexOf('-part_');
  return own > 0 ? fitName(stem.slice(0, own), `${stem.slice(own)}${tail}`) : fitName(stem, tail);
};

/**
 * The name a part is written under in a folder: its own name when the folder does not hold it,
 * otherwise the next free numbered name. A file already in the folder is never replaced (s2-01).
 */
const freeNameIn = async (folder: FileSystemDirectoryHandle, name: string) => {
  for (let number = 0; number < 1000; number += 1) {
    const candidate = number === 0 ? name : numberedPartName(name, number);
    try {
      await folder.getFileHandle(candidate);
    } catch (error) {
      if (errorName(error) === 'NotFoundError') return candidate;
      // A folder of that name: not free either.
      if (errorName(error) === 'TypeMismatchError') continue;
      throw error;
    }
  }
  throw new Error(`No free name for ${name}`);
};
const fresh = (part: SeparatePart): FreshResult => ({ blob: part.blob, name: part.name, mimeType: 'application/pdf' });

/**
 * Saves the parts that are not yet saved (`skip`), reporting each one. Never throws
 * for a single file: a failed file is left out of `saved`, so a retry saves only the rest.
 */
export const saveParts = async (parts: SeparatePart[], path: SeparatePath, options: SaveOptions = {}): Promise<SaveOutcome> => {
  const skip = options.skip ?? [];
  const todo = parts.map((part, index) => ({ part, index })).filter(({ index }) => !skip.includes(index));
  const saved = [...skip];
  let done = 0;
  const step = () => options.onProgress?.(skip.length + (++done), parts.length);

  if (path === 'native') {
    if (!options.saveFreshMany) return { saved, cancelled: true };
    try {
      await options.saveFreshMany(todo.map(({ part }) => fresh(part)));
    } catch (error) {
      if (isAbort(error)) return { saved, cancelled: true };
      throw error;
    }
    todo.forEach(({ index }) => { saved.push(index); step(); });
    return { saved };
  }

  if (path === 'folder') {
    const folder = options.folder ?? await pickSeparateFolder(options.showDirectoryPicker ?? windowPicker());
    if (!folder) return { saved, cancelled: true };
    options.onFolder?.(folder);
    // A folder picked now may not be the one the earlier parts went to: the whole set is written
    // there, so the folder the status names holds every part (s2-03). A folder handed in is the
    // same one: only the missing parts are added.
    const fresh = !options.folder && skip.length > 0;
    const list = fresh ? parts.map((part, index) => ({ part, index })) : todo;
    const written = fresh ? [] : saved;
    let count = fresh ? 0 : skip.length;
    for (const { part, index } of list) {
      try {
        const handle = await folder.getFileHandle(await freeNameIn(folder, part.name), { create: true });
        const writable = await handle.createWritable();
        await writable.write(part.blob);
        await writable.close();
        written.push(index);
      } catch { /* left for a retry */ }
      options.onProgress?.(++count, parts.length);
    }
    return { saved: written, folder: folder.name };
  }

  if (path === 'share') {
    const share = options.share ?? ((data: ShareData) => navigator.share(data));
    const files = todo.map(({ part }) => new File([part.blob], part.name, { type: 'application/pdf' }));
    try {
      await share({ files });
    } catch (error) {
      if (isAbort(error)) return { saved, cancelled: true };
      throw error;
    }
    todo.forEach(({ index }) => { saved.push(index); step(); });
    return { saved };
  }

  if (path === 'sequential') {
    for (const { part, index } of todo) {
      try {
        if (!options.saveFresh) throw new Error('No saveFresh');
        await options.saveFresh(fresh(part));
        saved.push(index);
      } catch { /* left for a retry */ }
      step();
    }
    return { saved };
  }

  // downloads: one per file, apart. A blocked download cannot be seen from the page.
  const download = options.download;
  if (!download) return { saved, cancelled: true };
  for (const [position, { part, index }] of todo.entries()) {
    if (position > 0) await pause(options.pauseMs ?? 350);
    download(part.blob, part.name);
    saved.push(index);
    step();
  }
  return { saved };
};
