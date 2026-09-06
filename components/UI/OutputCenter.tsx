import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, Download, ExternalLink, Pencil, Share2, X } from 'lucide-react';
import type { OutputRecord } from '../../services/workspace';
import { OUTPUT_EVENT, getWorkspaceSettings } from '../../services/workspace';
import { Button, Sheet, StatusLine, cx } from './Primitives';
import { formatBytes, splitFilename } from './format';
import {
  FALLBACK_DOCUMENT_NAME,
  FALLBACK_MIME_TYPE,
  useHaptics,
  useWorkspacePlatform,
} from '../../hooks/useWorkspaceRuntime';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';

/**
 * What happens after a job finishes.
 *
 * With "save on finish" on, the save flow already owns the outcome and the tool
 * shows its own inline completion, so this renders nothing at all. A floating
 * strip on top of that was a second notice for one event, and it could not
 * honestly say "Saved" either: a native or browser export can still fail or be
 * cancelled after the app has handed the bytes over.
 *
 * With that setting off, the result genuinely needs an action, so one compact
 * "Result ready" strip carries Save with everything else behind More.
 */

export const OutputCenter: React.FC = () => {
  const platform = useWorkspacePlatform();
  const haptic = useHaptics();
  const navigate = useNavigate();
  const location = useLocation();
  const { setOpenedPdfFile } = useOpenedPdf();

  const [record, setRecord] = useState<OutputRecord | null>(null);
  const [retained, setRetained] = useState(false);
  const [name, setName] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dismiss = useCallback(() => {
    setRecord(null);
    setMoreOpen(false);
    setRenameOpen(false);
    setError('');
  }, []);

  useEffect(() => {
    const onOutput = (event: Event) => {
      const next = (event as CustomEvent<OutputRecord>).detail;
      if (!next) return;
      const settings = getWorkspaceSettings();
      // Save on finish: the tool's own inline state and Recent are the record of
      // what happened. Nothing floats over the page.
      if (settings.autoDownload) {
        haptic('commit');
        return;
      }
      setRecord(next);
      setName(typeof next.filename === 'string' ? next.filename : '');
      setRetained(settings.keepLocalHistory);
      setError('');
      haptic('commit');
    };
    window.addEventListener(OUTPUT_EVENT, onOutput);
    return () => window.removeEventListener(OUTPUT_EVENT, onOutput);
  }, [haptic]);

  // Leaving the screen ends the result: it belonged to the job just finished.
  useEffect(() => {
    dismiss();
  }, [location.pathname, dismiss]);

  const typed = name.trim() || record?.filename?.trim() || FALLBACK_DOCUMENT_NAME;
  const originalExtension = splitFilename(record?.filename?.trim() || '').extension;
  const safeName =
    splitFilename(typed).extension || !originalExtension ? typed : `${typed}${originalExtension}`;
  const mimeType = record?.mimeType || record?.blob?.type || FALLBACK_MIME_TYPE;
  const isPdf = mimeType === 'application/pdf' || safeName.toLowerCase().endsWith('.pdf');

  const act = useCallback(
    async (action: () => Promise<void>, failure: string) => {
      setBusy(true);
      setError('');
      try {
        await action();
        haptic('commit');
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        haptic('error');
        setError(caught instanceof Error && caught.message ? caught.message : failure);
      } finally {
        setBusy(false);
      }
    },
    [haptic],
  );

  if (!record) return null;
  const result = { blob: record.blob, name: safeName, mimeType };

  return (
    <>
      <aside
        role="status"
        aria-live="polite"
        className={cx(
          'chef-enter chef-safe-x pointer-events-none fixed inset-x-2 z-40 sm:inset-x-auto sm:right-4 sm:w-[24rem]',
          'bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] md:bottom-4',
        )}
      >
        <div className="pointer-events-auto rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 shadow-[var(--elevation-panel)]">
          <div className="flex items-center gap-2">
            <CheckCircle2 aria-hidden size={17} className="shrink-0 text-[var(--status-success-text)]" />
            <p className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">
              <span className="chef-filename block truncate">Result ready</span>
              <span className="type-footnote tabular block text-[var(--text-secondary)]">
                {formatBytes(record.size ?? null)}
                {retained ? ' · kept on this device' : ' · not kept'}
              </span>
            </p>

            <Button
              tone="primary"
              busy={busy}
              className="h-9 shrink-0 px-3"
              icon={<Download aria-hidden size={15} />}
              onClick={() => void act(() => platform.saveFresh(result), 'That file could not be saved.')}
            >
              Save
            </Button>

            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label={`More actions for ${safeName}`}
              className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--accent-text)]"
            >
              <Pencil aria-hidden size={16} />
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
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

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={safeName} description={formatBytes(record.size ?? null)}>
        <div className="space-y-2">
          <Button
            block
            icon={<Pencil aria-hidden size={16} />}
            onClick={() => {
              setRenameValue(safeName);
              setMoreOpen(false);
              setRenameOpen(true);
            }}
          >
            Rename
          </Button>
          {isPdf && (
            <Button
              block
              icon={<ExternalLink aria-hidden size={16} />}
              onClick={() => {
                setOpenedPdfFile(new File([record.blob], safeName, { type: 'application/pdf' }));
                haptic('selection');
                dismiss();
                navigate('/view');
              }}
            >
              Open PDF
            </Button>
          )}
          {platform.shareFresh && (
            <Button
              block
              icon={<Share2 aria-hidden size={16} />}
              onClick={() => void act(() => platform.shareFresh!(result), 'Sharing did not complete.').then(() => setMoreOpen(false))}
            >
              Share
            </Button>
          )}
          {retained && (
            <Button
              block
              icon={<Clock aria-hidden size={16} />}
              onClick={() => {
                dismiss();
                navigate('/recent');
              }}
            >
              Show in Recent
            </Button>
          )}
        </div>
      </Sheet>

      <Sheet
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename result"
        footer={
          <>
            <Button tone="secondary" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={!renameValue.trim()}
              onClick={() => {
                setName(renameValue.trim());
                setRenameOpen(false);
              }}
            >
              Save name
            </Button>
          </>
        }
      >
        <label htmlFor="output-rename" className="type-footnote block font-semibold text-[var(--text-secondary)]">
          File name
        </label>
        <input
          id="output-rename"
          className="chef-field mt-1"
          value={renameValue}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setRenameValue(event.target.value)}
        />
      </Sheet>
    </>
  );
};
