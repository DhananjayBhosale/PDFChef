import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useI18n } from '../../services/i18n/react';
import { MQ_LG, MQ_MD, useMediaQuery, useWide } from '../../hooks/useMediaQuery';
import { useShellOwnChrome } from '../Layout/AppShell';
import { useResultSlotRef } from '../UI/resultSlot';
import { LeaveAskContext, ToolTop, useRouteTool } from './ToolTop';
import { ActionReasonContext, ActionRow, PageNoticeContext, ToolNoticeContext, ToolTitleContext, ToolVoiceContext, setScreenVoice, useAnnouncer, type ToolVoice } from './parts';
import { ToolProgressShownContext } from '../UI/StatusToast';
import { dropZoneShown } from '../UI/dropZone';
import { getStripSaved } from '../UI/outputNote';
import { SOURCE_PART, setWorkPart } from '../UI/workSignature';
import { activeLeaveGuard, leaveGuarded, useDiscardPrompt } from '../../hooks/useConfirmDiscard';
import { useHeavyJobCheck } from '../../hooks/useHeavyJobCheck';
import { shouldWarnForBytes } from '../../services/workspace';
import { NavigationType, useBlocker, useLocation, type BlockerFunction } from 'react-router-dom';

type BlockerArgs = Parameters<BlockerFunction>[0];
import { t } from '../../services/i18n/core.ts';

/**
 * The one layout every tool route uses (plan 2.2).
 *
 * Phone (below 768 px):
 *  - grid / list / file / form bodies: header, file line, the body, and a foot sheet
 *    with the result slot, the sentence, chips, one notice line and the main action.
 *  - preview bodies: header, the sentence as a band on top, the preview, and a foot
 *    bar with the result slot and the actions.
 *  - editor bodies: header, then the editor's own layout.
 * Wide (768 px and up, tablets included): header with the file and the change control, then one band: the sentence,
 * chips and notice, with the main action at its end and the result under the action;
 * then the canvas, which fills the rest of the viewport.
 */

export type ToolScreenKind = 'grid' | 'list' | 'file' | 'preview' | 'form' | 'editor';

export interface ToolScreenProps {
  /** The page's h1. */
  title: string;
  beta?: boolean;
  file?: { name: string; meta?: React.ReactNode };
  /** The header's "change the file" control (`ChangeFile`). */
  change?: React.ReactNode;
  /** Replaces the brand link at the header's start. */
  leading?: React.ReactNode;
  /** The phone name link's accessible name (ToolTop `homeLabel`). */
  homeLabel?: string;
  kind: ToolScreenKind;
  body: React.ReactNode;
  /** The body section's name: the id of its heading, or a label. */
  bodyLabelledBy?: string;
  bodyLabel?: string;
  /** Desktop right column of a file or form screen; on phones it is drawn under the body. */
  side?: React.ReactNode;
  /** Above the sentence. */
  lead?: React.ReactNode;
  sentence?: React.ReactNode;
  chips?: React.ReactNode;
  notice?: React.ReactNode;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  /** Desktop only: a choice about the main action, drawn under it in the band's end column
      (Split's "Separate PDFs / One ZIP"), so it does not add a row to the band. */
  endControl?: React.ReactNode;
  /** While running: replaces the action row (progress line and Cancel). */
  progress?: React.ReactNode;
  toast?: React.ReactNode;
  /** Modals and anything else rendered once. */
  extra?: React.ReactNode;
  className?: string;
  /**
   * Whether a reload or a closed tab would lose work, so the browser asks first. By default a
   * screen holds work while no drop zone is on it, that is, once a file is loaded.
   */
  holdsWork?: boolean;
  /**
   * The size of the work the main action does (fix round 2, item 7). Above the "Warn before a heavy
   * job" threshold, the main action asks first in the app's own sheet; Cancel keeps the files.
   * `files` picks the wording for several files; `title` replaces the question.
   */
  heavyJob?: { bytes: number; files?: number; title?: string };
}

/** False until the first tool screen after a page load has placed focus. */
let pageLoadSettled = false;

