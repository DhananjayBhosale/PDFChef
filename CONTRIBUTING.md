# Contributing to PDF Chef

Thanks for helping improve PDF Chef. Keep contributions focused, privacy-preserving, and easy to review.

## Development setup

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint
npm run test:catalog
npm run build
npm run test:unit
node scripts/check-localization.mjs
```

`npm run test:unit` includes `tests/offline`, which reads `dist/`: build first.

## Contribution principles

- Keep PDF processing in the browser unless there is a clear, documented reason not to.
- Do not add server uploads for user documents.
- Avoid large dependencies when a small browser-side implementation is enough.
- Match the existing UI patterns before introducing new controls.
- Keep copy short and direct. A tool screen has no line under its title.
- Add route metadata and sitemap coverage for new public tools.

## Adding a new tool

1. Add the tool UI under `components/Tools`. Return one `ToolScreen` (see below).
2. Put PDF logic in `services` when it can be reused.
3. Add the route in `App.tsx`.
4. Add the catalog entry in `components/Tools/toolCatalog.ts`, including its `availability`
   and, if the Android app has the same tool, its `androidTool`.
5. Add metadata in `components/SEO/RouteSEO.tsx`.
6. Add the route to `public/sitemap.xml`.
7. Add the strings (see "Strings and translation").
8. Run `npm run test:catalog`, then the checks in "Checking a tool".

### Building the screen with the tool kit

The kit is `components/Tool/`. A tool builds its controls as local constants and returns one
`ToolScreen`; there is no shell, header or panel component to wrap it in.

- **No file yet:** `<ToolScreen title kind="file" body={<FileUpload … label={t(…)} />} />` and
  nothing else. The label names the task. Do not add a description under the title.
- **Pick the kind:** `grid` (page thumbnails, with `PageGrid`), `list` (files), `file` (one
  document; `FilePreview` shows its first page), `preview` (a live preview of the result),
  `form` (labelled fields), or `editor` (a canvas with its own toolbar). The Office converters
  share `ConverterScreen`.
- **Header:** pass `title` (it becomes the `h1`), `beta` for a beta tool, `file={{ name, meta }}`,
  and `change={<ChangeFile label onClick />}` for the "change the file" control. Tools and the
  conditional Back are added for you.
- **Say what the action does** in `sentence`, once a file is loaded:
  - a **sentence with slots** when the tool has settings: `<Sentence template="sentence.<tool>.<case>"
    values slots groupLabel />`. The template is one whole translated message with named
    placeholders; each slot is a `SlotDef` with a `label`, the visible `text` and an `editor`
    that holds the tool's existing control (keep its accessible name and handler). Page values
    come from `pagesPhrase(keys, selection, total)` in `components/Tool/values.ts`, with the
    tool's own six literal keys, so "page 4", "pages 2–5", "pages 1 and 3", "the 5 selected
    pages" and "all 12 pages" stay exact.
  - a **statement** (a `Sentence` with no slots) when the tool has no settings: its existing
    consequence line, moved into the sentence position.
  - Give "nothing chosen yet" and "invalid value" their own natural sentences, and make a missing
    number a question ("how many pages?").
- **Under the sentence:** `chips` for secondary actions (`ChipActions`), one `notice` line
  (`<Notice tone="error" | "pending" | "caution" | "outcome">`, an error with `role="alert"`), the
  main `action`, and `progress` for while it runs (`ProgressLine`, with Cancel).
- **Results:** do nothing special. The result strip draws itself into the screen's action area.
- **Never remove a control.** A setting may move behind a slot or into a chip, but
  `npm run test:browser:ui-controls` compares every tool against `inventory/today.json` and
  `--touch` checks the 48 px touch floor.

### Strings and translation

Every new UI string is a key in `services/i18n/en-US.ts`, written as a string literal wherever it is
used (the localization check counts a key as used only when it finds the literal). English comes
first for new strings:

1. Add the key and its English text to `services/i18n/en-US.ts`.
2. Add the key to `services/i18n/pending.ts`.
3. Run `node scripts/sync-locale-fallbacks.mjs`. It writes the English text into the 21 other locale
   files and drafts, with the plural forms each locale needs, so nothing is missing at runtime.
4. Run `node scripts/check-localization.mjs` and `node scripts/check-localization.mjs --drafts`.

Reuse a key that already exists whenever you can (labels, button names, errors, a one-action tool's
statement): those are already translated. When a language is translated, put the translation in its
locale file and draft, take the key off `pending.ts`, and run the sync script with `--check`.

### Checking a tool

Most scripts need `npm run build` and `npm run preview -- --port 4173 --strictPort --host 127.0.0.1`,
run with `PDF_CHEF_URL=http://127.0.0.1:4173`. A script that loads TypeScript source (for example
`tests/browser/workspaceResultLifecycle.mjs`, and the ones that import `/services/*.ts`) needs
`npm run dev` on port 4195 instead. A setting that is a slot is reached by opening the slot first
(`openSlot` in `scripts/lib/tool-ui.mjs`). `AGENTS.md` lists every script.

## Pull request checklist

- [ ] The change preserves the no-upload privacy model.
- [ ] TypeScript passes.
- [ ] Production build passes.
- [ ] New public routes have SEO and sitemap entries.
- [ ] UI changes work on mobile and desktop, and no control was removed (`test:browser:ui-controls`).
- [ ] New strings are in `en-US.ts` and `pending.ts`, and the sync script has run.
- [ ] The README or docs are updated if behavior changes.
