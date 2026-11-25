import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useNavigationType, type NavigateFunction } from 'react-router-dom';
import { ChevronLeft, Download, History, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { mobileAppLinks } from '../../services/mobileAppWelcome';
import { TAB_ENTRY, rememberHistoryEntry, returnToTools } from './navigationHistory';
import { tools } from '../Tools/toolCatalog';
import { ToolTop } from '../Tool/ToolTop';
import { cx } from '../UI/Primitives';
import { useHaptics } from '../../hooks/useWorkspaceRuntime';
import { MQ_LG } from '../../hooks/useMediaQuery';
import './tabBarGlass.css';

/**
 * Three destinations, named for what is in them. "Tools" rather than "Home",
 * because a specific label is predictable and a generic one is not.
 */
export const TABS = [
  { to: '/', get label() { return t("app-shell.tools.ea93d6"); }, icon: LayoutGrid, match: (path: string) => path === '/' || tools.some((tool) => tool.path === path) },
  { to: '/recent', get label() { return t("app-shell.recent.690dbe"); }, icon: History, match: (path: string) => path === '/recent' || path === '/history' },
  { to: '/settings', get label() { return t("app-shell.settings.74a883"); }, icon: SlidersHorizontal, match: (path: string) => path === '/settings' },
] as const;

/**
 * Help, Privacy, Terms and Licenses are reading pages behind the Settings tab, not
 * tools: they keep the tab bar and the side rail (owner decision 4, B-020). No tab is
 * current on them, as before the redesign (polish item 6).
 */
const SETTINGS_PAGES = new Set(['/help', '/privacy', '/privacy-policy', '/pdf-chef-privacy', '/terms', '/terms-and-conditions', '/licenses']);
export const isSettingsPage = (path: string) => SETTINGS_PAGES.has(path);

// Tab highlighting and tab-root layout are different decisions. Tool routes
// highlight Tools, but they have no rail and no tab bar of their own to share.
const isTabRoot = (path: string) => path === '/' || path === '/recent' || path === '/history' || path === '/settings';

const KEYBOARD_EDITABLE_SELECTOR = [
  'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

const isKeyboardEditable = (element: Element | null) =>
  element instanceof HTMLElement && element.matches(KEYBOARD_EDITABLE_SELECTOR);

/**
 * Some mobile WebViews overlay the keyboard instead of resizing the layout
 * viewport, and iOS additionally scrolls the *visual* viewport to reveal a
 * focused editable. Mirror both into CSS, without React state or rerenders:
 * the covered portion at the bottom, and how far the visible region has been
 * pushed down from the layout viewport's top. When the layout already resizes
 * and nothing is focused, both measure zero.
 */
const useVisualViewportInsets = () => {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const rootStyle = document.documentElement.style;
    const previousInset = rootStyle.getPropertyValue('--chef-keyboard-inset');
    const previousOffsetTop = rootStyle.getPropertyValue('--chef-viewport-offset-top');
    let frame = 0;
    let currentInset = -1;
    let currentOffsetTop = -1;
    let currentTyping = false;
    // Android resizes the window for the keyboard instead of covering it, so nothing
    // measures as covered there; a window that shrank while typing is the sign instead.
    // Kept per width, so turning the phone mid-typing compares like with like.
    const restingHeights = new Map([[window.innerWidth, window.innerHeight]]);

    const update = () => {
      frame = 0;
      const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
      const coveredHeight = Math.max(0, layoutHeight - viewport.height - viewport.offsetTop);
      const unzoomed = Math.abs(viewport.scale - 1) <= 0.05;
      const editing = isKeyboardEditable(document.activeElement);
      const keyboardVisible = editing && unzoomed && coveredHeight >= 80;
      const nextInset = keyboardVisible ? Math.round(coveredHeight) : 0;
      if (!editing) restingHeights.set(window.innerWidth, window.innerHeight);
      const restingHeight = restingHeights.get(window.innerWidth);
      // The tab bar would sit on the keyboard, over the field being typed in. Turned to a width
      // never seen without the keyboard, keep the last answer until the field is left.
      const typing = keyboardVisible || (editing && (restingHeight === undefined
        ? currentTyping
        : restingHeight - window.innerHeight >= 120));
      if (typing !== currentTyping) {
        currentTyping = typing;
        document.documentElement.toggleAttribute('data-chef-keyboard', typing);
      }
      // While the reader is pinch-zoomed the offset is theirs to pan, so leave the chrome alone
      // and only follow the viewport when the page is at its natural scale.
      const nextOffsetTop = unzoomed ? Math.max(0, Math.round(viewport.offsetTop)) : 0;

      if (nextInset !== currentInset) {
        currentInset = nextInset;
        rootStyle.setProperty('--chef-keyboard-inset', `${nextInset}px`);
      }
      if (nextOffsetTop !== currentOffsetTop) {
        currentOffsetTop = nextOffsetTop;
        rootStyle.setProperty('--chef-viewport-offset-top', `${nextOffsetTop}px`);
      }
    };

    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    viewport.addEventListener('resize', scheduleUpdate);
    viewport.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', scheduleUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', scheduleUpdate);
      viewport.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate);
      document.removeEventListener('focusout', scheduleUpdate);
      if (previousInset) rootStyle.setProperty('--chef-keyboard-inset', previousInset);
      else rootStyle.removeProperty('--chef-keyboard-inset');
      document.documentElement.removeAttribute('data-chef-keyboard');
      if (previousOffsetTop) rootStyle.setProperty('--chef-viewport-offset-top', previousOffsetTop);
      else rootStyle.removeProperty('--chef-viewport-offset-top');
    };
  }, []);
};

