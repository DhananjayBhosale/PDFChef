# Design System Master

Authoritative for durable visual and interaction choices. Brand rationale lives
in `docs/brand-guidelines.md`; values live in `assets/design-tokens.json` and
`assets/design-tokens.css`, which must stay in step with each other.

## Brand direction

- Product feeling: private, calm, precise, unhurried. A workbench, not a funnel.
- Trust cues: plain statements of where the file went, exact scope on every
  destructive action, honest unavailable states, no claim the product cannot back.
- Avoid: decorative gradients, gradient text, glass used for looks, identical
  card grids, hero metrics, oversized empty hero space, motion that does not
  report a state change, any language implying upload, sync, account, or backup.

## Colour tokens

Five hues. Restrained strategy: neutrals plus one accent, three status hues.

- `paper` — warm neutral ground with a faint yellow-brown cast. Canvas is
  `paper-50` (`#faf7f2`), the raised card is `paper-25` (`#ffffff`), the sunken
  track is `paper-100`. Never `#000`.
- `ink` — the single accent, one tomato red. The token name is retained for
  compatibility. `--accent-rest` is `#c23a22` light and `#c9402a` dark. Primary
  action, current tab, selection, slots. Not decoration.
- `success` (145) finished and actually smaller · `caution` (75) beta, memory
  pressure, review-first · `danger` (22) delete, clear, failed.

Semantic aliases (`--surface-*`, `--text-*`, `--border-*`, `--accent-*`,
`--status-*`) resolve per theme. Components read the aliases, never a raw step.
The full ramps and semantic values are in `docs/brand-guidelines.md`.

Tailwind's stock family names are re-pointed at these ramps in
`tailwind.config.cjs`, so the pre-existing tool components inherit the palette
without being edited. New code uses `paper-*`, `ink-*`, `success-*`, `caution-*`,
`danger-*`, or the `surface` / `content` / `edge` aliases.

`--accent-rest` is the accent as a *fill, border and focus-ring tint*, where
3:1 is what is owed. As a label or a glyph on a neutral surface it is one step
too light on the sunken surface, so accent-coloured text reads `--accent-text`
instead: `#a93119` light, `#ff8a70` dark. The focus ring is not the accent: it is
`#1d1a16` light and `#f4eee4` dark, so it stays visible on an accent fill. The
Android app logo keeps its supplied colours.

New tokens: `--slot-tint` (the tint of a slot, a value in a sentence that opens an
editor), `--radius-slot` 6px, `--radius-pop` 10px, `--elevation-chip` (the lift of
a selected chip), `--font-display` and `--font-display-weight`.

## Contrast and edges

Every semantic value is chosen against all three surfaces of its own theme —
canvas, raised, sunken — not against the lightest one. A value that passes on
`raised` and fails on `sunken` has not passed.

Text is four steps, and each one clears 4.5:1 on all three. The ratios below
are computed by `node scripts/check-token-contrast.mjs` (which also fails if
`assets/design-tokens.json` and `assets/design-tokens.css` disagree); re-run it
with `--markdown` after any token change and paste the table here.

