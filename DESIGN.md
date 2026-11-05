# PDF Chef Design Contract

## Experience direction

Use a calm, premium, low-glare workspace: purposeful rounded surfaces, clear hierarchy, and restrained motion. Density is a phone-first decision, not a leftover: on a phone the surface carries the Android app's rhythm, because that rhythm is what a returning user recognises and what puts real content above the fold. The interface should feel trustworthy for sensitive documents, not like a generic upload funnel. Keep copy short, concrete, and visible at the point of decision.

## Surface contracts

### Dashboard

The product name and mark, then the privacy line, then one search field, then counted category filters, then the whole catalog as **one full-width divided list**. Not a card grid: 34 same-shaped cards is the generic answer, and a divided list is denser, faster to scan, and the shape the Android app already earned.

The phone rhythm is the Android list's, to the pixel: 16px page sides; a 50px mark beside a 24/30 title; a nominal 46px privacy strip; a 38px search visual inside a 44px practical target; a 46px category shell holding 38px segments; 72px-minimum rows with 14x10 padding, a 48px icon bubble carrying 32px of generated artwork, a 14px text gap, a 14/20 SemiBold title over a 12/16 Medium subtitle of at most two lines, and a 22px chevron. Dividers begin after the icon region so the marks read as one column. Rows are minimums and grow; the icon column is fixed so the divider never drifts.

The five category filters wrap onto another line rather than scrolling out of reach, so every one of them is reachable at 320px and at 200% text without the page ever moving sideways. Each row states beta and availability on itself. Empty search results provide a clear reset action. No duplicate tool navigation, no oversized decorative hero space.

Tablet and desktop adapt deliberately rather than inheriting the phone list: the side rail carries navigation and the mark, search and filters stick to the top of a long page, rows go denser (56px, 40px bubble), and past 1200px the same rows in the same order lay into two columns instead of stretching a single one across empty width.

### Upload and tool shell

Use a shared drop zone that is also keyboard activatable, labels the accepted type, and supports picker and drag/drop. After selection show filename, size, format constraints, and any fidelity or memory warning before the primary action. Keep one dominant action, a nearby recovery action, and a visible status region.

### Active tool surfaces

An open tool spends its screen on the document. Every tool page is framed by `ToolShell` — a 16px phone gutter and 16px of page padding — and every gap inside a live workflow is 8, 10, 12 or 16px by role; 24 and 32 mark a real change of section, never the distance between a control and what it controls. Option surfaces hug their content, and a two- or three-way choice is a compact strip rather than a column of large padded cards. Visual boxes sit at 38–44px and reach the 48px touch floor through the hit-area extension, so density never comes out of the target.

Order inside an open tool is fixed: source, essential options, primary action, live status and result, then preview or queue. The primary action sits in normal document flow directly under the options or selection summary it acts on and before the list it produces; only a genuine immersive editor keeps a persistent action, and it keeps it in its own chrome rather than over the page. No tool adds a bottom spacer of its own — the shell already reserves the tab bar — because a spacer under the content reads as an unexplained gap between the document and the action.

On Android, the system Back action dismisses the top sheet first, then moves through React route history, returns a direct tool launch to Home, and exits only from Home. Preview controls stay outside document overlays so they never cover the content being positioned.

A control that has nothing to do is removed from its row rather than reserving an empty one.
Short peer actions such as Add pages and Blank page share a compact two-column row on a phone.
Empty tool landings are optically centred in the space between the tool bar and tab bar; the complete panel determines the offset, so taller option panels stay fully visible. Once a document is loaded, the workspace returns to the top edge so controls and previews do not inherit decorative empty space.
Numeric slider values are compact editable fields, not passive labels: users can drag for speed or tap the value and enter an exact quality, scale, size, opacity, rotation, or position.

One accent per screen carries the primary action; the secondary beside it is an outlined control, not a second fill. The status hues never stand in for that hierarchy — a green primary or an amber primary reads as an outcome — and a running job fills its progress track with the accent. Anything drawn on a rendered page uses fixed ink steps, because the page stays white in both themes while a neutral token does not.

### Tool copy

A tool page gets a title and at most one line under it, and it earns that line only for something the controls cannot say: a lossy or destructive consequence, a password rule, a beta fidelity limit, an accepted-format or output-format constraint. Most tools carry no line. The same explanation never appears both under the title and beside the control; when a limit belongs to a decision it lives at the decision. Instructions for a gesture the interface already offers by another visible means are deleted rather than shortened. Live status, error text, accessible names, and review warnings are never treated as excess copy.

