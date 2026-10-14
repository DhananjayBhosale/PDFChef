import { localizeError } from '../../services/i18n/errors.ts';
import english from '../../services/i18n/en-US.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpDown,
  CalendarDays,
  Check,
  Clock,
  Download,
  ExternalLink,
  FileText,
  FileWarning,
  FileX2,
  Folder,
  MoreVertical,
  Pencil,
  Search,
  Share2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { TabHeader } from '../Layout/AppShell';
import {
  Button,
  ConfirmSheet,
  EmptyState,
  Sheet,
  SkeletonRow,
  StatusLine,
  cx,
} from '../UI/Primitives';
import { formatBytes, formatTimestamp, formatTimestampLong, renameKeepingExtension, splitFilename } from '../UI/format';
import {
  knownSpaceSaved,
  recordAbilities,
  useHaptics,
  useRecentRecords,
  useWorkspacePlatform,
  type RecentRecord,
  type RecordAbilities,
  type RecordLimitation,
  type UndoReceipt,
} from '../../hooks/useWorkspaceRuntime';
import { tools } from '../Tools/toolCatalog';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';

/** The older Android app's own opaque reference. Never a path, never readable. */
const LEGACY_REF = /^a1_[1-9][0-9]*$/;

/**
 * A row that is one logical group of files from the older Android app.
 *
 * It is not a document: it carries no document ref, no MIME type and no byte
 * size, so it is recognised by its own opaque collection ref and described in
 * items. Every browser record is without one, so nothing here changes for them.
 */
export const isCollectionRecord = (record: RecentRecord): boolean =>
  typeof record.collection?.ref === 'string' && LEGACY_REF.test(record.collection.ref);

/**
 * A row that came from the older Android app's history. It can be read, saved
 * and shared, but this app does not own it, so it cannot be deleted from here.
 * A group is one of these too, even though it has no document ref of its own.
 */
export const isLegacyRecord = (record: RecentRecord): boolean =>
  (typeof record.entry.documentRef === 'string' && LEGACY_REF.test(record.entry.documentRef))
  || isCollectionRecord(record);

/**
 * Only a single PDF can be handed back to the viewer; everything else is save
 * or share. A group of files is never one document, whatever it is named.
 */
export const isReopenable = (record: RecentRecord): boolean =>
  record.available &&
  !isCollectionRecord(record) &&
  (record.entry.mimeType === 'application/pdf' ||
    (typeof record.entry.name === 'string' && record.entry.name.toLowerCase().endsWith('.pdf')));

/** How many files a group holds. Zero means the older app did not record it. */
const itemCountOf = (record: RecentRecord): number => {
  const count = record.collection?.itemCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
};

/**
 * A group is measured in items, because it has no single byte size to state.
 * Nothing here calls it a PDF, a file, or an archive of one.
 */
export const collectionItemLabel = (count: number): string =>
  count > 0 ? t('recent.collection.items', { count }) : t("recent-page.item.count.not.recorded.e68cd6");

/**
 * Save and share hand the platform the group itself, so they say how many files
 * they act on. Neither produces a single document, and neither claims to.
 */
export const collectionActionLabel = (verb: 'Save' | 'Share', count: number): string =>
  count > 0
    ? t(verb === 'Save' ? 'recent.collection.save' : 'recent.collection.share', { count })
    : t(verb === 'Save' ? 'recent.collection.saveUnknown' : 'recent.collection.shareUnknown');

/**
 * A record written by an older build may carry no tool path at all. That is a
 * fact about the record, not a reason to crash or to invent a tool name.
 */
