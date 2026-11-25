# PDF Chef brand guidelines

Source of truth for `assets/design-tokens.json` and `assets/design-tokens.css`.
Change a value here first, then in both token files. They must agree.

## What this product is

A private workbench for documents you would not hand to a stranger. Someone
opens PDF Chef standing in a clinic corridor, at a solicitor's desk, or at a
kitchen table with a payslip, and needs to be certain the file did not go
anywhere. Everything below serves that one moment of certainty.

"Chef" here means a craftsperson with sharp tools, not a restaurant. There is
nothing culinary in the visual language.

## Voice

Plain, specific, and unhurried. State what happened and what will happen next.

- Say what a thing does, not how good it is. "Opened and processed on this
  device", not "blazing-fast private processing".
- Never claim a document is secure because it was processed locally. Those are
  different claims.
- Name the scope of a destructive action exactly: what is deleted, what is not,
  and whether it can be undone.
- Beta means beta. Detection produces suggestions. Conversion produces a best
  effort. Say so beside the button, not in a help page. The BETA mark is small:
  16px high, caution tint, no border.
- No exclamation marks, no em dashes, no "simply", no "just".

## Colour

Strategy: **restrained**. Warm paper carries the surface, one tomato accent
carries meaning, three status hues carry state. Nothing is coloured for
decoration.

| Role | Light | Dark | Where |
|---|---|---|---|
| Paper (canvas) | `#faf7f2` | `#14120f` | The ground. Warm, never `#000`. |
| Raised | `#ffffff` | `#1c1915` | Cards, sheets, the tab bar. |
| Sunken | `#f2ede5` | `#24201b` | Tracks behind chips and segments, empty wells. |
| Ink (accent) | `#c23a22` | `#c9402a` | Primary actions, current tab, selection, slots. |
| Success | `#2f6a35` / `#e9f1e4` | `#93cf8e` | Finished, saved, actually smaller. Text / quiet fill. |
| Caution | `#845600` / `#f8eed6` | `#e7bb65` | Beta, memory pressure, review-first. |
| Danger | `#a3301c` / `#fae6df` | `#ff9f88` | Delete, clear, failed. |

Paper is a warm neutral with a faint yellow-brown cast, like uncoated stock.
Chroma drops toward both ends of the ramp, so the lightest and darkest steps
look almost neutral and should stay that way. The ink ramp is one tomato hue:

| Step | Paper | Ink |
|---|---|---|
| 25 | `#ffffff` | `#fef6f3` |
| 50 | `#faf7f2` | `#fbe9e3` |
| 100 | `#f2ede5` | `#f6d3c8` |
| 200 | `#e6dfd4` | `#ffc2b2` |
| 300 | `#d3c9ba` | `#ff8a70` |
| 400 | `#a89c8c` | `#c9402a` |
| 500 | `#857a6b` | `#c63c24` |
| 600 | `#6f665c` | `#c23a22` |
| 700 | `#57504a` | `#a93119` |
| 800 | `#34302a` | `#8a2814` |
| 900 | `#1d1a16` | `#3a2018` |
| 950 | `#14120f` | `#24120d` |

The semantic tokens (text steps, borders, accent roles, status pairs) are set
in `assets/design-tokens.css` and mirrored in `assets/design-tokens.json`;
`scripts/check-token-contrast.mjs` computes the contrast of every text pair
(4.5:1) and of `--border-strong` (3:1) in both themes and fails if the two files
disagree. The measured ratios are recorded in `design-system/MASTER.md`.

Colour is never the only signal. Every status carries an icon and words.

Brand red and danger clay are deliberately separate roles even though they are
neighbours in hue. Brand red means act, current, selected, or focused. Danger
clay means delete, clear, failed, or destructive, and always includes words or
an icon. As text, the accent uses `--accent-text`, one step darker than the
fill, so it clears 4.5:1 on every surface. The focus ring is ink-coloured
paper-900 (`#1d1a16` light, `#f4eee4` dark), not the accent, so it stays visible
on an accent fill.

The Android logo artwork keeps its own red and is never re-coloured, outlined,
filtered, or shadowed. The interface accent is the product's own tomato, not a
match for the logo.

