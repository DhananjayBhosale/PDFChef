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

- `paper` — warm neutral ground, hue 82. The page, panels, borders, all text.
  Never `#fff`, never `#000`.
- `ink` — the single accent, Android logo red at hue 24-28. The token name is
  retained for compatibility. `#E42121` is the exact light logo anchor;
  `#DC2020` is the AA light semantic accent; `#FF4D52` is the exact dark
  semantic accent. Primary action, current tab, selection, focus ring. Not
  decoration.
- `success` (145) finished and actually smaller · `caution` (75) beta, memory
  pressure, review-first · `danger` (22) delete, clear, failed.

Semantic aliases (`--surface-*`, `--text-*`, `--border-*`, `--accent-*`,
`--status-*`) resolve per theme. Components read the aliases, never a raw step.

Tailwind's stock family names are re-pointed at these ramps in
`tailwind.config.cjs`, so the pre-existing tool components inherit the palette
without being edited. New code uses `paper-*`, `ink-*`, `success-*`, `caution-*`,
`danger-*`, or the `surface` / `content` / `edge` aliases.

The canonical `#E42121` logo red reaches 4.25:1 on light paper, below the 4.5:1
AA threshold for normal text. Light semantic accent uses the smallest uniformly
darker derivative that clears it: `#DC2020` at 4.52:1. Dark semantic accent uses
`#FF4D52` at 5.64:1 on `#16140F`. Keep action red and danger clay semantically
separate and pair status with words or an icon. The original Android app logo
keeps its supplied colours.

`--accent-rest` is the accent as a *fill, border and focus ring*, where 3:1 is
what is owed. As a label or a glyph on a neutral surface it misses 4.5:1 on the
sunken surface, so accent-coloured text reads `--accent-text` instead: `ink-700`
light, `ink-300` dark. Nothing else changes; the button, the ring and the
selected edge stay the brand step.

## Contrast and edges

Every semantic value is chosen against all three surfaces of its own theme —
canvas, raised, sunken — not against the lightest one. A value that passes on
`raised` and fails on `sunken` has not passed.

Text is four steps, and each one clears 4.5:1 on all three:

| token | light | dark | worst ratio |
| --- | --- | --- | --- |
| `--text-primary` | `#24211d` | `paper-50` | 13.6 |
| `--text-body` | `#4a443c` | `paper-200` | 8.2 |
| `--text-secondary` | `#615a50` | `#c9c1b3` | 5.8 |
| `--text-tertiary` | `#6e675c` | `#ada395` | 4.8 |

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
the existing accessibility-oriented alternatives. No separate display face.

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
- **An open tool's copy budget is what would cost the user work.** A tool page
  gets a title and, at most, one line under it, and it gets that line only for
  something the controls cannot say: a lossy or destructive consequence, a
  password rule, a beta fidelity limit, an accepted-format constraint, an output
  format. A sentence that restates the title, the upload label, the export
  button, or the next obvious gesture is deleted, not shortened. Most tools pass
  no line at all.
- The same explanation never appears above and below the control it describes.
  When a limit belongs to a decision, it lives beside the button that makes it,
  not under the page title as well. `ToolHeader`'s `note` is the single slot for
  the exception.
- Instructions for gestures the interface already offers by other means are
  copy, not help: "select pages, then turn them left or right" beside a Left and
  a Right button, "drag to place" above a position slider, "tap a thumbnail to
  preview" beside a preview control. Live status, error text, accessible names,
  and review warnings are never in this category and are never removed.

## Spacing and shape

- Radii step with surface size: control 12, field 14, row 16, panel 22, sheet 28.
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

- A tool that already has a document is spending screen on the document. The
  frame is `ToolShell`: 16px gutter, 16px of page padding on a phone, the airier
  padding only from `sm:` up. Vertical gaps inside a live workflow are 8, 10, 12
  or 16px by role. 24 and 32 are for a genuine change of section, not for the
  space between a control and the thing it controls.
- Option surfaces hug their content: `ToolPanel` is 12px of padding on a phone.
  A two- or three-way choice is a strip (`ToolChoiceRow`, `SegmentedControl`, a
  `grid-cols-3` of 40px chips), never a column of large padded cards, and never
  a card carrying a second line that restates its own label.