### Forms editor

The editor is a three-part workspace on wide screens: field controls, page canvas, and current-page field list; stack these in a usable order on narrow screens. Make “Detect fields” visually secondary to “Create fillable PDF”. Suggested fields must be visibly distinguishable from source content, individually removable/renamable, page-addressable, and accompanied by “review every field” copy. Ensure page navigation, field labels, and actions remain usable at high text size.

### Edit PDF controls

Keep page selection, undo, redo, Text, Image, Shape, and Save in a stable toolbar. When an element is selected, expose its properties in a labelled inspector: content, colour, font, size, fill/stroke, rotation, page, and delete. Selection and resize affordances need a clear focus/selected state and at least a phone-usable target; never rely on colour alone. Zoom is persistent and reachable without covering the page.

### Batch

Use a clear two-column flow on desktop: operation/settings first, ordered file queue second. The primary button states the file count. Show per-file progress, preserve order, identify failures, and describe the ZIP result. Removing a queued file is reversible until processing starts; controls lock while running.

### Output card and history

The output card is an `aria-live` success surface with filename editing, one primary action, quieter outlined actions in two columns, and History. Save is the primary action until the file is saved to the device; after that Share is, and Save is removed. The location is stated once, in the description. It states “saved locally in this browser” rather than implying server storage. History lists filename, originating tool, size, and local timestamp with individual delete, clear-all, loading, error, and empty states. Deletion copy distinguishes browser-local outputs from files already saved to the device.

### Settings and onboarding

Onboarding is dismissible and limited to four short lines: documents stay on the device, nothing is uploaded and no account is needed, tools work offline after loading, and retained results remain until deletion. Settings groups interface font, immediate download, local history, large-job warnings/threshold, local-data deletion, and converter credits. Each preference states its scope and persistence; destructive controls require confirmation and report completion.

## Accessibility and privacy

- Maintain WCAG AA text/interactive contrast in both themes, measured against every surface a value can sit on — canvas, raised and sunken — not only the lightest one. Text clears 4.5:1; an edge that bounds a control clears 3:1; a divider only has to be visible. A disabled control may miss AA but never drops below `opacity-55`. Do not use amber, blue, or green as the sole meaning channel.
- Every icon-only control has an accessible name; every form control has a visible or programmatic label; status and errors are announced without stealing focus.
- Preserve visible keyboard focus, logical tab order, `Enter`/Space activation for upload, and pointer/keyboard alternatives for editor actions.
- Respect reduced motion. Entrance/lift/tap motion is optional polish, never required to understand state.
- Keep file names and document content out of telemetry and external requests. Privacy language must describe actual processing boundaries, including beta converters and locally retained outputs.

## Packaged shell boundary

The same interface ships in three shells and they are told apart explicitly rather
than guessed. A browser or an installed PWA keeps the offline app shell exactly as it
was. The packaged iOS and Android shells never register it, and any registration or
shell cache an earlier build left behind is released, so the verified packaged bytes
are the only thing that can render. When the platform cannot be read the shell
registers nothing rather than assuming a browser, and the release step, which deletes,
runs only where the shell is positively native and touches nothing but this product's
own shell caches. It always settles, so rendering never waits on it.

The document carries its own content and navigation policy: no remote script, style,
worker or connection, no `unsafe-eval`, and the two inline blocks admitted by exact
content hash. The retired-host redirect stays for browsers on the old host, targets
https only, and is inert wherever a packaged shell runs.

None of this changes a visible surface. Startup diagnostics state only that a step did
not complete: no exception, document, filename, address, path or provider reaches the
console. The durable detail is in `design-system/pages/native-frontend-shell.md`.

## Responsive rules

Design for a narrow phone first: no horizontal page scrolling, 44px-or-larger practical controls, and tool actions reachable after the keyboard opens. A control whose visual box is set by platform rhythm (a 38px search field, a 38px filter segment) reaches 44px on both axes through its label or a hit-area extension, never by growing the pixels. An extension may only grow the axis its neighbours do not occupy: segments in a strip take a width floor on the box and a height-only extension, so no target reaches into the one beside it. A single-line prompt inside an input cannot wrap, so it is sized for the narrowest supported screen at 200% text in the widest selectable interface font; anything that would not survive that is stated in a line beside the control instead. Wide layouts may add columns and inspectors, but must not change task order or hide limitations. At 200% text size, panels, status, and controls wrap rather than truncate essential meaning; density clamps that are correct at default text, such as the two-line row subtitle, are released rather than enforced.