| Pair | Theme | Against | Canvas | Raised | Sunken | Needs |
|---|---|---|---|---|---|---|
| `--text-primary` | light | canvas / raised / sunken | 16.22 | 17.33 | 14.87 | 4.5 |
| `--text-body` | light | canvas / raised / sunken | 12.26 | 13.11 | 11.25 | 4.5 |
| `--text-secondary` | light | canvas / raised / sunken | 7.41 | 7.92 | 6.80 | 4.5 |
| `--text-tertiary` | light | canvas / raised / sunken | 5.27 | 5.63 | 4.83 | 4.5 |
| `--accent-text` | light | canvas / raised / sunken | 6.26 | 6.69 | 5.74 | 4.5 |
| `--border-strong` | light | canvas / raised / sunken | 3.94 | 4.21 | 3.61 | 3 |
| `--text-on-accent` | light | --accent-rest | 5.35 |  |  | 4.5 |
| `--accent-text` | light | --accent-quiet | 5.69 | 5.69 | 5.69 | 4.5 |
| `--accent-on-quiet` | light | --accent-quiet | 7.46 | 7.46 | 7.46 | 4.5 |
| `--status-success-text` | light | canvas / raised / sunken | 6.08 | 6.49 | 5.57 | 4.5 |
| `--status-success-text` | light | --status-success-quiet | 5.62 | 5.62 | 5.62 | 4.5 |
| `--status-caution-text` | light | canvas / raised / sunken | 5.93 | 6.34 | 5.44 | 4.5 |
| `--status-caution-text` | light | --status-caution-quiet | 5.49 | 5.49 | 5.49 | 4.5 |
| `--status-danger-text` | light | canvas / raised / sunken | 6.56 | 7.01 | 6.01 | 4.5 |
| `--status-danger-text` | light | --status-danger-quiet | 5.82 | 5.82 | 5.82 | 4.5 |
| `--text-primary` | dark | canvas / raised / sunken | 16.20 | 15.17 | 14.03 | 4.5 |
| `--text-body` | dark | canvas / raised / sunken | 13.48 | 12.63 | 11.67 | 4.5 |
| `--text-secondary` | dark | canvas / raised / sunken | 9.16 | 8.58 | 7.93 | 4.5 |
| `--text-tertiary` | dark | canvas / raised / sunken | 6.20 | 5.81 | 5.37 | 4.5 |
| `--accent-text` | dark | canvas / raised / sunken | 8.12 | 7.61 | 7.03 | 4.5 |
| `--border-strong` | dark | canvas / raised / sunken | 4.44 | 4.16 | 3.85 | 3 |
| `--text-on-accent` | dark | --accent-rest | 4.94 |  |  | 4.5 |
| `--accent-text` | dark | --accent-quiet | 6.52 | 6.52 | 6.52 | 4.5 |
| `--accent-on-quiet` | dark | --accent-quiet | 9.72 | 9.72 | 9.72 | 4.5 |
| `--status-success-text` | dark | canvas / raised / sunken | 10.29 | 9.64 | 8.91 | 4.5 |
| `--status-success-text` | dark | --status-success-quiet | 7.89 | 7.24 | 6.54 | 4.5 |
| `--status-caution-text` | dark | canvas / raised / sunken | 10.41 | 9.75 | 9.01 | 4.5 |
| `--status-caution-text` | dark | --status-caution-quiet | 7.89 | 7.26 | 6.62 | 4.5 |
| `--status-danger-text` | dark | canvas / raised / sunken | 9.41 | 8.81 | 8.14 | 4.5 |
| `--status-danger-text` | dark | --status-danger-quiet | 7.29 | 6.69 | 6.11 | 4.5 |
PASS: 30 contrast pairs and the JSON mirror

Edges are two, and the difference between them is a rule rather than a shade:

- `--border-hairline` **separates**. Panel outline, row divider, scroll edge,
  chrome rule. It only has to be seen: about 2.1:1 light, 2.1:1 dark against the
  surface it is drawn on.
- `--border-strong` **bounds a control**. Field, select, secondary button,
  unselected segment, switch track, drop zone, floating strip, sheet, the
  resting edge of a card that is itself a toggle. It clears 3:1 on canvas,
  raised and sunken in both themes.

The test for which one applies is not how the element looks: *a full outline
around something that can be pressed or typed into is a control boundary.* A
single-side rule is a divider and stays hairline.

Two dark surfaces cannot be more than a fraction of a ratio apart before the
lighter one stops reading as dark, so a nested dark panel is separated by its
**edge**, not by lifting its fill. `--surface-raised` sits 1.18:1 off the dark
canvas and the hairline does the rest.

A disabled control may miss AA, but it must still be readable enough to say what
it is: the floor is `opacity-55`, never 30 or 40.

A status border carries meaning, so it owes 3:1 in both themes. The 50-300 tints
sat between 1.7:1 and 2.5:1 on light and vanished on dark; each family's mid
step (`danger-400`, `caution-500`, `success-500`, `ink-500`) clears 3:1 in both
and is what those tints resolve to. Never thin a status edge with an alpha
modifier — `border-rose-500/30` is not an edge.

### Where the theme lives

`textColor` and `borderColor` are remapped in `tailwind.config.cjs` onto the
theme-aware semantic tokens; `backgroundColor` is deliberately **not**. Those two
utilities are the only ones that owe a contrast ratio, and the ratio a fixed hex
holds depends on which theme is painted behind it. A background often must not
flip — a PDF page is white in both themes — and the `/opacity` modifiers the
tools use on backgrounds only work on real hex.

The consequence worth knowing: `text-slate-500 dark:text-slate-400` now means
"secondary, and secondary in the dark" and resolves to the token in each theme,
so an unpaired half heals itself and one token change reaches all 34 tool
routes. The exception is a surface whose fill does **not** flip, and it runs in
both directions. A surface that is dark in both themes — the PDF preview modal,
the readability preview — must use literal `paper-*` steps, because a
theme-flipping neutral would paint dark on dark there. A surface that is *light*
in both themes owes the same care and is the easier one to miss: the rendered
page in the reader, the sign and page-number canvases, a drag overlay of a page.
A page mark written as `text-slate-500` reads 5.1:1 on that white page in the
light theme and 1.5:1 in the dark one, because the token flipped and the page
did not. Anything drawn on a page takes a literal dark `paper-*` step.

