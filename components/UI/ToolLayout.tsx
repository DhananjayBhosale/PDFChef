import React from 'react';
import { useLocation } from 'react-router-dom';
import { cx } from './Primitives';
import { tools } from '../Tools/toolCatalog';

/**
 * The frame every tool page is built in, and the small set of surfaces an
 * active tool is allowed to put inside it.
 *
 * The rhythm here is the phone's. A tool that is already open has spent its
 * screen on the document: the frame keeps a 16px gutter, 16px of page padding,
 * and gaps of 8/10/12/16px by role, so the next control is always within reach
 * of the last one. Wide screens keep the airier padding they already had.
 */

/* ---------------------------------------------------------------- Shell --- */

export const ToolShell: React.FC<{
  children: React.ReactNode;
  /** Reading column (default), a long list, a workspace, or a full-bleed grid. */
  width?: 'measure' | 'list' | 'wide' | 'full';
  /** Optically centre the complete empty-state panel in the phone workspace. */
  centered?: boolean;
  className?: string;
}> = ({ children, width = 'measure', centered = false, className }) => (
  <div
    className={cx(
      'chef-tool-shell mx-auto w-full px-4 py-4 sm:py-10',
      centered && 'chef-tool-landing-centered',
      width === 'measure' && 'max-w-3xl',
      width === 'list' && 'max-w-4xl',
      width === 'wide' && 'max-w-5xl',
      width === 'full' && 'max-w-6xl',
      className,
    )}
  >
    {children}
  </div>
);

/* --------------------------------------------------------------- Header --- */

/**
 * Title, and at most one line under it.
 *
 * `note` is for something the controls cannot say themselves: a lossy or
 * destructive consequence, a password rule, a beta fidelity limit, a format
 * constraint. A sentence that restates the title, the upload label or the
 * export button is a line of screen the page content could have used, so tools
 * whose controls already speak pass no note at all.
 */
export const ToolHeader: React.FC<{
  title: React.ReactNode;
  note?: React.ReactNode;
  className?: string;
}> = ({ title, note, className }) => {
  // Most tool screens opened with a title and "Choose a PDF to flatten", which
  // only helps someone who already knew what flattening was. The catalogue
  // already carries one plain line per tool for the list they arrived from;
  // show them the same line here rather than making them go back and read it.
  const { pathname } = useLocation();
  const line = note ?? tools.find((tool) => tool.path === pathname)?.description;
  return (
    <div className={cx('mb-3 sm:mb-6', className)}>
      <h1 className="text-3xl font-bold text-[var(--text-primary)]">{title}</h1>
      {line ? <p className="mt-1 text-[var(--text-secondary)]">{line}</p> : null}
    </div>
  );
};

/* --------------------------------------------------------------- Panel --- */

/**
 * A surface that hugs its content. 12px of padding on a phone, 16px on a wide
 * screen: an option box is a box around controls, not a room for them.
 */
export const ToolPanel: React.FC<{
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'section';
}> = ({ children, className, as: Tag = 'div' }) => (
  <Tag
    className={cx(
      'rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 sm:p-4',
      className,
    )}
  >
    {children}
  </Tag>
);

/* ---------------------------------------------------------- Option rows --- */

/**
 * Divided rows instead of a stack of padded cards. One border for the group,
 * a hairline between rows, and no gap to pay for per option.
 */
export const OptionRows: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div
    className={cx(
      'divide-y divide-[var(--border-hairline)] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]',
      className,
    )}
  >
    {children}
  </div>
);

export const OptionRow: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => <div className={cx('px-3 py-2.5', className)}>{children}</div>;

/** Label on the left, control on the right, on one line wherever it fits. */
export const InlineOptionRow: React.FC<{
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ label, hint, children, className }) => (
  <div className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5', className)}>
    <div className="min-w-0">
      <span className="text-sm font-semibold text-[var(--text-primary)]">{label}</span>
      {hint ? <span className="type-caption ms-2 text-[var(--text-tertiary)]">{hint}</span> : null}
    </div>
    <div className="min-w-0 shrink-0">{children}</div>
  </div>
);

/* ----------------------------------------------------------- Choice row --- */

export interface ToolChoice {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** Spoken name when the visible label needs direction or units to make sense. */
  ariaLabel?: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Two or three labelled actions shoulder to shoulder.
 *
 * This replaces the large padded button boxes an action pair used to get. The
 * visual box is 40px because that is what the label and an 18px icon need; the
 * pressable region reaches the 48px floor through `chef-hit-y`, which extends
 * height only, so no choice reaches into the one beside it.
 */
export const ToolChoiceRow: React.FC<{
  label: string;
  choices: readonly ToolChoice[];
  className?: string;
}> = ({ label, choices, className }) => (
  <div role="group" aria-label={label} className={cx('grid gap-2', className)} style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}>
    {choices.map((choice) => (
      <button
        key={choice.key}
        type="button"
        onClick={choice.onClick}
        disabled={choice.disabled}
        aria-label={choice.ariaLabel}
        className={cx(
          'chef-pressable chef-hit-y flex h-10 min-w-0 items-center justify-center gap-2 rounded-[var(--radius-control)]',
          'border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 text-sm font-semibold text-[var(--text-primary)]',
          'hover:border-[var(--accent-rest)] disabled:cursor-not-allowed disabled:opacity-55',
        )}
      >
        {choice.icon}
        <span className="truncate">{choice.label}</span>
      </button>
    ))}
  </div>
);

/* -------------------------------------------------------- Selection bar --- */

export interface ToolChipAction {
  key: string;
  label: string;
  onClick: () => void;
  /**
   * A chip with nothing to do is removed rather than greyed out. Reset is the
   * reason: reserving a full row for a control that is only ever live after a
   * change left an empty band above the page list on every first view.
   */
  hidden?: boolean;
  disabled?: boolean;
}

/**
 * Selection count and its chips on one line. The count is the live region, so
 * the same row that offers Select all also reports what it did.
 */
export const ToolSelectionBar: React.FC<{
  summary: React.ReactNode;
  actions: readonly ToolChipAction[];
  className?: string;
}> = ({ summary, actions, className }) => {
  const visible = actions.filter((action) => !action.hidden);
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-1', className)}>
      <p className="type-footnote min-w-0 text-[var(--text-secondary)]" role="status" aria-live="polite">
        {summary}
      </p>
      {visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {visible.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              className="chef-pressable chef-hit-y rounded-[var(--radius-pill)] px-2.5 py-1.5 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-quiet)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
