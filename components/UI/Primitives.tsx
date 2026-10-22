import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';

/**
 * The shared component vocabulary. One button shape, one field shape, one
 * confirmation. If a control looks different on two screens, one of them is
 * wrong, so both come from here.
 */

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* -------------------------------------------------------------- Button --- */

type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'destructive';

const toneClass: Record<ButtonTone, string> = {
  primary:
    'bg-[var(--accent-rest)] text-[var(--text-on-accent)] border border-transparent hover:bg-[var(--accent-hover)]',
  secondary:
    'bg-[var(--surface-raised)] text-[var(--text-primary)] border border-[var(--border-strong)] hover:border-[var(--accent-rest)]',
  quiet:
    'bg-transparent text-[var(--accent-text)] border border-transparent hover:bg-[var(--accent-quiet)]',
  destructive:
    'bg-transparent text-[var(--status-danger-text)] border border-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  /** Renders a spinner and blocks repeat presses without changing the label. */
  busy?: boolean;
  block?: boolean;
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ tone = 'secondary', busy = false, block = false, icon, children, className, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={cx(
        'chef-pressable chef-target inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 text-sm font-semibold',
        'disabled:cursor-not-allowed disabled:opacity-55',
        block && 'w-full',
        toneClass[tone],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : icon}
      <span className="chef-wrap-words">{children}</span>
    </button>
  ),
);
Button.displayName = 'Button';

/* --------------------------------------------------------------- Badge --- */

type BadgeTone = 'neutral' | 'caution' | 'success' | 'danger' | 'accent';

const badgeTone: Record<BadgeTone, string> = {
  neutral: 'border-[var(--border-hairline)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  caution: 'border-[var(--status-caution-text)] bg-[var(--status-caution-quiet)] text-[var(--status-caution-text)]',
  success: 'border-[var(--status-success-text)] bg-[var(--status-success-quiet)] text-[var(--status-success-text)]',
  danger: 'border-[var(--status-danger-text)] bg-[var(--status-danger-quiet)] text-[var(--status-danger-text)]',
  accent: 'border-transparent bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]',
};

export const Badge: React.FC<{ tone?: BadgeTone; children: React.ReactNode; className?: string }> = ({
  tone = 'neutral',
  children,
  className,
}) => { return (
  <span
    className={cx(
      'type-caption inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border px-2 py-0.5 uppercase tracking-[0.08em]',
      badgeTone[tone],
      className,
    )}
  >
    {children}
  </span>
); };