### Colour is not a rank

The accent marks the one action a screen is for; `success`, `caution` and
`danger` mark what happened or what it will cost. A status hue never stands in
for a position in the action hierarchy. A green "Create fillable PDF", a green
"Add signature" beside a red Export, or an amber "Open PDF" all read as
outcomes rather than as the primary and secondary they were: the primary takes
`--accent-rest`, the secondary takes `--border-strong` on `--surface-raised`,
and the status hues stay for status. The same rule governs progress: a running
job fills with the accent, not with `danger` or a neutral.

A secondary action needs that edge, not a tinted ground. `bg-slate-100` on a
raised panel is 1.13:1 off the surface behind it and `bg-slate-50` is 1.02:1, so
a button drawn only that way is a label floating on the panel.

## Typography

`Inter` is bundled and is the default interface and numeric family. `Manrope`
and `System` (SF Pro on Apple devices) remain selectable in Settings, alongside
the existing accessibility-oriented alternatives. The one exception is the title
serif: `--font-display` (a system serif chosen per script with `:lang()`, weight
600: Iowan Old Style / Charter / Noto Serif for Latin and Cyrillic, Hiragino
Mincho for Japanese, Songti for Chinese, AppleMyungjo for Korean, and the
interface font for Arabic and Hindi) is used for tab-root titles, tool titles,
the brand name in the rail and on the home header, and the tool sentence.
Nothing else. Nothing is downloaded, and the interface font a person picks in
Settings still sets everything else.

**The Android app is the size authority.** Both shells ship the same typeface at
the same density and a WebView CSS pixel is an Android dp, so the product
carries the Android app's six fixed UI sizes and no others:

| Step | Size / leading | Token | Use |
|---|---:|---|---|
| Meta | 12 / 16 | `caption`, `footnote` | captions, supporting status, helper lines |
| Body | 14 / 20 | `body` | normal copy, rows, buttons, navigation |
| Emphasis | 16 / 22 | `callout` | strong body, prominent values |
| Title | 20 / 26 | `title3` | card and dialog titles |
| Heading | 24 / 30 | `title2` | screen and result headings |
| Display | 30 / 36 | `title1`, `display` | the largest title the product has |

Caption and footnote are both the Meta step and differ by weight and case, not
size; `display` and `title1` are both the Display step, because the Android
scale stops at 30 and a larger web-only step would be a seventh size nothing on
a phone earns.

Tailwind's stock `text-*` scale is re-pointed at these steps in
`tailwind.config.cjs`, exactly as its colour families are, so every pre-existing
tool inherits the compact rhythm without being edited: `base` and `lg` both land
on Emphasis, and `3xl` and above all land on Display. A surface that writes a
size the scale does not contain — 15px, 17px, 18px — is wrong; there are six.

Tracking is size-specific and negative as type grows. Everything is in `rem`;
the readable text size preference scales the root, so layout moves with the
text.

## UI copy

- The strict minimal-copy policy applies to Settings. Tools/Home rows retain the
  Android app's exact subtitles because those short lines distinguish adjacent
  operations and are part of cross-platform tool identity.
- Prefer one concise, self-explanatory label. Do not add a subtitle, helper,
  description, or explanatory line when the label, value, control, icon, or
  surrounding context already communicates the same thing.
- Supporting copy is reserved for preventing errors, explaining non-obvious
  consequences or required input, and important privacy, security, billing,
  permission, or data-loss information. Keep it to one short sentence.
- Destructive confirmations state only the action's scope and the safety boundary.
  Live success and error messages remain explicit and are announced politely.
- Copy names the store the running shell actually has. A packaged build keeps
  results in its own app storage and has no browser data to clear, so it does
  not say "browser"; a browser build says "browser" exactly as explicitly as
  before. The existing capability flag answers the question — no surface sniffs
  a user agent — and where a boundary is already stated at the press that
  decides it, the screen header does not repeat it.
- **A tool screen has no line under its title.** The catalog description stays
  on the Tools home row only. Before a file is chosen the screen is the title and
  the picker label, which names the task. Once a file is loaded, what the tool
  will do is said once, in the sentence above the main action (a statement or a
  sentence with slots), and the one notice line under it carries an error, a
  pending value, a caution or the outcome, in that order. Honesty limits that
  `PRODUCT.md` requires (Office converters, passwords) stay as that caution line.
- A hint under a label becomes the field's placeholder; when the field already
  has one, the hint becomes its `aria-describedby` text, visually hidden. Error
  and caution lines stay visible.