/* ------------------------------------------------------------- Tab bar --- */

/**
 * Tabs replace the current entry instead of stacking (`replace` on every tab
 * link), so Back never replays tab visits. A plain press on Tools steps back to
 * Tools home when it is just behind, so the list keeps its place.
 */
const pressTab = (to: string, navigate: NavigateFunction) => (event: React.MouseEvent<HTMLAnchorElement>) => {
  if (to !== '/' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  returnToTools(navigate);
};

const TabBar: React.FC = () => {
  useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const haptic = useHaptics();

  return (
    <nav
      aria-label={t("app-shell.primary.efe10c")}
      className="chef-chrome chef-tab-bar chef-safe-bottom chef-safe-x fixed inset-x-0 bottom-0 z-40 md:hidden"
    >
      {/* A glass island inset from the edges; see tabBarGlass.css. */}
      <ul className="chef-tab-dock mx-auto flex max-w-xl">
        {TABS.map(({ to, label, icon: Icon, match }) => {
          const active = match(location.pathname);
          return (
            <li key={to} className="flex-1">
              <Link
                to={to}
                replace
                state={TAB_ENTRY}
                onClick={pressTab(to, navigate)}
                aria-current={active ? 'page' : undefined}
                onPointerDown={() => haptic('selection')}
                className={cx(
                  'chef-tab chef-pressable flex min-h-[calc(var(--size-tab-bar)-8px)] flex-col items-center justify-center gap-1 rounded-full py-1',
                  active ? 'font-bold text-[var(--accent-on-quiet)]' : 'text-[var(--chef-tab-rest)]',
                )}
              >
                <span className="grid px-3">
                  <Icon aria-hidden size={24} strokeWidth={active ? 2.5 : 1.9} />
                </span>
                <span className="chef-tab-label text-[0.8125rem] font-semibold leading-none tracking-[0.005em]">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};

/* ---------------------------------------------------------- Side rail ---- */

/**
 * The same three destinations on iPad and desktop. Structural adaptation, not a
 * different information architecture: identical labels, identical order.
 */
const SideRail: React.FC = () => {
  useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  return (
  <nav
    aria-label={t("app-shell.primary.efe10c")}
    className="chef-safe-top chef-safe-x sticky top-0 hidden h-screen w-[13.5rem] shrink-0 flex-col border-e border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-5 md:flex lg:w-[15rem]"
  >
    <Link to="/" replace state={TAB_ENTRY} onClick={pressTab('/', navigate)} className="chef-pressable mb-6 flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-1">
      <img src="/pdf-chef-logo-exact.webp" alt="" aria-hidden className="h-9 w-9 object-contain" />
      <span className="min-w-0">
        <span className="chef-display block leading-tight text-[var(--text-primary)]">PDF Chef</span>
        <span className="type-caption block font-medium normal-case tracking-normal text-[var(--text-secondary)]">{t("app-shell.on.this.device.38b9d8")}</span>
      </span>
    </Link>

    <ul className="space-y-1">
      {TABS.map(({ to, label, icon: Icon, match }) => {
        const active = match(location.pathname);
        return (
          <li key={to}>
            <NavLink
              to={to}
              replace
              state={TAB_ENTRY}
              onClick={pressTab(to, navigate)}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'chef-pressable chef-target flex items-center gap-3 rounded-[var(--radius-control)] px-3 font-semibold',
                active
                  ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]',
              )}
            >
              <Icon aria-hidden size={20} />
              {label}
            </NavLink>
          </li>
        );
      })}
    </ul>

    {/* The website's way to the apps on a tablet or computer, where no "get the app" screen opens
        (owner, 25 Nov 2026). The apps themselves have none. */}
    {!Capacitor.isNativePlatform() && (
      <ul className="mt-auto space-y-1">
        {(['android', 'ios'] as const).map((platform) => (
          <li key={platform}>
            <a
              href={mobileAppLinks[platform]}
              className="chef-pressable chef-target flex items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
            >
              <Download aria-hidden size={18} className="shrink-0" />
              <span className="chef-wrap-words py-1">{t(platform === 'android' ? 'mobileAppWelcome.android' : 'mobileAppWelcome.ios')}</span>
            </a>
          </li>
        ))}
      </ul>
    )}
  </nav>
  );
};

/* ------------------------------------------------------ Tool header ---- */

/**
 * The three destinations with today's names and behaviour, for a header that draws
 * its own links (the tool header's Tools link and brand link). Render each item as
 * `<Link {...item.linkProps}>`: the links keep `replace`, the tab entry state,
 * `aria-current` and the Tools press rule.
 */
export const usePrimaryNav = () => {
  useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const haptic = useHaptics();
  return {
    label: t("app-shell.primary.efe10c"),
    items: TABS.map(({ to, label, icon, match }) => {
      const active = match(location.pathname);
      return {
        to,
        label,
        icon,
        active,
        linkProps: {
          to,
          replace: true,
          state: TAB_ENTRY,
          onClick: pressTab(to, navigate),
          onPointerDown: () => haptic('selection'),
          'aria-current': active ? ('page' as const) : undefined,
        },
      };
    }),
  };
};

/** Where a page opened from another tab (Privacy from Settings) goes back to, and how. */
export const useToolBack = () => {
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const backTab = TABS.find((tab) => tab.to === from) ?? TABS[0];
  const goBack = () => {
    const historyIndex = Number(window.history.state?.idx ?? 0);
    if (historyIndex > 0) navigate(-1);
    else navigate(backTab.to, { replace: true });
  };
  return { backTab, goBack };
};

/** "‹ Settings" on a page opened from Settings: names the tab it returns to. */
export const ToolBackButton: React.FC<{ className?: string }> = ({ className }) => {
  useI18n();
  const { backTab, goBack } = useToolBack();
  return (
    <button
      type="button"
      onClick={goBack}
      className={cx(
        'chef-pressable chef-target inline-flex items-center gap-0.5 rounded-[var(--radius-control)] ps-1 pe-2 font-medium text-[var(--accent-text)]',
        className,
      )}
    >
      <ChevronLeft aria-hidden size={22} className="rtl:rotate-180" />{backTab.label}</button>
  );
};

const ShellChromeContext = createContext<((delta: 1 | -1) => void) | null>(null);

/**
 * A tool screen that draws its own header (`ToolScreen`, Read PDF's reader, Edit PDF's
 * immersive editor) says so while mounted, and the shell stops drawing the header for
 * that route. The shell's own header covers pages with no `ToolScreen` (Help, legal
 * pages). Each caller adds one to a count while it is active, so one screen
 * unmounting (an empty state giving way to a reader) never brings the shell's header
 * back while another still draws its own.
 */
export const useShellOwnChrome = (active: boolean) => {
  const change = useContext(ShellChromeContext);
  useLayoutEffect(() => {
    if (!change || !active) return undefined;
    change(1);
    return () => change(-1);
  }, [change, active]);
};

/* -------------------------------------------------------------- Shell ---- */

/**
 * The tool row on Tools and the reader's own heading both call `/view` "Read
 * PDF"; "View PDF" is the catalog's store-facing name. The navigation bar
 * follows the screen it sits above, so all three agree.
 */
const ROUTE_TITLE_OVERRIDES: Record<string, string> = {
  get '/view'() { return t("app-shell.read.pdf.b00d88"); },
};

const ROUTE_TITLES: Record<string, string> = {
  get '/batch'() { return t("app-shell.batch.320b5d"); },
  get '/help'() { return t("app-shell.help.b79cac"); },
  get '/privacy'() { return t("app-shell.privacy.54a57c"); },
  get '/privacy-policy'() { return t("app-shell.privacy.54a57c"); },
  get '/pdf-chef-privacy'() { return t("app-shell.privacy.54a57c"); },
  get '/terms'() { return t("app-shell.terms.ede548"); },
  get '/licenses'() { return t("settings-page.open.source.licenses.c9f6d0"); },
  get '/terms-and-conditions'() { return t("app-shell.terms.ede548"); },
};

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useI18n();
  const location = useLocation();
  const path = location.pathname;
  const mainRef = useRef<HTMLElement>(null);

  useVisualViewportInsets();

  const routeTool = useMemo(() => tools.find((item) => item.path === path), [path]);
  const title = ROUTE_TITLE_OVERRIDES[path] ?? routeTool?.name ?? ROUTE_TITLES[path] ?? '';

  const root = isTabRoot(path);
  const settingsPage = SETTINGS_PAGES.has(path);
  // The tab bar and the side rail: the three roots and the pages behind Settings.
  const tabbed = root || settingsPage;
  const navigationType = useNavigationType();
  // A tool route's screen draws its own <main> after its header, so the header is the page's banner
  // (research r3, desktop-10); the shell's box is then a plain one. The route decides, not the
  // screen's own chrome, so the box never changes under a mounted screen.
  const MainBox = (tabbed ? 'main' : 'div') as 'main';
  // A route drawn by `ToolScreen` has its own header. Any other non-root route (Help,
  // the legal pages, a tool still loading) gets one here.
  const [ownChromeCount, setOwnChromeCount] = useState(0);
  const ownChrome = ownChromeCount > 0;
  const changeOwnChrome = useCallback((delta: 1 | -1) => setOwnChromeCount((count) => Math.max(0, count + delta)), []);

  // What sits at each history entry, so the Tools tab and Back can tell what is behind.
  useEffect(() => {
    rememberHistoryEntry(location.pathname, navigationType === 'PUSH');
  }, [location.key, location.pathname, navigationType]);

  // A route change moves focus to the top of the new view so a screen reader or
  // keyboard user lands where a sighted user's eyes land, not where they were.
  // Not on the first load: there the page starts at its top, so the first Tab is
  // "Skip to content" (T-16). Tools home puts back its own scroll position.
  const shownPathRef = useRef(path);
  useEffect(() => {
    if (shownPathRef.current === path) return;
    shownPathRef.current = path;
    // On a tablet or desktop a tool screen's content start, past its header (research r2,
    // desktop-03): it is named by the screen, and Shift+Tab still reaches the header. A screen
    // that is still loading moves focus there itself once it arrives (ToolScreen).
    const start = window.matchMedia?.(MQ_LG).matches
      ? mainRef.current?.querySelector<HTMLElement>('[data-skip-target]')
      : null;
    (start ?? mainRef.current)?.focus({ preventScroll: true });
    if (path !== '/') window.scrollTo({ top: 0, behavior: 'auto' });
  }, [path]);

  // A page behind Settings names itself in its own heading (B-024). Once that heading scrolls
  // under the sticky header, the header shows the page's name, so a title is always in view
  // (polish item 6; today's header always showed it).
  const [headingAway, setHeadingAway] = useState(false);
  useEffect(() => {
    setHeadingAway(false);
    const main = mainRef.current;
    if (!settingsPage || !main || typeof IntersectionObserver === 'undefined') return undefined;
    let intersection: IntersectionObserver | null = null;
    const watch = () => {
      const heading = main.querySelector('h1');
      if (!heading || intersection) return Boolean(heading);
      const header = document.querySelector<HTMLElement>('.tk-top-sticky');
      const top = Math.round(header?.getBoundingClientRect().height ?? 49);
      intersection = new IntersectionObserver(
        ([entry]) => setHeadingAway(!entry.isIntersecting && entry.boundingClientRect.top < top),
        { rootMargin: `-${top}px 0px 0px 0px` },
      );
      intersection.observe(heading);
      return true;
    };
    // The page is loaded lazily: wait for its heading.
    const mutation = watch() ? null : new MutationObserver(() => { if (watch()) mutation?.disconnect(); });
    mutation?.observe(main, { childList: true, subtree: true });
    return () => { mutation?.disconnect(); intersection?.disconnect(); };
  }, [path, settingsPage]);

  // Root screens (Tools, Recent, Settings) keep the side rail and the tab bar. Every
  // other route is a tool screen: no rail, no tab bar, and one header with Tools at
  // its end (plan 2.2). The chrome is added and removed around a `<main>` that stays
  // where it is, rather than by returning a different tree: a route that turns its own
  // chrome on would otherwise be unmounted by its own state change and come back empty.
  return (
    <ShellChromeContext.Provider value={changeOwnChrome}>
      <div className="chef-viewport-floor flex" data-chef-route={root ? 'root' : settingsPage ? 'settings-page' : 'tool'}>
        {tabbed && <SideRail />}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* A page behind Settings names itself once, in its own heading (B-024): its header
              keeps only "‹ Settings" (or Tools). */}
          {!root && !ownChrome && title && <ToolTop title={title} tool={routeTool} heading={false} sticky bare={settingsPage} bareTitle={settingsPage && headingAway} />}
          <MainBox
            ref={mainRef}
            tabIndex={-1}
            id="main"
            // Focus coming back to the page (a closed sheet returns it here) scrolls it into view;
            // stop below the sticky header so the page's heading is not hidden under it.
            style={!root ? { scrollMarginTop: 'calc(49px + env(safe-area-inset-top, 0px))' } : undefined}
            // Every non-root route is a tool surface. The marker is set once here
            // so the phone density rules in `index.css` reach all the tools without
            // a set of edits each; a tab root keeps its own header rhythm.
            className={cx(
              'chef-main-surface flex-1 outline-none',
              tabbed && 'chef-safe-x chef-tab-inset md:pb-10',
              settingsPage && 'chef-tool-surface',
              !tabbed && !ownChrome && 'chef-safe-x chef-tool-inset chef-tool-surface',
            )}
          >
            {children}
          </MainBox>
        </div>
        {tabbed && <TabBar />}
      </div>
    </ShellChromeContext.Provider>
  );
};

/**
 * Large title header for the three tab roots. iOS puts the destination's name at
 * the top of its own screen; the tab bar label alone is not a title.
 */
export const TabHeader: React.FC<{
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  leading?: React.ReactNode;
}> = ({ title, subtitle, trailing, leading }) => { useI18n(); return (
  <div className="chef-safe-top px-4 pb-3 md:px-8 md:pb-2">
    {/* `.chef-safe-top` owns padding-top, so the header's own 14px lives on the
        inner row; otherwise the inset rule wins and the title sits on the edge. */}
    <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 pt-3.5 md:pt-8">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="min-w-0">
          {/* `text-[var(--…)]` is ambiguous to Tailwind and compiles to a colour,
              which is why this title had been rendering at the inherited body
              size. `text-[length:…]` states the axis. Phones take the 24/30 step
              the Android header uses; desktop keeps the larger title. */}
          <h1
            className="chef-wrap-words text-[length:var(--type-title2-size)] font-extrabold leading-[var(--type-title2-leading)] tracking-[var(--type-title2-tracking)] text-[var(--text-primary)] md:text-[length:var(--type-title1-size)] md:leading-[var(--type-title1-leading)] md:tracking-[var(--type-title1-tracking)]"
          >
            {title}
          </h1>
          {subtitle && <p className="type-footnote mt-1 max-w-measure text-[var(--text-secondary)]">{subtitle}</p>}
        </div>
      </div>
      {trailing}
    </div>
  </div>
); };