/** The tool's main action: the one an editor names, else the filled button of the action row. */
const MAIN_ACTION = '[data-main-action], .tk-actions > .tk-primary, .tk-primary';
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const shown = (node: HTMLElement) => node.isConnected && node.getClientRects().length > 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]');
/** A control that starts the tool's job besides its main action (Split's "Extract N pages"):
 *  the heavy-job warning asks before it too. */
const HEAVY_ACTION = '[data-heavy-action]';
const mainActionIn = (root: ParentNode | null) => (root
  ? Array.from(root.querySelectorAll<HTMLElement>(MAIN_ACTION)).find((node) => shown(node)) ?? null
  : null);
const isOff = (node: HTMLElement) => (node as HTMLButtonElement).disabled || node.getAttribute('aria-disabled') === 'true';

/**
 * Runs the tool's main action as a press would (finding 1 of the fix review): Enter in a field
 * that confirms the job (Unlock's and Protect's passwords) goes through the same heavy-job
 * warning as the button. Does nothing while the main action is off. True when it pressed it.
 */
export const pressMainAction = (from?: Element | null) => {
  const root = from?.closest('.tk-screen') ?? (typeof document === 'undefined' ? null : document.querySelector('.tk-screen'));
  const main = mainActionIn(root);
  if (!main || isOff(main)) return false;
  main.click();
  return true;
};

/**
 * Focus never drops to the page (path to 9, item 6). When the control that has focus leaves the
 * page (Merge's Remove, a chip that hides itself, Cancel when the job stops), focus moves to its
 * nearest neighbour in the tool, as the next Tab would have reached it; a control in the running
 * line gives focus to the main action that takes its place. The tool says what changed itself.
 */
const useFocusRescue = (
  screenRef: React.RefObject<HTMLDivElement | null>,
  startRef: React.MutableRefObject<HTMLElement | null>,
  cleared: React.MutableRefObject<(() => void) | null>,
) => {
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || typeof MutationObserver === 'undefined') return undefined;
    let last: HTMLElement | null = null;
    let nearby: HTMLElement[] = [];
    let inRunning = false;
    let inPicker = false;
    let inChange = false;
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !screen.contains(target)) return;
      const items = Array.from(screen.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(shown);
      const index = items.indexOf(target);
      last = target;
      inRunning = Boolean(target.closest('.tk-progress-block'));
      inPicker = dropZoneShown() && Boolean(target.closest('.tk-canvas'));
      inChange = Boolean(target.closest('[data-tk-change]'));
      // The next control first, then the one before, then further out: a removed row takes its
      // own buttons with it, so the nearest one still on the page wins.
      nearby = index < 0 ? [] : [1, -1, 2, -2, 3, -3, 4, -4].map((step) => items[index + step]).filter((item): item is HTMLElement => Boolean(item));
    };
    const rescue = () => {
      if (!last || last.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) { last = null; return; }
      const main = inRunning ? screen.querySelector<HTMLElement>('.tk-actions .tk-primary:not([disabled]):not([aria-disabled="true"])') : null;
      // A chosen file replaced the picker (fix round 2, item 3): focus starts inside the tool, not
      // on the header link before the picker. The tool's start takes it once the file has opened.
      const start = inPicker && startRef.current && shown(startRef.current) ? startRef.current : null;
      // The header's "change the file" control (Clear, Choose another PDF) took the file away
      // (fix round 2, item 4): focus goes to the picker's Choose button, and the screen says so.
      const picker = inChange && dropZoneShown()
        ? Array.from(screen.querySelectorAll<HTMLElement>('.tk-canvas button:not([disabled])')).find(shown) ?? null
        : null;
      if (picker) cleared.current?.();
      const next = picker ?? start ?? (main && shown(main) ? main : null)
        ?? nearby.find((item) => shown(item) && !(item as HTMLButtonElement).disabled)
        ?? (startRef.current && shown(startRef.current) ? startRef.current : null);
      last = null;
      next?.focus({ preventScroll: false });
    };
    const observer = new MutationObserver(rescue);
    observer.observe(screen, { childList: true, subtree: true });
    document.addEventListener('focusin', remember);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', remember);
    };
  }, [screenRef, startRef, cleared]);
};

