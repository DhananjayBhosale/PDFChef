import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ErrorText } from '../UI/ErrorText';
import type { ProcessingStatus } from '../../types';
import { announceOutputNote, getStripInSlot, getStripNote, subscribeStripInSlot, subscribeStripNote } from '../UI/outputNote';
import { Minus, Plus } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useResultSlotRef } from '../UI/resultSlot';

/** A number field with − and + beside it (the buttons are new; the field is today's). */
export const Stepper: React.FC<{
  label: string;
  /** Today's field (a <label> with its input). */
  field: React.ReactNode;
  onStep: (delta: 1 | -1) => void;
  disabled?: boolean;
  decreaseDisabled?: boolean;
  increaseDisabled?: boolean;
}> = ({ label, field, onStep, disabled, decreaseDisabled, increaseDisabled }) => (
  <div className="tk-stepper">
    <div className="tk-stepper-field">{field}</div>
    <button
      type="button"
      onClick={() => onStep(-1)}
      disabled={disabled || decreaseDisabled}
      aria-label={t('stepper.decrease', { label })}
      className="tk-step chef-pressable"
    >
      <Minus aria-hidden size={16} strokeWidth={2} />
    </button>
    <button
      type="button"
      onClick={() => onStep(1)}
      disabled={disabled || increaseDisabled}
      aria-label={t('stepper.increase', { label })}
      className="tk-step chef-pressable"
    >
      <Plus aria-hidden size={16} strokeWidth={2} />
    </button>
  </div>
);

/**
 * A few tap choices for a number (path to 9, item 1): size, opacity and angle editors offer the
 * common values next to their slider or − / +, so a phone sets one with a tap and no keyboard.
 * A tap on one closes the editor it sits in (Popover `pickCloses`).
 */