- The same explanation never appears above and below the control it describes.
  When a limit belongs to a decision, it lives at the decision.
- **English first.** A new string is added to `services/i18n/en-US.ts` and to
  `services/i18n/pending.ts`; `node scripts/sync-locale-fallbacks.mjs` then writes
  the English text into the other 21 locale files and drafts. Nothing is missing at
  runtime and the list says exactly what a translator still has to do. Strings that
  already exist stay in the person's language: labels, button names, errors and the
  statements of one-action tools reuse today's keys.
- Instructions for gestures the interface already offers by other means are
  copy, not help: "select pages, then turn them left or right" beside a Left and
  a Right button, "drag to place" above a position slider, "tap a thumbnail to
  preview" beside a preview control. Live status, error text, accessible names,
  and review warnings are never in this category and are never removed.

## Spacing and shape

- Radii: control is a pill (999), field 10, row 16, panel 10, sheet 18, slot 6, popover 10. Surfaces are flat (`--elevation-raised: none`) and bounded by a hairline; only popovers and sheets lift, and the selected chip of a segmented strip keeps `--elevation-chip`.
- Spacing varies by role. Do not apply one padding value everywhere.
- Reading measure 68ch for prose. Data may run denser.
- **One touch floor: 48px, `--size-touch-target`.** The product ships a WebView
  and a native Android screen in the same app, so it carries one number rather
  than a 44pt web floor beside Android's 48dp. 48 is the larger of the two
  platform minimums and is already what the reader Activity's own controls use,
  so the shared value is theirs. Every interactive element clears it whatever
  its visual box, and the number lives only in the token: no surface writes 44
  or 48 into a class.
- Density is unchanged by that floor, because the floor grows the pressable
  region and never the pixels. Where a control's visual size is fixed by
  platform convention or by Android's rhythm — the 51x31 switch, the 38px search
  field, the 38px filter segment — `.chef-hit`, `.chef-hit-y` and a matching
  negative margin absorb the difference. An extension may only grow the axis its
  neighbours do not occupy, and a strip that wraps must carry a row gap at least
  as large as the extension it hands each segment, or two targets in adjacent
  rows overlap.
- Native `select` carries the floor globally; it is always a control and never
  layout. A segmented control's segment is not: it is a 38px box inside a 46px
  shell that reaches the floor through `chef-hit-y`. Giving a segment the floor
  as its `min-height` is the mistake that turns a 46px strip into a 56px one and
  a settings screen into a scroll.
- One switch shape in the product: 51x31 with a 25px knob, reaching the floor
  through `chef-hit`. A tool that draws its own larger toggle is wrong even when
  it works.
- The phone tab bar is a glass island 60px tall, inset 12px from each side and
  floating 10px above the bottom edge (or 10px down into a home-indicator inset),
  with 24px icons and 13px labels; the current tab sits on a tinted chip. It
  grows with the readable-text size rather than clipping its labels. `--size-tab-bar-readable` is that measured height. The bottom
  content inset and every surface that floats above the bar — progress strip,
  result strip, and any tool's own export action that has not yet moved into
  flow — derive their offset from it and from nothing else. Reading the flat
  60px token instead is how a floating control ends up parked behind the chrome
  at a large text size.

### Active-tool rhythm

Every tool route is one `ToolScreen` (`components/Tool/ToolScreen.tsx`), drawn
full-viewport: no side rail, no tab bar, no navigation bar of the shell's own.

- **Header (`ToolTop`)**: 48px plus the top safe area on a phone, 52px from
  768px. In order: Back (only when the screen behind is known and is not Tools
  home, and the page was not opened from Settings), the brand link (desktop), the
  tool's mark and its name as the page `h1` (serif) with the small BETA badge on
  beta tools, the file name and meta (desktop), the tool's "change the file"
  control (`ChangeFile`: words on desktop and for short labels, otherwise an icon
  with the words as its name), and **Tools** at the end (start edge in RTL). A page
  opened from Settings shows "‹ Settings" there. No Recent, no Settings.
- **Phone, grid / list / file / form bodies**: header, the file line, the body
  (scrolls), then a foot sheet (raised surface, 18px top radius, hairline, safe-area
  padding) holding the result strip, the sentence, chips, the notice and the main
  action row. While running the action row is the progress line with Cancel. The
  sheet takes at most 40% of the screen at default text (Large and Largest keep the
  80% cap and scroll inside); with a result in it, the outcome line gives way.
  A setting appears once on a phone: as a value in the sentence whose card holds its
  control, never also as a control under the sentence (owner decision 2026-11-15).
