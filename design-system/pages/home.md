# Page Override

## Screen

- Name: Tools (the first tab, route `/`)
- User goal: reach the right tool out of 34 in one or two actions, while being
  clear that normal PDF processing happens on this device without an upload

## Deviations from master

- No hero. On phones, the screen opens with the exact Android logo next to a
  24/30 product name, 14px below the status inset. The compact brand row has no
  duplicate Settings action; Settings remains one of the three primary
  destinations in the tab bar. At desktop sizes the side rail already carries the
  logo, so the page title stays compact and grows to the 30px step.
- The mark is Android's 50px at the reader's default text size and shrinks as
  that text grows, `clamp(32px, 50px / --text-scale, 50px)`. It is fixed artwork
  beside a name that scales: held at 50px it took roughly a third of a 320px line
  away from the product's own name at 200% text, and broke "PDF Chef" across two
  lines on a 393px screen.
- Privacy is a line, not a container: a 1.375rem success-tinted chip carrying a
  0.875rem shield, then "Processed on this device." and "Nothing is uploaded." on
  one 13px line that wraps from the glyph rather than truncating. It does not
  make the absolute "never leaves" claim shown in the Android reference. It had
  been a bordered, shadowed 46px card, which put three lozenges of nearly the
  same height, radius, border and fill in a row — card, field, strip — with no
  hierarchy between them; as a line it belongs to the title above it and lets the
  search field be the one control in the header. The chip and its glyph are sized
  in rem, unlike the tool bubbles, because nothing keys off this chip's edge and
  a fixed 22px square reads as a dot beside 32px text. Its row is aligned to the
  start, so at 200% text the glyph stays beside the first line instead of
  centring against four wrapped ones. There is no trailing padlock: it was a
  second glyph making the same claim, and it was what floated in mid-air once the
  sentence wrapped.
- Search outranks the filter, because a typed query is a stronger signal than a
  tapped category. Its visual is the Android field: 38px tall, 22px radius, 16x8
  padding, a 20px glyph, 16/22 Bold text. The label around it is the 44px target,
  and it gives the extra 6px back to the layout, so the target is Apple's and the
  rhythm is Android's. It rides with the page on phones and sticks only at `md`
  and above, where the list runs far enough past the fold for a pinned field to
  earn its place. The field and its prompt are Medium, not Bold: at Bold an empty
  field read as a heading rather than as something to type into, which is the one
  job a prompt has.
- Page padding sits outside the measure, exactly as the tab header sets it up, so
  the title, the assurance line, the field, the filter strip and the list all
  share one left edge. Nested the other way round the content below the title
  lost 32px at desktop widths and sat visibly inset from the title itself. The
  sticky element at `md` is the full-width one, so its backing colour reaches the
  window edge rather than stopping at the measure.
- The prompt is one word, "Search", not the Android field's "Smart search
  tools...". An input's prompt is a single unwrappable line: at 200% text on a
  320px screen the field has roughly 190px for it, and the interface family is a
  Settings choice, so anything longer clips in at least one supported font. The
  accessible name stays exactly "Search 34 tools", and the glyph beside the
  prompt is what identifies the field whether or not anything is typed.
- The result count is shown as well as announced. The `role="status"` line stays
  mounted for announcements and reveals itself once there is a query, because a
  prompt disappears the moment someone types and this line does not. It names the
  query it is reporting on and wraps rather than clipping at any text size.
- All five counted category controls sit in one quiet 46px segmented shell with
  38px segments, a 20px shell radius and a 16px segment radius, weighted 4:4:8:7:6
  the way the Android strip is. They wrap onto another line rather than scrolling,
  so every category is reachable at 320px and at 200% text without the page ever
  scrolling sideways. Every segment is a genuine 44x44 target: a 44px width floor
  on the box itself, and a hit extension that grows only the height, so a short
  label such as "All" reaches the floor without reaching into its neighbour.
  Selection is exposed with `aria-pressed`, and the count is repeated in the
  accessible name.
- Selection is a raised chip on the sunken track — raised surface, hairline ring,
  the raised elevation, accent label — rather than the flat accent-filled segment
  it had been, which read as a status block rather than as a choice. Android gets
  the strip's structure from a hairline between every pair of segments, which a
  wrapping strip cannot keep in place; the chip supplies that structure and
  survives the wrap. Counts stay in each segment's accessible name rather than
  competing with the five labels in the narrow visible row.
