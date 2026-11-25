import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, FolderOpen, LayoutGrid, X } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { useHeaderLinks, useWide } from '../../hooks/useMediaQuery';
import { ToolBackButton, usePrimaryNav, useToolBack } from '../Layout/AppShell';
import { pathBehind, returnToTools } from '../Layout/navigationHistory';
import { ToolIdentity } from '../Tools/ToolIdentity';
import { tools, type ToolCardData } from '../Tools/toolCatalog';
import { BetaBadge } from '../UI/Primitives';
import { useNoteCancel } from './parts';
import { useReplaceOnDrop } from '../../hooks/useFileDrop';
import './tool.css';

/**
 * The header of every tool route (plan 2.2): the conditional Back arrow, the brand
 * link (desktop), the tool's mark and name, the file (desktop), the tool's "change
 * the file" control, and Tools at the end (top right; top left in RTL). On desktop,
 * Recent and Settings sit just before Tools (research r1: one click away again); a
 * phone keeps Tools alone. A page opened from Settings shows "‹ Settings" instead
 * of Tools.
 */

/** The route's tool (for the mark beside its name and the BETA badge). */
export const useRouteTool = (): ToolCardData | undefined => {
  const { pathname } = useLocation();
  return tools.find((tool) => tool.path === pathname);
};

/** True when this page was opened from Settings (Help, Privacy, Terms, Licenses). */
export const useOpenedFromSettings = () => useToolBack().backTab.to !== '/';

/**
 * Set by a tool screen (path to 9, item 7): asks before a header link (Tools, the brand, Recent,
 * Settings) leaves a loaded file or a running job behind, as reload already does. Returns true
 * when it asked; it calls `go` itself once the person chooses to leave.
 */
export const LeaveAskContext = React.createContext<((go: () => void) => boolean) | null>(null);

type NavLinkProps = ReturnType<typeof usePrimaryNav>['items'][number]['linkProps'];

/** A header link's props with the tool screen's leave question in front of its own click. */
const useAskingLink = (linkProps: NavLinkProps) => {
  const ask = React.useContext(LeaveAskContext);
  const navigate = useNavigate();
  const { ['aria-current']: _current, onClick, ...rest } = linkProps;
  return {
    ...rest,
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      const go = () => {
        if (linkProps.to === '/') returnToTools(navigate);
        else navigate(linkProps.to, { replace: linkProps.replace, state: linkProps.state });
      };
      if (ask && plain && ask(go)) {
        event.preventDefault();
        return;
      }
      onClick(event);
    },
  };
};

/**
 * The one Tools control on a tool screen. It merges today's "‹ Tools" back button and
 * the Tools tab: a link named "Tools" that goes to Tools home the way the tab does (a
 * step back when Tools home is just behind, which is also what the back button did).
 */
export const ToolsLink: React.FC<{ className?: string }> = ({ className }) => {
  const nav = usePrimaryNav();
  const toolsTab = nav.items[0];
  const linkProps = useAskingLink(toolsTab.linkProps);
  return (
    <Link {...linkProps} data-tk-tools="" className={`tk-tools chef-pressable${className ? ` ${className}` : ''}`}>
      <LayoutGrid aria-hidden size={16} strokeWidth={1.75} />
      <span>{toolsTab.label}</span>
    </Link>
  );
};

/** A tool header's end: the Tools link, or for a page opened from Settings, its back button. */
export const BackOrTools: React.FC = () => {
  const fromSettings = useOpenedFromSettings();
  return fromSettings ? <ToolBackButton className="tk-settings-back" /> : <ToolsLink />;
};

/**
 * Desktop (research r1) and tablet portrait, 768 px and wider (research r2, web-lead decision):
 * Recent and Settings, with the names and behaviour of the side rail's links, just before the
 * header's Tools. Phones keep only Tools. A destination the header
 * already goes back to ("‹ Settings") is not repeated. `compact`: the icon alone, the word kept
 * as the link's name and tooltip.
 */