- **Phone, preview bodies**: header, the sentence as a slim band on top, the preview
  as tall as the space allows, and a foot bar with the result strip and the actions
  (secondary outlined, main filled). While a card is open the preview keeps at least
  40% of the screen, or 30% when the card's controls need more room: the card's
  height is capped there, its body scrolls under its fixed title and close control,
  and the preview's own tools step aside.
- **Desktop (768px and up, tablets included)**: header, then one full-width band
  with the sentence, chips and notice at its start and the secondary and main
  action at its end with the result strip under them; then the canvas, which fills
  the rest of the viewport (own scroll, 24px padding). No right panel.
- **Editors** (Edit PDF, Sign, Make Fillable, Image to PDF's page editor) keep
  their own toolbar and main action. The result strip is drawn in a slot they
  provide above the toolbar (`components/UI/resultSlot.ts`).
- Vertical gaps inside a live workflow are 8, 10, 12 or 16px by role. 24 and 32
  are for a genuine change of section.
- Visual boxes sit at 38–44px and reach the 48px floor through `chef-hit-y`, as
  the shell's own controls do. The touch floor is never lowered to buy density.
  `scripts/verify-ui-controls.mjs --touch` measures it for every control.
- No tool reserves space for a control that is not live. A chip with nothing to
  do is removed from the row, not greyed out.
- **No tool adds its own bottom spacer.** The foot sheet already clears the safe
  area, the keyboard (`--chef-keyboard-inset`) and the result strip.
- Control order in an open tool is fixed: source, the sentence with its settings,
  the primary action, live status and result, then the preview or queue.

## Components

The shared vocabulary lives in `components/UI/Primitives.tsx`. One button shape,
one field shape, one switch, one segmented control, one sheet, one confirmation,
one empty state, one status line, one skeleton. If a control looks different on
two screens, one of them is wrong.

A tool page is built from the tool kit in `components/Tool/` (class prefix `tk-`,
styles in `components/Tool/tool.css`). `ToolShell`, `ToolHeader`, `ToolPanel`,
`OptionRows`, `ToolChoiceRow` and `ToolSelectionBar` no longer exist; a tool that
reaches for a raw padded card, a bespoke page wrapper or a hand-rolled action pair
is reintroducing the density the kit replaced.

- **ToolScreen**: the one layout (see Active-tool rhythm). Props: `title`, `beta`,
  `file`, `change`, `leading`, `kind` (`grid`, `list`, `file`, `preview`, `form`,
  `editor`), `body`, `side`, `lead`, `sentence`, `chips`, `notice`, `action`,
  `secondary`, `progress`, `toast`, `extra`. A tool with no file yet renders
  `kind="file"` with today's `FileUpload` as its body and nothing else.
- **ToolTop**: the header, with `BackIfNeeded`, `ToolsLink`, `BrandLink`,
  `ChangeFile`, `LogoTile`.
- **Sentence**: the tool's settings as one translated sentence. The template is one
  whole message with named placeholders; slots are filled by position so word order
  is the translator's. A value that opens an editor is a **Slot**: a button named
  "{setting}, {visible value}", tinted `--slot-tint`, radius `--radius-slot`. A
  sentence with no slots is a statement. When a sentence needs a third line (a long
  language, large text, a narrow phone), or a phone sentence holds four or more
  values, it is drawn as labelled rows with the same buttons and names (two to a line,
  label over value, in a live-preview band, at every text size); a statement is drawn at one serif statement size, short or long
  (`data-form="statement"`).
  Page phrases are exact: "page 4", "pages 2–5", "pages 1 and 3", "the 5 selected
  pages", "all 12 pages", "the only page" (`pagesPhrase` in `values.ts`).
- **Editor popover** (`Popover.tsx`): what a slot opens. A popover anchored to the
  slot on desktop, a card at the foot on phones. It holds today's control with
  today's accessible name and handler, stays mounted while closed (a typed draft
  survives), traps focus and returns focus to the slot. Every card closes the same
  way: its one close button (✕, "Close"), Escape, or a tap outside it, which closes
  the card and reaches what it landed on. No dim scrim on a phone.
- **Notice**: the one line under the sentence, tone `error`, `pending`, `caution` or
  `outcome`; an error is `role="alert"`.
- **Stepper**: − and + around a number field.
- **PageGrid**: page tiles sized by `usePageGridFit` so that every page is visible
  and as large as the canvas allows (132–420px tiles on desktop, three columns on a
  phone); beyond what fits it scrolls.
- **FilePreview**: the first page of the loaded PDF in the canvas of file tools.
- **CropFrame**: the live crop frame on a rendered page. Four edge handles
  (`role="slider"`, 0–40, arrow keys 1, Shift 5) and four corner handles, fixed
  ink dimming outside the frame, kept in step with the sentence.