const toolNameFor = (toolId: unknown): string => {
  if (typeof toolId !== 'string' || !toolId.trim()) return t("recent-page.tool.not.recorded.8cf14c");
  const tool = tools.find((item) => item.path === toolId);
  if (tool) return tool.name;
  const label = toolId.replace(/^\//, '').replace(/-/g, ' ').trim();
  return label ? label.replace(/\b\w/g, (letter) => letter.toUpperCase()) : t("recent-page.tool.not.recorded.8cf14c");
};

/** Safe display name. Never blank, never "undefined". */
const displayName = (name: unknown): string =>
  typeof name === 'string' && name.trim() ? name.trim() : t("recent-page.untitled.document.9f6d7c");

/** Zero means the store did not record a time. Do not render the epoch as one. */
const hasTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Renaming should not cost the file its type. If the new name carries no
 * extension, the original one is carried over rather than silently dropped.
 */
/** Path separators become "-" because the native store refuses them. */
export const withOriginalExtension = (nextName: string, previousName: unknown): string => {
  const current = displayName(previousName);
  return renameKeepingExtension(nextName, splitFilename(current).extension, current);
};

type Feedback = { tone: 'success' | 'danger'; message: string } | null;

/* --------------------------------------------------- Delete and undo --- */

/**
 * The reason a control is unavailable on this row, in the person's language.
 *
 * The platform reports a limitation, never a sentence and never a native
 * detail, so the wording lives here beside the control it explains.
 */
const LIMITATION_REASON: Record<RecordLimitation, string> = {
  get 'legacy-read-only'() { return t("recent-page.files.from.the.older.android.app.are.ce5f36"); },
  get 'session-only'() { return t("recent-page.kept.in.this.browser.so.deleting.it.d39ecb"); },
  get 'file-missing'() { return t("recent-page.the.file.is.no.longer.on.this.752b82"); },
};

export const limitationReason = (limitation: RecordLimitation | null): string | null =>
  limitation ? LIMITATION_REASON[limitation] : null;

/**
 * One line covers both facts a group's sheet has to explain: there is no Open,
 * because it is not a single document, and there is no Rename or Delete,
 * because this app does not own it.
 */
export const COLLECTION_READ_ONLY_REASON = english["recent-page.a.group.of.files.not.one.pdf.08f59c"];

/**
 * The reason for one specific row.
 *
 * A limitation code alone cannot answer for a group: it is read-only for the
 * same reason as any legacy row, but it also cannot be opened at all, so it
 * says that rather than promising an open that will never come.
 */
export const recordReason = (record: RecentRecord, limitation: RecordLimitation | null): string | null =>
  isCollectionRecord(record) ? t("recent-page.a.group.of.files.not.one.pdf.08f59c") : limitationReason(limitation);

/** A deletion that can still be taken back. Receipts stay in memory only. */
export interface PendingUndo {
  receipts: readonly UndoReceipt[];
  /** The one file's name when exactly one can be restored; otherwise null. */
  name: string | null;
  expiresAt: number;
  /** The line held on screen for as long as this offer stands. */
  message: string;
  /** True when a restore already refused these receipts and can be tried again. */
  retry: boolean;
}

/**
 * While an undo stands, the line and its action are one panel wearing the same
 * status tokens the status line wears. It is that line grown to hold the answer
 * to it, not a second surface stacked under it.
 */
const undoPanelTone: Record<'success' | 'danger', string> = {
  success: 'border-[var(--status-success-text)] bg-[var(--status-success-quiet)] text-[var(--status-success-text)]',
  danger: 'border-[var(--status-danger-text)] bg-[var(--status-danger-quiet)] text-[var(--status-danger-text)]',
};

/** Pressing again after a restore that refused is a retry, and says so. */
export const undoActionLabel = (offer: PendingUndo): string =>
  offer.retry ? t("recent-page.try.undo.again.eb95e0") : t("recent-page.undo.delete.bff260");

export const UNDO_EXPIRED = english["recent-page.the.time.to.undo.has.passed.so.d77970"];
export const UNDO_UNAVAILABLE = english["recent-page.undo.is.not.available.on.this.device.1f9686"];
export const UNDO_FAILED = english["recent-page.that.could.not.be.restored.it.is.405132"];

/** The offer stands until the window closes, and not one moment after it. */
export const undoIsOffered = (
  offer: { receipts: readonly UndoReceipt[]; expiresAt: number } | null,
  now: number,
): boolean => Boolean(offer && offer.receipts.length > 0 && now < offer.expiresAt);

/** A receipt and the name it was taken for, so a lone offer can still be named. */
export interface TrashedRecord {
  receipt: UndoReceipt;
  name: string;
}

/**
 * Fold what a deletion actually reversed into whatever is still offered.
 *
 * A later deletion — permanent, failed, or partly successful — must not take
 * away an offer the person can still use, so the standing receipts are carried
 * forward and only exact successful trash calls join them. The window is the
 * earliest of the ones combined, because that is the first moment part of the
 * offer stops being true.
 */
export const mergeUndo = (
  current: PendingUndo | null,
  added: readonly TrashedRecord[],
  message: string,
  now: number,
): PendingUndo | null => {
  const live = undoIsOffered(current, now) ? current : null;
  if (added.length === 0) return live;
  const receipts = [...(live?.receipts ?? []), ...added.map((item) => item.receipt)];
  return {
    receipts,
    // One receipt can be named; a mixed offer is counted instead of guessing
    // which of its files to speak for.
    name: receipts.length === 1 ? (live ? live.name : added[0].name) : null,
    expiresAt: Math.min(live?.expiresAt ?? Number.POSITIVE_INFINITY, ...added.map((item) => item.receipt.expiresAt)),
    message,
    // A fresh deletion joined it, so this is an offer again rather than a retry.
    retry: false,
  };
};

/**
 * What is left to offer after a restore.
 *
 * A receipt that refused is not spent, so it stays on its original window and
 * the action stays on screen to be tried again. Nothing is extended: the window
 * is the one the deletion opened.
 */
export const remainingUndo = (
  offer: PendingUndo,
  unrestored: readonly UndoReceipt[],
  message: string,
  now: number,
): PendingUndo | null => {
  if (unrestored.length === 0 || now >= offer.expiresAt) return null;
  return {
    receipts: unrestored,
    name: unrestored.length === 1 && offer.receipts.length === 1 ? offer.name : null,
    expiresAt: offer.expiresAt,
    message,
    retry: true,
  };
};

/** Which rows can be taken back and which are gone for good, in one pass. */
export const partitionDeletion = (
  targets: readonly RecentRecord[],
  abilitiesOf: (record: RecentRecord) => RecordAbilities,
): { reversible: RecentRecord[]; permanent: RecentRecord[] } => {
  const reversible: RecentRecord[] = [];
  const permanent: RecentRecord[] = [];
  for (const target of targets) {
    (abilitiesOf(target).reversibleDelete ? reversible : permanent).push(target);
  }
  return { reversible, permanent };
};

export interface DeletionOutcome {
  deleted: number;
  failed: number;
  total: number;
  /** The name of the only record attempted, when there was only one. */
  name: string | null;
}

/**
 * What to say about a deletion.
 *
 * A count that came back short is never rounded up into "Deleted". The exact
 * numbers are stated so a partial result is never read as a complete one.
 */
export const deletionFeedback = ({ deleted, failed, total, name }: DeletionOutcome): Feedback => {
  if (total === 0) return null;
  if (failed === 0) {
    return {
      tone: 'success',
      message: total === 1 && name ? t("recent-page.deleted.6188f7", { v0: name }) : t("recent-page.deleted.results.22b2a6", { v0: total }),
    };
  }
  if (deleted === 0) {
    return {
      tone: 'danger',
      message: total === 1 ? t("recent-page.that.result.could.not.be.deleted.602fa7") : t("recent-page.none.of.the.selected.results.could.be.b1fb67"),
    };
  }
  return { tone: 'danger', message: t("recent-page.deleted.of.could.not.be.deleted.5e0a59", { v0: deleted, v1: total, count: failed }) };
};

/** The same honesty in the other direction: a partial restore says so. */
export const undoFeedback = (restored: number, total: number, name: string | null): Feedback => {
  if (total === 0) return null;
  if (restored === total) {
    return {
      tone: 'success',
      message: total === 1 ? (name ? t("recent-page.restored.e29f24", { v0: name }) : t("recent-page.restored.54fb6e")) : t("recent-page.restored.results.7805d6", { v0: total }),
    };
  }
  if (restored === 0) return { tone: 'danger', message: t("recent-page.that.could.not.be.restored.it.is.405132") };
  return { tone: 'danger', message: t("recent-page.restored.of.the.rest.could.not.be.bcee5b", { v0: restored, v1: total }) };
};

type RecentSortOrder =
  | 'date-newest'
  | 'date-oldest'
  | 'size-largest'
  | 'size-smallest'
  | 'name-ascending'
  | 'name-descending';

const RECENT_SORT_OPTIONS: ReadonlyArray<{ value: RecentSortOrder; label: string }> = [
  { value: 'date-newest', get label() { return t("recent-page.date.newest.first.1e6881"); } },
  { value: 'date-oldest', get label() { return t("recent-page.date.oldest.first.e25725"); } },
  { value: 'size-largest', get label() { return t("recent-page.size.largest.first.621edf"); } },
  { value: 'size-smallest', get label() { return t("recent-page.size.smallest.first.f300a1"); } },
  { value: 'name-ascending', get label() { return t("recent-page.name.a.to.z.b4cc28"); } },
  { value: 'name-descending', get label() { return t("recent-page.name.z.to.a.5978b9"); } },
];

const sortRecentRecords = (records: readonly RecentRecord[], order: RecentSortOrder): RecentRecord[] => {
  const sorted = [...records];
  const name = (record: RecentRecord) => displayName(record.entry.name);
  const compareName = (first: RecentRecord, second: RecentRecord) =>
    name(first).localeCompare(name(second), undefined, { sensitivity: 'base', numeric: true });
  const stable = (first: RecentRecord, second: RecentRecord) =>
    compareName(first, second) || String(first.entry.id).localeCompare(String(second.entry.id));

  return sorted.sort((first, second) => {
    switch (order) {
      case 'date-newest':
        return (Number(second.entry.createdAt) || 0) - (Number(first.entry.createdAt) || 0) || stable(first, second);
      case 'date-oldest':
        return (Number(first.entry.createdAt) || 0) - (Number(second.entry.createdAt) || 0) || stable(first, second);
      case 'size-largest':
        return (Number(second.entry.outputSizeBytes) || 0) - (Number(first.entry.outputSizeBytes) || 0) || stable(first, second);
      case 'size-smallest':
        return (Number(first.entry.outputSizeBytes) || 0) - (Number(second.entry.outputSizeBytes) || 0) || stable(first, second);
      case 'name-descending':
        return compareName(second, first) || (Number(second.entry.createdAt) || 0) - (Number(first.entry.createdAt) || 0);
      case 'name-ascending':
      default:
        return compareName(first, second) || (Number(second.entry.createdAt) || 0) - (Number(first.entry.createdAt) || 0);
    }
  });
};

/* ----------------------------------------------------------------- Row --- */

/**
 * One saved result, in the shape the Android app's Recent list used: an icon
 * bubble, the name, a tool chip beside the size, the date under it, and every
 * action behind one control at the end of the row. Tapping the row opens the
 * result; holding it starts a selection.
 */
const RecentRow: React.FC<{
  record: RecentRecord;
  onOpenActions: (record: RecentRecord) => void;
  onReopen: (record: RecentRecord) => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: (record: RecentRecord) => void;
  onLongPress: (record: RecentRecord) => void;
}> = ({ record, onOpenActions, onReopen, selectionMode, selected, onToggleSelected, onLongPress }) => {
  useI18n();
  const { entry, available } = record;
  const collection = isCollectionRecord(record);
  const items = itemCountOf(record);
  const legacy = isLegacyRecord(record);
  // Nothing here can delete a legacy row, so it never joins a bulk selection.
  const selectable = selectionMode && !legacy;
  const name = displayName(entry.name);
  const holdTimer = useRef<number | null>(null);
  const held = useRef(false);

  const cancelHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  const startHold = () => {
    if (legacy) return;
    held.current = false;
    cancelHold();
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      onLongPress(record);
    }, 450);
  };

  const activate = () => {
    // A hold has already done its job; the release that ends it must not also
    // open the file the user was only trying to tick.
    if (held.current) {
      held.current = false;
      return;
    }
    if (selectable) {
      onToggleSelected(record);
      return;
    }
    // Never a dead tap: anything that cannot be reopened offers its actions.
    if (isReopenable(record)) onReopen(record);
    else onOpenActions(record);
  };

  return (
    <div
      className={cx(
        'flex items-center gap-3 px-3 py-2.5',
        selected && 'bg-[var(--accent-quiet)]',
      )}
    >
      <button
        type="button"
        aria-pressed={selectable ? selected : undefined}
        aria-label={selectable ? t("recent-page..24a420", { v0: selected ? t("recent-page.deselect.142174") : t("recent-page.select.2a7802"), v1: name }) : t("recent-page.open.863533", { v0: name })}
        onClick={activate}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(event) => {
          if (legacy) return;
          event.preventDefault();
          onLongPress(record);
        }}
        className="chef-pressable-row flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <span
          aria-hidden
          className={cx(
            'grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)]',
            selected
              ? 'bg-[var(--accent-rest)] text-[var(--text-on-accent)]'
              : available
              ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
              : 'bg-[var(--surface-sunken)] text-[var(--text-tertiary)]',
          )}
        >
          {selected ? (
            <Check size={19} strokeWidth={2.3} />
          ) : collection ? (
            <Folder size={19} strokeWidth={1.9} />
          ) : available ? (
            <FileText size={19} strokeWidth={1.9} />
          ) : (
            <FileX2 size={19} strokeWidth={1.9} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-[var(--text-primary)]">{name}</span>

          <span className="type-footnote tabular mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[var(--text-secondary)]">
            <span className="rounded-[var(--radius-pill)] bg-[var(--accent-quiet)] px-2 py-0.5 font-semibold text-[var(--accent-on-quiet)]">
              {toolNameFor(entry.toolId)}
            </span>
            <span>{collection ? collectionItemLabel(items) : formatBytes(entry.outputSizeBytes)}</span>
            {legacy && <span className="text-[var(--text-tertiary)]">{t("recent-page.read.only.72bb90")}</span>}
            {/* The one thing a row must say on its own: the record is here but
                the file it points at is not. */}
            {!available && (
              <span className="inline-flex items-center gap-1 font-semibold text-[var(--status-caution-text)]">
                <FileWarning aria-hidden size={13} />{t("recent-page.missing.6be36c")}</span>
            )}
          </span>

          <span className="type-footnote tabular mt-1 flex items-center gap-1.5 text-[var(--text-tertiary)]">
            <CalendarDays aria-hidden size={13} className="shrink-0" />
            {hasTime(entry.createdAt) ? (
              <time dateTime={new Date(entry.createdAt).toISOString()} title={formatTimestampLong(entry.createdAt)}>
                {formatTimestamp(entry.createdAt)}
              </time>
            ) : (
              <span>{t("recent-page.time.not.recorded.9bfe70")}</span>
            )}
          </span>
        </span>
      </button>

      {selectionMode ? null : (
        <Button
          tone="quiet"
          onClick={() => onOpenActions(record)}
          className="shrink-0 px-2"
          aria-label={t("recent-page.more.actions.for.e1329b", { v0: name })}
          icon={<MoreVertical aria-hidden size={18} />}
        />
      )}
    </div>
  );
};

