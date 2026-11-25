import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Files } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { triggerBrowserDownload } from '../../services/pdfShared';
import type { FreshResult } from '../../services/platform/contracts';
import type { SeparateSaveRequest } from '../../services/pdfShared';
import {
  countZipParts, readZipParts, saveParts, separatePath,
  type SaveOutcome, type SeparatePart, type SeparatePath, type SeparatePlatform,
} from '../../services/saveSeparately';

/**
 * State and buttons for "Save N files separately" on a Split result (plan 2.5).
 * OutputCenter calls the hook for every result; it does nothing unless `enabled`
 * (a Split ZIP) and the ZIP holds more than one PDF. A Split set to "separate PDFs" hands its
 * result over unsaved with `auto`: the parts are then saved at once, except where a tap is needed
 * (the share sheet on iPhone and iPad browsers): there the sheet's button is offered first.
 */

type Phase = 'idle' | 'saving' | 'done' | 'partial' | 'failed';

interface SeparateState {
  phase: Phase;
  current: number;
  total: number;
  saved: number[];
  folder?: string;
}

const IDLE: SeparateState = { phase: 'idle', current: 0, total: 0, saved: [] };

export interface SeparateSave {
  visible: boolean;
  count: number;
  saving: boolean;
  run: () => void;
  label: string;
  status: string;
  tone: 'outcome' | 'error' | null;
  note: string;
  /** Every part is saved. */
  done: boolean;
  /** The parts are waiting for the person's tap (share sheet): the sheet puts the button first. */
  offered: boolean;
}