- Visual boxes inside an active tool sit at 38–44px and reach the 48px floor
  through `chef-hit-y`, exactly as the shell's own controls do. The touch floor
  is never lowered to buy density.
- No tool reserves space for a control that is not live. A chip with nothing to
  do — Reset before the first change — is removed from the row rather than
  greyed out in a row of its own. `ToolChipAction.hidden` is that switch.
- **The primary action is in normal document flow**, directly under the options
  or the selection summary it acts on, and before the page list or queue it
  produces. A phone export bar pinned above the tab bar covers the last item and
  then needs a spacer under the content to uncover it. Only a genuine immersive
  editor — one whose route takes the whole viewport and draws its own chrome —
  keeps a persistent action, and it keeps it in that chrome, never over the page.
- **No tool adds its own bottom spacer.** The shell already reserves the tab bar
  with `chef-tab-inset`; an `h-24`, a `pb-28` or a `pb-64` under the content is a
  second inset nobody asked for and reads as an unexplained gap between the
  document and the action.
- Control order in an open tool is fixed: source, essential options, primary
  action, live status and result, then preview or queue.

## Components

The shared vocabulary lives in `components/UI/Primitives.tsx`. One button shape,
one field shape, one switch, one segmented control, one sheet, one confirmation,
one empty state, one status line, one skeleton. If a control looks different on
two screens, one of them is wrong.

A tool page's own frame lives beside it in `components/UI/ToolLayout.tsx`:
`ToolShell` (gutter and page padding), `ToolHeader` (title and the single
optional note), `ToolPanel` (an option surface that hugs its content),
`OptionRows` / `InlineOptionRow` (divided rows instead of stacked cards),
`ToolChoiceRow` (two or three labelled actions shoulder to shoulder at 40px with
18px icons) and `ToolSelectionBar` (a live count and its chips on one line, with
chips that are absent rather than dead). A tool that reaches for a raw padded
card, a bespoke page wrapper or a hand-rolled action pair is reintroducing the
density these replace.

- App shell: `components/Layout/AppShell.tsx`. Bottom tab bar below `md`, side
  rail at `md` and above, tool nav bar on non-root routes, large title header on
  each tab root. A tab root may supply compact leading brand artwork on phones;
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
- The 34 tool routes share one shell, not 34 sets of density edits. `AppShell`
  marks every non-root route `.chef-tool-surface`, and the phone rules for that
  scope live in `index.css`: the 16px leading edge, the in-page title at the
  Heading step with no top margin, and a 16px gap under the title block. They
  are scoped to `max-width: 767px` because they are the phone's rhythm, not a
  redesign of the wide layouts. Only structural, unambiguous properties belong
  there; a rule that reached for arbitrary utility classes would be guessing at
  a tool's intent.
- A tool's in-page title is the Heading step, not Display. The nav bar already
  names the tool, so a Display title above it is the same word twice at the
  largest size the product has.
- An immersive route is handed no shell chrome, so it consumes the platform
  insets itself. `/view`, `/image-to-pdf` and `/pdf-to-jpg` each carry
  `chef-safe-top` on their own header; without it the header, and the action in
  it, paint underneath the status bar and the camera cutout on a phone that
  reports a real top inset.
- The reader's zoom cluster is a 40px strip: 36px visual controls whose
  pressable region is extended on the vertical axis only, with the width held at
  the touch floor. They sit shoulder to shoulder, so a horizontal extension
  would let one control steal the next one's edge, and a 48px *visual* box turns
  a four-control cluster into a slab as tall as the document title above it.
- Lists over grids. Use divided rows inside a bordered panel; group them only
  when grouping materially improves navigation.
- Segmented controls wrap onto further rows at large readable-text sizes. Their
  option width is set in rem, so the labels reflow instead of overlapping.
- One navigation per route. `AppShell` supplies the tool nav bar and the way
  back, so a tool must not also draw its own back link. Immersive routes get no
  nav bar and therefore carry one named, full-size exit of their own.
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

Translucent chrome on the tab bar and tool nav bar only, both with content
scrolling beneath. Solid everywhere else. Both go solid under
`prefers-reduced-transparency` and `prefers-contrast: more`, and the tab bar's
island also at the large readable-text sizes. Scroll edges fade in
only where chrome actually overlaps content.

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
