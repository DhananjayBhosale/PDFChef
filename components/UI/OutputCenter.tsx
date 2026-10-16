import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, Download, ExternalLink, MoreHorizontal, Pencil, Share2, Wrench, X } from 'lucide-react';
import type { OutputReadyRecord } from '../../services/pdfShared';
import { OUTPUT_DISMISS_EVENT, OUTPUT_EVENT, OUTPUT_RENAMED_EVENT, announceOutputRenamed, announceRecordsChanged, getWorkspaceSettings } from '../../services/workspace';
import { Button, Sheet, StatusLine, cx } from './Primitives';
import { formatBytes, renameKeepingExtension, sanitizeFilenameStem, splitFilename } from './format';
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const recordRef = useRef<OutputReadyRecord | null>(null);
  recordRef.current = record;
  const closeMore = useCallback(() => setMoreOpen(false), []);
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
      setName(typeof next.filename === 'string' ? next.filename : '');
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

  // A failed save stays retryable; any other result gives way to the next document.
  useEffect(() => {
    const onDismiss = () => { if (!recordRef.current?.deliveryIssue) dismiss(); };
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

  // A failed save must remain retryable across navigation until dismissed.
  useEffect(() => {
    if (!recordRef.current?.deliveryIssue) abandonPendingSave();
    setRecord(current => current?.deliveryIssue ? current : null);
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

  const downloadResult = async () => {
    const download = () => recent ? platform.save(recent, safeName) : platform.saveFresh(result!);
    if (!accessLocked) {
      await download();
      return;
    }
    // The preview's operation ID is its metering key: saving it records that job against
    // fresh native state instead of trusting a cached free count.
    const accessResult = await runWithExportAccess(download, { operationId: record.id });
    return accessResult.status !== 'blocked';
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
    dismiss();
    navigate('/view', { state: { openTools: openTools && !accessLocked, openedPdfId: opened.id } });
  };

  return (
    <>
      <aside
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
                {retained ? t("output-center.kept.on.this.device.c76dee") : t("output-center.available.until.dismissed.a4288a")}
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
              onClick={dismiss}
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
          <Button
            block
            busy={busy}
            disabled={!platform.keepFresh || retained || Boolean(recent)}
            icon={<CheckCircle2 aria-hidden size={16} />}
            onClick={() => void act(keepResult, t("output-center.that.file.could.not.be.saved.4d740f"))}
          >{t("output-center.save.1509f5")}</Button>
          <Button
            block
            disabled={recent ? !platform.share : !platform.shareFresh}
            icon={<Share2 aria-hidden size={16} />}
            onClick={() => void act(async () => {
              const share = () => recent ? platform.share!(recent, safeName) : platform.shareFresh!(result!);
              if (!(recent ? platform.share : platform.shareFresh)) return false;
              if (!accessLocked) return share();
              const accessResult = await runWithExportAccess(share, { operationId: record.id });
              return accessResult.status !== 'blocked';
            }, t("output-center.sharing.did.not.complete.bf9347"))}
          >{t("output-center.share.29887a")}</Button>
          <Button
            block
            icon={<Download aria-hidden size={16} />}
            onClick={() => {
              setNotice('');
              void act(downloadResult, t("output-center.that.file.could.not.be.saved.4d740f")).then((saved) => {
                // Each press saves another copy; without a word here it looked like nothing happened.
                if (saved && recordRef.current?.id === record.id) setNotice(`Saved ${safeName}.`);
              });
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
              dismiss();
              navigate('/');
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
                const nextName = renameKeepingExtension(renameValue, originalExtension, safeName);
                if (recent && platform.rename) {
                  const renamed = await act(() => platform.rename!(recent, nextName), t("output-center.that.file.could.not.be.saved.4d740f"));
                  if (!renamed) return;
                  setRecord(current => current?.id === record.id ? {
                    ...current,
                    filename: nextName,
                    recentRecord: {
                      ...recent,
                      entry: { ...recent.entry, name: nextName },
                      document: recent.document ? { ...recent.document, name: nextName } : null,
                    },
                  } : current);
                  // The tool that made this result may still show its name (Create PDF's scan card).
                  announceOutputRenamed(record.id, nextName);
                }
                if (recordRef.current?.id !== record.id) return;
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
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setRenameValue(sanitizeFilenameStem(event.target.value));
            setError('');
          }}
        />
        {error && <div className="mt-2"><StatusLine tone="danger">{error}</StatusLine></div>}
      </Sheet>
    </>
  );
};