- **BetaBadge** (`Primitives.tsx`): the small BETA badge, on the home row and beside a
  beta tool's title.
- **ZoomControls** (`bare`, `dense`) and the reader's zoom pill that hides on
  scroll (`hooks/useHideOnScroll.ts`, phone only).

- App shell: `components/Layout/AppShell.tsx`. Bottom tab bar below `md`, side
  rail at `md` and above, large title header on each tab root. Non-root routes
  carry no shell chrome: each draws its own `ToolTop`. A tab root may supply compact leading brand artwork on phones;
  desktop must not repeat artwork already present in the side rail.
- Tool identity: the generated Android mark is authoritative for the 25 tools
  shared with Android. Reader, web-only tools, and shell controls use their
  existing Lucide fallback. Generated artwork is never recoloured or filtered.
  Marks below the first screen load lazily and decode asynchronously; the rows
  that can be on screen at first paint stay eager. This is delivery only, so the
  pixels and the semantics of every mark are unchanged.
- Icon bubbles take their wash from the mark inside them, using the same palette
  seed the Android artwork was drawn from, composited at 13% over the surface
  behind it so one value serves both themes. Never tint a bubble by category:
  four tints repeat what a counted filter already says, they disagree with the
  artwork they sit behind, and in dark theme the semantic quiet tokens resolve
  dark and saturated enough to read as status. A tool with no generated mark
  takes the product's own logo red rather than an invented hue.
- Selection in a segmented control is a raised chip on a sunken track — the
  native shape — with the accent on the label. A flat accent-filled segment
  reads as a status block, not as a choice.
- The tool routes share one layout, `ToolScreen`, not a set of density edits each.
  The only shell-drawn header left is the one `AppShell` gives pages that are not
  tool screens (Help, Privacy, Terms, Licenses, a tool still loading); those marked
  `.chef-tool-surface` keep the phone rules in `index.css`, scoped to
  `max-width: 767px`.
- A tool's title is the page's `h1` in `--font-display`, in the header, at
  19/24. The body repeats no title.
- A route that draws its own header consumes the platform insets itself:
  `ToolTop` and the reader's header carry `chef-safe-top`. Without it the header,
  and the action in it, paint underneath the status bar and the camera cutout on a
  phone that reports a real top inset.
- The reader's zoom cluster is a 40px strip: 36px visual controls whose
  pressable region is extended on the vertical axis only, with the width held at
  the touch floor. They sit shoulder to shoulder, so a horizontal extension
  would let one control steal the next one's edge, and a 48px *visual* box turns
  a four-control cluster into a slab as tall as the document title above it.
- Lists over grids. Use divided rows inside a bordered panel; group them only
  when grouping materially improves navigation.
- Segmented controls wrap onto further rows at large readable-text sizes. Their
  option width is set in rem, so the labels reflow instead of overlapping.
- One navigation per route. `ToolTop` supplies Tools and the conditional Back, so
  a tool must not also draw its own back link. PDF to Image keeps "Back to tools"
  in the brand position through `ToolScreen`'s `leading`.
- A bounded scroll panel caps its height with both a viewport and a rem term, so
  the cap grows with the readable-text size instead of landing through a control,
  and it carries `chef-edge-fade-y` so any remaining boundary reads as more
  content below rather than as a clipped row.
- Every modal owns focus: it moves focus inside on open, keeps Tab within
  itself, closes on Escape, and returns focus to the control that opened it.
- A segmented control with a short, known option set takes fixed columns so it
  holds one row on a phone; the rem-basis wrap is for labels whose width is not
  known in advance.
- Every true modal renders through `Portal`. `position: fixed` resolves against
  the nearest transformed ancestor and the route wrapper is transformed for its
  entrance, so an overlay declared inside a route anchors to the page, not the
  viewport: that is how a row-action sheet opened below the fold while the body
  was locked.
- Finishing a routine job does not earn an interruption. Progress is a compact
  strip. When "save on finish" is on the app shows no floating result at all:
  the tool's own inline completion and Recent are the record, and a strip on top
  of them is a second notice for one event. It also could not be honest, since a
  native or browser export can fail or be cancelled after the bytes are handed
  over, so nothing claims "Saved". Only a result awaiting a manual Save keeps one
  compact "Result ready" strip, with the rest behind More. Modal interruption is reserved for errors needing action,
  destructive confirmations and essential warnings, and the progress and result
  strips never appear together.