/**
 * The screen's leave guard: the browser's "Leave site?" prompt on reload or a closed tab, the question
 * before a header link, and the app's one navigation blocker for Back, Forward and the system Back.
 * A ToolScreen holds it; an editor that draws its own screen holds it through `ToolLeaveGuard`.
 * Only one of the two is mounted at a time, so the app keeps one blocker.
 */
const useScreenLeaveGuard = (holdsWork: boolean | undefined, running: boolean) => {
  // The browser's own "Leave site?" prompt (research r3, desktop-03): no strings of ours.
  useEffect(() => {
    if (holdsWork === false) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (holdsWork === undefined && dropZoneShown()) return;
      if (getStripSaved()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [holdsWork]);

  // The header's links ask before leaving a loaded file or a running job (path to 9, item 7), by
  // the rule reload uses. A tool's own "Discard your unsaved edits?" asks instead when it will.
  const leaveState = useRef({ holdsWork, running: false });
  leaveState.current = { holdsWork, running };
  const leavePrompt = useDiscardPrompt({ title: t('tool.leave.title') });
  const askDiscard = leavePrompt.ask;
  // Whether leaving now would lose the screen's work (the rule reload uses).
  const wouldLose = useCallback(() => {
    const { holdsWork: holds, running } = leaveState.current;
    if (!running && (holds === false || (holds === undefined && dropZoneShown()))) return false;
    // The result of this work is saved (downloaded, shared or kept in Recent), and nothing has
    // changed since: leaving loses nothing (final fix, item 6). A tool's own unsaved edits
    // still ask through its leave guard.
    if (!running && getStripSaved()) return false;
    return true;
  }, []);
  // Set once the person chose to leave, so the blocker below does not ask a second time.
  const leaving = useRef(false);
  const { key: locationKey } = useLocation();
  useEffect(() => { leaving.current = false; }, [locationKey]);
  const askLeave = useCallback((go: () => void) => {
    if (leaveGuarded()) return false;
    if (!wouldLose()) return false;
    askDiscard(() => { leaving.current = true; go(); });
    return true;
  }, [askDiscard, wouldLose]);
  // The browser's Back and Forward, the system Back and the header's Back arrow ask too, by the
  // same rule (fix round 2, item 2). This is the app's one navigation blocker: a tool's own guard
  // ("Discard your unsaved edits?") asks through it for every way out, as its own blocker did.
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation, historyAction }: BlockerArgs) => {
    if (leaving.current) return false;
    if (leaveGuarded()) return true;
    if (currentLocation.pathname === nextLocation.pathname) return false;
    // Back and Forward, a replace with Home (the Android Back from a tool that is the first entry goes
    // there by replacing it) and a push that says it leaves the work (Open PDF from the result
    // sheet) ask by the same rule (fix review, finding 7). Links ask before they navigate.
    const asks = historyAction === NavigationType.Pop
      || (historyAction === NavigationType.Replace && nextLocation.pathname === '/')
      || Boolean((nextLocation.state as { leavesWork?: boolean } | null)?.leavesWork);
    return asks && wouldLose();
  }, [wouldLose]));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const leave = () => { leaving.current = true; blocker.proceed(); };
    const stay = () => blocker.reset();
    const guard = activeLeaveGuard();
    if (guard?.ask) guard.ask(leave, stay);
    else askDiscard(leave, stay);
  }, [askDiscard, blocker]);

  return { askLeave, sheet: leavePrompt.sheet };
};

/**
 * The guards of a tool screen around an editor that draws its own screen (Edit PDF on a phone and
 * in the Android app; overnight 2026-11-24, s4-02). It must never sit inside a ToolScreen.
 */
export const ToolLeaveGuard: React.FC<{ holdsWork?: boolean; children: React.ReactNode }> = ({ holdsWork, children }) => {
  const { askLeave, sheet } = useScreenLeaveGuard(holdsWork, false);
  return (
    <LeaveAskContext.Provider value={askLeave}>
      {children}
      {sheet}
    </LeaveAskContext.Provider>
  );
};