export const DesktopNavLinks: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const nav = usePrimaryNav();
  const { backTab } = useToolBack();
  const fromSettings = useOpenedFromSettings();
  return (
    <>
      {nav.items.slice(1).filter((item) => !(fromSettings && item.to === backTab.to)).map((item) => (
        <AskingNavLink key={item.to} item={item} compact={compact} />
      ))}
    </>
  );
};

const AskingNavLink: React.FC<{ item: ReturnType<typeof usePrimaryNav>['items'][number]; compact: boolean }> = ({ item, compact }) => {
  const Icon = item.icon;
  const linkProps = useAskingLink(item.linkProps);
  return (
    <Link {...linkProps} title={compact ? item.label : undefined} data-tk-nav="" data-compact={compact || undefined} className="tk-navlink chef-pressable">
      <Icon aria-hidden size={16} strokeWidth={1.75} />
      <span className={compact ? 'sr-only' : undefined}>{item.label}</span>
    </Link>
  );
};

const NAMES = '.tk-top-title, .tk-fname, .tk-rtitle-name';
/** Cut short: the tool's title at all, or a file name left under about 20 characters (on one
 * line, or past its second line where names wrap). */
const cutShort = (el: HTMLElement) => (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
  && (el.classList.contains('tk-top-title') || el.clientWidth < 160);

/**
 * Desktop: Recent and Settings show their words while the header row has room. When the words
 * would cut the tool's name or the file name short (1024 px, German, Largest text), they show only
 * their icons (level 1); still cut, Tools too (level 2, as on a phone). Names never change. The
 * ref goes on the links' own <nav>, a child of the row. A new row width, a new name or the fonts
 * arriving try the words again.
 */
export const useNavFit = (wide: boolean) => {
  const ref = React.useRef<HTMLElement>(null);
  const [level, setLevel] = React.useState(0);
  const names = React.useRef('');
  React.useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!wide || !row || typeof ResizeObserver === 'undefined') return undefined;
    let width = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      setLevel(0);
    });
    observer.observe(row);
    let live = true;
    if (document.fonts && document.fonts.status !== 'loaded') void document.fonts.ready.then(() => { if (live) setLevel(0); });
    return () => { live = false; observer.disconnect(); };
  }, [wide]);
  React.useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!wide || !row) return;
    const els = [...row.querySelectorAll<HTMLElement>(NAMES)];
    const key = els.map((el) => el.textContent).join('\n');
    if (key !== names.current) {
      names.current = key;
      if (level) { setLevel(0); return; }
    }
    if (level < 2 && els.some(cutShort)) setLevel(level + 1);
  });
  return { ref, level: wide ? level : 0 };
};

/** The exact logo image in a round paper disc. */
export const LogoTile: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <span aria-hidden className="tk-logo">
    <img src="/pdf-chef-logo-exact.webp" alt="" width={size} height={size} />
  </span>
);

/** The side rail's brand link as a small logo: same name ("PDF Chef On this device"), same destination. */
export const BrandLink: React.FC<{ className?: string }> = ({ className }) => {
  useI18n();
  const nav = usePrimaryNav();
  const linkProps = useAskingLink(nav.items[0].linkProps);
  return (
    <Link {...linkProps} title="PDF Chef" className={`tk-brand chef-pressable${className ? ` ${className}` : ''}`}>
      <LogoTile />
      <span className="sr-only">PDF Chef</span>
      <span className="sr-only"> {t('app-shell.on.this.device.38b9d8')}</span>
    </Link>
  );
};

/**
 * Back, only where it does something Tools does not: the entry behind this screen is
 * known and is not Tools home (a tool opened from Read PDF's menu, from "Use in another
 * tool", from Recent or from another tool). Same action as the system Back. A page
 * opened from Settings keeps its "‹ Settings" instead.
 */
export const BackIfNeeded: React.FC = () => {
  useI18n();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const fromSettings = useOpenedFromSettings();
  const behind = pathBehind();
  if (fromSettings || !behind || behind === '/' || behind === pathname) return null;
  return (
    <button
      type="button"
      onClick={() => navigate(-1)}
      aria-label={t('nav.back')}
      title={t('nav.back')}
      data-tk-back=""
      className="tk-back chef-pressable"
    >
      <ChevronLeft aria-hidden size={22} strokeWidth={1.75} className="rtl:rotate-180" />
    </button>
  );
};

