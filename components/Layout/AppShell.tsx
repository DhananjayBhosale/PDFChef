import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, History, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import { tools } from '../Tools/toolCatalog';
import type { ToolCardData } from '../Tools/toolCatalog';
import { ToolIdentity } from '../Tools/ToolIdentity';
import { cx } from '../UI/Primitives';
import { useHaptics } from '../../hooks/useWorkspaceRuntime';

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
 * Routes that may take the whole screen. Permission, not a state: a route in
 * this set is still an ordinary tool screen until it says it has a workspace
 * worth the whole viewport, because an empty drop zone is not one.
 */
export const IMMERSIVE_ROUTES = new Set(['/view', '/image-to-pdf', '/pdf-to-jpg', '/edit']);

const ImmersiveWorkspaceContext = createContext<((active: boolean) => void) | null>(null);

/**
 * How one of those routes asks for the whole screen. Before a document is
 * loaded the shell keeps its navigation bar and its tab bar, so the way back
 * and the other two destinations are where they are on every other tool
 * screen. The route gives them up only once there is a live workspace behind
 * them, and takes them back when it is cleared or left.
 */
export const useImmersiveWorkspace = (active: boolean) => {
  const setImmersive = useContext(ImmersiveWorkspaceContext);

  // Before paint, so a route that arrives with a workspace already loaded never
  // shows a frame of chrome it is about to drop.
  useLayoutEffect(() => {
    if (!setImmersive) return;
    setImmersive(active);
    return () => setImmersive(false);
  }, [active, setImmersive]);
};

// Tab highlighting and tab-root layout are different decisions. Tool routes
// highlight Tools, but they still need their own nav bar, safe-area inset, and
// measured workspace for exact picker centering.
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

