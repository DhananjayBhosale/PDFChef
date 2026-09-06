/** @type {import('tailwindcss').Config} */

/*
 * PDF Chef palette. Mirrors assets/design-tokens.json.
 *
 * The brand runs on five hues: paper (warm neutral ground), ink (the one accent),
 * and three status hues. Tool components written before this system used Tailwind's
 * stock `slate` / `orange` / `cyan` / `emerald` families directly, so those family
 * names are re-pointed at the brand ramps here rather than edited in 34 files.
 *
 * New code should use the semantic names: `paper-*`, `ink-*`, `success-*`,
 * `caution-*`, `danger-*`, or the `surface` / `content` / `edge` aliases which read
 * from CSS variables and therefore follow the active theme on their own.
 */

const paper = {
  25: '#fffcfa',
  50: '#fff8f4',
  100: '#fff1eb',
  200: '#f0e2db',
  300: '#ddc9c0',
  400: '#a2918b',
  500: '#80716c',
  600: '#70625d',
  700: '#564a46',
  800: '#3a302e',
  900: '#261f1e',
  950: '#17100f',
};

const ink = {
  25: '#fff8f7',
  50: '#fff2f0',
  100: '#ffe4e1',
  200: '#ffc8c3',
  300: '#ff9b95',
  400: '#ff4d52',
  500: '#e42121',
  600: '#dc2020',
  700: '#b01e22',
  800: '#881a1b',
  900: '#631b19',
  950: '#38100e',
};

const success = {
  50: '#ecf3ea',
  100: '#d7e7d3',
  200: '#b6d2b0',
  300: '#96be8e',
  400: '#6d9a63',
  500: '#4e7a46',
  600: '#3f6538',
  700: '#34512e',
  800: '#2a3f26',
  900: '#20301e',
  950: '#141d13',
};

const caution = {
  50: '#fbf1e0',
  100: '#f6e3c2',
  200: '#eccd97',
  300: '#e0b368',
  400: '#c8933a',
  500: '#a9761b',
  600: '#8c6014',
  700: '#704c11',
  800: '#573b0f',
  900: '#422d0d',
  950: '#291c08',
};

const danger = {
  50: '#fbecea',
  100: '#f7d8d3',
  200: '#eeb3a9',
  300: '#e09285',
  400: '#c4634f',
  500: '#a6412f',
  600: '#8c3526',
  700: '#712b1f',
  800: '#57221a',
  900: '#421a14',
  950: '#28100c',
};

/*
 * Utility-family overrides.
 *
 * The colour ramps above are literal hex, which is right for a *fill*: a page
 * canvas, a chip ground, an always-dark overlay. It is wrong for text and for
 * edges, because those two are the only places the product owes a contrast
 * ratio, and the ratio a fixed hex holds depends on which theme is painted
 * behind it. So `textColor` and `borderColor` get their own remapped neutral
 * ramps pointed at the theme-aware semantic tokens, and `backgroundColor` does
 * not — a `bg-white` PDF page must stay white in the dark theme, and the
 * `/opacity` modifiers the tools use on backgrounds only work on real hex.
 *
 * This is what lets one token change reach all 34 tool routes: a tool that
 * wrote `text-slate-500 dark:text-slate-400` is asking for "secondary" and
 * "secondary in the dark", and now gets exactly that, at the ratio the token
 * guarantees, whether or not it remembered the `dark:` half.
 */

// Neutral text ladder. Four steps, not eleven: primary, body, secondary,
// tertiary. Light and dark usages of the same class both land somewhere legible
// because the value flips with the theme, so an unpaired `text-slate-900` is no
// longer white-on-white in the dark theme.
const neutralText = {
  25: 'var(--text-primary)',
  50: 'var(--text-primary)',
  100: 'var(--text-primary)',
  200: 'var(--text-primary)',
  300: 'var(--text-secondary)',
  400: 'var(--text-tertiary)',
  500: 'var(--text-tertiary)',
  600: 'var(--text-secondary)',
  700: 'var(--text-body)',
  800: 'var(--text-body)',
  900: 'var(--text-primary)',
  950: 'var(--text-primary)',
};

// Neutral edges. The light steps a tool reaches for (100/200 to separate, 300
// to bound a control) and the dark steps it reaches for (800/900 to separate,
// 600/700 to bound) map onto the same two tokens from opposite ends, so one
// class works in both themes.
const neutralEdge = {
  25: 'var(--border-hairline)',
  50: 'var(--border-hairline)',
  100: 'var(--border-hairline)',
  200: 'var(--border-hairline)',
  300: 'var(--border-strong)',
  400: 'var(--border-strong)',
  500: 'var(--border-strong)',
  600: 'var(--border-strong)',
  700: 'var(--border-strong)',
  800: 'var(--border-hairline)',
  900: 'var(--border-hairline)',
  950: 'var(--border-hairline)',
};

// A status edge carries meaning, so it owes 3:1 against the surface behind it
// in both themes. The 50-300 tints tools used for these borders sat between
// 1.7:1 and 2.5:1 on light and vanished on dark; each family's mid step clears
// 3:1 in both, so those tints are pointed at it. The darker steps are left
// alone: they are already past the line.
const statusEdge = (ramp, mid) => ({ ...ramp, 50: ramp[mid], 100: ramp[mid], 200: ramp[mid], 300: ramp[mid] });