/**
 * Keeps the phone header one height (T-04): one 48 px row with Tools at the end and the name in
 * 20 px lines, BETA glued to its last word. When the name would wrap, the title first shrinks one
 * step (level 1); when it still wraps, or Tools is pushed off the row, the "change file" control
 * drops its word (level 2; on a tablet, Recent and Settings too). A title that is still on two
 * lines beside its mark drops the mark next (level 3), so an icon never keeps the name wrapped
 * (PowerPoint to PDF beside BETA). If it is still two lines, Tools keeps its name and shows only
 * its icon, and the mark stays off (level 4), which is what fits a 360 px phone. Tools keeps its
 * word until then, or until the name needs more than two lines or Tools is pushed under it
 * (research r2, mobile-03). A word too long for the row is then hyphenated and the mark returns
 * (level 5, verify V-02).
 * Every control keeps its name. A width change starts again from level 0, so a wider screen gets the words back.
 */
const rowWrapped = (row: HTMLElement, strict: boolean) => {
  const first = row.firstElementChild as HTMLElement | null;
  const last = row.lastElementChild as HTMLElement | null;
  if (!first || !last) return false;
  // A row that cannot wrap any further pushes Tools past the end edge instead (Create PDF in
  // Russian): that counts as too long as well.
  if (row.scrollWidth > row.clientWidth + 1) return true;
  // Hyphenation asks for more: Tools on a line of its own under the row's start, not merely
  // centred lower beside a title of three or four lines.
  return strict ? last.offsetTop >= first.offsetTop + first.offsetHeight - 2 : last.offsetTop > first.offsetTop + 8;
};

/** The title takes a second line, or BETA drops under it. A badge glued to the last word is
 * its own box on that same line, so only a lower line counts, not a second box. */
const nameWrapped = (row: HTMLElement) => {
  const title = row.querySelector<HTMLElement>('.tk-top-title');
  if (!title) return false;
  const lines = [...title.getClientRects()];
  const tops = new Set(lines.map((rect) => Math.round(rect.top)));
  if (tops.size > 1) return true;
  const badge = row.querySelector<HTMLElement>('.tk-top-beta');
  const line = lines[0];
  return Boolean(badge && line && badge.getBoundingClientRect().top >= line.bottom - 2);
};

/** The name needs more than the row's 40 px inside (three lines, or two at large text). */
const nameTooTall = (row: HTMLElement) => {
  const name = row.querySelector<HTMLElement>('.tk-top-name');
  return Boolean(name && name.getBoundingClientRect().height > 40.5);
};

/** The name takes more than two of its own lines (at any text size). */
const nameOverTwoLines = (row: HTMLElement) => {
  const name = row.querySelector<HTMLElement>('.tk-top-name');
  const title = row.querySelector<HTMLElement>('.tk-top-title');
  if (!name || !title) return false;
  const line = parseFloat(getComputedStyle(title).lineHeight) || 20;
  return name.getBoundingClientRect().height > line * 2 + 1;
};

const MAX_LEVEL = 5;
const tooLong = (row: HTMLElement, level: number, settled: boolean) => {
  if (level === 0) return rowWrapped(row, false) || nameWrapped(row);
  // The name keeps one line before the "change file" word does (owner, 2026-11-15: "Change"
  // put Page Numbers on two lines on a 366 px phone).
  if (level === 1) return rowWrapped(row, false) || nameWrapped(row);
  // Still two lines after the change-file word has gone: the mark gives way (level 3). Still
  // two lines after that: Tools' word gives way too, and the mark stays off (level 4).
  if (level === 2 || level === 3) return rowWrapped(row, settled) || nameWrapped(row) || (level === 3 && nameOverTwoLines(row));
  return rowWrapped(row, settled) || nameTooTall(row);
};

