import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, Download, ExternalLink, MoreHorizontal, Pencil, Share2, Wrench, X } from 'lucide-react';
import type { OutputReadyRecord } from '../../services/pdfShared';
import { OUTPUT_DISMISS_EVENT, OUTPUT_EVENT, OUTPUT_RENAMED_EVENT, announceOutputRenamed, announceRecordsChanged, getWorkspaceSettings } from '../../services/workspace';
import { Button, Sheet, StatusLine, cx } from './Primitives';
import { isConfirmEnter } from './keys';
import { filenameStemLimit, formatBytes, renameKeepingExtension, sanitizeFilenameStem, splitFilename } from './format';
import type { SavedCopy } from '../../services/platform/contracts';
import { useDiscardPrompt } from '../../hooks/useConfirmDiscard';
import { returnToTools } from '../Layout/navigationHistory';
import { isSettingsPage } from '../Layout/AppShell';
import {
  FALLBACK_DOCUMENT_NAME,
  FALLBACK_MIME_TYPE,
  useHaptics,
  useWorkspacePlatform,
} from '../../hooks/useWorkspaceRuntime';
import { useMonetization } from '../../hooks/useMonetization';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useResultSlotTarget } from './resultSlot';
import { SeparateAction, useSeparateSave } from './SaveSeparately';
import { OUTPUT_NOTE_EVENT, setStripInSlot, setStripNote, setStripSaved, takeOutputDetail } from './outputNote';
import { SOURCE_PART, sameWork, subscribeWork, workPart, workSignature, type WorkSnapshot } from './workSignature';
import { tools } from '../Tools/toolCatalog';
import { MiddleName } from './MiddleName';
// The result's pages over the tool (Open PDF on a tool screen), loaded only when asked for.
const PDFPreviewModal = React.lazy(() => import('./PDFPreviewModal').then((module) => ({ default: module.PDFPreviewModal })));

/**
 * What happens after a job finishes.
 *
 * Every generated output opens the same actions, including automatic exports.
 * Closing the sheet leaves the result strip available for another action.
 */