export const TapChoices = <T extends number | string>({ label, values, current, text, onPick, disabled, isCurrent, columns, ltr = true, dense = false }: {
  /** The setting's name: the group's name. */
  label: string;
  values: readonly T[];
  current: T;
  /** The visible value, already formatted for the locale ("12 pt", "30 %", "45°", "Page 1 of 3"). */
  text: (value: T) => string;
  onPick: (value: T) => void;
  disabled?: boolean;
  /** Whether `value` is the one set now; by default an equal value (numbers within a rounding error). */
  isCurrent?: (value: T) => boolean;
  /** A fixed number of columns, for choices laid out as a grid (Page Numbers' six positions). */
  columns?: number;
  /** Tighter choices, so long words keep one line (Page Numbers' positions and formats on a phone). */
  dense?: boolean;
  /** Values drawn left to right (numbers, formats); false for words that follow the language. */
  ltr?: boolean;
}) => (
  // Dense columns take the width their words need before sharing what is left, so "Bottom center"
  // keeps one line beside "Bottom left" at 360 px (pass 5, item 10); they wrap only when they must.
  <div role="group" aria-label={label} className="tk-taps" data-dense={dense ? '' : undefined} style={columns ? { gridTemplateColumns: dense ? `repeat(${columns}, auto)` : `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
    {values.map((value) => (
      <button
        key={value}
        type="button"
        data-tk-preset=""
        aria-pressed={isCurrent ? isCurrent(value) : typeof value === 'number' && typeof current === 'number' ? Math.abs(current - value) < 1e-6 : value === current}
        onClick={() => onPick(value)}
        disabled={disabled}
        className="tk-tap chef-pressable"
      >{ltr ? <bdi dir="ltr" className="tabular">{text(value)}</bdi> : text(value)}</button>
    ))}
  </div>
);

/** The tool's title, for names that include it (the progress bar's "<tool> progress"). */
export const ToolTitleContext = createContext<string | null>(null);

/**
 * The tool screen's own voice (path to 9, item 6): one polite line, in the page from the start,
 * that any part of a tool can speak through (a file removed, a job canceled). `cancelAsked` is set
 * when a Cancel is pressed, so the running line can say "Canceled." once the job has stopped.
 */
export interface ToolVoice {
  announce: (words: string) => void;
  cancelAsked: React.MutableRefObject<boolean>;
}
export const ToolVoiceContext = createContext<ToolVoice | null>(null);
/**
 * The voice of the tool screen on the page, for a tool's own handlers: the tool component draws
 * its `ToolScreen`, so it sits outside the screen's context. One tool screen is shown at a time.
 */
let screenVoice: ToolVoice | null = null;
export const setScreenVoice = (voice: ToolVoice | null, leaving?: ToolVoice) => {
  if (leaving && screenVoice !== leaving) return;
  screenVoice = voice;
};
/** Speaks through the tool screen's line; does nothing when no tool screen is shown. */
export const useToolAnnounce = (): ((words: string) => void) => {
  const voice = useContext(ToolVoiceContext);
  return useCallback((words: string) => (voice ?? screenVoice)?.announce(words), [voice]);
};
/** Marks that the person asked the running job to stop (a Cancel outside the running line). */
export const useNoteCancel = (): (() => void) => {
  const voice = useContext(ToolVoiceContext);
  return useCallback(() => {
    const current = voice ?? screenVoice;
    if (current) current.cancelAsked.current = true;
  }, [voice]);
};

/**
 * The running state of the action row: today's message, the percent and Cancel. The bar
 * is a named progressbar with its value (B-035), as today's one-action tools drew it.
 */
export const ProgressLine: React.FC<{
  label: React.ReactNode;
  detail?: React.ReactNode;
  percent?: React.ReactNode;
  /** 0–100, drawn as a thin bar under the line. */
  value?: number;
  cancel?: React.ReactNode;
  /** The bar's name; by default "<tool> progress". */
  name?: string;
  /** The tool says its own words when a job is canceled, so this line does not say "Canceled." too. */
  quietCancel?: boolean;
}> = ({ label, detail, percent, value, cancel, name, quietCancel = false }) => {
  const title = useContext(ToolTitleContext);
  // "Canceled." once the job has stopped after a Cancel (path to 9, item 6): this line leaves the
  // page when the job ends, and a Cancel pressed while it ran says so through the tool's voice.
  const voice = useContext(ToolVoiceContext);
  const quietRef = useRef(quietCancel);
  quietRef.current = quietCancel;
  useEffect(() => {
    if (!voice) return undefined;
    voice.cancelAsked.current = false;
    return () => {
      if (!voice.cancelAsked.current) return;
      voice.cancelAsked.current = false;
      if (!quietRef.current) voice.announce(t('tool.canceled'));
    };
  }, [voice]);
  const labelId = useId();
  const barName = name ?? (title ? t('pdf-advanced-tools.progress.459332', { v0: title }) : undefined);
  const now = value === undefined ? undefined : Math.round(Math.max(0, Math.min(100, value)));
  return (
    <div className="tk-progress-block">
      <div role="status" aria-live="polite" className="tk-progress">
        <span aria-hidden className="tk-spinner" />
        <span className="tk-progress-text">
          <span id={labelId} className="tk-progress-label">{label}</span>
          {detail && <span className="tk-progress-detail">{detail}</span>}
        </span>
        {percent && <span className="tk-progress-pct tabular">{percent}</span>}
        {cancel && (
          <span className="contents" onClickCapture={() => { if (voice) voice.cancelAsked.current = true; }}>{cancel}</span>
        )}
      </div>
      {now !== undefined && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={now}
          aria-label={barName}
          aria-labelledby={barName ? undefined : labelId}
          // Busy as today's working card was. Kept on the bar, not the block, so the status line's
          // announcements are not held back.
          aria-busy
          className="tk-progress-track"
        >
          <div className="tk-progress-fill" style={{ width: `${now}%` }} />
        </div>
      )}
    </div>
  );
};

/**
 * True inside an open editor's copy of the notice line: the copy drops its id (the
 * line under the sentence keeps it for `aria-describedby`), and an error is an alert.
 */
export const EditorNoticeContext = createContext(false);

/** True inside the tool's own notice line (ToolScreen), the line an open editor repeats. */
export const PageNoticeContext = createContext(false);

/* How many open editors show a copy of the tool's notice line (verify V-06). */
let noticeCopies = 0;
const noticeCopyListeners = new Set<() => void>();
const subscribeNoticeCopies = (listener: () => void) => {
  noticeCopyListeners.add(listener);
  return () => { noticeCopyListeners.delete(listener); };
};
const noticeCopied = () => noticeCopies > 0;
const announceNoticeCopies = () => noticeCopyListeners.forEach((listener) => listener());

/** An open editor draws a copy of the tool's notice line. Returns the release. */
export const holdNoticeCopy = (): (() => void) => {
  noticeCopies += 1;
  announceNoticeCopies();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    noticeCopies -= 1;
    announceNoticeCopies();
  };
};

/**
 * A line only a screen reader hears, in the page from the start so every change to it is read
 * (an editor's undo, delete or page change; research r4, desktop-04). The same words twice are
 * still read: a zero-width space alternates at the end.
 */
export const useAnnouncer = (): [React.ReactNode, (words: string) => void] => {
  const [said, setSaid] = useState({ words: '', count: 0 });
  const announce = useCallback((words: string) => setSaid((last) => ({ words, count: last.count + 1 })), []);
  const node = (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {said.words ? `${said.words}${said.count % 2 ? '\u200b' : ''}` : ''}
    </p>
  );
  return [node, announce];
};

/** The one line under the sentence (D10): error, pending, caution, outcome. */
export const Notice: React.FC<{
  tone?: 'error' | 'pending' | 'outcome' | 'caution';
  id?: string;
  role?: 'alert' | 'status';
  children: React.ReactNode;
}> = ({ tone = 'outcome', id, children, role }) => {
  const inEditor = useContext(EditorNoticeContext);
  const inPage = useContext(PageNoticeContext);
  const copied = useSyncExternalStore(subscribeNoticeCopies, noticeCopied, () => false);
  // While the result strip is in the tool's action area, the outcome line would say the same
  // thing again ("Created crop.pdf."): it is left out, and its words go to the result sheet (T-07).
  const stripShown = useSyncExternalStore(subscribeStripInSlot, getStripInSlot, () => false);
  const words = typeof children === 'string' ? children : null;
  // Only a finished job's plain message (a status line holding a control is left alone).
  const givesWay = Boolean(words) && tone === 'outcome' && role === 'status' && inPage && !inEditor && stripShown;
  useEffect(() => {
    if (givesWay && words) announceOutputNote(words);
  }, [givesWay, words]);
  if (givesWay) return null;
  const liveRole = role ?? (inEditor && tone === 'error' ? 'alert' : undefined);
  // While an open editor repeats this line, its copy is the live one and the line behind it
  // stays on screen without a live role, so the message is announced once (verify V-06).
  const quiet = inPage && !inEditor && copied && (liveRole === 'alert' || liveRole === 'status');
  return (
    <p
      id={inEditor ? undefined : id}
      role={quiet ? undefined : liveRole}
      className="tk-notice-line"
      data-tone={tone}
    >{children}</p>
  );
};

/**
 * A job's own lines in the notice line (A-014): its error as an alert, and its finished
 * message, unless the result strip already shows that message as its line (owner
 * decision 2). A finished message with no result ("Found 12 embedded images.") stays here.
 */
export const useStatusNotice = (status: ProcessingStatus, id?: string): React.ReactNode => {
  const stripNote = useSyncExternalStore(subscribeStripNote, getStripNote, () => '');
  if (status.isProcessing) return null;
  if (status.error) return <Notice tone="error" role="alert" id={id}><ErrorText text={status.error} /></Notice>;
  if (status.progress === 100 && status.message && status.message !== stripNote) return <Notice role="status" id={id}>{status.message}</Notice>;
  return null;
};

/** The tool's notice line, for the editor that covers it (ToolScreen provides it). */
export const ToolNoticeContext = createContext<React.ReactNode>(null);

/**
 * Which notices an open editor repeats: errors and pending lines, the ones that say why the main
 * action is off. Not cautions (each editor keeps its own) and not outcomes: an outcome line can
 * carry its own control (PDF to Image's "Images (12)"), which a copy would show twice (owner
 * decision 2026-11-15, item 1: a setting appears once).
 */
export const editorNotice = (notice: React.ReactNode): React.ReactNode => {
  if (!notice) return null;
  if (React.isValidElement(notice) && notice.type === Notice) {
    const tone = (notice.props as { tone?: string }).tone ?? 'outcome';
    if (tone !== 'error' && tone !== 'pending') return null;
  }
  return notice;
};

export interface ChipAction {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hidden?: boolean;
  icon?: React.ReactNode;
}

/** Today's selection actions (Select all, Clear, Use all pages) as chips under the sentence. */
export const ChipActions: React.FC<{ actions: ChipAction[] }> = ({ actions }) => {
  const visible = actions.filter((action) => !action.hidden);
  if (!visible.length) return null;
  return (
    <>
      {visible.map((action) => (
        <button key={action.key} type="button" onClick={action.onClick} disabled={action.disabled} className="tk-chip chef-pressable">
          {action.icon}
          {action.label}
        </button>
      ))}
    </>
  );
};

/**
 * A file that cannot be drawn as a page (a locked PDF, a Word or PowerPoint file): a blank page
 * with the tool's mark, in the same frame as a page preview, so the canvas is not a small card
 * in empty space. The name and size are already on the file line (T-16).
 */
export const FileStand: React.FC<{ icon: React.ReactNode }> = ({ icon }) => (
  <figure className="tk-filepreview" aria-hidden>
    <div className="tk-filepreview-page"><span className="tk-filestand">{icon}</span></div>
  </figure>
);

/** A file card: the tool's mark, the name and the meta (a file that cannot be drawn). */
export const FileCard: React.FC<{ icon: React.ReactNode; name: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode }> = ({ icon, name, meta, children }) => (
  <div className="tk-filecard">
    <span aria-hidden className="tk-filecard-icon">{icon}</span>
    <span className="tk-filecard-text">
      <bdi className="tk-fname chef-filename" title={typeof name === 'string' ? name : undefined}>{name}</bdi>
      {meta && <span className="tk-fmeta tabular">{meta}</span>}
    </span>
    {children}
  </div>
);

/**
 * Where an editor screen draws the result-ready strip (plan 2.23): beside its Save
 * control on desktop, above its bottom toolbar on phones. The strip is portalled in.
 */
export const ResultSlot: React.FC<{ className?: string }> = ({ className }) => {
  const ref = useResultSlotRef();
  return <div ref={ref} className={`tk-result${className ? ` ${className}` : ''}`} />;
};

/**
 * The action row (main action and its secondary). Side by side while both labels fit on one
 * line; stacked, main action on top, as soon as one would wrap (T-08). It measures the labels,
 * not the screen width, so a long language, large text or a narrow phone all get the stack.
 */
/** The ids of the lines that say why the main action is off: the sentence and the notice line. */
export const ActionReasonContext = createContext('');

const PRIMARY = /(^|\s)tk-primary(\s|$)/;

/**
 * A main action that is off stays in the Tab order (fix round 2, item 5): `aria-disabled` in place
 * of `disabled`, a press does nothing, and it is described by the lines that say why. It looks the
 * same as a disabled one (`.tk-primary[aria-disabled="true"]`).
 */
const keepReachable = (node: React.ReactNode, reason: string): React.ReactNode => {
  if (!React.isValidElement(node)) return node;
  const props = node.props as { className?: string; disabled?: boolean; children?: React.ReactNode; 'aria-describedby'?: string };
  if (node.type === React.Fragment) {
    return React.cloneElement(node, undefined, React.Children.map(props.children, (child) => keepReachable(child, reason)));
  }
  if (node.type !== 'button' || !props.disabled || !PRIMARY.test(props.className ?? '')) return node;
  return React.cloneElement(node as React.ReactElement<Record<string, unknown>>, {
    disabled: false,
    'aria-disabled': true,
    'aria-describedby': [props['aria-describedby'], reason].filter(Boolean).join(' ') || undefined,
    onClick: (event: React.MouseEvent) => event.preventDefault(),
  });
};

export const ActionRow: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => {
  const reason = useContext(ActionReasonContext);
  const rowRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      const items = Array.from(row.children) as HTMLElement[];
      if (items.length < 2) { setStacked(false); return; }
      row.dataset.measure = '';
      const natural = items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0);
      delete row.dataset.measure;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      setStacked(natural + gap * (items.length - 1) > row.clientWidth + 0.5);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    Array.from(row.children).forEach((child) => observer.observe(child as Element));
    return () => observer.disconnect();
  });
  return (
    <div ref={rowRef} className={`tk-actions${className ? ` ${className}` : ''}`} data-stacked={stacked ? '' : undefined}>
      {React.Children.map(children, (child) => keepReachable(child, reason))}
    </div>
  );
};