export const useSeparateSave = ({
  enabled,
  id,
  name,
  platform,
  load,
  guard,
  auto,
}: {
  enabled: boolean;
  /** The result's ID: a new result resets everything. */
  id: string | null;
  name: string;
  platform: SeparatePlatform & { saveFresh?: (result: FreshResult) => Promise<unknown> };
  /** The ZIP: the result's blob, or the copy kept in Recent. */
  load: () => Promise<Blob | null>;
  /** Metered previews: runs the whole set through one access check. Returns false when blocked. */
  guard: (work: () => Promise<void>) => Promise<boolean>;
  /** Save the parts as soon as the result arrives (Split's "separate PDFs"). */
  auto?: SeparateSaveRequest | null;
}): SeparateSave => {
  useI18n();
  const path: SeparatePath | null = enabled ? separatePath(platform) : null;
  // The PDF count, with the result it was read from (a new result is not counted yet).
  const [counted, setCounted] = useState<{ id: string | null; total: number }>({ id: null, total: 0 });
  const count = counted.id === id ? counted.total : 0;
  const [state, setState] = useState<SeparateState>(IDLE);
  // The parts read from the ZIP, with the result and name they belong to (s2-04: a late read for an
  // earlier result never fills a newer one's cache; a renamed result reads its parts again).
  const parts = useRef<{ id: string; name: string; parts: SeparatePart[] } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const nameRef = useRef(name);
  nameRef.current = name;
  // The result on screen now, and the result whose save is running (set before its first await, so
  // a second tap while the ZIP is still being read starts nothing).
  const idRef = useRef(id);
  idRef.current = id;
  const inFlight = useRef<string | null>(null);
  // The folder this result's parts went into: a retry after a partial save writes there again,
  // with no second picker (s2-03).
  const pickedFolder = useRef<{ id: string; handle: FileSystemDirectoryHandle } | null>(null);
  // The result whose parts were already saved automatically: once per result.
  const autoRan = useRef<string | null>(null);

  // The share sheet needs the tap's own user activation, so a Split saved as separate PDFs on the
  // share path reads its parts when the result arrives: the tap then shares them at once (P5).
  const readFirst = path === 'share' && Boolean(auto);
  useEffect(() => {
    setCounted({ id: null, total: 0 });
    setState(IDLE);
    parts.current = null;
    pickedFolder.current = null;
    if (!path || !id) return undefined;
    let alive = true;
    const counting = readFirst
      ? loadRef.current().then(async (zip) => {
        if (!zip) return 0;
        const readName = nameRef.current;
        const read = await readZipParts(zip, readName);
        if (alive) parts.current = { id, name: readName, parts: read };
        return read.length;
      })
      : loadRef.current().then((zip) => (zip ? countZipParts(zip) : 0));
    void counting
      .then((total) => { if (alive) setCounted({ id, total }); })
      .catch(() => { if (alive) setCounted({ id, total: 0 }); });
    return () => { alive = false; };
  }, [path, id, readFirst]);

  const start = useCallback((folder?: FileSystemDirectoryHandle) => {
    if (!path || !id || state.phase === 'saving' || inFlight.current === id) return;
    // Every update below belongs to this result; once another result is on screen they are dropped.
    const owner = id;
    const current = () => idRef.current === owner;
    inFlight.current = owner;
    void (async () => {
      try {
        let all = parts.current?.id === owner && parts.current.name === name ? parts.current.parts : null;
        if (!all) {
          const zip = await loadRef.current();
          if (!zip) throw new Error('The ZIP is not available.');
          const read = await readZipParts(zip, name);
          if (!current()) return;
          parts.current = { id: owner, name, parts: read };
          all = read;
        }
        const set = all;
        const skip = state.phase === 'partial' ? state.saved : [];
        const retryFolder = state.phase === 'partial' && pickedFolder.current?.id === owner ? pickedFolder.current.handle : undefined;
        const left = set.length - skip.length;
        if (path === 'downloads' && left > 10 && !window.confirm(t('output.separate.confirm', { count: left }))) return;
        setState({ phase: 'saving', current: skip.length, total: set.length, saved: skip });
        let outcome: SaveOutcome | null = null;
        const allowed = await guard(async () => {
          outcome = await saveParts(set, path, {
            skip,
            folder: folder ?? retryFolder,
            onFolder: (picked) => { if (current()) pickedFolder.current = { id: owner, handle: picked }; },
            saveFresh: platform.saveFresh,
            saveFreshMany: platform.saveFreshMany,
            download: (blob, fileName) => { triggerBrowserDownload(blob, fileName); },
            onProgress: (done, total) => { if (current()) setState((now) => ({ ...now, current: done, total })); },
          });
        });
        if (!current()) return;
        const result = outcome as SaveOutcome | null;
        if (!allowed || !result || result.cancelled) {
          setState(skip.length ? { phase: 'partial', current: skip.length, total: set.length, saved: skip } : IDLE);
          return;
        }
        const savedCount = result.saved.length;
        setState({
          phase: savedCount === set.length ? 'done' : savedCount === 0 ? 'failed' : 'partial',
          current: savedCount,
          total: set.length,
          saved: result.saved,
          folder: result.folder,
        });
      } catch {
        if (current()) setState((now) => ({ ...now, phase: now.saved.length ? 'partial' : 'failed' }));
      } finally {
        if (inFlight.current === owner) inFlight.current = null;
      }
    })();
  }, [guard, id, name, path, platform, state]);
  const run = useCallback(() => start(), [start]);

  // "Separate PDFs" chosen in Split: save the parts once the ZIP is read, as the ZIP was saved.
  // The share sheet, and a folder picker not already answered, need a tap: those are offered.
  const needsTap = path === 'share' || (path === 'folder' && !auto?.folder);
  const autoFor = auto && id && path && !needsTap && count > 1 && state.phase === 'idle' ? id : null;
  useEffect(() => {
    if (!autoFor || autoRan.current === autoFor) return;
    autoRan.current = autoFor;
    start(auto?.folder);
  }, [auto, autoFor, start]);

  const saving = state.phase === 'saving';
  const total = state.total || count;
  const label = saving
    ? t('output.separate.saving', { current: Math.min(state.current + 1, total), total })
    : t('output.separate.action', { count });
  let status = '';
  let tone: SeparateSave['tone'] = null;
  if (state.phase === 'done') {
    tone = 'outcome';
    const folder = state.folder ?? (path === 'sequential' ? platform.capabilities.exportFolder : undefined);
    status = path === 'downloads'
      ? t('output.separate.sent', { count: total })
      : folder ? t('output.separate.savedIn', { count: total, folder }) : t('output.separate.saved', { count: total });
  } else if (state.phase === 'partial') {
    tone = 'error';
    status = t('output.separate.partial', { saved: state.saved.length, count: total });
  } else if (state.phase === 'failed') {
    tone = 'error';
    status = t('output.separate.failed');
  }
  const note = path === 'downloads' && (state.phase === 'idle' || saving) ? t('output.separate.browserNote') : '';

  return {
    visible: Boolean(path) && count > 1,
    count,
    saving,
    run,
    label,
    status,
    tone,
    note,
    done: state.phase === 'done',
    offered: Boolean(auto) && needsTap && state.phase === 'idle' && count > 1,
  };
};

/** The text button on the strip, or the full-width outlined button in the sheet, with its status line. */
export const SeparateAction: React.FC<{ sep: SeparateSave; variant: 'strip' | 'sheet'; statusFirst?: boolean }> = ({ sep, variant, statusFirst = false }) => {
  if (!sep.visible) return null;
  const line = sep.status || (variant === 'sheet' ? sep.note : '');
  const lineFirst = statusFirst && Boolean(sep.status);
  return (
    <div className="tk-separate-row" data-variant={variant} data-status-first={lineFirst ? '' : undefined}>
      <button
        type="button"
        className="tk-separate chef-pressable"
        aria-busy={sep.saving || undefined}
        aria-disabled={sep.saving || undefined}
        data-separate={variant}
        onClick={() => { if (!sep.saving) sep.run(); }}
      >
        <Files aria-hidden size={16} strokeWidth={1.75} />
        <span>{sep.label}</span>
      </button>
      {line && (
        <p className="tk-separate-status" data-tone={sep.status ? sep.tone ?? undefined : undefined} role={variant === 'sheet' ? 'status' : undefined}>
          {line}
        </p>
      )}
    </div>
  );
};