/* ---------------------------------------------------------------- Page --- */

export const RecentPage: React.FC = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const { state, refresh } = useRecentRecords();
  const navigate = useNavigate();
  const haptic = useHaptics();
  const { setOpenedPdfFile } = useOpenedPdf();

  const [active, setActive] = useState<RecentRecord | null>(null);
  const [renaming, setRenaming] = useState<RecentRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<RecentRecord | null>(null);
  const [confirmClear, setConfirmClear] = useState<'records' | 'documents' | null>(null);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<RecentSortOrder>('date-newest');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const records = state.status === 'ready' ? state.value : [];
  const savings = useMemo(() => knownSpaceSaved(records), [records]);
  const hasLegacy = useMemo(() => records.some(isLegacyRecord), [records]);
  const visibleRecords = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const matching = query
      ? records.filter((record) => {
          const searchable = `${displayName(record.entry.name)} ${toolNameFor(record.entry.toolId)}`.toLocaleLowerCase();
          return searchable.includes(query);
        })
      : records;
    return sortRecentRecords(matching, sortOrder);
  }, [records, searchQuery, sortOrder]);
  const visibleIdKey = visibleRecords.map((record) => String(record.entry.id)).join('\u0000');
  /** Legacy rows cannot be deleted, so they are never part of a selection. */
  const selectableRecords = useMemo(
    () => visibleRecords.filter((record) => !isLegacyRecord(record)),
    [visibleRecords],
  );
  const allVisibleSelected =
    selectableRecords.length > 0
    && selectableRecords.every((record) => selectedIds.has(String(record.entry.id)));
  const selectedBytes = useMemo(
    () =>
      records.reduce(
        (total, record) =>
          selectedIds.has(String(record.entry.id)) ? total + (Number(record.entry.outputSizeBytes) || 0) : total,
        0,
      ),
    [records, selectedIds],
  );

  useEffect(() => {
    const visible = new Set(visibleRecords.map((record) => String(record.entry.id)));
    setSelectedIds((current) => {
      const retained = new Set([...current].filter((id) => visible.has(id)));
      return retained.size === current.size ? current : retained;
    });
  }, [visibleIdKey]);

  /**
   * A line stays until something newer replaces it. It sits above the list, so
   * one that timed out would pull the list up from under a finger about to tap.
   */
  const report = useCallback((tone: 'success' | 'danger', message: string) => {
    setFeedback({ tone, message });
  }, []);

  const run = useCallback(
    async (action: () => Promise<void>, successMessage: string, failureMessage: string) => {
      setBusy(true);
      try {
        await action();
        haptic('commit');
        report('success', successMessage);
        return true;
      } catch (caught) {
        // Closing the Files picker or share sheet is a choice, not a failure.
        if (caught instanceof Error && caught.name === 'AbortError') return false;
        haptic('error');
        report('danger', caught instanceof Error && caught.message ? localizeError(caught) : failureMessage);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [haptic, report],
  );

  /**
   * One latch over every way of opening a row.
   *
   * The native reader keeps its promise pending for as long as its screen is up,
   * so it must not run inside `run`: that would hold Recent busy behind a screen
   * the person is no longer even looking at. The web path is short but still
   * reads the whole file, so both share this latch — two quick taps must not
   * start two full reads or two navigations. It is synchronous, because state
   * has not re-rendered by the time the second tap arrives.
   */
  const openRef = useRef(false);

  const handOff = useCallback(
    (record: RecentRecord, toolPath: string | null) =>
      run(
        async () => {
          const file = await platform.reopen(record);
          const opened = setOpenedPdfFile(file);
          if (toolPath === null) navigate('/view');
          else navigate(toolPath, { state: { useOpenedPdf: true, openedPdfId: opened.id } });
        },
        `Opened ${displayName(record.entry.name)}.`,
        t("recent-page.that.file.could.not.be.reopened.1525d4"),
      ),
    [navigate, platform, run, setOpenedPdfFile],
  );

  const reopen = useCallback(
    (record: RecentRecord) => {
      // A group of files is not a document. Its control is disabled and states
      // the reason, and the platform is never asked to open one as a file.
      if (isCollectionRecord(record)) return;
      if (openRef.current) return;
      openRef.current = true;

      const reader = platform.pdfReader;
      const document = record.document;
      // Only a durable file the native reader accepts. A result that exists
      // only as bytes in this session stays on the web reader.
      if (reader && document && record.available && reader.isEligible(document)) {
        haptic('selection');
        void (async () => {
          try {
            const result = await reader.open(document);
            // The iOS reader can create durable, bounded parts for very large
            // PDFs. Refresh after the native session so those parts appear in
            // Recent without copying their bytes through the web bridge.
            await refresh().catch(() => undefined);
            // Closing the reader is the ordinary end of reading, so it is
            // silent: no toast, no error, nothing moved.
            if (result.action !== 'closed') await handOff(record, result.toolPath);
          } catch {
            // A refused launch falls back to the web reader exactly once.
            await handOff(record, null);
          } finally {
            openRef.current = false;
          }
        })();
        return;
      }

      void handOff(record, null).finally(() => {
        openRef.current = false;
      });
    },
    [handOff, haptic, platform, refresh],
  );

  const closeActions = useCallback(() => setActive(null), []);
  const toggleSelectionMode = useCallback(() => {
    if (selectionMode) setSelectedIds(new Set());
    setSelectionMode(!selectionMode);
  }, [selectionMode]);
  const toggleSelected = useCallback((record: RecentRecord) => {
    if (isLegacyRecord(record)) return;
    const id = String(record.entry.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  /** Holding a row is the discoverable way into selection without a visible control. */
  const startSelectionAt = useCallback(
    (record: RecentRecord) => {
      if (isLegacyRecord(record)) return;
      haptic('commit');
      setSelectionMode(true);
      setSelectedIds((current) => new Set(current).add(String(record.entry.id)));
    },
    [haptic],
  );
  const toggleAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(current);
      selectableRecords.forEach((record) => next.add(String(record.entry.id)));
      return next;
    });
  }, [allVisibleSelected, selectableRecords]);

  /* ------------------------------------------------- delete and undo --- */

  const abilitiesOf = useCallback(
    (record: RecentRecord) => recordAbilities(platform, record),
    [platform],
  );
  const activeAbilities = active ? abilitiesOf(active) : null;
  const activeReason = active ? recordReason(active, activeAbilities?.limitation ?? null) : null;
  const activeIsCollection = active ? isCollectionRecord(active) : false;
  const activeItems = active ? itemCountOf(active) : 0;
  const undoOffered = undoIsOffered(pendingUndo, Date.now());

  const selectedTargets = useMemo(
    () => records.filter((record) => selectedIds.has(String(record.entry.id))),
    [records, selectedIds],
  );
  const selectedSplit = useMemo(
    () => partitionDeletion(selectedTargets, abilitiesOf),
    [abilitiesOf, selectedTargets],
  );

  // The offer withdraws itself the moment the window closes, so nothing on
  // screen promises a restore the store will no longer perform. The line it was
  // holding goes with it, and only if nothing newer has replaced it.
  useEffect(() => {
    if (!pendingUndo) return undefined;
    const { expiresAt, message } = pendingUndo;
    const close = () => {
      setPendingUndo(null);
      setFeedback((current) => (current?.message === message ? null : current));
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      close();
      return undefined;
    }
    const timer = window.setTimeout(close, Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [pendingUndo]);

  /**
   * One deletion path for a row and for a selection.
   *
   * Each record is attempted on its own, so one refusal cannot cancel the rest
   * or turn the others into a failure they did not have. Only the rows that
   * actually came back with a receipt can be undone, and the report counts what
   * happened rather than what was asked for.
   */
  const deleteRecords = useCallback(
    async (reversible: readonly RecentRecord[], permanent: readonly RecentRecord[]) => {
      const total = reversible.length + permanent.length;
      if (total === 0) return { deleted: 0, failed: 0, total: 0 };
      const service = platform.recordRecovery;
      setBusy(true);
      // An offer already on screen is not this deletion's to withdraw. It is
      // folded in below, so a permanent or failed deletion leaves it standing.

      const trashed: TrashedRecord[] = [];
      let failed = 0;
      for (const target of reversible) {
        try {
          if (!service) throw new Error(t("recent-page.this.platform.has.no.reversible.deletion.4a2d91"));
          trashed.push({ receipt: await service.deleteReversibly(target), name: displayName(target.entry.name) });
        } catch {
          // The native reason is not this person's business and could name a
          // location. It is counted, never quoted, and never swallowed.
          failed += 1;
        }
      }
      let removed = 0;
      for (const target of permanent) {
        try {
          await platform.records.delete(target.entry.id);
          removed += 1;
        } catch {
          failed += 1;
        }
      }
      setBusy(false);

      const deleted = trashed.length + removed;
      const outcome = deletionFeedback({
        deleted,
        failed,
        total,
        name: total === 1 ? displayName((reversible[0] ?? permanent[0]).entry.name) : null,
      });
      if (outcome) {
        setPendingUndo((current) => mergeUndo(current, trashed, outcome.message, Date.now()));
      }
      haptic(failed === 0 ? 'commit' : 'error');
      if (outcome) report(outcome.tone, outcome.message);
      await refresh();
      return { deleted, failed, total };
    },
    [haptic, platform, refresh, report],
  );

  const undoDelete = useCallback(async () => {
    const offer = pendingUndo;
    if (!offer) return;
    setPendingUndo(null);
    if (Date.now() >= offer.expiresAt) {
      haptic('warning');
      report('danger', t("recent-page.the.time.to.undo.has.passed.so.d77970"));
      return;
    }
    const service = platform.recordRecovery;
    if (!service) {
      haptic('error');
      report('danger', t("recent-page.undo.is.not.available.on.this.device.1f9686"));
      return;
    }
    setBusy(true);
    const unrestored: UndoReceipt[] = [];
    for (const receipt of offer.receipts) {
      try {
        await service.restore(receipt);
      } catch {
        // Same rule as the deletion: counted exactly, described plainly. A
        // receipt that refused is not spent, so it goes back on the offer.
        unrestored.push(receipt);
      }
    }
    setBusy(false);
    const restored = offer.receipts.length - unrestored.length;
    const outcome = undoFeedback(restored, offer.receipts.length, offer.name);
    const retry = outcome ? remainingUndo(offer, unrestored, outcome.message, Date.now()) : null;
    setPendingUndo(retry);
    haptic(unrestored.length === 0 ? 'commit' : 'error');
    if (outcome) report(outcome.tone, outcome.message);
    // Recent is the record, so it is brought back into step here rather than
    // sending the person somewhere else to see what happened.
    await refresh();
  }, [haptic, pendingUndo, platform, refresh, report]);

  const deleteSelected = useCallback(async () => {
    const { deleted, failed } = await deleteRecords(selectedSplit.reversible, selectedSplit.permanent);
    if (deleted > 0 && failed === 0) {
      setSelectedIds(new Set());
      setSelectionMode(false);
    }
  }, [deleteRecords, selectedSplit]);

  return (
    <>
      {/* Count and Select sit beside the title, which is where a list-wide fact
          and a list-wide action belong and where the eye already is. */}
      <TabHeader
        title={t("recent-page.recent.690dbe")}
        trailing={
          state.status === 'ready' && records.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1">
              <span className="tabular type-footnote font-bold text-[var(--text-secondary)]">
                {t('format.itemCount', { count: visibleRecords.length })}
              </span>
              {records.some((record) => !isLegacyRecord(record)) && (
                <Button tone="quiet" onClick={toggleSelectionMode} disabled={busy} className="px-2.5">
                  {selectionMode ? t("recent-page.done.11a676") : t("recent-page.select.2a7802")}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="mx-auto max-w-4xl px-4 md:px-8">
        {/* One anchored place for what just happened and for the single action
            that takes it back. It does not move, follow the finger, or time
            itself out from under a reversible deletion.

            While the deletion can still be taken back the line and its action
            are one panel, not a strip with a small control loose beneath it:
            the sentence and the way to reverse it are one event, and on a phone
            a lone control floating in the page reads as debris. The panel takes
            the same radius, sides and rhythm as the result summary below it, so
            it lands as part of the page rather than on top of it. Once there is
            nothing to reverse the ordinary status line returns. */}
        <div role="status" aria-live="polite">
          {undoOffered && pendingUndo ? (
            <div
              key={pendingUndo.message}
              className={cx(
                'chef-enter mb-3 rounded-[var(--radius-panel)] border px-4 py-3.5',
                undoPanelTone[feedback?.tone ?? 'success'],
              )}
            >
              <p className="flex items-start gap-2 font-semibold">
                <span aria-hidden className="mt-0.5 shrink-0">
                  {feedback?.tone === 'danger' ? <AlertTriangle size={17} /> : <Check size={17} />}
                </span>
                <span className="chef-filename">{feedback?.message ?? pendingUndo.message}</span>
              </p>
              <Button
                block
                tone="secondary"
                className="mt-3"
                icon={<Undo2 aria-hidden size={17} />}
                disabled={busy}
                aria-label={t("recent-page.for.eca73a", { v0: undoActionLabel(pendingUndo), v1: pendingUndo.name ?? t("recent-page.results.a9c6d9", { v0: pendingUndo.receipts.length }) })}
                onClick={() => void undoDelete()}
              >
                {undoActionLabel(pendingUndo)}
              </Button>
            </div>
          ) : (
            feedback && (
              <div key={feedback.message} className="chef-enter mb-3">
                <StatusLine tone={feedback.tone}>{feedback.message}</StatusLine>
              </div>
            )
          )}
        </div>

        {/* Sorting belongs to the list the field searches, so it sits at the end
            of that field's row rather than claiming a second full-width row on a
            phone. */}
        {state.status === 'ready' && records.length > 0 && (
          <div className="mb-3 flex items-stretch gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">{t("recent-page.search.recent.results.01b657")}</span>
              <Search
                aria-hidden
                size={18}
                className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("recent-page.search.files.179fed")}
                className="chef-field ps-10"
                style={{ paddingInlineStart: '2.5rem' }}
              />
            </label>
            <div className="relative shrink-0">
              <span
                aria-hidden
                className="chef-field pointer-events-none flex items-center gap-2 px-3 text-[var(--text-secondary)]"
              >
                <ArrowUpDown size={17} />
                <span className="hidden whitespace-nowrap font-semibold sm:inline">
                  {RECENT_SORT_OPTIONS.find((option) => option.value === sortOrder)?.label}
                </span>
              </span>
              <select
                aria-label={t("recent-page.sort.recent.results.9b7614")}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as RecentSortOrder)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              >
                {RECENT_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {selectionMode && state.status === 'ready' && records.length > 0 && (
          <div className="mb-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3">
            <p className="font-semibold text-[var(--text-primary)]">
              {selectedIds.size === 0
                ? t("recent-page.select.results.c6bf21")
                : t("recent-page.selected.d3387b", { v0: selectedIds.size, v1: formatBytes(selectedBytes) })}
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Button tone="secondary" onClick={toggleAllVisible} disabled={selectableRecords.length === 0 || busy}>
                {allVisibleSelected ? t("recent-page.clear.selection.cea4d2") : t("recent-page.select.all.1fc9a3")}
              </Button>
              <Button
                tone="destructive"
                icon={<Trash2 aria-hidden size={16} />}
                disabled={selectedIds.size === 0 || busy}
                onClick={() => {
                  if (selectedSplit.permanent.length === 0 && selectedSplit.reversible.length > 0) {
                    void deleteSelected();
                    return;
                  }
                  setConfirmDeleteSelected(true);
                }}
              >{t("recent-page.delete.selected.d2ab5d")}</Button>
            </div>
          </div>
        )}

        {/* The count moved up beside the title. What is left worth saying is the
            one fact the list itself cannot show: how much space these results
            saved. */}
        {state.status === 'ready' && savings.known > 0 && savings.bytes > 0 && !selectionMode && (
          <p className="tabular mb-3 font-semibold text-[var(--status-success-text)]">{t("recent-page.message.77c9aabdbc", { v0: formatBytes(savings.bytes) })}</p>
        )}

        {!platform.capabilities.durableDocuments && state.status === 'ready' && records.length > 0 && (
          <div className="mb-3">
            <StatusLine tone="caution" icon={<AlertTriangle size={15} />}>{t("recent-page.results.are.kept.in.browser.storage.save.22ee8b")}</StatusLine>
          </div>
        )}

        <div className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]">
          {state.status === 'loading' ? (
            <div aria-busy="true" aria-label={t("recent-page.loading.recent.results.989937")}>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : state.status === 'error' ? (
            <div className="p-5">
              <StatusLine tone="danger" icon={<AlertTriangle size={15} />}>
                {state.message}
              </StatusLine>
              <Button tone="secondary" className="mt-4" onClick={() => void refresh()}>{t("recent-page.try.again.d8b839")}</Button>
            </div>
          ) : records.length === 0 ? (
            <EmptyState
              icon={<Clock size={30} />}
              title={t("recent-page.no.files.yet.cb922b")}
              action={
                <Button tone="primary" onClick={() => navigate('/')}>{t("recent-page.browse.tools.a4e6fa")}</Button>
              }
            />
          ) : visibleRecords.length === 0 ? (
            <EmptyState
              icon={<Search size={30} />}
              title={t("recent-page.no.matching.files.7eaa32")}
              action={
                <Button tone="secondary" onClick={() => setSearchQuery('')}>{t("recent-page.clear.search.3b7ea5")}</Button>
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--border-hairline)]">
              {visibleRecords.map((record) => (
                <li key={record.entry.id}>
                  <RecentRow
                    record={record}
                    onOpenActions={setActive}
                    onReopen={reopen}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(String(record.entry.id))}
                    onToggleSelected={toggleSelected}
                    onLongPress={selectionMode ? toggleSelected : startSelectionAt}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* The second clear action only exists where the platform can actually
            separate the record from the file it points at. Both sit in one
            compact row: they are the footer of a list, and stacked at full width
            they read as the subject of the screen instead. */}
        {state.status === 'ready' && records.length > 0 && !selectionMode && (
          <div className="mt-4 flex flex-row flex-wrap gap-2 pb-6">
            <Button
              tone="destructive"
              className="flex-1 px-3"
              icon={<Trash2 aria-hidden size={16} />}
              onClick={() => setConfirmClear('records')}
            >{t("recent-page.clear.all.29a390")}</Button>
            {platform.capabilities.separateClearActions && (
              <Button
                tone="destructive"
                className="flex-1 px-3"
                icon={<Trash2 aria-hidden size={16} />}
                onClick={() => setConfirmClear('documents')}
              >{t("recent-page.delete.files.only.911496")}</Button>
            )}
          </div>
        )}
      </div>

      {/* Row actions. A sheet rather than a hidden swipe, so every action is
          reachable by touch, keyboard and VoiceOver in the same place. */}
      <Sheet
        open={Boolean(active)}
        onClose={closeActions}
        title={active ? displayName(active.entry.name) : ''}
        description={
          active
            ? t("recent-page..b6dda3", { v0: toolNameFor(active.entry.toolId), v1: hasTime(active.entry.createdAt) ? formatTimestampLong(active.entry.createdAt) : t("recent-page.time.not.recorded.9bfe70"), v2: activeIsCollection ? collectionItemLabel(activeItems) : formatBytes(active.entry.outputSizeBytes) })
            : undefined
        }
      >
        {active && (
          <div className="space-y-2">
            {!active.available && (
              <StatusLine tone="caution" icon={<FileWarning size={15} />}>
                {activeIsCollection ? t("recent-page.these.files.are.no.longer.on.this.8f69ee") : t("recent-page.this.file.is.no.longer.on.this.d65cb3")}
              </StatusLine>
            )}

            {/* The row's own tap reopens, but the menu is where every action
                the Android app listed is reachable in one place. */}
            {isReopenable(active) && (
              <Button
                block
                tone="primary"
                icon={<ExternalLink aria-hidden size={16} />}
                onClick={() => {
                  const target = active;
                  closeActions();
                  reopen(target);
                }}
              >{t("recent-page.open.ed077f")}</Button>
            )}

            <Button
              block
              tone={isReopenable(active) ? undefined : 'primary'}
              icon={<Download aria-hidden size={16} />}
              busy={busy}
              disabled={!active.available}
              onClick={() =>
                void run(
                  () => platform.save(active, displayName(active.entry.name)),
                  `Saved ${displayName(active.entry.name)}.`,
                  t("recent-page.that.file.could.not.be.saved.4d740f"),
                ).then(closeActions)
              }
            >
              {activeIsCollection ? collectionActionLabel('Save', activeItems) : t("recent-page.save.a.copy.2c2a76")}
            </Button>

            {/* A device with no share sheet gets no Share button, rather than a
                dead one and a sentence explaining it. */}
            {platform.share && (
              <Button
                block
                icon={<Share2 aria-hidden size={16} />}
                disabled={!active.available}
                onClick={() =>
                  void run(
                    () => platform.share!(active, displayName(active.entry.name)),
                    t("recent-page.handed.to.the.share.sheet.cae3ae"),
                    t("recent-page.sharing.did.not.complete.bf9347"),
                  ).then(closeActions)
                }
              >
                {activeIsCollection ? collectionActionLabel('Share', activeItems) : t("recent-page.share.29887a")}
              </Button>
            )}

            <Button
              block
              icon={<Pencil aria-hidden size={16} />}
              disabled={!activeAbilities?.rename}
              onClick={() => {
                setRenameValue(displayName(active.entry.name));
                setRenaming(active);
                closeActions();
              }}
            >{t("recent-page.rename.3064d7")}</Button>

            {/* A deletion this app can genuinely take back does not earn a
                second interruption: it happens, and the Undo waits in Recent.
                A permanent one keeps its confirmation, because that is the
                only chance to reconsider it. */}
            <Button
              block
              tone="destructive"
              icon={<Trash2 aria-hidden size={16} />}
              disabled={activeAbilities?.limitation === 'legacy-read-only'}
              onClick={() => {
                const target = active;
                closeActions();
                if (activeAbilities?.reversibleDelete) void deleteRecords([target], []);
                else setConfirmDelete(target);
              }}
            >{t("recent-page.delete.e2d0a5")}</Button>

            {/* The reason a control above is unavailable, in text, where a
                finger and a screen reader both reach it. */}
            {activeReason && <p className="type-footnote pt-1 text-[var(--text-tertiary)]">{activeReason}</p>}
          </div>
        )}
      </Sheet>

      {/* Rename */}
      <Sheet
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title={t("recent-page.rename.3064d7")}
        footer={
          <>
            <Button tone="secondary" onClick={() => setRenaming(null)}>{t("recent-page.cancel.19766e")}</Button>
            <Button
              tone="primary"
              busy={busy}
              disabled={!renameValue.trim()}
              onClick={() => {
                const target = renaming;
                if (!target || !platform.rename) return;
                void run(
                  () => platform.rename!(target, withOriginalExtension(renameValue, target.entry.name)),
                  'Renamed.',
                  t("recent-page.that.result.could.not.be.renamed.d87425"),
                )
                  .then(refresh)
                  .then(() => setRenaming(null));
              }}
            >{t("recent-page.save.name.b72972")}</Button>
          </>
        }
      >
        <label htmlFor="recent-rename" className="type-footnote block font-semibold text-[var(--text-secondary)]">{t("recent-page.file.name.3efed3")}</label>
        <input
          id="recent-rename"
          className="chef-field mt-1"
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Sheet>

      <ConfirmSheet
        open={Boolean(confirmDelete)}
        title={t("recent-page.delete.this.file.ee4e10")}
        description={confirmDelete ? t("recent-page.this.cannot.be.undone.copies.you.saved.aaddca") : ''}
        confirmLabel={t("recent-page.delete.e2d0a5")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const target = confirmDelete;
          if (!target) return;
          await deleteRecords([], [target]);
          setConfirmDelete(null);
        }}
      />

      {/* Only the part of a selection that cannot be taken back is confirmed,
          and the description says exactly how much of it that is. */}
      <ConfirmSheet
        open={confirmDeleteSelected}
        title={t("recent-page.delete.cfd948", { count: selectedIds.size })}
        description={
          selectedSplit.reversible.length === 0
            ? t("recent-page.frees.this.cannot.be.undone.5d87d1", { v0: formatBytes(selectedBytes) })
            : t("recent-page.frees.8d93c0", { v0: formatBytes(selectedBytes), v1: selectedSplit.permanent.length === 1
                  ? t("recent-page.one.of.them.cannot.be.undone.9f0ace")
                  : t("recent-page.of.them.cannot.be.undone.c8e64b", { v0: selectedSplit.permanent.length }) })
        }
        confirmLabel={t("recent-page.delete.e2d0a5")}
        onCancel={() => setConfirmDeleteSelected(false)}
        onConfirm={async () => {
          await deleteSelected();
          setConfirmDeleteSelected(false);
        }}
      />

      <ConfirmSheet
        open={Boolean(confirmClear)}
        title={confirmClear === 'documents' ? t("recent-page.delete.every.file.17d4d8") : t("recent-page.clear.all.909f22")}
        // Deleting the files while keeping the list is the one outcome the title
        // cannot convey on its own, so that branch says it and the other does not.
        description={t("recent-page.this.cannot.be.undone.copies.you.saved.098cb0", { v0: confirmClear === 'documents' ? t("recent-page.the.list.of.what.you.made.stays.d6827e") : '', v1: hasLegacy ? t("recent-page.files.from.the.older.android.app.stay.610916") : '' })}
        confirmLabel={confirmClear === 'documents' ? t("recent-page.delete.files.d31462") : t("recent-page.clear.all.29a390")}
        onCancel={() => setConfirmClear(null)}
        onConfirm={async () => {
          const mode = confirmClear;
          if (!mode) return;
          // Clearing is deliberate and destructive by contract, so it neither
          // gains an undo nor keeps an earlier one alive over it.
          setPendingUndo(null);
          await run(
            () => (mode === 'documents' ? platform.records.clearDocuments() : platform.records.clearRecords()),
            mode === 'documents'
              ? hasLegacy
                ? t("recent-page.kept.files.deleted.older.android.files.were.9185d2")
                : t("recent-page.kept.files.deleted.be87dd")
              : hasLegacy
                ? t("recent-page.this.app.s.results.were.cleared.older.89cce7")
                : t("recent-page.recent.cleared.598fd2"),
            t("recent-page.that.could.not.be.cleared.0a5d6f"),
          );
          setConfirmClear(null);
          await refresh();
        }}
      />
    </>
  );
};