module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-ui)'],
        system: ['var(--font-system)'],
      },
      colors: {
        // Semantic aliases — theme-aware, preferred for new work.
        surface: {
          canvas: 'var(--surface-canvas)',
          raised: 'var(--surface-raised)',
          sunken: 'var(--surface-sunken)',
          chrome: 'var(--surface-chrome)',
        },
        content: {
          primary: 'var(--text-primary)',
          body: 'var(--text-body)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          accent: 'var(--accent-text)',
          'on-accent': 'var(--text-on-accent)',
        },
        edge: {
          hairline: 'var(--border-hairline)',
          strong: 'var(--border-strong)',
        },
        accent: {
          DEFAULT: 'var(--accent-rest)',
          hover: 'var(--accent-hover)',
          quiet: 'var(--accent-quiet)',
          'on-quiet': 'var(--accent-on-quiet)',
          // The accent as a *label*, one step darker than the fill so it clears
          // 4.5:1 as text on every surface rather than only on the lightest one.
          text: 'var(--accent-text)',
        },

        // Brand ramps.
        paper,
        ink,
        success,
        caution,
        danger,

        // Legacy family names re-pointed at the brand ramps. `red` and `rose`
        // remain the clay danger ramp; action red is `ink`, `accent`, or `primary`.
        white: '#fffcfa',
        slate: paper,
        gray: paper,
        zinc: paper,
        neutral: paper,
        stone: paper,
        orange: ink,
        blue: ink,
        sky: ink,
        cyan: ink,
        indigo: ink,
        violet: ink,
        purple: ink,
        emerald: success,
        green: success,
        teal: success,
        lime: success,
        amber: caution,
        yellow: caution,
        rose: danger,
        red: danger,
        primary: ink,
      },
      textColor: {
        slate: neutralText,
        gray: neutralText,
        zinc: neutralText,
        neutral: neutralText,
        stone: neutralText,
      },
      borderColor: {
        slate: neutralEdge,
        gray: neutralEdge,
        zinc: neutralEdge,
        neutral: neutralEdge,
        stone: neutralEdge,
        rose: statusEdge(danger, 400),
        red: statusEdge(danger, 400),
        amber: statusEdge(caution, 500),
        yellow: statusEdge(caution, 500),
        emerald: statusEdge(success, 500),
        green: statusEdge(success, 500),
        teal: statusEdge(success, 500),
        lime: statusEdge(success, 500),
        blue: statusEdge(ink, 500),
        sky: statusEdge(ink, 500),
        cyan: statusEdge(ink, 500),
        indigo: statusEdge(ink, 500),
        violet: statusEdge(ink, 500),
        purple: statusEdge(ink, 500),
        orange: statusEdge(ink, 500),
        primary: statusEdge(ink, 500),
      },
      borderRadius: {
        control: 'var(--radius-control)',
        field: 'var(--radius-field)',
        row: 'var(--radius-row)',
        panel: 'var(--radius-panel)',
        sheet: 'var(--radius-sheet)',
      },
      boxShadow: {
        raised: 'var(--elevation-raised)',
        panel: 'var(--elevation-panel)',
        sheet: 'var(--elevation-sheet)',
      },
      // The Android app's six fixed UI sizes are the product's size authority, so
      // Tailwind's stock scale is re-pointed at them exactly as its colour
      // families are. Every pre-existing tool keeps its utility classes and
      // inherits the compact rhythm without being edited, and the scale collapses
      // onto six steps instead of nine: `base` and `lg` both land on Emphasis,
      // and `3xl`, `4xl` and above all land on Display, which is where the
      // Android scale stops.
      fontSize: {
        xs: ['var(--type-caption-size)', { lineHeight: 'var(--type-caption-leading)' }],
        sm: ['var(--type-body-size)', { lineHeight: 'var(--type-body-leading)' }],
        base: ['var(--type-callout-size)', { lineHeight: 'var(--type-callout-leading)' }],
        lg: ['var(--type-callout-size)', { lineHeight: 'var(--type-callout-leading)' }],
        xl: [
          'var(--type-title3-size)',
          { lineHeight: 'var(--type-title3-leading)', letterSpacing: 'var(--type-title3-tracking)' },
        ],
        '2xl': [
          'var(--type-title2-size)',
          { lineHeight: 'var(--type-title2-leading)', letterSpacing: 'var(--type-title2-tracking)' },
        ],
        '3xl': [
          'var(--type-title1-size)',
          { lineHeight: 'var(--type-title1-leading)', letterSpacing: 'var(--type-title1-tracking)' },
        ],
        '4xl': [
          'var(--type-display-size)',
          { lineHeight: 'var(--type-display-leading)', letterSpacing: 'var(--type-display-tracking)' },
        ],
        '5xl': [
          'var(--type-display-size)',
          { lineHeight: 'var(--type-display-leading)', letterSpacing: 'var(--type-display-tracking)' },
        ],
      },
      spacing: {
        touch: 'var(--size-touch-target)',
        'safe-top': 'env(safe-area-inset-top)',
        'safe-bottom': 'env(safe-area-inset-bottom)',
        'safe-left': 'env(safe-area-inset-left)',
        'safe-right': 'env(safe-area-inset-right)',
      },
      maxWidth: {
        measure: 'var(--size-reading-measure)',
      },
      transitionTimingFunction: {
        settle: 'var(--ease-settle)',
        enter: 'var(--ease-enter)',
        exit: 'var(--ease-exit)',
      },
      transitionDuration: {
        instant: '80ms',
        tap: '120ms',
        transition: '220ms',
        sheet: '320ms',
      },
    },
  },
  plugins: [],
};
