import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, Download, ExternalLink, MoreHorizontal, Pencil, Share2, Wrench, X } from 'lucide-react';
import type { OutputReadyRecord } from '../../services/pdfShared';
import { OUTPUT_DISMISS_EVENT, OUTPUT_EVENT, OUTPUT_RENAMED_EVENT, announceOutputRenamed, announceRecordsChanged, getWorkspaceSettings } from '../../services/workspace';
import { Button, Sheet, StatusLine, cx } from './Primitives';
import { filenameStemLimit, formatBytes, renameKeepingExtension, sanitizeFilenameStem, splitFilename } from './format';
import type { SavedCopy } from '../../services/platform/contracts';
import { useDiscardPrompt } from '../../hooks/useConfirmDiscard';
import { returnToTools } from '../Layout/navigationHistory';
import {
  FALLBACK_DOCUMENT_NAME,
  FALLBACK_MIME_TYPE,
  useHaptics,
  useWorkspacePlatform,
} from '../../hooks/useWorkspaceRuntime';
import { useMonetization } from '../../hooks/useMonetization';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';

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
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const recordRef = useRef<OutputReadyRecord | null>(null);
  recordRef.current = record;
  // Nothing else holds this result: not Recent, not Downloads, not a share target.
  const unsaved = Boolean(record?.blob && !record.recentRecord && !record.accessLocked && !retained && !exported && !shared);
  const unsavedRef = useRef(false);
  unsavedRef.current = unsaved;
  const discardPrompt = useDiscardPrompt({ title: t("output-center.this.result.is.not.saved.discard.it.95f518") });
  const folder = platform.capabilities.exportFolder;
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const stripRef = useRef<HTMLElement | null>(null);
  const stripVisible = Boolean(record?.blob || record?.recentRecord);

  // The page leaves room for the strip, so it never covers a tool's last row or main button.
  useEffect(() => {
    const root = document.documentElement;
    const strip = stripRef.current;
    if (!stripVisible || !strip) return undefined;
    const measure = () => root.style.setProperty(
      '--chef-output-strip-space', `${Math.ceil(strip.getBoundingClientRect().height) + 8}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--chef-output-strip-space');
    };
  }, [stripVisible]);
  const closeRename = useCallback(() => setRenameOpen(false), []);

  // A Save waiting behind the paywall belongs to this result. Once the result is
  // gone, a later purchase or restore must not run it.
  const abandonPendingSave = useCallback(() => {
    if (recordRef.current) cancelPendingExport(recordRef.current.id);
  }, [cancelPendingExport]);

  const dismiss = useCallback(() => {
    abandonPendingSave();
    setRecord(null);
    setMoreOpen(false);
    setExported(false);
    setSaved(null);
    setShared(false);
    setNotice('');
    setRenameOpen(false);
    setError('');
  }, [abandonPendingSave]);

  useEffect(() => {
    const onOutput = (event: Event) => {
      const next = (event as CustomEvent<OutputReadyRecord>).detail;
      if (!next?.blob && !next?.recentRecord) return;
      const settings = getWorkspaceSettings();
      abandonPendingSave();
      setRecord(next);
      setSaved(next.savedCopy ?? null);
      setShared(false);
      // Downloads adds " (1)" to a name that is taken; show the name the file really has.
      setName(next.savedCopy?.savedName ?? (typeof next.filename === 'string' ? next.filename : ''));
      setRetained(next.historyRetained ?? settings.keepLocalHistory);
      setExported(next.externallyExported ?? (
        settings.autoDownload && !next.recentRecord && !next.deliveryIssue && !next.accessLocked
      ));
      setMoreOpen(true);
      setRenameOpen(false);
      setNotice('');
      setError(next.deliveryIssue === 'cancelled'
        ? t("output-center.save.cancelled.your.result.is.still.available.79e0fc")
        : next.deliveryIssue === 'failed'
          ? t("output-center.saving.did.not.complete.try.save.again.044526")
          : '');
      haptic(next.deliveryIssue ? 'warning' : 'commit');
    };
    window.addEventListener(OUTPUT_EVENT, onOutput);
    return () => window.removeEventListener(OUTPUT_EVENT, onOutput);
  }, [abandonPendingSave, haptic]);

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

  const savedMessage = (savedName: string) => folder
    ? t("output-center.saved.to.as.cf91b2", { v0: folder, v1: savedName })
    : t("output-center.saved.4a9b73", { v0: savedName });

  const downloadResult = async () => {
    // A copy already in Downloads is reported, not copied again: repeated taps used to leave
    // "Name.pdf", "Name (1).pdf" and "Name (2).pdf" side by side.
    if (saved?.exportRef && platform.renameSaved) {
      try {
        const savedName = await platform.renameSaved(saved.exportRef, saved.savedName);
        if (recordRef.current?.id === record.id) setNotice(savedMessage(savedName));
        return true;
      } catch {
        // Deleted from Downloads, or saved more than a day ago: save a new copy.
      }
    }
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
    setNotice(savedMessage(kept ? kept.savedName : safeName));
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
    const opened = setOpenedPdfFile(file, {
      provenance: accessLocked ? 'preview' : 'retained',
      previewOnly: accessLocked,
    });
    // An unsaved result stays on the strip, so it can still be saved after a look.
    if (unsaved) setMoreOpen(false);
    else dismiss();
    navigate('/view', { state: { openTools: openTools && !accessLocked, openedPdfId: opened.id } });
  };

  return (
    <>
      <aside
        ref={stripRef}
        role="status"
        aria-live="polite"
        className={cx(
          'chef-enter chef-safe-x pointer-events-none fixed inset-x-2 z-40 sm:inset-x-auto sm:end-4 sm:w-[24rem]',
          'bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] md:bottom-4',
        )}
      >
        <div className="pointer-events-auto rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 shadow-[var(--elevation-panel)]">
          <div className="flex items-center gap-2">
            <CheckCircle2 aria-hidden size={17} className="shrink-0 text-[var(--status-success-text)]" />
            <p className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">
              <span className="chef-filename block truncate">{exported && isPdf ? t("output-center.pdf.exported.67ba14") : t("output-center.result.ready.572c0b")}</span>
              <span className="type-footnote tabular block text-[var(--text-secondary)]">
                {formatBytes(record.size ?? null)}
                {exported && folder
                  ? t("output-center.in.6ca2da", { v0: folder })
                  : retained ? t("output-center.kept.on.this.device.c76dee") : t("output-center.available.until.dismissed.a4288a")}
              </span>
              {accessLocked && (
                <span className="type-footnote block text-[var(--status-caution-text)]">{t("output-center.preview.only.unlock.to.save.share.or.1b46c3")}</span>
              )}
            </p>

            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label={t("output-center.more.actions.for.e1329b", { v0: safeName })}
              className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--accent-text)]"
            >
              <MoreHorizontal aria-hidden size={18} />
            </button>
            <button
              type="button"
              onClick={() => { if (unsaved) discardPrompt.ask(dismiss); else dismiss(); }}
              aria-label={t("output-center.dismiss.48845b")}
              className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)]"
            >
              <X aria-hidden size={16} />
            </button>
          </div>

          {error && (
            <div className="mt-2">
              <StatusLine tone="danger">{error}</StatusLine>
            </div>
          )}
        </div>
      </aside>

      <Sheet
        open={moreOpen}
        onClose={closeMore}
        title={exported && isPdf ? t("output-center.pdf.exported.67ba14") : t("output-center.result.ready.572c0b")}
        description={`${safeName} · ${formatBytes(record.size ?? null)}`}
      >
        <div className="space-y-2">
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
          <Button
            block
            disabled={recent ? !platform.share : !platform.shareFresh}
            icon={<Share2 aria-hidden size={16} />}
            onClick={() => void act(async () => {
              const share = () => recent ? platform.share!(recent, safeName) : platform.shareFresh!(result!);
              if (!(recent ? platform.share : platform.shareFresh)) return false;
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
          <Button
            block
            icon={<Download aria-hidden size={16} />}
            onClick={() => {
              setNotice('');
              void act(downloadResult, t("output-center.that.file.could.not.be.saved.4d740f"));
            }}
          >{t("output-center.download.9ce5b1")}</Button>
          {notice && <StatusLine tone="success">{notice}</StatusLine>}
          <Button
            block
            icon={<Wrench aria-hidden size={16} />}
            onClick={() => {
              if (isPdf) {
                void act(() => openPdf(true), t("output-center.that.file.could.not.be.saved.4d740f"));
                return;
              }
              if (unsaved) setMoreOpen(false);
              else dismiss();
              returnToTools(navigate);
            }}
          >{t("app-shell.tools.ea93d6")}</Button>
          <div className="border-t border-[var(--border-hairline)] pt-2" />
          {isPdf && (
            <Button
              block
              icon={<ExternalLink aria-hidden size={16} />}
              onClick={() => void act(() => openPdf(false), t("output-center.that.file.could.not.be.saved.4d740f"))}
            >{t("output-center.open.pdf.5b1034")}</Button>
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
      </Sheet>

      <Sheet
        open={renameOpen}
        onClose={closeRename}
        title={t("output-center.rename.result.74b8c0")}
        dismissible={!busy}
        footer={
          <>
            <Button tone="secondary" disabled={busy} onClick={() => setRenameOpen(false)}>{t("output-center.cancel.19766e")}</Button>
            <Button
              tone="primary"
              busy={busy}
              disabled={busy || !renameValue.trim()}
              onClick={() => void (async () => {
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
                if (renamedCopy) {
                  setSaved(current => current && { ...current, savedName: nextName });
                  setNotice(savedMessage(nextName));
                } else {
                  setNotice('');
                }
                setName(nextName);
                setRenameOpen(false);
                setMoreOpen(true);
              })()}
            >{t("output-center.save.name.b72972")}</Button>
          </>
        }
      >
        <label htmlFor="output-rename" className="type-footnote block font-semibold text-[var(--text-secondary)]">{t("output-center.file.name.3efed3")}</label>
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
        />
        {error && <div className="mt-2"><StatusLine tone="danger">{error}</StatusLine></div>}
      </Sheet>
      {discardPrompt.sheet}
    </>
  );
};