- A durable document opens in the platform's own reader where one exists; a
  result that is only bytes in this session stays on the web reader. Closing a
  reader is the ordinary end of reading and is silent — no toast, no error, no
  navigation. Choosing a tool from inside a reader returns to that tool with the
  document already selected. A native screen wears the product's own chrome,
  tokens and tool names rather than the platform default, so crossing into it
  does not read as leaving the app.
- A destructive action that the platform can genuinely take back is not
  confirmed twice. It happens on the press and offers one Undo in the surface's
  own anchored status place — never a floating toast, never a swipe — and that
  line is held for exactly as long as the window is open. A permanent action
  keeps its confirmation, because that press is the only chance to reconsider
  it. A selection that mixes the two is confirmed once and the confirmation
  names how much of it cannot be undone. While that offer stands, the line and
  the action are one status-toned panel in the page's own rhythm, with the
  action full width beneath the sentence it answers. A small control loose under
  a full-width strip is two surfaces for one event and reads as debris on a
  phone.
- An undo token is opaque, kept in memory for the window only, and never
  rendered, stored or logged. When the window closes the offer withdraws itself
  rather than waiting to fail. Expired, unavailable and failed undo copy is
  fixed plain language; a native message is counted, never quoted.
- A standing offer belongs to the person, not to the next action. A later
  action that reversed nothing leaves it alone, one that reverses more folds
  into it on the earliest of the windows, and a restore that only partly worked
  keeps the receipts that refused on their original window so the action stays
  there to be tried again.
- A batch reports the counts it actually achieved. "Deleted 2 of 3" is the
  honest form; a batch that came back short is never given the wording of one
  that completed, and an undo is offered only for the exact rows that came back
  reversible.
- Capability flags answer for a build; a store that owns some rows while only
  reading others answers per row. The platform reports a limitation code and the
  surface owns the sentence, so no native wording reaches a person.
- A preference that also lives in a store this app does not own has one
  authority: this app's own store, once it holds a real choice. The other store
  is read once when it does not, never written during that read, and never
  rewritten into a shape it did not have. A choice is not called saved until the
  device confirms it and this store has kept it; until then it is in flight, and
  a launch that finds an interrupted write asks the device what actually
  happened rather than guessing. A device that cannot be reached is a failure
  with the last confirmed choice restored, never a quiet local success.
- Feedback for a setting belongs to the setting: it sits in that row, in flow,
  at the width of the control it answers, announced politely. It distinguishes
  in flight, settled, and refused, and it never repeats a platform's own modes,
  messages, keys or storage. The control stays live throughout, because a
  refused write is a reason to press again rather than to be locked out.
- A disabled control states its reason on the surface, in text, beside the
  control. A `title` attribute is not a reason: a phone has no hover, and a
  disabled element is not focusable, so a hover-only explanation reaches nobody
  on the platform this product ships to.
- Content the product can read but does not own is labelled as such on the row,
  keeps every action it genuinely supports, and has the rest disabled with the
  reason rather than hidden. It never joins a bulk selection, and a clear action
  beside it names what it is actually clearing instead of implying it removed
  something it cannot touch.
- A group of files is not a document. A row the platform reports as a logical
  collection is named as a group, marked with a plain folder, and measured in
  items, because it has no single byte size and no MIME type. It is never called
  a PDF, a file or an archive, and nothing offers to turn it into one. It keeps
  the native save and share it genuinely has, labelled by how many files those
  act on, and opening is disabled with the visible reason that it is a group of
  files rather than one PDF. Read-only like any legacy row, so it stays out of
  selection, rename, delete and undo.
- A phone action bar goes in flow. A sticky bottom bar competes with the tab bar
  for the same strip and covers the last row of whatever it belongs to.
- A drag-reorder surface that scrolls inside a bounded element passes that
  element to `useDragReorder`. Slot geometry is recorded in the scroller's own
  content space and re-measured while auto-scrolling, so an offscreen target is
  reachable; omitting the option keeps the page-scrolling default. A native listener
  installed on pointer down keeps the closure from that render, so the drag
  reads what it is dragging and what the list currently holds from refs, never
  from render state that has not committed yet, and the drag overlay follows the
  pointer through committed state rather than a mutated ref.
- An intake control is a full drop zone only while the queue is empty. Once
  something is queued it becomes a compact 44pt Add row, and on a phone the
  intake and the action precede the queue.
- Short peer actions such as Add pages and Blank page share one two-column row
  on a phone; they do not consume separate full-width rows.
- An empty phone tool landing is optically centred in the height left between
  the tool bar and tab bar. The complete panel is the unit being centred, so a
  compact picker moves farther down while a tall Batch panel moves only enough
  to remain fully usable.
- Loaded document workspaces are top-aligned; landing-page centring never adds
  dead space above active controls, thumbnails, or previews.
