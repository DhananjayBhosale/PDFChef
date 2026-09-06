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
  effort. Say so beside the button, not in a help page.
- No exclamation marks, no em dashes, no "simply", no "just".

## Colour

Strategy: **restrained**. Warm tinted neutrals carry the surface, one accent
carries meaning, three status hues carry state. Nothing is coloured for
decoration.

| Role | Value | Where |
|---|---|---|
| Paper | `#fff8f4` light, `#17100f` dark | The ground. Warm, never `#fff` or `#000`. |
| Ink | `#dc2020` light, `#ff4d52` dark | The single accent: primary actions, current tab, selection, focus. |
| Success | `#3f6538` / `#96be8e` | Finished, saved, actually smaller. |
| Caution | `#8c6014` / `#e0b368` | Beta, memory pressure, review-first. |
| Danger | `#8c3526` / `#e09285` | Delete, clear, failed. |

Every neutral is tinted toward hue 24 — the accent's own hue — so the surface
reads as warm paper with a faint reddish cast rather than as grey. `paper-50`,
`paper-100` and `paper-200` are the Android app's background, card and divider
values verbatim; the rest of the ramp is those three resolved up and down at the
same hue, and dark carries the same cast rather than a cool blue-black. Chroma
drops as lightness approaches either end, which is why the darkest and lightest
steps look almost neutral and should stay that way.

Colour is never the only signal. Every status carries an icon and words.

The authoritative Android logo red is `#E42121`, retained at `ink-500` as the
brand anchor. It reaches only 4.40:1 against the light paper ground
`#FFF8F4`, just below the WCAG AA 4.5:1 requirement for normal text and
text-sized controls. Light-theme semantic accent therefore uses `#DC2020` at
`ink-600`, the smallest uniformly darker RGB derivative that clears AA at
4.68:1. Dark-theme semantic accent uses Android's exact `#FF4D52`; it reaches
5.76:1 against `#17100F`. Keep the logo artwork at its original colours.

Brand red and danger clay are deliberately separate roles even though they are
neighbours in hue. Brand red means act, current, selected, or focused. Danger
clay means delete, clear, failed, or destructive, and always includes words or
an icon.

### Why this red

This is the PDF Chef Android identity carried into the workspace, not generic
PDF-category decoration. Warm paper still owns almost every surface. Logo red
is reserved for actions and current state, so the interface stays calm and the
accent keeps its meaning. Dark plus neon green remains outside the brand.

## Typography

One family, no display face. `Manrope` is bundled for a consistent render
across web and iOS; `System` maps to SF Pro on Apple devices and is offered in
Settings for anyone who prefers the platform face. There is no serif or script
anywhere in the interface.

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

- Radii step with the surface: `12px` controls, `14px` fields, `16px` rows,
  `22px` panels, `28px` sheets. A small chip never wears a panel radius.
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