/* --------------------------------------------------- Segmented control --- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Radio group in a segmented shell. Arrow keys move between options because it
 * is a radio group, not a toolbar, and that is what VoiceOver announces.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  columns,
}: {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  /**
   * Fixed columns instead of the rem-basis wrap. A short, known set of choices
   * reads as one row; the rem basis exists for labels whose width is unknown.
   */
  columns?: 3 | 4;
}) {
  const group = useRef<HTMLDivElement>(null);

  // Arrow keys move between options because this is a radio group, which is what
  // VoiceOver announces and what a keyboard user will reach for. Roving tabindex
  // means the old option stops being focusable the moment the value changes, so
  // focus has to follow the selection or it lands back on the document.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const rtl = group.current && getComputedStyle(group.current).direction === 'rtl';
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    window.requestAnimationFrame(() => {
      group.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
    });
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        'w-full rounded-[var(--radius-field)] bg-[var(--surface-raised)]',
        // Without `columns` the options wrap on a rem basis, which is right when
        // the label widths are unknown. With it they hold one row on a phone,
        // and only a four-up set drops to 2x2 below 360px.
        // A segment's visual box is the 44px phone touch height and its
        // pressable region is extended to the 48px floor. Any strip that can
        // wrap carries a row gap wider than that extension, or the regions of
        // two stacked rows would overlap.
        !columns && 'flex flex-wrap gap-x-1 gap-y-2.5',
        columns === 3 && 'grid grid-cols-3 gap-1',
        columns === 4 && 'grid grid-cols-2 gap-x-1 gap-y-2.5 min-[360px]:grid-cols-4 min-[360px]:gap-1',
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            // Every option is drawn as its own chip. An unselected segment with
            // no edge of its own dissolves into the track, so a two-option
            // strip reads as one bar with a label floating beside the choice
            // rather than as two things to choose between. The selected chip
            // keeps a transparent border so gaining the raised surface never
            // moves anything.
            className={cx(
              'chef-pressable chef-hit-y grid min-h-11 min-w-0 place-items-center rounded-[var(--radius-field)] border px-1.5 text-sm font-semibold',
              !columns && 'flex-1 basis-[6.5rem] px-2',
              selected
                ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)] shadow-[var(--elevation-raised)]'
                : 'border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-secondary)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- Switch --- */

export const Switch: React.FC<{
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (next: boolean) => void;
}> = ({ label, detail, checked, disabled = false, disabledReason, onChange }) => {
  const id = useId();
  const describedBy = detail || disabledReason ? `${id}-detail` : undefined;

  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={cx('block font-semibold', disabled && 'opacity-60')}>
          {label}
        </label>
        {(detail || disabledReason) && (
          <p id={describedBy} className="type-footnote mt-1 max-w-measure text-[var(--text-secondary)]">
            {disabled && disabledReason ? disabledReason : detail}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        // The switch keeps its 51x31 iOS proportions; `chef-hit` grows the
        // pressable area to 44pt without moving a pixel of the visual.
        className={cx(
          'chef-pressable chef-hit relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-[var(--radius-pill)] border transition-colors duration-tap ease-settle',
          'disabled:cursor-not-allowed disabled:opacity-55',
          checked
            ? 'border-transparent bg-[var(--accent-rest)]'
            : 'border-[var(--border-strong)] bg-[var(--surface-sunken)]',
        )}
      >
        <span
          aria-hidden
          className={cx(
            // Transform, not `left`: the knob must not run a layout animation.
            'absolute start-[2px] top-1/2 block h-[25px] w-[25px] rounded-full bg-[var(--surface-raised)] shadow-[var(--elevation-raised)]',
            'transition-transform duration-transition ease-settle',
            checked ? '-translate-y-1/2 translate-x-[20px] rtl:-translate-x-[20px]' : '-translate-y-1/2 translate-x-0',
          )}
        />
      </button>
    </div>
  );
};

/* --------------------------------------------------------------- Portal --- */

/**
 * Renders into the document body.
 *
 * `position: fixed` resolves against the nearest transformed ancestor, and the
 * route wrapper is transformed for its entrance animation, so any overlay
 * declared inside a route anchors to the page rather than the viewport. Every
 * true modal goes through here so it is genuinely viewport-fixed and paints
 * above the shell chrome.
 */
export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  { return typeof document === 'undefined' ? null : createPortal(<>{children}</>, document.body); };

/* --------------------------------------------------------------- Sheet --- */

/**
 * Modal sheet. Used only where the task genuinely blocks: a destructive
 * confirmation, a rename, a first-run explanation. Focus is trapped, Escape
 * closes, and focus returns to whatever opened it.
 */
export const Sheet: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Hides the close affordance for a first-run flow that has its own exit. */
  dismissible?: boolean;
}> = ({ open, onClose, title, description, children, footer, dismissible = true }) => {
  useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Callers pass inline closures, so onClose changes on every keystroke in a
  // field inside the sheet. Reading it through a ref keeps the effect below from
  // re-running and moving focus off the field after the first character.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      panel.current ? Array.from(panel.current.querySelectorAll<HTMLElement>(selector)) : [];
    // A rename field opens focused with its text selected, so typing replaces the old name.
    const field = panel.current?.querySelector<HTMLInputElement>('input[data-sheet-initial-focus]');
    const preferred = panel.current?.querySelector<HTMLElement>('[data-sheet-primary-focus] button:not([disabled])');
    if (field) {
      field.focus();
      field.select();
    } else {
      (preferred || focusables()[0])?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Android Back arrives as Escape. A sheet that cannot close yet still holds it, so Back
      // does not leave the screen behind a running rename or save.
      if (event.key === 'Escape') {
        event.preventDefault();
        if (dismissible) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [dismissible, open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="chef-safe-x fixed inset-0 z-[100] flex items-end justify-center sm:items-center"
      style={{ background: 'var(--surface-scrim)' }}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cx(
          'chef-enter-sheet chef-safe-bottom chef-scroller w-full max-w-lg overflow-y-auto',
          'max-h-[calc(100dvh-env(safe-area-inset-top))] overscroll-contain',
          'rounded-t-[var(--radius-sheet)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4 shadow-[var(--elevation-sheet)] sm:p-5',
          'sm:max-h-[calc(100dvh-2rem)] sm:rounded-[var(--radius-sheet)]',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="type-title3 font-semibold text-[var(--text-primary)]">
            {title}
          </h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("primitives.close.7d9eb7")}
              className="chef-pressable chef-target -me-2 -mt-2 grid place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <X aria-hidden size={20} />
            </button>
          )}
        </div>
        {description && (
          <p id={descriptionId} className="mt-2 max-w-measure text-[var(--text-secondary)]">
            {description}
          </p>
        )}
        {children && <div className="mt-3">{children}</div>}
        {footer && <div data-sheet-primary-focus className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

/* ------------------------------------------------------- Confirm sheet --- */

export const ConfirmSheet: React.FC<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}> = ({ open, title, description, confirmLabel, onConfirm, onCancel }) => {
  useI18n();
  const [busy, setBusy] = useState(false);

  const confirm = useCallback(async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }, [onConfirm]);

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      footer={
        <>
          <Button tone="secondary" onClick={onCancel} disabled={busy}>{t("primitives.cancel.19766e")}</Button>
          <Button tone="destructive" busy={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
};

/* ---------------------------------------------------------- Empty state --- */

/** `body` is optional: a title that already says it does not need saying twice. */
export const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}> = ({ icon, title, body, action }) => { return (
  <div className="flex flex-col items-center px-5 py-9 text-center sm:py-12">
    <div aria-hidden className="mb-3 text-[var(--text-tertiary)]">
      {icon}
    </div>
    <h2 className="type-title3 font-semibold text-[var(--text-primary)]">{title}</h2>
    {body && <p className="mt-1.5 max-w-measure text-[var(--text-secondary)]">{body}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
); };

/* --------------------------------------------------------- Status line --- */

export const StatusLine: React.FC<{
  tone: 'info' | 'caution' | 'danger' | 'success';
  children: React.ReactNode;
  icon?: React.ReactNode;
}> = ({ tone, children, icon }) => {
  const styles = {
    info: 'border-[var(--border-hairline)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
    caution: 'border-[var(--status-caution-text)] bg-[var(--status-caution-quiet)] text-[var(--status-caution-text)]',
    danger: 'border-[var(--status-danger-text)] bg-[var(--status-danger-quiet)] text-[var(--status-danger-text)]',
    success: 'border-[var(--status-success-text)] bg-[var(--status-success-quiet)] text-[var(--status-success-text)]',
  }[tone];

  return (
    <p className={cx('type-footnote flex items-start gap-2 rounded-[var(--radius-field)] border px-3 py-2', styles)}>
      {icon ? <span aria-hidden className="mt-0.5 shrink-0">{icon}</span> : null}
      <span className="chef-filename">{children}</span>
    </p>
  );
};

/* ------------------------------------------------------------- Skeleton --- */

export const SkeletonRow: React.FC = () => { return (
  <div className="flex items-center gap-3 px-4 py-4" aria-hidden>
    <div className="h-10 w-10 shrink-0 rounded-[var(--radius-control)] bg-[var(--surface-sunken)]" />
    <div className="min-w-0 flex-1 space-y-2">
      <div className="h-3.5 w-2/5 rounded-[var(--radius-pill)] bg-[var(--surface-sunken)]" />
      <div className="h-3 w-3/5 rounded-[var(--radius-pill)] bg-[var(--surface-sunken)]" />
    </div>
  </div>
); };

/* ------------------------------------------------------------ Checkmark --- */

export const SelectedMark: React.FC<{ selected: boolean }> = ({ selected }) =>
  { return selected ? <Check aria-hidden size={18} className="shrink-0 text-[var(--accent-text)]" /> : null; };

export { cx };