### Why this red

A single warm red on warm paper reads as a craftsperson's mark on good stock.
The accent is reserved for actions and current state, so the interface stays
calm and the accent keeps its meaning. Dark plus neon green remains outside the
brand.

## Typography

One interface family. `Manrope` is bundled for a consistent render across web
and iOS; `System` maps to SF Pro on Apple devices and is offered in Settings for
anyone who prefers the platform face.

A serif carries the voice, in two places only: titles (the `h1` of a screen, the
brand name in the rail) and the sentence on a tool screen. It is a system serif,
so nothing is downloaded, chosen by script (`--font-display` in the token file,
weight 600):

- Latin and Cyrillic: Iowan Old Style, Charter, Noto Serif, Georgia.
- Japanese: Hiragino Mincho ProN, Yu Mincho, Noto Serif CJK JP.
- Simplified and Traditional Chinese: Songti SC / Songti TC, Noto Serif CJK.
- Korean: AppleMyungjo, Noto Serif CJK KR.
- Arabic and Hindi: no dependable serif on phones, so the interface font at 600.

The interface font a person picks in Settings still sets everything else.

- Tracking is size-specific: `-0.028em` at display, `-0.02em` at title 1, near
  `0` at body, `+0.01em` at caption. A single letter-spacing value is wrong
  somewhere.
- Leading tightens as type grows: `1.08` at display, `1.5` at body.
- Hierarchy comes from weight and size together, in a 1.2 ratio. Never from
  colour alone.
- Every size is in `rem` so the readable-text-size preference and the OS text
  setting move the layout with the text instead of overflowing it.
- Sizes, counts, and timestamps use tabular figures so columns line up.

## Layout and shape

- Controls are pills (`999px`). Fields and panels are `10px`, rows `16px`, sheets
  `18px`, a slot (a value in a sentence) `6px`, a popover `10px`. A small chip
  never wears a panel radius.
- Surfaces are flat and bounded by a hairline. Only popovers and sheets lift; the
  selected chip of a segmented strip keeps a small lift of its own so the current
  choice is easy to find.
- Lists, not card grids. Thirty-four identical cards is a grid of noise; a
  grouped list with a category heading says something true about the catalog.
- Spacing varies by role. Section gaps are larger than row gaps, which are
  larger than inline gaps.
- Reading measure caps at 68ch. Data can run denser.

## Materials

Translucency is functional, never decorative. Only two surfaces use it: the tab
bar and the tool navigation bar, both because content scrolls underneath them.
Everything else is opaque. Under `prefers-reduced-transparency` and
`prefers-contrast: more` both go solid.

Scroll edges fade in only where floating chrome actually overlaps content. There
is no permanent 1px line under a bar that has nothing beneath it.

## Motion

Critically damped by default: `damping 1.0`, response `0.22s` for state,
`0.32s` for a sheet. Overshoot is reserved for motion that follows a gesture the
user physically made, and there is currently none of that in the shell, so there
is currently no bounce.

- Feedback lands on pointer-down, not on release.
- Nothing loops, drifts, floats, or pulses.
- Under `prefers-reduced-motion`, travel and scale are removed and opacity
  remains, so a state change is still legible.

## Haptics

Signals fire on the causal event only, on the same frame as the visual:

| Signal | When |
|---|---|
| `selection` | Tab change, picker opened, filter chosen. |
| `commit` | A job finished, a file saved, onboarding dismissed. |
| `warning` | A large-document warning appears. |
| `error` | An action failed. |

No haptic on scroll, hover, or arrival. A missing haptics service is a silent
no-op, never replaced with a visual substitute.

## Artwork

See `assets/brand/README.md`. The original Android app logo is authoritative.
It is never re-coloured, outlined, filtered, or shadowed. Its red anchors the
interface accent ramp but does not license decorative red elsewhere.

## The line we do not cross

No copy, icon, badge, animation, or empty state may imply that a document was
uploaded, synced, backed up, scanned by a service, or verified by anyone. If a
capability is not implemented, the interface says it is unavailable. It does not
show a success it cannot deliver.