export const ToolScreen: React.FC<ToolScreenProps> = ({
  title, beta, file, change, leading, homeLabel, kind, body, bodyLabelledBy, bodyLabel, side, lead, sentence, chips, notice,
  action, secondary, endControl, progress, toast, extra, className, holdsWork, heavyJob,
}) => {
  useI18n();
  useShellOwnChrome(true);
  const wide = useWide();
  // Tablets (768 px and wider) take the desktop's Tab order for a settings column (research r3,
  // mobile-05): the settings come before the page in the document, and CSS draws the page first.
  const sideFirst = useMediaQuery(MQ_MD);
  const tool = useRouteTool();
  const resultRef = useResultSlotRef(kind !== 'editor');
  const preview = kind === 'preview';
  const editor = kind === 'editor';
  // Desktop with a settings column (research r2, desktop-04): the column comes before the main
  // action in the document, so Tab goes sentence, settings, action, as it did in today's panel.
  // The action and the result strip are drawn in the band's row all the same (`data-tail`).
  const tail = wide && !editor && Boolean(side);

  const leaveGuard = useScreenLeaveGuard(holdsWork, Boolean(progress));

  // The file this screen works on, for the result strip's "earlier result" (final fix, item 3).
  const sourceName = file?.name ?? '';
  useEffect(() => { setWorkPart(SOURCE_PART, sourceName); }, [sourceName]);
  useEffect(() => () => setWorkPart(SOURCE_PART, null), []);

  // "Warn before a heavy job" (fix round 2, item 7): a press on the main action (or Ctrl+Enter)
  // over the threshold asks first. Asked once for the same work; Cancel leaves everything as it is.
  const heavy = useHeavyJobCheck();
  const heavyRef = useRef({ job: heavyJob, confirm: heavy.confirm, confirmed: '' });
  heavyRef.current.job = heavyJob;
  heavyRef.current.confirm = heavy.confirm;
  useEffect(() => {
    const root = screenRef.current;
    if (!root) return undefined;
    const onClick = (event: MouseEvent) => {
      const { job, confirm, confirmed } = heavyRef.current;
      if (!job || job.bytes <= 0 || !shouldWarnForBytes(job.bytes)) return;
      const from = event.target as Element | null;
      const target = from?.closest<HTMLElement>(HEAVY_ACTION) ?? from?.closest<HTMLElement>(MAIN_ACTION) ?? null;
      if (!target || isOff(target)) return;
      if (!target.matches(HEAVY_ACTION) && target !== mainActionIn(root)) return;
      const key = `${job.bytes}:${job.files ?? 1}`;
      if (confirmed === key) return;
      const title = job.title ?? ((job.files ?? 1) > 1
        ? t('heavy-job.files')
        : t('pdfto-word.this.is.a.large.pdf.and.may.848eab'));
      event.preventDefault();
      event.stopPropagation();
      void confirm(job.bytes, title).then((go) => {
        if (!go || !target.isConnected) return;
        heavyRef.current.confirmed = key;
        target.click();
      });
    };
    root.addEventListener('click', onClick, true);
    return () => root.removeEventListener('click', onClick, true);
  }, []);

  const fileBits = file && (
    <>
      <bdi className="tk-fname chef-filename" title={file.name}>{file.name}</bdi>
      {file.meta && <span className="tk-fmeta tabular">{file.meta}</span>}
    </>
  );
  const actionRow = progress ?? ((action || secondary) && (
    <ActionRow>
      {secondary}
      {action}
    </ActionRow>
  ));
  const reasonBase = useId().replace(/[^a-zA-Z0-9]/g, '');
  const reasonIds = { sentence: `tk-why-${reasonBase}-s`, notice: `tk-why-${reasonBase}-n` };
  // The page's notice line: an open editor repeats it, and while it does, the copy is the alert (verify V-06).
  const noticeLine = notice ? <PageNoticeContext.Provider value><div id={reasonIds.notice} className="tk-notice">{notice}</div></PageNoticeContext.Provider> : null;
  const chipRow = chips ? <div className="tk-chips">{chips}</div> : null;
  const hasControls = Boolean(sentence || actionRow || lead || noticeLine);
  // Where keyboard focus starts in this tool (research r2, desktop-01 to -03): the sentence and
  // its settings once a file is loaded, otherwise the body (the picker). "Skip to content" lands
  // here, and so does a route change on a tablet or desktop.
  const startOnControls = hasControls && !editor;
  // A form below 768 px draws its foot sheet after the fields, so its settings start is the fields
  // (research r3, mobile-05): starting on the sheet left Tab nothing but the page's top.
  const startOnFields = startOnControls && kind === 'form' && !wide;
  const startRef = useRef<HTMLElement | null>(null);
  const setStart = (node: HTMLElement | null) => { startRef.current = node; };
  const screenRef = useRef<HTMLDivElement>(null);
  // What says why the main action is off (fix round 2, item 5): the sentence and the notice line.
  // A disabled main action stays focusable and is described by both (ActionRow).
  useLayoutEffect(() => {
    const visible = screenRef.current?.querySelector<HTMLElement>('.tk-sentence-group > p.tk-sentence:not(.tk-measure), .tk-sentence-group > .tk-rows');
    if (visible && !visible.id) visible.id = reasonIds.sentence;
  });

  // Ctrl+Enter (Cmd+Enter on a Mac) runs the main action from anywhere in the tool while it is on
  // (fix round 2, item 5). Not while a sheet or dialog that holds the page is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return;
      const root: HTMLDivElement | null = screenRef.current;
      if (!root || document.querySelector('[aria-modal="true"]')) return;
      const main = mainActionIn(root);
      if (!main) return;
      event.preventDefault();
      // Held keys repeat: one press runs the job once (fix review, finding 6).
      if (event.repeat || isOff(main)) return;
      main.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The screen's own polite line (path to 9, item 6): removals and "Canceled." are said here.
  const [voiceLine, announce] = useAnnouncer();
  // The file the screen last held, so clearing it can be said by name ("qa-sample.pdf removed.").
  const heldName = useRef('');
  if (file?.name) heldName.current = file.name;
  const cleared = useRef<(() => void) | null>(null);
  cleared.current = () => { if (heldName.current) announce(t('tool.removed', { v0: heldName.current })); };
  useFocusRescue(screenRef, startRef, cleared);
  const cancelAsked = useRef(false);
  const voice = useMemo<ToolVoice>(() => ({ announce, cancelAsked }), [announce]);
  useLayoutEffect(() => {
    setScreenVoice(voice);
    return () => setScreenVoice(null, voice);
  }, [voice]);
  const controlsBefore = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const before = controlsBefore.current;
    controlsBefore.current = startOnControls;
    const active = document.activeElement as HTMLElement | null;
    // Focus that waited on the canvas while the file opened (an editor, Metadata) counts as lost.
    const lost = !active || active === document.body || !active.isConnected
      || (active.classList.contains('tk-canvas') && active !== startRef.current);
    const onMain = active?.id === 'main';
    const wideEnough = window.matchMedia?.(MQ_LG).matches ?? false;
    // A file just arrived: the picker that had focus is gone, so the next Tab would start inside
    // the page grid (68 presses to the range field on a 60-page file). Start at the settings.
    const fileArrived = before === false && startOnControls && (lost || onMain);
    // A route change (the shell focused <main> before this lazy screen arrived): skip the header.
    // So does the first screen after the page loads, when nothing has focus yet (round 5,
    // desktop-07: a tool opened by its address took 6 Tabs to Choose files; today's took 1).
    const opened = before === null && wideEnough && (onMain || (!pageLoadSettled && lost));
    pageLoadSettled = true;
    if (fileArrived || opened) startRef.current?.focus({ preventScroll: true });
  }, [startOnControls]);
  const startProps = (on: boolean) => (on ? { ref: setStart, tabIndex: -1, 'data-skip-target': '' } : {});

  const canvas = (
    <section
      className="tk-canvas"
      data-kind={kind}
      aria-labelledby={bodyLabelledBy}
      aria-label={bodyLabelledBy ? undefined : bodyLabel}
      {...startProps(!startOnControls || startOnFields)}
    >
      {side ? (
        <div className="tk-split">
          {/* Tablet and desktop: the settings come before the page in the document (Tab order,
              research r2 and r3); CSS draws the page first. A phone keeps the page first. */}
          {sideFirst && <div className="tk-split-side">{side}</div>}
          <div className="tk-split-main">{body}</div>
          {!sideFirst && <div className="tk-split-side">{side}</div>}
        </div>
      ) : body}
    </section>
  );

  const sheet = !wide && !preview && !editor && hasControls && (
    <div className="tk-sheet" {...startProps(startOnControls && !startOnFields)}>
      <div ref={resultRef} className="tk-result" />
      {lead}
      {sentence}
      {chipRow}
      {noticeLine}
      {actionRow}
    </div>
  );
  // Phones (verify V-01): the foot sheet comes before the page tiles or file rows in the
  // document, so Tab and a screen reader reach the settings and the main action first, as on
  // desktop; CSS `order` still draws it at the foot. A form keeps its fields first: they are
  // its settings, and the sheet's action follows them.
  const sheetFirst = kind !== 'form';

  return (
    <ToolVoiceContext.Provider value={voice}>
    <LeaveAskContext.Provider value={leaveGuard.askLeave}>
    <ToolTitleContext.Provider value={title}>
    <ToolNoticeContext.Provider value={notice ?? null}>
    <ToolProgressShownContext.Provider value={Boolean(progress)}>
    <ActionReasonContext.Provider value={`${reasonIds.sentence}${notice ? ` ${reasonIds.notice}` : ''}`}>
    <div ref={screenRef} className="tk-screen">
    {/* The header is the page's banner, outside <main> (research r3, desktop-10). */}
    <ToolTop title={title} tool={tool} beta={beta} file={wide ? fileBits : undefined} trailing={change} leading={leading} homeLabel={homeLabel} />
    <main className={`tk-tool${className ? ` ${className}` : ''}`} data-kind={kind} data-wide={wide ? '' : undefined} data-tail={tail && hasControls ? '' : undefined}>
      {!wide && file && !preview && !editor && <p className="tk-fileline">{fileBits}</p>}
      {wide && !editor && hasControls && (
        <div className="tk-band" {...startProps(startOnControls)}>
          <div className="tk-band-main">
            {lead}
            {sentence}
            {chipRow}
            {noticeLine}
          </div>
          {!tail && (
            <>
              <div className="tk-band-end">
                {actionRow}
                {endControl}
              </div>
              {/* The result strip takes the band's width under both (T-07). */}
              <div ref={resultRef} className="tk-result tk-band-result" />
            </>
          )}
        </div>
      )}
      {!wide && preview && (sentence || noticeLine) && (
        <div className="tk-band tk-band-top" {...startProps(startOnControls)}>
          {sentence}
          {chipRow}
          {noticeLine}
        </div>
      )}
      {sheetFirst && sheet}
      {canvas}
      {/* The band's action and result strip, after the settings column in the document and drawn
          in the band's row (research r2, desktop-04). */}
      {tail && hasControls && (
        // Also a `.tk-band`, so the band's action rules apply; it draws no box of its own.
        <div className="tk-band tk-band-tail">
          <div className="tk-band-end">
            {actionRow}
            {endControl}
          </div>
          <div ref={resultRef} className="tk-result tk-band-result" />
        </div>
      )}
      {!sheetFirst && sheet}
      {!wide && preview && (
        <div className="tk-footbar">
          <div ref={resultRef} className="tk-result" />
          {actionRow}
        </div>
      )}
      {extra}
      {toast}
      {leaveGuard.sheet}
      {heavy.sheet}
    </main>
    {/* Last in the screen, so a tool's own status line stays the first one in the page. */}
    {voiceLine}
    </div>
    </ActionReasonContext.Provider>
    </ToolProgressShownContext.Provider>
    </ToolNoticeContext.Provider>
    </ToolTitleContext.Provider>
    </LeaveAskContext.Provider>
    </ToolVoiceContext.Provider>
  );
};
