# PDF Chef Design Contract

## Experience direction

The identity is warm paper, ink, and one tomato accent, with a serif for titles and the tool sentence. Use a calm, premium, low-glare workspace: purposeful rounded surfaces, clear hierarchy, and restrained motion. Density is a phone-first decision, not a leftover: on a phone the surface carries the Android app's rhythm, because that rhythm is what a returning user recognises and what puts real content above the fold. The interface should feel trustworthy for sensitive documents, not like a generic upload funnel. Keep copy short, concrete, and visible at the point of decision.

## Surface contracts

### Dashboard

The product name and mark, then the privacy line, then one search field, then counted category filters, then the whole catalog as **one full-width divided list**. Not a card grid: 34 same-shaped cards is the generic answer, and a divided list is denser, faster to scan, and the shape the Android app already earned.

The phone rhythm is the Android list's, to the pixel: 16px page sides; a 50px mark beside a 24/30 title; a nominal 46px privacy strip; a 38px search visual inside a 44px practical target; a 46px category shell holding 38px segments; 72px-minimum rows with 14x10 padding, a 48px icon bubble carrying 32px of generated artwork, a 14px text gap, a 14/20 SemiBold title over a 12/16 Medium subtitle of at most two lines, and a 22px chevron. Dividers begin after the icon region so the marks read as one column. Rows are minimums and grow; the icon column is fixed so the divider never drifts.

The five category filters wrap onto another line rather than scrolling out of reach, so every one of them is reachable at 320px and at 200% text without the page ever moving sideways. Each row states beta and availability on itself; beta is the small `BetaBadge`, the same badge that sits beside a beta tool's title. Empty search results provide a clear reset action. No duplicate tool navigation, no oversized decorative hero space.

Tablet and desktop adapt deliberately rather than inheriting the phone list: the side rail carries navigation and the mark, search and filters stick to the top of a long page, rows go denser (56px, 40px bubble), and past 1200px the same rows in the same order lay into two columns instead of stretching a single one across empty width.

### Upload and tool shell

Use a shared drop zone that is also keyboard activatable, labels the accepted type, and supports picker and drag/drop. The label names the task ("Choose a PDF to split"). After selection show filename, size, format constraints, and any fidelity or memory warning before the primary action. Keep one dominant action, a nearby recovery action, and a visible status region.

### Active tool surfaces

Every tool route is one `ToolScreen`, drawn full-viewport: no tab bar and no side rail. A phone's header has no Recent or Settings link; at 768px and wider the header carries both.

- **Header (`ToolTop`)**: 48px plus the top safe area on a phone, 52px on desktop. A Back arrow only when the screen behind is known and is not Tools home (and the page was not opened from Settings); on desktop the brand link; the tool's mark and its name as the page `h1` in the display serif, with the small BETA badge on beta tools; on desktop the file name and its size; the tool's "change the file" control, named "Choose another file" in every one-file tool (words on desktop, an icon and "Change" with the words as its name on a phone); at 768px and wider the **Recent** and **Settings** links (icons only when the row is tight); and **Tools** at the end (the start edge in right-to-left). A page opened from Settings shows "‹ Settings" there instead, and no second Settings link.
- **Phone, grid / list / file / form tools**: the header, the file line, the body (scrolls), then a foot sheet holding the result strip, the sentence, chips, one notice line and the main action. The sheet takes at most 40% of the screen, so the page or pages fill the rest; when a result arrives, the settings are the sentence alone. A setting appears once: as a value in the sentence whose card holds its control, never also as a control under it. **Live-preview tools** (Watermark, Page Numbers, PDF to Image, Crop, Compare) put the sentence in a slim band under the preview, joined to the foot bar that holds the actions, so the settings are in reach of the thumb; an open card ends above that band; while a card is open the preview keeps at least 40% of the screen; a card whose controls need more room may grow until the preview keeps 30% (Page Numbers' Position card until it keeps 20%, so its places and sliders show whole on a 360×800 phone), and beyond that its body scrolls under its fixed title and close control.
- **Desktop (768px and up and 480px tall, tablets included; a phone on its side keeps the phone layout)**: the header, then a canvas that fills the viewport down to one full-width band pinned at the foot, with the sentence, chips and notice, the secondary and main action at its end and the result strip above them. The canvas scrolls above the band and is never under it; a value's card opens above its slot. No right panel, except in the live-preview tools with settings (Watermark, Page Numbers, PDF to Image, Header & Footer): their controls stay on screen in one narrow column at the canvas's end edge, beside the preview and above the main action, and a slot in their sentence moves focus to its control there instead of opening a card. Page grids scale so every page is as large as the canvas allows; file tools show the first page of the file; form tools use two columns.
- **Editors** (Edit PDF, Sign, Make Fillable, Image to PDF) keep their own toolbar and main action under the shared header; the result strip is drawn in a slot above their toolbar.

Every gap inside a live workflow is 8, 10, 12 or 16px by role; 24 and 32 mark a real change of section, never the distance between a control and what it controls. Option surfaces hug their content, and a two- or three-way choice is a compact strip rather than a column of large padded cards. Visual boxes sit at 38–44px and reach the 48px touch floor through the hit-area extension, so density never comes out of the target.

Order inside an open tool is fixed: source, the sentence with its settings, primary action, live status and result, then preview or queue. The primary action sits at the end of the sentence block, at the foot of the screen on every size (foot sheet or foot bar on a phone, the band on desktop); in the document it comes before the list it produces, so Tab and a screen reader reach it first. A tool's "add more files" control sits with the sentence (Merge's Add PDFs is a chip under it), not at the top of the list. No tool adds a bottom spacer of its own: the foot sheet already clears the safe area, the keyboard and the result strip.