- The catalog is one flat, uninterrupted list, not a card grid. Rows use the
  Android homepage's exact subtitle for every Android-shared tool, with the
  existing concise description retained for Read PDF and web-only tools.
  Category filters narrow the same ordered list without regrouping it.
- The default order follows Android popularity order, with Create PDF first and
  the existing `/view` route projected as **Read PDF** in second place. The
  complete order is: Create PDF, Read PDF, Compress PDF, Merge PDF, Split PDF,
  Edit PDF, Make Fillable, Sign PDF, Watermark PDF, Protect PDF, Unlock PDF,
  Delete Pages, Page Numbers, Reorder Pages, Rotate Pages, Flatten PDF, Extract
  Pages, Image to PDF, PDF to Image, PDF to Word, Word to PDF, PowerPoint to PDF,
  Extract Text, Metadata, Repair PDF, Compare Summary, Crop, Header & Footer,
  Extract images, Remove metadata, Remove annotations, Sanitize, Remove blank
  pages, Batch Processing. Web-only tools stay after all Android-shared tools.
- Icon bubbles take their wash from the mark inside them, using the palette seed
  the Android artwork was drawn from (`ToolVisuals.kt`), composited at 13% over
  the surface behind it so one value serves both themes without `color-mix`,
  which not every WebKit version this app supports has. Reader and the web-only
  tools have no generated mark, so they take the product's own logo red — the
  same seed Android gives five of its own tools — rather than an invented hue or
  a grey that would read as a lesser tier of the catalog.
- Category tinting was tried here and replaced. Four tints said nothing the
  counted filter directly above the list did not already say, and each one
  disagreed with the artwork inside it — a green bubble under a red-and-grey
  compressor. In dark theme it was worse: the Edit tint resolved to `--ink-900`,
  so fourteen of the thirty-four rows carried a saturated maroon block and the
  catalog read as a list of errors. Category is a filter, not a paint job.
- The list is one 16px-radius panel with a 1px border and rows divided by a
  hairline that begins after the icon region, so the marks read as a single
  column.
- Phone tool rows are the Android row: 72px minimum height, 14x10 padding, a
  48px bubble carrying 32px of artwork at a 12px radius, a 14px text gap, a
  14/20 SemiBold title, a 12/16 Medium subtitle of at most two lines, and a 22px
  chevron at 70% opacity — Android's own 0.72 alpha, and what stops thirty-four
  of them from reading as a column that competes with the titles. The height is a
  minimum and grows with wrapping and text scale; the bubble, its radius and the
  paddings stay in px so the icon column, and therefore the divider, holds its
  position while the type scales. At large readable-text sizes the two-line clamp
  is released rather than enforced.
- Desktop rows retain the denser list rhythm: 56px, a 40px bubble with 28px
  artwork, a 15px title and a 64px divider inset. Past 1200px the same rows in
  the same order lay into two columns separated by one hairline, because a single
  column at that width is mostly empty space between the subtitle and the
  chevron. Visual order and DOM order stay identical.
- Press feedback is the row's own surface changing on pointer-down, not a scale;
  state transitions run at 220ms on `cubic-bezier(0.22, 1, 0.36, 1)` and the
  transform is dropped under `prefers-reduced-motion` while the colour stays.

## Constraints

- All 34 tools stay reachable and every route is unchanged.
- Search ranking stays on `services/toolSearch.ts` so a phrase typed here returns
  the same tools in the same order as the same phrase in the Android app.
- The homepage order is a projection only: `/view` keeps its catalog identity,
  route, keywords, and search scoring. Search ties continue to use catalog order.
- Beta and Not available status must remain visible on the row itself. Beta is the
  small `BetaBadge`, the same one beside a beta tool's title.
- The empty result must offer a reset and suggest what to type instead.
- Must stay scannable on a 320px viewport and at 200% text.
- The fixed phone tab bar uses the shared 60px size token, 24px icons, and 13px
  labels. Its safe-area and content inset remain token-linked.

## Identity update

The layout is unchanged. The screen takes the new tokens (warm paper, one tomato
accent) and the serif title (`--font-display`). The category filter keeps its raised
chip with a ring on a sunken track.