const useCompactRow = (deps: unknown[]) => {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [level, setLevel] = React.useState(0);
  // Each level is tried on the row itself, from 0 up, and the first that fits is kept (research
  // r2): stepping up one level per callback could overshoot by one when a resize, a font and a
  // render crossed, and take a word that fits (the Tools word at Largest text). Every level is
  // drawn by CSS from `data-compact`, so trying one needs no render; the row is put back as React
  // drew it before the level found is set.
  const measure = React.useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const drawn = row.getAttribute('data-compact');
    let next = 0;
    for (; next < MAX_LEVEL; next += 1) {
      if (next) row.setAttribute('data-compact', String(next));
      else row.removeAttribute('data-compact');
      if (!tooLong(row, next, true)) break;
    }
    if (drawn === null) row.removeAttribute('data-compact');
    else row.setAttribute('data-compact', drawn);
    setLevel(next);
  }, []);
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    let seen = '';
    const name = row.querySelector<HTMLElement>('.tk-top-name');
    // A new width, a control arriving (the row's height), or the name changing size by itself
    // (the row keeps its height when the name takes a second line, T-04; its font arriving)
    // measures again.
    const observer = new ResizeObserver(() => {
      const now = `${row.clientWidth} ${row.clientHeight} ${Math.round(name?.getBoundingClientRect().height ?? 0)}`;
      if (now === seen) return;
      seen = now;
      measure();
    });
    observer.observe(row);
    if (name) observer.observe(name);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) measure(); });
    const fontsArrived = () => { if (live) measure(); };
    document.fonts?.addEventListener?.('loadingdone', fontsArrived);
    return () => {
      live = false;
      observer.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', fontsArrived);
    };
  }, [measure]);
  React.useLayoutEffect(() => { measure(); }, deps);
  return { rowRef, level };
};

export const ToolTop: React.FC<{
  title: string;
  tool?: ToolCardData;
  /** The name is the page's h1. False on a page whose body carries its own h1 (Help, legal pages). */
  heading?: boolean;
  beta?: boolean;
  file?: React.ReactNode;
  /** The tool's "change the file" control (ChangeFile). */
  trailing?: React.ReactNode;
  /** Replaces the brand link (PDF to Image keeps "Back to tools" there). */
  leading?: React.ReactNode;
  /** Sticks to the top of a scrolling page (the header the shell draws for Help and the legal pages). */
  sticky?: boolean;
  /** Only the end control (a page behind Settings: the side rail has the brand, the page names itself). */
  bare?: boolean;
  /** The phone name link's accessible name, where a tool already had a top-left link (PDF to Image's
   * "Back to tools", Image to PDF's "Back to dashboard"). Default: "Tools". */
  homeLabel?: string;
  /** False where the name is not drawn on a phone (Edit PDF under 440 px shows only its heading to
   * assistive technology), so there is nothing to tap. */
  nameLink?: boolean;
  /** With `bare`: show the name too (a page behind Settings whose own heading has scrolled away). */
  bareTitle?: boolean;
}> = ({ title, tool, heading = true, beta, file, trailing, leading, sticky = false, bare = false, homeLabel, nameLink = true, bareTitle = false }) => {
  useI18n();
  const wide = useWide();
  const links = useHeaderLinks() && !bare;
  const nav = usePrimaryNav();
  const Title = heading ? 'h1' : 'span';
  const isBeta = beta ?? Boolean(tool?.beta);
  const { rowRef, level } = useCompactRow([title, isBeta, wide, links]);
  const navFit = useNavFit(wide && !bare);
  // Phones (T-04): BETA is glued to the title's last word, so it never drops to a line of its
  // own. It is drawn inside the heading but hidden from it, and said once after it, so the
  // heading's name stays the tool's name.
  const name = title.trim();
  const cut = name.lastIndexOf(' ');
  const glue = !wide && isBeta && cut > 0;
  const betaWord = t('dashboard.beta.703390');
  const nameParts = (
    <>
      {tool && <ToolIdentity tool={tool} size={18} assetSize={24} className="tk-top-mark" assetClassName="tk-top-mark-img" />}
      {glue ? (
        <>
          <Title className="tk-top-title">
            {name.slice(0, cut + 1)}
            <span className="tk-top-glue">
              {name.slice(cut + 1)}
              <span aria-hidden><BetaBadge className="tk-top-beta">{betaWord}</BetaBadge></span>
            </span>
          </Title>
          {/* With a space, so the link's name reads "Edit PDF Beta", not "Edit PDFBETA" (fable K11). */}
          <span className="sr-only">{` ${betaWord}`}</span>
        </>
      ) : (
        <>
          <Title className="tk-top-title">{title}</Title>
          {isBeta && <BetaBadge className="tk-top-beta">{betaWord}</BetaBadge>}
        </>
      )}
    </>
  );
  // Phones (owner decision D-1): the tool's mark and name go to Tools home, the way today's
  // top-left "‹ Tools" did. Same look, and the link's name is the existing "Tools".
  const homeProps = useAskingLink(nav.items[0].linkProps);
  const asHomeLink = !wide && !bare && heading && nameLink;
  return (
    <header className={`tk-top chef-safe-top${sticky ? ' tk-top-sticky' : ''}${bare ? ' tk-top-bare' : ''}`}>
      <div ref={rowRef} className="tk-top-row" data-compact={level || undefined}>
        <BackIfNeeded />
        {!bare && (leading ?? (wide && <BrandLink className="tk-top-brand" />))}
        {!bare && (leading || wide) && <span aria-hidden className="tk-top-sep" />}
        {(!bare || bareTitle) && (asHomeLink ? (
          <Link {...homeProps} aria-label={homeLabel ?? nav.items[0].label} data-tk-home="" className="tk-top-name tk-top-home">
            {nameParts}
          </Link>
        ) : (
          <span className="tk-top-name" aria-hidden={heading ? undefined : true}>
            {nameParts}
          </span>
        ))}
        {file && <span className="tk-top-file">{file}</span>}
        <span className="tk-spacer" />
        {trailing}
        {links ? (
          <nav ref={navFit.ref} aria-label={nav.label} data-fit={navFit.level || undefined} className="tk-topnav">
            {/* A tablet's row gives the links' words up with the change control's (level 2, in CSS). */}
            <DesktopNavLinks compact={wide && navFit.level > 0} />
            <BackOrTools />
          </nav>
        ) : <BackOrTools />}
      </div>
    </header>
  );
};

