import { t, formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ProcessingStatus } from '../../types';
import { OUTPUT_EVENT } from '../../services/workspace';

/**
 * Job status while it is running, and failures that need attention.
 *
 * A routine success is not shown here. Finishing produces a result, and the
 * result strip already says so; two overlays stacked in the same corner saying
 * the same thing was the repeated popup people rejected. So a success message
 * clears itself quickly, and it is suppressed outright when a result strip is
 * about to take its place. A failure stays until it is read.
 */

const SUCCESS_CLEAR_MS = 3500;
/** A result strip appearing within this window owns the success message. */
const OUTPUT_HANDOFF_MS = 1500;

export const StatusToast: React.FC<{ status: ProcessingStatus }> = ({ status }) => {
  useI18n();
  const [dismissedSuccess, setDismissedSuccess] = useState(false);
  const outputAt = useRef(0);

  useEffect(() => {
    const onOutput = () => {
      outputAt.current = Date.now();
    };
    window.addEventListener(OUTPUT_EVENT, onOutput);
    return () => window.removeEventListener(OUTPUT_EVENT, onOutput);
  }, []);

  const message = status.error || status.message;
  const failed = Boolean(status.error);

  useEffect(() => {
    setDismissedSuccess(false);
    if (status.isProcessing || failed || !message) return undefined;
    const timer = window.setTimeout(() => setDismissedSuccess(true), SUCCESS_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [failed, message, status.isProcessing]);

  if (status.isProcessing) {
    const progress = Math.max(0, Math.min(100, Number.isFinite(status.progress) ? status.progress : 0));
    const determinate = progress > 0;

    return createPortal(
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="chef-enter chef-safe-x fixed inset-x-2 bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] z-40 sm:inset-x-auto sm:end-4 sm:w-80 md:bottom-4"
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
  // A result strip has just claimed this corner; do not stack a second one.
  if (!failed && Date.now() - outputAt.current < OUTPUT_HANDOFF_MS) return null;
  if (!failed && dismissedSuccess) return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="chef-enter chef-safe-x fixed inset-x-2 bottom-[calc(var(--size-tab-bar-readable)+env(safe-area-inset-bottom)+0.5rem)] z-40 sm:inset-x-auto sm:end-4 sm:max-w-sm md:bottom-4"
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
        <span className="chef-filename">{message}</span>
      </p>
    </div>,
    document.body,
  );
};