On Android, the system Back action dismisses the top sheet or open editor first, then moves through React route history, returns a direct tool launch to Home, and exits only from Home. Preview controls stay outside document overlays so they never cover the content being positioned.

A control that has nothing to do is removed from its row rather than reserving an empty one.
Short peer actions such as Add pages and Blank page share a compact two-column row on a phone.
An empty tool landing is today's drop zone, centred under the header. Once a document is loaded, the workspace fills the space the header leaves.
Numeric slider values are compact editable fields, not passive labels: users can drag for speed or tap the value and enter an exact quality, scale, size, opacity, rotation, or position.

One accent per screen carries the primary action; the secondary beside it is an outlined control, not a second fill. The status hues never stand in for that hierarchy — a green primary or an amber primary reads as an outcome — and a running job fills its progress track with the accent. Anything drawn on a rendered page uses fixed ink steps, because the page stays white in both themes while a neutral token does not.

### Tool copy

A tool screen has no line under its title. The catalog description stays on the Tools home row only. Before a file is chosen the screen is the title and the picker label. Once a file is loaded, what the tool will do is said once, above the main action, as a **sentence** (settings are slots) or a **statement** (a one-action tool's existing consequence line, moved into that position). Under the sentence goes one notice line, the first that applies: an error, a value typed but not applied, a caution, the outcome. Honesty limits `PRODUCT.md` requires (Office converters, passwords) stay as the caution line.

A hint under a label becomes the field's placeholder; when the field has one already, the hint becomes its visually hidden `aria-describedby` text. The same explanation never appears both above and beside the control; when a limit belongs to a decision it lives at the decision. Instructions for a gesture the interface already offers by another visible means are deleted rather than shortened. Live status, error text, accessible names, and review warnings are never treated as excess copy.

### Sentences

A sentence is the tool's settings written as one translated message with named placeholders, so word order belongs to the translator and nothing is joined from fragments. A value that opens an editor is a **slot**: a button, tinted, named "{setting}, {visible value}". The editor holds today's control with today's accessible name and handler (a popover anchored to the slot on desktop, a card at the foot on a phone), stays mounted while closed so a typed draft survives, and returns focus when it closes. Every card closes the same way: its one close button, Escape, or a tap outside it, which also reaches what it landed on. The exceptions are the colour input, drawn inline, Rotate's two action words, which act at once, and on a phone a setting with exactly two choices (PowerPoint's orientation, OCR's mode), whose words switch to the other choice on a tap; underneath they stay today's two radios.

- **Page phrases are exact.** One page: "page 4". A run: "pages 2–5". Two or three scattered pages: "pages 1 and 3", "pages 1, 3 and 5". More: "the 5 selected pages". All: "all 12 pages"; a one-page file: "the only page". "N of M pages" appears nowhere. Delete Pages says "marked" where others say "selected".
- A missing number is a question ("how many pages?", "how many MB?"). An invalid typed value shows the typed text, in the error style. A range field with Mark or Select keeps its rejected text in the field, with the error; the sentence keeps the last accepted value, and the main action is disabled until the range is fixed or cleared.
- Values are formatted with the locale's number, list and unit formatters and sit in `<bdi>`; ranges and lists are forced left to right.
- At most two lines on a phone. When a third would be needed (a long language, large text, a narrow phone), or the sentence holds four or more values (a control drawn inline, such as Watermark's colour swatch or Rotate's two words, is not counted), it becomes labelled rows with the same buttons, editors and names (Pages / Format / Quality / Resolution; two to a line in a live-preview band). A statement that needs more than two lines drops to body size.
- States: no file (no sentence), ready, nothing chosen yet (its own sentence, never a value such as "no pages yet" dropped into the normal frame), value typed but not applied (that slot in the pending style, main action disabled), invalid (error style, `role="alert"`, action disabled), running (plain text, slots `aria-disabled`, the action replaced by progress and Cancel), done (the result strip appears in the action area).
- The live region speaks the sentence 600 ms after a change.
- No control is removed by a sentence: a setting moves behind a slot or into the chips, and `scripts/verify-ui-controls.mjs` checks every tool against today's inventory.

### Forms editor

The editor is a three-part workspace on wide screens: field controls, page canvas, and current-page field list; stack these in a usable order on narrow screens. Make “Detect fields” visually secondary to “Create fillable PDF”. Suggested fields must be visibly distinguishable from source content, individually removable/renamable, page-addressable, and accompanied by “review every field” copy. Ensure page navigation, field labels, and actions remain usable at high text size.

### Edit PDF controls

Keep page selection, undo, redo, Text, Image, Shape, and Save in a stable toolbar. When an element is selected, expose its properties in a labelled inspector: content, colour, font, size, fill/stroke, rotation, page, and delete. Selection and resize affordances need a clear focus/selected state and at least a phone-usable target; never rely on colour alone. Zoom is persistent and reachable without covering the page.

### Reader

Read PDF is the document. On a phone one top bar carries the logo link, file and page, Search, Verify signatures, Share, Download and the Tools menu; zoom is a floating pill at the bottom centre that hides after 24px of downward scroll and returns after 12px upward, and is always reachable (within 8px of the top or bottom, while a zoom control has focus, for 2s after a zoom change, while Search is open). On desktop one 52px header carries zoom and it never hides.

### Crop

Crop shows one page of the file with a live frame inset by each edge's margin; outside it the page is dimmed with fixed ink. Each edge has a handle (`role="slider"`, 0–40, arrow keys change it by 1, Shift by 5, Home and End go to 0 and 40) and each corner moves its two edges. Drag and the sentence stay in step: dragging updates the sentence at once, and changing a number in an editor moves the frame. The margins are percentages of the page and apply to every page. Left and Right are sides of the page and do not mirror in right-to-left. If the page cannot be drawn, the sentence and the fields still work.

### Batch

The sentence names the operation and its option, with the ordered file list under it (a centred column on desktop). The primary button states the file count. Show per-file progress, preserve order, identify failures, and describe the ZIP result. Removing a queued file is reversible until processing starts; controls lock while running.

A Split into two or more parts says how they are saved as its notice line, a one-slot sentence with the exact count: "Saves 12 separate PDFs." (the default) or "Saves one ZIP with 12 PDFs." It is a two-choice setting (a tap switches it on a phone; two radios under the main action, in the band's end column, on desktop), remembered per device; a split by size says "Saves the parts as separate PDFs" or "one ZIP" above its caution. The ZIP is the result either way; with separate PDFs the automatic save writes the parts instead of it (the folder is asked for at the tap on desktop Chrome and Edge; iPhone and iPad browsers offer "Save N files separately" first in the result sheet). Once the parts are saved, the result sheet leads with where they went, and the ZIP is a plain "Download as one ZIP" button. Where parts cannot be saved one by one (the iOS app) the line stays "12 PDFs download together in one ZIP."

### Output card and history

The result is an `aria-live` strip drawn in the tool's action area (the foot sheet or foot bar on a phone, above the sentence and the main action in the band on desktop); on root screens it floats as before. It carries the file name, size and where it is kept, **More actions** and **Dismiss**. The result sheet opens by itself only when the person must act: it stays closed when the file is saved and placed (downloaded and kept in Recent on the website, exported to Download/PDF Chef in the Android app), and opens with automatic saving off, after a failed or cancelled save, for a preview only and for a Split saved as separate PDFs. More actions opens the result sheet: one primary action (Download until the file is saved to the device, then Share), then Open PDF, Rename, "Use in another tool" and "Keep in Recent" or "Show in Recent". A Split result that makes more than one file also offers **Save N files separately** as an outlined button on the strip and in the sheet (one folder pick on desktop Chrome and Edge, one share sheet on iPhone and iPad browsers, one download per file elsewhere, Android browsers included, one file after another in the Android app). Untouched, a Split saves one ZIP when it would make more than 10 downloads or share items, and separate PDFs otherwise; a choice the person made wins; it is hidden in the iOS app until a native one-picker export exists. The location is stated once, in the sheet's line. It states "saved locally in this browser" rather than implying server storage. History lists filename, originating tool, size, and local timestamp with individual delete, clear-all, loading, error, and empty states. Deletion copy distinguishes browser-local outputs from files already saved to the device.

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