export const OutputCenter: React.FC = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const haptic = useHaptics();
  const navigate = useNavigate();
  const location = useLocation();
  const { setOpenedPdfFile } = useOpenedPdf();
  const { access, runWithExportAccess, cancelPendingExport } = useMonetization();

  const [record, setRecord] = useState<OutputReadyRecord | null>(null);
  const [retained, setRetained] = useState(false);
  const [name, setName] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [exported, setExported] = useState(false);
  // The copy in Downloads, so a rename renames it and Download does not make a duplicate.
  const [saved, setSaved] = useState<SavedCopy | null>(null);
  const [shared, setShared] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  // Said in the sheet when "Use in another tool" has nothing to hand on: a ZIP holds several
  // files and no tool opens it (round 6, desktop-08). Cleared when the sheet closes.
  const [handOffNote, setHandOffNote] = useState('');
  useEffect(() => { if (!moreOpen) setHandOffNote(''); }, [moreOpen]);
  // The tool's own success message for this result (owner decision 2).
  const [note, setNote] = useState('');
  // A tool's own figure for the size line (Compress's "3.0 MB → 728 kB, −77%").
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  // Open PDF on a tool screen: the result's pages shown over the tool, which keeps its files.
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const recordRef = useRef<OutputReadyRecord | null>(null);
  recordRef.current = record;
  const unsavedRef = useRef(false);
  const discardPrompt = useDiscardPrompt({ title: t("output-center.this.result.is.not.saved.discard.it.95f518") });
  const folder = platform.capabilities.exportFolder;
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const stripRef = useRef<HTMLElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  // The control the person last pressed, and the one that started this result (or More actions):
  // closing the sheet returns there (final fix, item 5), not to whatever held focus as it opened.
  const lastPressedRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // The tool's settings or file changed after this result was made (final fix, item 3).
  const [stale, setStale] = useState(false);
  const stripVisible = Boolean(record?.blob || record?.recentRecord);
  // A tool screen draws the strip in its action area (resultSlot.ts); elsewhere it floats.
  const slotTarget = useResultSlotTarget();
  // A result carried over from another tool ("Use in another tool") is not this tool's
  // result: in this tool's action area it is one line that names where it came from (A-024).
  const fromTool = slotTarget && record?.toolPath && record.toolPath !== location.pathname
    ? tools.find((tool) => tool.path === record.toolPath)?.name ?? null
    : null;
  // Tool routes have no tab bar, so a floating strip sits on the safe area instead.
  const onTabRoot = ['/', '/recent', '/history', '/settings'].includes(location.pathname) || isSettingsPage(location.pathname);

  // The page leaves room for the strip, so it never covers a tool's last row or main button.
  useEffect(() => {
    const root = document.documentElement;
    const strip = stripRef.current;
    if (!stripVisible || !strip || slotTarget) return undefined;
    const measure = () => root.style.setProperty(
      '--chef-output-strip-space', `${Math.ceil(strip.getBoundingClientRect().height) + 8}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--chef-output-strip-space');
    };
  }, [stripVisible, slotTarget]);
  // Cancel, Escape or a tap outside goes back to the result sheet the rename came from, as Save
  // name does; it does not close the whole result (research r4, mobile-05).
  const closeRename = useCallback(() => {
    setRenameOpen(false);
    setMoreOpen(true);
  }, []);

  // "Save N files separately" for a Split ZIP (plan 2.5).
  const separate = useSeparateSave({
    enabled: Boolean(record?.blob || record?.recentRecord) && record?.toolPath === '/split'
      && /\.zip$/i.test(record?.filename ?? ''),
    id: record?.id ?? null,
    name: record?.filename ?? '',
    platform,
    load: async () => {
      const current = recordRef.current;
      if (current?.blob) return current.blob;
      return current?.recentRecord ? platform.reopen(current.recentRecord) : null;
    },
    guard: async (work) => {
      const current = recordRef.current;
      if (!current?.accessLocked || access?.unlocked) { await work(); return true; }
      const accessResult = await runWithExportAccess(work, { operationId: current.id });
      return accessResult.status !== 'blocked';
    },
    auto: record?.separateSave ?? null,
  });
  // Nothing else holds this result: not Recent, not Downloads, not a share target, not its parts.
  const unsaved = Boolean(record?.blob && !record.recentRecord && !record.accessLocked && !retained && !exported && !shared
    && !separate.done);
  unsavedRef.current = unsaved;

  // A Save waiting behind the paywall belongs to this result. Once the result is
  // gone, a later purchase or restore must not run it.
  const abandonPendingSave = useCallback(() => {
    if (recordRef.current) cancelPendingExport(recordRef.current.id);
  }, [cancelPendingExport]);

  const dismiss = useCallback(() => {
    abandonPendingSave();
    setRecord(null);
    setStale(false);
    setMoreOpen(false);
    setExported(false);
    setSaved(null);
    setShared(false);
    setRenameOpen(false);
    setError('');
    setNote('');
    setDetail('');
  }, [abandonPendingSave]);

  useEffect(() => {
    const onOutput = (event: Event) => {
      const next = (event as CustomEvent<OutputReadyRecord>).detail;
      if (!next?.blob && !next?.recentRecord) return;
      const settings = getWorkspaceSettings();
      abandonPendingSave();
      setRecord(next);
      setNote('');
      setDetail(takeOutputDetail(next.filename));
      setSaved(next.savedCopy ?? null);
      setShared(false);
      // Downloads adds " (1)" to a name that is taken; show the name the file really has.
      setName(next.savedCopy?.savedName ?? (typeof next.filename === 'string' ? next.filename : ''));
      const retainedNow = next.historyRetained ?? settings.keepLocalHistory;
      const exportedNow = next.externallyExported ?? (
        settings.autoDownload && !next.recentRecord && !next.deliveryIssue && !next.accessLocked
      );
      setRetained(retainedNow);
      setExported(exportedNow);
      setStale(false);
      openerRef.current = lastPressedRef.current;
      // The sheet opens by itself only when the person must act (Q1). A result that is saved and
      // placed (in the app's folder, or kept in Recent) stays on the strip; More actions opens it.
      // A failed or cancelled save, a preview only, and separate parts always open it.
      const placed = exportedNow && (Boolean(folder) || retainedNow);
      setMoreOpen(!placed || Boolean(next.deliveryIssue || next.accessLocked || next.separateSave));
      setRenameOpen(false);
      setError(next.deliveryIssue === 'cancelled'
        ? t("output-center.save.cancelled.your.result.is.still.available.79e0fc")
        : next.deliveryIssue === 'failed'
          ? t("output-center.saving.did.not.complete.try.save.again.044526")
          : '');
      haptic(next.deliveryIssue ? 'warning' : 'commit');
    };
    window.addEventListener(OUTPUT_EVENT, onOutput);
    return () => window.removeEventListener(OUTPUT_EVENT, onOutput);
  }, [abandonPendingSave, folder, haptic]);

  // The tool's own outcome line gives way while this tool's strip is on screen (T-07).
  const inSlot = Boolean(slotTarget && (record?.blob || record?.recentRecord) && !fromTool);
  useEffect(() => { setStripInSlot(inSlot); }, [inSlot]);
  useEffect(() => () => setStripInSlot(false), []);

  useEffect(() => {
    const remember = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      const pressed = event.target instanceof Element
        ? event.target.closest<HTMLElement>('button, a[href], input, select, textarea, [role="button"]')
        : null;
      if (pressed && !pressed.closest('[aria-modal="true"]')) lastPressedRef.current = pressed;
    };
    document.addEventListener('click', remember, true);
    document.addEventListener('keydown', remember, true);
    return () => {
      document.removeEventListener('click', remember, true);
      document.removeEventListener('keydown', remember, true);
    };
  }, []);
  const sheetReturnFocus = useCallback(() => {
    const usable = (node: HTMLElement | null): node is HTMLElement => Boolean(node && node.isConnected
      && node.getClientRects().length > 0 && !(node as HTMLButtonElement).disabled
      && !node.closest('[inert], [hidden], [aria-hidden="true"]'));
    const opener = openerRef.current;
    if (usable(opener)) return opener;
    return usable(moreButtonRef.current) ? moreButtonRef.current : null;
  }, []);

  // An earlier result (final fix, item 3; fix round 2, item 1): the person changed any input of
  // the tool after this result was made (workSignature.ts reads them all from the screen).
  // Changes the tool makes itself, with no press or typing from the person since the result, move
  // the baseline instead (a tool that resets after a job). A saved result gives way to a new file;
  // any other is kept, called "Earlier result", without the strip's one-tap Download, until every
  // input is back to what the result was made from. The sheet keeps every action.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const recordId = record?.id ?? null;
  // Kept per result, so the strip leaving its slot and coming back (a cleared file shows the picker)
  // does not take the screen at that moment as what the result was made from.
  const workBaseRef = useRef<{ id: string; baseline: WorkSnapshot; source: string; touched: boolean } | null>(null);
  useEffect(() => {
    if (!inSlot || !recordId) return undefined;
    if (workBaseRef.current?.id !== recordId) {
      workBaseRef.current = { id: recordId, baseline: workSignature(), source: workPart(SOURCE_PART), touched: false };
    }
    const base = workBaseRef.current;
    const touch = (event: Event) => {
      if (event instanceof KeyboardEvent && ['Tab', 'Shift', 'Escape'].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      // The strip and its own sheets never change the work.
      if (target?.closest('.chef-result-face') || target?.closest('[role="dialog"]')?.querySelector('[data-result-sheet]')) return;
      base.touched = true;
    };
    const check = () => {
      const now = workSignature();
      if (sameWork(now, base.baseline)) { setStale(false); return; }
      if (!base.touched) {
        base.baseline = now;
        base.source = workPart(SOURCE_PART);
        return;
      }
      if (workPart(SOURCE_PART) !== base.source && !unsavedRef.current && !recordRef.current?.deliveryIssue) {
        dismissRef.current();
        return;
      }
      setStale(true);
    };
    const events = ['pointerdown', 'keydown', 'input', 'change', 'drop'] as const;
    events.forEach((name) => document.addEventListener(name, touch, true));
    const unsubscribe = subscribeWork(check);
    return () => {
      events.forEach((name) => document.removeEventListener(name, touch, true));
      unsubscribe();
    };
  }, [inSlot, recordId]);

  // Leaving the tool asks nothing while its result is saved and still current (final fix, item 6).
  const savedHere = inSlot && !stale && !record?.deliveryIssue && !(record?.accessLocked && !access?.unlocked)
    && Boolean(record?.recentRecord || retained || exported || shared);
  useEffect(() => { setStripSaved(savedHere); }, [savedHere]);
  useEffect(() => () => setStripSaved(false), []);

  const shownNote = record?.blob || record?.recentRecord ? note : '';
  useEffect(() => { setStripNote(shownNote); }, [shownNote]);
  useEffect(() => () => setStripNote(''), []);

  useEffect(() => {
    const onNote = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (recordRef.current && typeof message === 'string') setNote(message);
    };
    window.addEventListener(OUTPUT_NOTE_EVENT, onNote);
    return () => window.removeEventListener(OUTPUT_NOTE_EVENT, onNote);
  }, []);

  // A failed or unsaved result stays; any other result gives way to the next document.
  useEffect(() => {
    const onDismiss = () => { if (!recordRef.current?.deliveryIssue && !unsavedRef.current) dismiss(); };
    window.addEventListener(OUTPUT_DISMISS_EVENT, onDismiss);
    return () => window.removeEventListener(OUTPUT_DISMISS_EVENT, onDismiss);
  }, [dismiss]);

  useEffect(() => {
    const onRenamed = (event: Event) => {
      const { id, filename } = (event as CustomEvent<{ id: string; filename: string }>).detail;
      if (recordRef.current?.id !== id) return;
      setRecord(current => current?.id !== id ? current : {
        ...current,
        filename,
        recentRecord: current.recentRecord ? {
          ...current.recentRecord,
          entry: { ...current.recentRecord.entry, name: filename },
          document: current.recentRecord.document ? { ...current.recentRecord.document, name: filename } : null,
        } : current.recentRecord,
      });
      setName(filename);
    };
    window.addEventListener(OUTPUT_RENAMED_EVENT, onRenamed);
    return () => window.removeEventListener(OUTPUT_RENAMED_EVENT, onRenamed);
  }, []);

  // A failed save must remain retryable across navigation until dismissed, and a result saved
  // nowhere must not vanish because the person went back to Tools.
  useEffect(() => {
    const keep = Boolean(recordRef.current?.deliveryIssue) || unsavedRef.current;
    if (!keep) abandonPendingSave();
    setRecord(current => keep ? current : null);
    setMoreOpen(false);
    setRenameOpen(false);
  }, [abandonPendingSave, location.pathname]);

  const typed = name.trim() || record?.filename?.trim() || t("use-workspace-runtime.untitled.document.9f6d7c");
  const mimeType = record?.mimeType || record?.blob?.type || FALLBACK_MIME_TYPE;
  const originalExtension = mimeType === 'application/pdf'
    ? '.pdf'
    : splitFilename(record?.filename?.trim() || '').extension;
  const safeName = originalExtension && !typed.toLowerCase().endsWith(originalExtension.toLowerCase())
    ? `${typed}${originalExtension}` : typed;
  const isPdf = mimeType === 'application/pdf' || safeName.toLowerCase().endsWith('.pdf');
  const isArchive = mimeType === 'application/zip' || safeName.toLowerCase().endsWith('.zip');

  const act = useCallback(
    async (action: () => Promise<void | boolean>, failure: string) => {
      setBusy(true);
      setError('');
      try {
        const completed = await action();
        if (completed === false) return false;
        haptic('commit');
        return true;
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return false;
        haptic('error');
        setError(caught instanceof Error && caught.message ? localizeError(caught) : failure);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [haptic],
  );

  if (!record?.blob && !record?.recentRecord) return null;
  const recent = record.recentRecord;
  const result = record.blob ? { blob: record.blob, name: safeName, mimeType } : null;
  const accessLocked = Boolean(record.accessLocked && !access?.unlocked);

  const downloadResult = async () => {
    let copy: SavedCopy | void = undefined;
    const download = async () => {
      copy = await (recent ? platform.save(recent, safeName) : platform.saveFresh(result!));
    };
    if (accessLocked) {
      // The preview's operation ID is its metering key: saving it records that job against
      // fresh native state instead of trusting a cached free count.
      const accessResult = await runWithExportAccess(download, { operationId: record.id });
      if (accessResult.status === 'blocked') return false;
    } else {
      await download();
    }
    if (recordRef.current?.id !== record.id) return true;
    const kept = copy as SavedCopy | void;
    setExported(true);
    if (kept) {
      setSaved(kept);
      setName(kept.savedName);
    }
    // A saved archive has nothing else to do in the sheet: it gives the screen back for the next
    // run, and the strip's More actions still offers Download.
    if (!isPdf) setMoreOpen(false);
    return true;
  };

  const keepResult = async () => {
    if (retained || recent) return;
    if (!platform.keepFresh || !result) return false;
    const keep = async () => {
      await platform.keepFresh!(result);
      announceRecordsChanged();
      if (recordRef.current?.id === record.id) setRetained(true);
    };
    if (!accessLocked) return keep();
    const accessResult = await runWithExportAccess(keep, { operationId: record.id });
    return accessResult.status !== 'blocked';
  };

  const openPdf = async (openTools: boolean) => {
    const file = recent
      ? await platform.reopen(recent)
      : new File([record.blob!], safeName, { type: 'application/pdf' });
    // On a tool screen, Open PDF shows the result over the tool (pass 5, item 2): going to Read PDF
    // asked "Leave this tool and discard your files?" when the person only wanted a look. The
    // strip stays, so the result can still be saved, renamed or carried on. "Use in another tool"
    // still opens it in Read PDF.
    if (!openTools && slotTarget) {
      setMoreOpen(false);
      setPreviewFile(file);
      return;
    }
    const opened = setOpenedPdfFile(file, {
      provenance: accessLocked ? 'preview' : 'retained',
      previewOnly: accessLocked,
    });
    // An unsaved result stays on the strip, so it can still be saved after a look.
    if (unsaved) setMoreOpen(false);
    else dismiss();
    // Leaving the tool's files for the reader asks first, by the rule Back uses (ToolScreen).
    // "Use in another tool" never asks: the person chose to carry the result on, so nothing is lost.
    navigate('/view', { state: { openTools: openTools && !accessLocked, openedPdfId: opened.id, leavesWork: !openTools } });
  };

  // One filled button. Save until a copy is on the device, then Share (Open PDF if the
  // platform cannot share). Once a PDF is saved, Download would only make a second copy; an
  // archive (Batch, Split) cannot be opened here, so Download stays its way back to the file.
  const savedOnDevice = Boolean(saved) || exported;
  const canShare = Boolean(recent ? platform.share : platform.shareFresh);
  const primary: 'save' | 'share' | 'open' = !savedOnDevice ? 'save'
    : canShare ? 'share' : isPdf ? 'open' : 'save';
  const savedIn = savedOnDevice && folder ? t("output-center.in.6ca2da", { v0: folder }) : '';
  const sizeLine = detail || formatBytes(record.size ?? null);
  // In the sheet's line a size never breaks between its number and unit ("3.2 / kB", round 5, mobile-09).
  const sheetSize = detail ? sizeLine : sizeLine.replace(/ /g, '\u00a0');
  // Where the result is kept, said once, in the sheet's line under its title (T-07). A result kept
  // nowhere shows its size only.
  const keptIn = savedIn || (retained ? t("output-center.kept.on.this.device.c76dee") : '');

  const shareButton = canShare && (
    <Button
      block
      tone={primary === 'share' ? 'primary' : 'secondary'}
      icon={<Share2 aria-hidden size={16} />}
      onClick={() => void act(async () => {
        const share = () => recent ? platform.share!(recent, safeName) : platform.shareFresh!(result!);
        if (!accessLocked) {
          await share();
        } else {
          const accessResult = await runWithExportAccess(share, { operationId: record.id });
          if (accessResult.status === 'blocked') return false;
        }
        if (recordRef.current?.id === record.id) setShared(true);
        return true;
      }, t("output-center.sharing.did.not.complete.bf9347"))}
    >{t("output-center.share.29887a")}</Button>
  );
  const openButton = isPdf && (
    <Button
      block
      tone={primary === 'open' ? 'primary' : 'secondary'}
      icon={<ExternalLink aria-hidden size={16} />}
      onClick={() => void act(() => openPdf(false), t("output-center.that.file.could.not.be.saved.4d740f"))}
    >{t("output-center.open.pdf.5b1034")}</Button>
  );
  // Split set to separate PDFs (owner decision 2026-11-17): the parts are what was saved, so their
  // status leads the sheet and the ZIP is a plain "Download as one ZIP", not the filled button that
  // invites saving everything a second time.
  const partsFirst = isArchive && separate.visible && (separate.done || separate.saving || Boolean(record?.separateSave));
  const downloadButton = (primary === 'save' || !isPdf) && (
    <Button
      block
      tone={primary === 'save' && !partsFirst ? 'primary' : 'secondary'}
      busy={busy}
      icon={<Download aria-hidden size={16} />}
      onClick={() => void act(downloadResult, t("output-center.that.file.could.not.be.saved.4d740f"))}
    >{partsFirst ? t('output-center.download.asZip') : t("output-center.download.9ce5b1")}</Button>
  );
  const primaryAction = primary === 'save' ? downloadButton : primary === 'share' ? shareButton : openButton;

  const stripFace = (
    <aside
      ref={stripRef}
      role="status"
      aria-live="polite"
      data-result-slotted={slotTarget ? '' : undefined}
      data-result-from={fromTool ? record.toolPath : undefined}
      className={cx(
        'chef-result-face chef-enter',
        slotTarget
          ? 'relative'
          : cx(
            'chef-safe-x pointer-events-none fixed inset-x-2 z-40 sm:inset-x-auto sm:end-4 sm:w-[24rem]',
            onTabRoot
              ? 'bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] md:bottom-4'
              : 'bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] md:bottom-4',
          ),
      )}
    >
      <div className="chef-result-card pointer-events-auto rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 shadow-[var(--elevation-panel)]">
        <div className="flex items-center gap-2">
          {stale
            ? <Clock aria-hidden size={17} className="shrink-0 text-[var(--text-secondary)]" />
            : <CheckCircle2 aria-hidden size={17} className="shrink-0 text-[var(--status-success-text)]" />}
          {fromTool ? (
            <p className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">
              <span className="chef-filename block truncate">
                {t('output-center.from.tool', { tool: fromTool })}
                <span className="tabular text-[var(--text-secondary)]"> · {formatBytes(record.size ?? null)}</span>
              </span>
            </p>
          ) : (
          // Line 1 the file's name, cut in the middle so its end and extension stay; line 2 its
          // size (T-07). Where it is kept, and the tool's own message, are in the sheet. (Q1: the
          // place was tried on line 2; in German at 360 px it was cut away, so it stays in the sheet.)
          <p className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">
            <MiddleName name={safeName} result />
            <span className="type-footnote tabular block truncate text-[var(--text-secondary)]">
              {stale ? `${t('output-center.earlier')} · ${sizeLine}` : sizeLine}
            </span>
            {accessLocked && (
              <span className="type-footnote block text-[var(--status-caution-text)]">{t("output-center.preview.only.unlock.to.save.share.or.1b46c3")}</span>
            )}
          </p>
          )}

          {/* One tap to save (path to 9, item 3): the sheet keeps its own Download. Named with the
              file, so it is told apart from the sheet's button; shown while the sheet would offer
              Download (until a PDF is saved; always for an archive). */}
          {/* Not for an earlier result: one tap would save a file made from other settings or
              another file (final fix, item 3). More actions still offers Download. */}
          {(primary === 'save' || !isPdf) && !stale && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(downloadResult, t("output-center.that.file.could.not.be.saved.4d740f"))}
              aria-label={t('output-center.download.named', { v0: safeName })}
              className="chef-result-download chef-pressable chef-target flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] font-semibold text-[var(--accent-text)] disabled:opacity-55"
            >
              <Download aria-hidden size={18} />
              <span aria-hidden className="chef-result-download-word text-sm">{t("output-center.download.9ce5b1")}</span>
            </button>
          )}
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => { openerRef.current = moreButtonRef.current; setMoreOpen(true); }}
            aria-label={t("output-center.more.actions.for.e1329b", { v0: safeName })}
            className="chef-result-more chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--accent-text)]"
          >
            <MoreHorizontal aria-hidden size={18} />
          </button>
          <button
            type="button"
            onClick={() => { if (unsaved) discardPrompt.ask(dismiss); else dismiss(); }}
            aria-label={t("output-center.dismiss.48845b")}
            className="chef-result-dismiss chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)]"
          >
            <X aria-hidden size={16} />
          </button>
        </div>

        <SeparateAction sep={separate} variant="strip" />

        {error && (
          <div className="mt-2">
            <StatusLine tone="danger">{error}</StatusLine>
          </div>
        )}
      </div>
    </aside>
  );

  // Save name, also on Enter in the field (polish item 12).
  const saveRename = async () => {
    const requested = renameKeepingExtension(renameValue, originalExtension, safeName);
    let nextName = requested;
    let renamedCopy = false;
    const renamed = await act(async () => {
      // The copy in Downloads takes the new name too, and its name decides the
      // rest: Downloads adds " (1)" when another file already has it.
      if (saved?.exportRef && platform.renameSaved) {
        try {
          nextName = await platform.renameSaved(saved.exportRef, requested);
          renamedCopy = true;
        } catch {
          // Deleted from Downloads, or saved more than a day ago: the next
          // Download saves a new copy under the new name.
          if (recordRef.current?.id === record.id) setSaved(null);
        }
      }
      if (recent && platform.rename) await platform.rename(recent, nextName);
    }, t("output-center.that.file.could.not.be.saved.4d740f"));
    if (!renamed) return;
    setRecord(current => current?.id === record.id ? {
      ...current,
      filename: nextName,
      recentRecord: current.recentRecord ? {
        ...current.recentRecord,
        entry: { ...current.recentRecord.entry, name: nextName },
        document: current.recentRecord.document ? { ...current.recentRecord.document, name: nextName } : null,
      } : current.recentRecord,
    } : current);
    // The tool that made this result may still show its name (Create PDF's scan card).
    if (recent) announceOutputRenamed(record.id, nextName);
    if (recordRef.current?.id !== record.id) return;
    if (renamedCopy) setSaved(current => current && { ...current, savedName: nextName });
    setName(nextName);
    setRenameOpen(false);
    setMoreOpen(true);
  };

  return (
    <>
      {slotTarget ? createPortal(stripFace, slotTarget) : stripFace}

      <Sheet
        open={moreOpen}
        onClose={closeMore}
        returnFocusRef={moreButtonRef}
        returnFocusTo={sheetReturnFocus}
        dismissible={!separate.saving}
        title={stale ? t('output-center.earlier') : exported && isPdf ? t("output-center.pdf.exported.67ba14") : t("output-center.result.ready.572c0b")}
        description={`${safeName} · ${sheetSize}${keptIn}`}
      >
        <div data-result-sheet="" className="space-y-2">
          {note && <p data-output-note="" className="chef-filename type-footnote text-[var(--text-primary)]">{note}</p>}
          {/* Focus starts on the main action, not Close (research r3, desktop-08). */}
          {/* Split set to separate PDFs on an iPhone or iPad browser: the parts wait for this tap
              (the share sheet needs one), so it comes first and takes the focus (the sheet focuses
              the first marked button). */}
          {(separate.offered || partsFirst) && <div data-sheet-primary-focus=""><SeparateAction sep={separate} variant="sheet" statusFirst={partsFirst} /></div>}
          <div data-sheet-primary-focus="">{primaryAction}</div>
          {!(separate.offered || partsFirst) && <SeparateAction sep={separate} variant="sheet" />}
          {/* Rows that fill: each button takes its own width, a row wraps when the next does not
              fit, and a button alone on a row takes the whole row. No label wraps inside a
              half-width cell, and no button sits alone at half width (T-16). */}
          <div className="flex flex-wrap gap-2 [&>*]:w-auto [&>*]:flex-[1_1_auto]">
            {primary !== 'save' && downloadButton}
            {primary !== 'share' && shareButton}
            {primary !== 'open' && openButton}
            <Button
              block
              icon={<Pencil aria-hidden size={16} />}
              onClick={() => {
                setRenameValue(originalExtension
                  ? safeName.slice(0, -originalExtension.length)
                  : safeName);
                setError('');
                setMoreOpen(false);
                setRenameOpen(true);
              }}
            >{t("output-center.rename.3064d7")}</Button>
            <Button
              block
              icon={<Wrench aria-hidden size={16} />}
              onClick={() => {
                if (isPdf) {
                  void act(() => openPdf(true), t("output-center.that.file.could.not.be.saved.4d740f"));
                  return;
                }
                if (isArchive) {
                  setHandOffNote(t("android-workspace-platform.error.6e5880db7e"));
                  return;
                }
                if (unsaved) setMoreOpen(false);
                else dismiss();
                returnToTools(navigate);
              }}
            >{t("output-center.use.in.another.tool.a1c3e7")}</Button>
            {/* Keeping is offered only while the result is not in Recent. A greyed "Saved" here
                read as "saved to the phone" when the file was only inside the app. */}
            {platform.keepFresh && !retained && !recent && (
              <Button
                block
                busy={busy}
                icon={<CheckCircle2 aria-hidden size={16} />}
                onClick={() => void act(keepResult, t("output-center.that.file.could.not.be.saved.4d740f"))}
              >{t("output-center.keep.in.recent.36bf88")}</Button>
            )}
            {!accessLocked && retained && (
              <Button
                block
                icon={<Clock aria-hidden size={16} />}
                onClick={() => {
                  dismiss();
                  navigate('/recent');
                }}
              >{t("output-center.show.in.recent.dad6bc")}</Button>
            )}
          </div>
          <p role="status" className="type-footnote text-[var(--text-secondary)] empty:hidden">{handOffNote}</p>
        </div>
      </Sheet>

      <Sheet
        open={renameOpen}
        onClose={closeRename}
        title={t("output-center.rename.result.74b8c0")}
        dismissible={!busy}
        footer={
          <>
            <Button tone="secondary" disabled={busy} onClick={closeRename}>{t("output-center.cancel.19766e")}</Button>
            <Button
              tone="primary"
              busy={busy}
              disabled={busy || !renameValue.trim()}
              onClick={() => void saveRename()}
            >{t("output-center.save.name.b72972")}</Button>
          </>
        }
      >
        <label htmlFor="output-rename" data-result-sheet="" className="type-footnote block font-semibold text-[var(--text-secondary)]">{t("output-center.file.name.3efed3")}</label>
        <input
          id="output-rename"
          className="chef-field mt-1"
          value={renameValue}
          maxLength={filenameStemLimit(originalExtension)}
          data-sheet-initial-focus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setRenameValue(sanitizeFilenameStem(event.target.value));
            setError('');
          }}
          onKeyDown={(event) => {
            if (!isConfirmEnter(event)) return;
            event.preventDefault();
            if (!busy && renameValue.trim()) void saveRename();
          }}
        />
        {error && <div className="mt-2"><StatusLine tone="danger">{error}</StatusLine></div>}
      </Sheet>
      {discardPrompt.sheet}
      {previewFile && (
        <Suspense fallback={null}>
          <PDFPreviewModal
            file={previewFile}
            pageIndex={0}
            pageLabel={previewFile.name}
            onClose={() => {
              setPreviewFile(null);
              // Back to the strip the preview was opened from.
              window.requestAnimationFrame(() => moreButtonRef.current?.focus({ preventScroll: true }));
            }}
          />
        </Suspense>
      )}
    </>
  );
};
