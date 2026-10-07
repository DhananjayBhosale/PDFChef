import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';

/**
 * T024. The Home surface was rebuilt to the live Android app's phone rhythm, and
 * the values below are the ones a future edit would silently undo: the row
 * pitch, the icon column the dividers key off, the ambiguous Tailwind form that
 * had been turning the page title into a colour, and the wrapping category
 * strip that keeps all five filters reachable at 320px without the page moving
 * sideways. Screenshots prove the result; these assertions keep it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const dashboard = read('components/Tools/Dashboard.tsx');
const appShell = read('components/Layout/AppShell.tsx');
const appCss = read('index.css');
const catalog = read('components/Tools/toolCatalog.ts');

test('the page title states a font size, not an ambiguous bare variable', () => {
  // `text-[var(--x)]` compiles to `color`, which is why the phone title had been
  // rendering at the inherited body size. Any size token used with `text-[...]`
  // has to carry the `length:` hint.
  const ambiguous = [...appShell.matchAll(/text-\[var\(--type-[a-z0-9-]+-size\)\]/g)];
  assert.deepEqual(ambiguous.map((match) => match[0]), []);
  assert.match(appShell, /text-\[length:var\(--type-title2-size\)\]/);
  assert.match(appShell, /md:text-\[length:var\(--type-title1-size\)\]/);
});

test('the tab header keeps its own top padding off the safe-area class', () => {
  // `.chef-safe-top` sets padding-top from the inset, so a `pt-*` utility on the
  // same element is dropped and the title lands on the screen edge.
  const header = appShell.slice(appShell.indexOf('export const TabHeader'));
  assert.match(header, /className="chef-safe-top px-4 pb-3 md:px-8 md:pb-2"/);
  assert.match(header, /max-w-4xl items-center justify-between gap-4 pt-3\.5 md:pt-8/);
});

test('the phone tool row holds the Android list metrics', () => {
  assert.match(dashboard, /min-h-\[72px\]/);
  assert.match(dashboard, /gap-\[14px\]/);
  assert.match(dashboard, /px-\[14px\]/);
  assert.match(dashboard, /py-\[10px\]/);
  // 48px bubble carrying 32px of artwork, both fixed so the icon column, and
  // therefore the divider, holds its place while the type scales.
  assert.match(dashboard, /h-\[48px\] w-\[48px\]/);
  assert.match(dashboard, /assetSize=\{32\}/);
  assert.match(dashboard, /h-\[32px\] w-\[32px\] object-contain/);
  assert.match(dashboard, /ChevronRight aria-hidden size=\{22\}/);
  // 14/20 SemiBold title over a 12/16 Medium subtitle.
  assert.match(dashboard, /text-\[0\.875rem\] font-semibold leading-\[1\.4286\]/);
  assert.match(dashboard, /text-\[0\.75rem\] font-medium leading-\[1\.3333\]/);
});

test('the catalog stays one divided list, not a card grid', () => {
  assert.match(dashboard, /<ul className="chef-divided-list/);
  assert.doesNotMatch(dashboard, /grid-cols-\d/);
  // The divider starts after the icon region: 14 + 48 + 14 on phones, 12 + 40 +
  // 12 on the denser desktop row.
  assert.match(appCss, /\.chef-divided-list > li \+ li::before \{[^}]*margin-inline-start: 76px;/);
  assert.match(appCss, /margin-inline-start: 64px;/);
});

test('every category is reachable without the page scrolling sideways', () => {
  const strip = dashboard.slice(dashboard.indexOf('categoryOrder.map'));
  // Wrapping, not a horizontal scroller: at 320px and at 200% text the options
  // move onto another line instead of hiding past an edge.
  assert.match(dashboard, /flex w-full flex-wrap items-stretch gap-x-\[2px\] gap-y-\[10px\] rounded-\[20px\]/);
  assert.doesNotMatch(dashboard, /overflow-x-auto/);
  // 46px shell, 3px inset plus the 1px border, 38px segments inside a 48x48
  // practical target. The width floor is on the box itself, and the height
  // extension is vertical only, so the target is real on both axes and no
  // segment reaches into its neighbour.
  assert.match(dashboard, /bg-\[var\(--surface-sunken\)\] p-\[3px\]/);
  assert.match(strip, /chef-hit-y flex min-h-\[38px\] min-w-touch/);
  assert.match(appCss, /\.chef-hit-y::before \{[^}]*min-height: var\(--size-touch-target\);/);
  assert.match(appCss, /\.chef-hit-y::before \{[^}]*inset-inline: 0;/);
  assert.doesNotMatch(appCss, /\.chef-hit-y::before \{[^}]*min-width:/);
  // Counted filters keep their count in the accessible name too, so the numeral
  // is never the only place the total is stated.
  assert.match(strip, /aria-label=\{t\("dashboard\.\.baa7b4", \{ v0: t\(`category\.\$\{item\}`\), count: count \}\)\}/);
});

test('the search field is 38px of visual inside a 48px target', () => {
  assert.match(dashboard, /htmlFor="tool-search"/);
  assert.match(dashboard, /-my-\[5px\] flex min-h-touch w-full items-center/);
  // Android's field is 16sp Medium and so is its prompt. Bold made an empty
  // field read as a heading rather than as something to type into.
  assert.match(dashboard, /py-\[0\.4375rem\] ps-\[46px\] text-\[1rem\] font-medium leading-\[1\.375\]/);
  assert.match(dashboard, /placeholder:font-medium/);
  assert.doesNotMatch(dashboard, /placeholder:font-bold/);
  // The 20px glyph is positioned in px, like the padding it sits inside, so the
  // two do not drift apart when the reader scales the text.
  assert.match(dashboard, /absolute start-\[16px\] top-1\/2/);
});

test('the visible search prompt survives 200% text and the accessible name follows the catalog', () => {
  // A 320px screen at 200% leaves roughly 190px of field for the prompt, and
  // the interface font is a Settings choice, so the prompt is one word. The
  // trailing 46px is reserved only while the clear control exists.
  assert.equal(english["dashboard.search.49c266"], 'Search');
  assert.match(dashboard, /placeholder=\{t\("dashboard\.search\.49c266"\)\}/);
  assert.doesNotMatch(dashboard, /placeholder="Smart search tools\.\.\."/);
  assert.match(dashboard, /aria-label=\{t\("dashboard\.search\.2fba3d", \{ count: tools\.length \}\)\}/);
  assert.match(dashboard, /query \? 'pe-\[46px\]' : 'pe-\[16px\]'/);
});

test('the result line is visible as well as announced once a query exists', () => {
  // A prompt disappears the moment someone types. This line stays, names the
  // query it is reporting on, and wraps instead of clipping at any text size.
  assert.match(dashboard, /role="status"\s*\n\s*aria-live="polite"/);
  assert.match(dashboard, /searching\s*\n\s*\? 'chef-wrap-words mt-2/);
  assert.match(dashboard, /: 'sr-only'/);
  assert.match(dashboard, /t\("dashboard\.\.357c24", \{ v2: trimmed, count: filteredTools\.length \}\)/);
});

test('the two-line subtitle clamp is released once the reader asks for larger text', () => {
  assert.match(
    appCss,
    /html\[data-text-scale='large'\] \.chef-clamp-2,\s*html\[data-text-scale='larger'\] \.chef-clamp-2 \{[\s\S]*?-webkit-line-clamp: unset;/,
  );
});

test('the default order still opens with Create PDF and Read PDF', () => {
  const order = dashboard.slice(dashboard.indexOf('const homeTools'), dashboard.indexOf('/** Exact'));
  assert.match(order, /tools\.filter\(\(tool\) => tool\.path === '\/make-pdf'\)/);
  assert.match(order, /tools\.filter\(\(tool\) => tool\.path === '\/view'\)/);
  assert.ok(order.indexOf("'/make-pdf'") < order.indexOf("'/view'"));
  assert.equal(english["dashboard.read.pdf.b00d88"], 'Read PDF');
  assert.match(dashboard, /tool\.path === '\/view' \? t\("dashboard\.read\.pdf\.b00d88"\) : tool\.name/);
});

test('press feedback is restrained and reduced-motion safe', () => {
  // Feedback lands on pointer-down through `:active`, and reduced motion keeps
  // the colour change while dropping the transform.
  assert.match(dashboard, /chef-pressable chef-pressable-row/);
  assert.match(appCss, /\.chef-pressable-row:active \{\s*transform: none;/);
  assert.match(appCss, /@media \(prefers-reduced-motion: reduce\)/);
  // State transitions stay inside the 150-250ms band.
  const duration = Number(/--duration-transition:\s*(\d+)ms/.exec(read('assets/design-tokens.css'))?.[1]);
  assert.ok(duration >= 150 && duration <= 250, `state transition is ${duration}ms`);
});

/*
 * T025. The rest of this file records the Android rhythm. The block below
 * records the four judgements that replaced the first pass at the surface, each
 * of which a well-meaning edit would undo by reaching for the nearest token.
 */