/**
 * A tool's "choose another file" control for the header. Desktop: today's words as
 * the visible text. Phone: the words too when they are short ("Change", "Start over"),
 * otherwise an open-folder icon, with today's words as its accessible name either way.
 */
const SHORT_LABEL = 12;

export const ChangeFile: React.FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** The control cancels the running job instead (Extract Text): the phone word is "Cancel". */
  cancels?: boolean;
}> = ({ label, onClick, disabled, cancels }) => {
  useI18n();
  const wide = useWide();
  useReplaceOnDrop({ onReplace: onClick, busy: disabled || cancels });
  const noteCancel = useNoteCancel();
  const asText = wide || label.length <= SHORT_LABEL;
  return (
    <button
      type="button"
      onClick={() => {
        if (cancels) noteCancel();
        onClick();
      }}
      disabled={disabled}
      aria-label={wide ? undefined : label}
      title={asText ? undefined : label}
      data-tk-change=""
      className={wide ? 'tk-change chef-pressable' : asText ? 'tk-change tk-change-text chef-pressable' : 'tk-change tk-change-word chef-pressable'}
    >
      {asText ? (wide ? label : (
        // A short word on a phone ("Change", Japanese "別のファイルを選択") still gives way to
        // its icon when the header row is too long, like the longer labels do.
        <>
          {cancels ? <X aria-hidden size={18} strokeWidth={1.75} className="tk-change-compact" /> : <FolderOpen aria-hidden size={18} strokeWidth={1.75} className="tk-change-compact" />}
          <span>{label}</span>
        </>
      )) : (
        // Phone (B-007): the icon and a short word, so the button says what it does;
        // the full label stays its name. The key is the tools' shared "Change".
        <>
          {cancels ? <X aria-hidden size={18} strokeWidth={1.75} /> : <FolderOpen aria-hidden size={18} strokeWidth={1.75} />}
          <span aria-hidden>{cancels ? t('ocrpdf.cancel.19766e') : t('pdf-advanced-tools.change.c0bf75')}</span>
        </>
      )}
    </button>
  );
};