const TabBar: React.FC = () => {
  useI18n();
  const location = useLocation();
  const haptic = useHaptics();

  return (
    <nav
      aria-label={t("app-shell.primary.efe10c")}
      className="chef-chrome chef-tab-bar chef-safe-bottom chef-safe-x fixed inset-x-0 bottom-0 z-40 border-t md:hidden"
    >
      <ul className="mx-auto flex max-w-xl">
        {TABS.map(({ to, label, icon: Icon, match }) => {
          const active = match(location.pathname);
          return (
            <li key={to} className="flex-1">
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                onPointerDown={() => haptic('selection')}
                className={cx(
                  'chef-pressable flex min-h-[var(--size-tab-bar)] flex-col items-center justify-center gap-1 py-1.5',
                  active ? 'font-bold text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]',
                )}
              >
                <span className={cx('grid rounded-[var(--radius-pill)] px-3 py-0.5', active && 'bg-[var(--accent-quiet)]')}>
                  <Icon aria-hidden size={24} strokeWidth={active ? 2.5 : 1.9} />
                </span>
                <span className="text-[0.8125rem] font-semibold leading-none tracking-[0.005em]">{label}</span>
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

  return (
  <nav
    aria-label={t("app-shell.primary.efe10c")}
    className="chef-safe-top chef-safe-x sticky top-0 hidden h-screen w-[13.5rem] shrink-0 flex-col border-e border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-5 md:flex lg:w-[15rem]"
  >
    <Link to="/" className="chef-pressable mb-6 flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-1">
      <img src="/pdf-chef-logo-exact.webp" alt="" aria-hidden className="h-9 w-9 object-contain" />
      <span className="min-w-0">
        <span className="block font-semibold leading-tight text-[var(--text-primary)]">PDF Chef</span>
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

  </nav>
  );
};

/* ----------------------------------------------------------- Nav bar ----- */

/**
 * Tool routes get a navigation bar with the tool's own name and a back control
 * that reads "Tools", so the destination is stated rather than implied.
 */
const ToolNavBar: React.FC<{ title: string; tool?: ToolCardData }> = ({ title, tool }) => {
  useI18n();
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [titleFits, setTitleFits] = useState(true);

  // The tool's own heading is the title while it is on screen. Once it scrolls
  // away the bar takes over, which is how iOS hands a large title to the nav bar
  // and why the two never read as duplicates.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 48);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A centred title has to clear the Back control on both sides, so the room it
  // really has is the bar minus twice the Back width. At large text Back grows
  // until nothing is left; rather than let the two collide, the title stands
  // down and the tool's own heading carries the name.
  useEffect(() => {
    const measure = () => {
      const barWidth = bar.current?.clientWidth ?? 0;
      const backWidth = back.current?.offsetWidth ?? 0;
      setTitleFits(barWidth - backWidth * 2 >= 96);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (bar.current) observer.observe(bar.current);
    if (back.current) observer.observe(back.current);
    return () => observer.disconnect();
  }, [title]);

  return (
    <header
      className={cx(
        'chef-chrome chef-safe-top chef-safe-x chef-scroll-edge chef-scroll-edge-top sticky top-0 z-30 border-b border-transparent',
        scrolled && 'border-[var(--border-hairline)]',
      )}
    >
      <div ref={bar} className="relative mx-auto flex min-h-[var(--size-nav-bar)] max-w-4xl items-center px-1 py-1">
        <button
          ref={back}
          type="button"
          onClick={() => {
            const historyIndex = Number(window.history.state?.idx ?? 0);
            if (historyIndex > 0) navigate(-1);
            else navigate('/', { replace: true });
          }}
          className="chef-pressable chef-target inline-flex items-center gap-0.5 rounded-[var(--radius-control)] ps-1 pe-2 font-medium text-[var(--accent-text)]"
        >
          <ChevronLeft aria-hidden size={22} className="rtl:rotate-180" />{t("app-shell.tools.ea93d6")}</button>
        {/* Identity and title are one unit: the mark never appears without the
            name it belongs to, so the bar is either empty or fully legible. */}
        <div
          aria-hidden={!scrolled || !titleFits}
          className={cx(
            'pointer-events-none absolute left-1/2 flex max-w-[52%] -translate-x-1/2 items-center gap-1.5 text-center font-semibold text-[var(--text-primary)]',
            'transition-opacity duration-transition ease-settle',
            scrolled && titleFits ? 'opacity-100' : 'opacity-0',
          )}
        >
          {tool && (
            <ToolIdentity
              tool={tool}
              size={16}
              assetSize={22}
              className="shrink-0"
              assetClassName="h-[22px] w-[22px] shrink-0 object-contain"
            />
          )}
          <span className="chef-wrap-words">{title}</span>
        </div>
      </div>
    </header>
  );
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

  const [workspaceImmersive, setWorkspaceImmersive] = useState(false);
  const immersive = IMMERSIVE_ROUTES.has(path) && workspaceImmersive;
  const root = isTabRoot(path);

  // A route change moves focus to the top of the new view so a screen reader or
  // keyboard user lands where a sighted user's eyes land, not where they were.
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [path]);

  // The chrome is added and removed around a `<main>` that stays where it is,
  // rather than by returning a different tree. A route that turns immersive the
  // moment it has a workspace would otherwise be unmounted by its own state
  // change and come back empty.
  return (
    <ImmersiveWorkspaceContext.Provider value={setWorkspaceImmersive}>
      <div className="chef-viewport-floor flex">
        {!immersive && <SideRail />}
        <div className="flex min-w-0 flex-1 flex-col">
          {!immersive && !root && title && <ToolNavBar title={title} tool={routeTool} />}
          <main
            ref={mainRef}
            tabIndex={-1}
            id="main"
            // Every non-root route is a tool surface. The marker is set once here
            // so the phone density rules in `index.css` reach all 34 tools without
            // 34 sets of edits; a tab root keeps its own header rhythm.
            className={cx(
              'chef-main-surface flex-1 outline-none',
              !immersive && 'chef-safe-x chef-tab-inset md:pb-10',
              !immersive && !root && 'chef-tool-surface',
            )}
          >
            {children}
          </main>
        </div>
        {!immersive && <TabBar />}
      </div>
    </ImmersiveWorkspaceContext.Provider>
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