test('the bubble wash comes from the tool own mark, not from its category', () => {
  // Four category tints said nothing the counted filter above the list did not
  // already say, and they disagreed with the artwork inside them. Worse, in
  // dark theme the Edit tint resolved to `--ink-900`, so fourteen of the
  // thirty-four rows carried a saturated maroon block.
  assert.doesNotMatch(dashboard, /CATEGORY_TONE/);
  assert.match(dashboard, /const TOOL_TINT: Record<string, string>/);

  const tints = dashboard.slice(dashboard.indexOf('const TOOL_TINT'), dashboard.indexOf('const BRAND_TINT'));
  const shared = [...catalog.matchAll(/androidTool: '([A-Z_]+)'/g)]
    .map((match) => match[1])
    // The reader has no generated mark, so it takes the product's own red.
    .filter((id) => id !== 'READER');
  assert.ok(shared.length >= 25, `expected the Android-shared catalog, saw ${shared.length}`);
  for (const id of shared) {
    assert.match(tints, new RegExp(`\\b${id}: '\\d+ \\d+ \\d+',`), `${id} has no palette seed`);
  }

  // Composited over whatever surface is behind it, so one value serves both
  // themes without `color-mix`, which the WebKit versions this app supports
  // do not all have.
  assert.match(dashboard, /backgroundColor: `rgb\(\$\{tintFor\(tool\)\} \/ 0\.13\)`/);
  assert.doesNotMatch(dashboard, /backgroundColor: `color-mix/);
  // The bubble and its radius stay in px so the icon column, and therefore the
  // divider, holds its place while the type scales.
  assert.match(dashboard, /h-\[48px\] w-\[48px\] shrink-0 place-items-center rounded-\[12px\]/);
});

test('category selection is a raised chip on a sunken track, not a flat accent field', () => {
  const strip = dashboard.slice(dashboard.indexOf('categoryOrder.map'));
  assert.match(
    strip,
    /bg-\[var\(--surface-raised\)\] font-semibold text-\[var\(--accent-on-quiet\)\] shadow-\[var\(--elevation-raised\)\] ring-1 ring-inset/,
  );
  assert.doesNotMatch(strip, /bg-\[var\(--accent-quiet\)\]/);
  // Counts remain available to assistive technology without crowding the five
  // labels into an unreadable phone row.
  assert.match(strip, /aria-label=\{t\("dashboard\.\.baa7b4", \{ v0: t\(`category\.\$\{item\}`\), count: count \}\)\}/);
  assert.match(strip, /<span aria-hidden>\{t\(`category\.\$\{item\}`\)\}<\/span>/);
  assert.doesNotMatch(strip, /tabular text-\[0\.6875rem\]/);
});

test('the privacy claim is a line under the title, not a third lozenge', () => {
  // It had been a bordered, shadowed 46px card directly above a bordered 38px
  // field and a bordered 46px strip: three near-identical shapes and no
  // hierarchy. `items-start` is what keeps the glyph beside the first line
  // rather than centred against four wrapped ones at 200% text.
  const note = dashboard.slice(dashboard.indexOf('role="note"'), dashboard.indexOf('{monetizationAvailable && ('));
  assert.match(note, /role="note" className="flex items-start gap-2"/);
  assert.doesNotMatch(note, /border|shadow-|surface-raised/);
  assert.equal(english["dashboard.processed.on.this.device.6f6da5"], 'Processed on this device.');
  assert.equal(english["dashboard.nothing.is.uploaded.a8596d"], 'Nothing is uploaded.');
  assert.match(note, /t\("dashboard\.processed\.on\.this\.device\.6f6da5"\)/);
  assert.match(note, /t\("dashboard\.nothing\.is\.uploaded\.a8596d"\)/);
  // The trailing padlock was a second glyph making the same claim, and it was
  // the thing left floating mid-air once the sentence wrapped.
  assert.doesNotMatch(dashboard, /\bLock\b/);
});

test('the page padding sits outside the measure, so every edge lines up with the title', () => {
  // `TabHeader` is `px-4 md:px-8` around `mx-auto max-w-4xl`. Nested the other
  // way round the page lost 32px at desktop widths and everything below the
  // title sat inset from it.
  assert.match(dashboard, /<div className="px-4 md:px-8">\n\s*<div className="mx-auto max-w-4xl">/);
  assert.doesNotMatch(dashboard, /mx-auto max-w-4xl px-4 md:px-8/);
  // The sticky element is the full-width one, so the backing colour reaches the
  // window edge instead of stopping at the measure.
  assert.match(dashboard, /md:sticky md:top-0 md:z-20 md:bg-\[var\(--surface-canvas\)\] md:px-8/);
  assert.doesNotMatch(dashboard, /md:-mx-8/);
});

test('the brand mark yields room to the product name as the reader text grows', () => {
  // Android's 50dp mark is fixed artwork beside a name that scales; at 200% it
  // was taking a third of a 320px line away from the name itself.
  assert.match(dashboard, /clamp\(32px, calc\(50px \/ var\(--text-scale, 1\)\), 50px\)/);
  // The chevron column is thirty-four glyphs deep. Android draws it at 0.72.
  assert.match(dashboard, /ChevronRight aria-hidden size=\{22\} className="rtl:rotate-180 shrink-0 text-\[var\(--text-tertiary\)\] opacity-70"/);
});
