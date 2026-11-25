import { t, formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ErrorText } from './ErrorText';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ProcessingStatus } from '../../types';
import { OUTPUT_EVENT } from '../../services/workspace';
import { announceOutputNote } from './outputNote';
import { dropZoneShown, setDropZoneError } from './dropZone';

/**
 * Job status while it is running, and failures that need attention.
 *
 * A routine success is not shown here when a result strip appears with it: two
 * overlays stacked in the same corner was the repeated popup people rejected. The
 * success message goes to the strip instead, as its notice line under "PDF exported"
 * (owner decision 2), so a tool's own line ("Test every field before sharing.") is
 * still read. A success with no result clears itself quickly. A failure stays until
 * it is read.
 */

const SUCCESS_CLEAR_MS = 3500;
/** A result strip appearing within this window after the message takes it over. */
const OUTPUT_HANDOFF_MS = 1500;
/** A message set this long before its result (set, then saved) is also handed over. */
const MESSAGE_BEFORE_OUTPUT_MS = 5000;

/**
 * The bottom offset that keeps the toast above a tool's foot bar (B-032): the bar holds
 * the main action, which the toast must not cover. Null when no foot bar is on screen.
 */
const useFootbarInset = (active: boolean) => {
  const [inset, setInset] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setInset(null);
      return undefined;
    }
    const bars = () => Array.from(document.querySelectorAll<HTMLElement>('.tk-footbar')).filter((bar) => bar.getClientRects().length > 0);
    const measure = () => {
      const shown = bars();
      const top = Math.min(...shown.map((bar) => bar.getBoundingClientRect().top));
      setInset(shown.length && top < window.innerHeight ? Math.round(window.innerHeight - top + 8) : null);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    bars().forEach((bar) => observer?.observe(bar));
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active]);
  return inset;
};

/**
 * True inside a tool screen that draws its own progress line while it works; the
 * floating "working" card then stays away, so there is one progress bar, not two.
 */
export const ToolProgressShownContext = createContext(false);

export const StatusToast: React.FC<{ status: ProcessingStatus }> = ({ status }) => {
  useI18n();
  const toolShowsProgress = useContext(ToolProgressShownContext);
  const [dismissedSuccess, setDismissedSuccess] = useState(false);
  const outputAt = useRef(0);
  /** The success message a result strip took over stays hidden on later renders. */
  const handedOff = useRef<string | null>(null);
  /** The current success message and when it was set. */
  const success = useRef<{ message: string; at: number }>({ message: '', at: 0 });

  const message = status.error || status.message;
  const failed = Boolean(status.error);
  const successMessage = !status.isProcessing && !failed && message ? message : '';
  const footInset = useFootbarInset(Boolean(status.isProcessing || message));
  const handToDropZone = failed && !status.isProcessing && dropZoneShown();
  useEffect(() => {
    if (!handToDropZone || !status.error) return undefined;
    setDropZoneError(status.error);
    return () => setDropZoneError('');
  }, [handToDropZone, status.error]);
  const footStyle = footInset !== null ? { bottom: footInset } : undefined;

  useEffect(() => {
    const onOutput = () => {
      const now = Date.now();
      outputAt.current = now;
      setDismissedSuccess(true);
      // The message came first (set, then saved): it belongs to this result.
      const current = success.current;
      if (current.message && now - current.at < MESSAGE_BEFORE_OUTPUT_MS) {
        handedOff.current = current.message;
        announceOutputNote(current.message);
      }
    };
    window.addEventListener(OUTPUT_EVENT, onOutput);
    return () => window.removeEventListener(OUTPUT_EVENT, onOutput);
  }, []);

  useEffect(() => {
    const now = Date.now();
    success.current = { message: successMessage, at: now };
    // The result came first (saved, then the message): the strip shows it.
    if (successMessage && now - outputAt.current < OUTPUT_HANDOFF_MS && handedOff.current !== successMessage) {
      handedOff.current = successMessage;
      announceOutputNote(successMessage);
    }
  }, [successMessage]);

  useEffect(() => {
    setDismissedSuccess(false);
    if (status.isProcessing || failed || !message) return undefined;
    const timer = window.setTimeout(() => setDismissedSuccess(true), SUCCESS_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [failed, message, status.isProcessing]);

  if (status.isProcessing) {
    if (toolShowsProgress) return null;
    const progress = Math.max(0, Math.min(100, Number.isFinite(status.progress) ? status.progress : 0));
    const determinate = progress > 0;

    return createPortal(
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="chef-enter chef-safe-x fixed inset-x-2 bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] z-40 sm:inset-x-auto sm:end-4 sm:w-80 md:bottom-4"
        style={footStyle}
      >
        <div className="rounded-[var(--radius-field)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2.5 shadow-[var(--elevation-panel)]">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            <Loader2 aria-hidden size={16} className="shrink-0 animate-spin text-[var(--accent-text)]" />
            <span className="min-w-0 flex-1 truncate">{status.message || t("status-toast.working.on.this.device.b4ed58")}</span>
            {determinate && <span className="tabular shrink-0 text-[var(--text-secondary)]">{formatPercent(progress)}</span>}
          </div>
          <div
            role="progressbar"
            aria-label={t("status-toast.processing.progress.8a3009")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={determinate ? Math.round(progress) : undefined}
            className="mt-1.5 h-1 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--surface-sunken)]"
          >
            <span
              aria-hidden
              className={
                determinate
                  ? 'block h-full bg-[var(--accent-rest)] transition-[width] duration-transition ease-settle'
                  : 'chef-progress-indeterminate block h-full w-1/2 bg-[var(--accent-rest)]'
              }
              style={determinate ? { width: `${progress}%` } : undefined}
            />
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (!message) return null;
  // A file that did not open: its reason goes inside the drop zone on screen (T-09).
  if (failed && handToDropZone) return null;
  // A result strip has just claimed this corner; do not stack a second one.
  if (!failed && Date.now() - outputAt.current < OUTPUT_HANDOFF_MS) {
    handedOff.current = message;
    return null;
  }
  if (!failed && handedOff.current === message) return null;
  if (!failed && dismissedSuccess) return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="chef-enter chef-safe-x fixed inset-x-2 bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] z-40 sm:inset-x-auto sm:end-4 sm:max-w-sm md:bottom-4"
      style={footStyle}
    >
      <p
        className="flex items-start gap-2 rounded-[var(--radius-field)] border px-3 py-2.5 text-sm font-medium shadow-[var(--elevation-panel)]"
        style={{
          borderColor: failed ? 'var(--status-danger-text)' : 'var(--border-strong)',
          background: failed ? 'var(--status-danger-quiet)' : 'var(--surface-raised)',
          color: failed ? 'var(--status-danger-text)' : 'var(--text-primary)',
        }}
      >
        {failed && <AlertTriangle aria-hidden size={16} className="mt-0.5 shrink-0" />}
        <span className="chef-filename">{failed ? <ErrorText text={message} /> : message}</span>
      </p>
    </div>,
    document.body,
  );
};