- A slider with a precise numeric value uses the compact editable-value row:
  drag the track for quick adjustment or tap the value to type an exact number.
  The typed value is clamped to the same safe range as the slider.
- Two short peer sliders, such as image quality and resolution, share one
  two-column phone row instead of stacking two full-width control blocks.
- Segmented controls sit flush with adjacent full-width actions and panels;
  their segments do not add an extra outer inset that breaks the left edge.
- Loading is a skeleton in place, not a spinner over content.
- Empty states teach the next action and name it.

## Materials

Translucent chrome on the tab bar only, with content scrolling beneath. Solid
everywhere else, tool headers included. It goes solid under
`prefers-reduced-transparency` and `prefers-contrast: more`, and the tab bar's
island also at the large readable-text sizes.

## Motion

Critically damped: 220ms for state, 320ms for a sheet, ease `cubic-bezier(0.22,
1, 0.36, 1)`. Feedback on pointer-down. Nothing loops or drifts. Overshoot only
after a gesture that carried momentum. Under `prefers-reduced-motion`, travel and
scale are removed and opacity is kept.

## Platform integration

The interface talks to the platform through the typed ports in
`hooks/useWorkspaceRuntime.tsx`, which wrap `services/platform/contracts.ts` and
`services/domain/**`. A port that has not been injected is absent, and the
surface renders an unavailable state that explains it. No surface fakes a
success, and no surface invents persistence behaviour.

## Accessibility

AA contrast in both themes. Every icon-only control has an accessible name.
Status is announced politely and never steals focus. Focus is always visible.
Route changes move focus to the top of the new view. Colour is never the only
signal. Long filenames wrap rather than truncate; where a platform bar cannot
grow without limit, it takes two lines before it is allowed to ellipsise.
200% text reflows.

## Parity surface contracts (2026-08)

Retained from the previous revision and still binding:

- Dashboard: one search field, counted category filters, one uninterrupted
  Android-ordered catalog, truthful Beta / Not available status, and a reset
  path from an empty result.
- Upload shell: keyboard activatable, states the accepted format, shows name,
  size and any limitation before the primary action, keeps a live status region
  and a recovery action.
- Forms/editor: "Detect fields" produces suggestions and says "Review every
  field". Edit PDF keeps page, undo/redo, Text, Image, Shape, Save, zoom and a
  labelled inspector in a stable order. Below 768px, mobile web and native iOS
  use the same immersive editor composition as Android, with fixed bottom
  creation tools and route-safe unsaved-edit confirmation; desktop retains the
  wide toolbar and inspector. Selectable PDF words use direct text editing only
  after a unique geometry match; unsupported structures expose a named visual
  fallback. Existing text selection uses a caret/underline treatment instead of
  a movable rectangular box. Selection never depends on colour alone.
- Office conversion: Word to PDF is text-oriented and may omit fonts, styling,
  images and table grids. PowerPoint to PDF may substitute fonts and omits notes,
  animation, video and audio. PDF to Word is a searchable-text export. These sit
  beside the action, not in hidden documentation.
- Batch: one operation over an ordered queue, one ZIP, inspectable partial
  failures.
- Tool workflow: on phones, keep the order source, options, primary action,
  live status, result. The primary action stays reachable without covering the
  last option. Progress, cancellation and retry copy must describe what the
  browser can actually do; a button must not promise immediate cancellation of
  a synchronous step.
- Risk boundary: destructive choices, lossy conversion and unusually large
  browser jobs require an explicit review or confirmation. Estimates are named
  as estimates and never presented with measurement-like precision.
- Result card: Save is primary, retention is stated as local. The name is
  editable in one field, the original extension survives an edit that drops it,
  and the resolved name is always shown in full beneath the field.
- Recent: per-item and clear-all deletion with exact local scope. A row the app
  owns durably renames in place and deletes reversibly with an in-context Undo;
  a row it only reads or only holds for the session keeps its stated reason and
  its permanent deletion. Clear-all and clear-files stay destructive and never
  gain an undo.
- Settings: grouped local preferences, stated persistence. On Android the theme
  is shared with the older app's own settings store, so the Theme row states
  whether a choice is being written, was written, was brought over, or was
  refused, and it says so in that row and in plain words.
- Onboarding: exactly four short lines covering on-device documents, no uploads or account, offline use after loading, and local results until deletion. No supporting paragraphs.
- Android Back: dismiss the top sheet, then pop React history, then return a direct tool launch to Home; exit only from Home. Document preview controls must not cover the content they manipulate.
- Android system-bar icons follow the interface's resolved light or dark theme, including after relaunch.
