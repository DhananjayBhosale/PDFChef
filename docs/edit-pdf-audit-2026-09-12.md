# Edit PDF audit — 12 September 2026

The shared React editor was checked with five local PDFs. This round fixes selection alignment and prevents avoidable font substitution when saving fitting edits. Earlier line-preservation and table-line fixes were retained. Original PDF files were not overwritten or added to the repository.

## Before and after

| Problem before | What changed and why | Result after |
| --- | --- | --- |
| Replacing a whole text run could discard its font/style information and move the letters slightly, even without changing the number of characters. | Repair the affected editable markup only when the browser has removed its original run information. Restore the caret and preserve the original font, spacing and styling. Defer repairs during IME composition. | Whole-run replacement keeps its font and position. Ordinary typing retains native selection and caret behavior. |
| A short label's selection border included extra touch padding and could sit unevenly around the text. | Draw the visible border separately from the larger invisible touch target. Give the touch target padding above and below the text. | The border follows the PDF text while the target remains easy to tap. |
| Some fitting edits looked correct but Save substituted a font because PDF.js combined words or letters that the PDF engine stored separately. | Match the original pieces conservatively using their text, location, baseline and font identity. Rewrite the affected word using its original font; leave other words and lines in their own objects. Reject ambiguous matches. | The tested word-per-object and letter-per-object PDFs retain their original embedded fonts and baselines in the saved PDF. |
| Keeping individual changed letters in their old slots could create gaps that a PDF reader interpreted as spaces. | Rewrite the affected word together instead of placing each replacement letter in an old slot of a different width. | The saved wording is exact and remains searchable. |
| Enter could make centred/right-aligned text lose its alignment on Done/Save. | Preserve PDF origins for unchanged rows, and calculate alignment for newly created rows. | Centre/right alignment now agrees between the preview and exported PDF. |
| Direct Save waited for preview image work that it did not use. | Wait for that queue only when a paragraph needs redraw; keep the explicit background-fallback wait. | A direct edit saves even with the preview queue paused. |
| Punctuation below the baseline and extractor-inferred spaces could prevent an ordinary body-text font match. | Match the row by its baseline, include low punctuation, and allow only whitespace gaps in the character map. Missing visible characters still refuse. | The original Notes body-text controls now keep Georgia and Georgia Italic on export. |
| The mobile test sometimes sent an entire swipe before Chromium could start scrolling. | Use Chromium's paced touch gesture, with the same checks for scrolling inside the PDF viewport. | Mobile scroll verification passes without changing application scrolling code. |
| At 200%, the overflow hint beside a right-hand table amount was enlarged with the PDF and cut off by the viewport. | Draw the hint outside the scaled canvas and keep it inside the visible PDF area. Follow the caret through scrolling, zoom and keyboard resize without moving the text or intercepting touches. | The full hint stays readable and does not cover the caret; the original amount geometry is unchanged. |

The previous behavior remains: replacing text does not insert a line break. Longer text continues horizontally; Enter creates the intentional new line. Done and export use the same explicit rows. Table rules are retained when hiding or removing the original text.

## PDFs checked

- **Notes editor.pdf:** mixed fonts and separately stored glyphs. Checked paragraph grouping, selection, caret placement, replacement and original-font export.
- **ASUS Pad T3201M5A India Review Guide.pdf:** embedded Aptos fonts, short headings and longer body paragraphs. Checked selection, complete-run replacement and original-font export.
- **CCLastStatement26-08-2026.pdf:** table columns and Roboto amounts. Checked selection borders, equal-length replacement, extension and Done while retaining table rules.
- **627_684_tips_w8ben_2015_iosPaid.pdf:** a typeset document with different font styles. Checked ordinary editing and the existing missing-glyph fallback notice.
- **Priti_Business_Cards_Back_A4.pdf:** image-only control. It correctly explains that original image text is not editable and keeps Add Text / Extract Text available.

These files were opened locally in Codex's in-app browser. Synthetic fixtures cover the regressions; the private input PDFs are not test fixtures in the repository.

## Measurements

- Before the repair, complete-run replacement moved the guide's heading by about **1.61 CSS px** and the Notes heading by **0.96 CSS px**. Afterward, the measured differences were below **0.01 CSS px**.
- The statement amount retained **one line**, **55.9922 CSS px** editable-target height and the same PDF-relative top (**0.42749524**) through equal-length replacement and horizontal extension. Its Roboto font information remained unchanged.
- Original-file export checks retained **AAAAAA+Helvetica** in Notes and **BCDEEE+Aptos** in the guide. Baselines changed by less than **0.00001 PDF points**, and the saved replacement words matched. The ordinary page-one `home` → `hone` control retained **EAAAAA+Georgia**; the page-two sentence retained **GAAAAA+Georgia-Italic**, with baseline differences below **0.0001 PDF points**.

## Verification

- **127 focused unit and contract tests: passed.** Includes paragraph reconstruction, layout, native text matching, PDF geometry, editing safety and mobile editor contracts.
- **Paragraph browser suite: passed.** Includes explicit rows, equal-length and shorter replacements, horizontal extension, Enter/Undo, complete-run replacement, bold/italic styling, caret position, native Chromium IME composition, embedded-font export, table rules, find/replace, forms and Save.
- **Mobile browser suite: passed at 390 × 844.** Includes pinch zoom, independent PDF scrolling, focus anchoring, keyboard/caret visibility, Done, Undo/Redo, added text/shapes, page navigation and successful/failed Save behavior.
- **TypeScript lint: passed.**
- **Export-safety browser checks: 29 passed**, including fitting edits, rotations, page edges and italic overhangs.
- **Production build: passed**, run once on the reviewed source. Vite completed in 7.12 seconds; only the existing large-chunk advisory remained.
- **Claude review: complete.** Claude Code Opus 5 at Extra High reviewed the changes, then reviewed the fixes in the same session and returned **READY — no concrete remaining blocker**.

The first mobile run timed out on the raw swipe. A diagnostic run reproduced it; the paced gesture then passed the complete suite. The regression tests also failed before the whole-run and fragmented-font fixes and passed afterward.

Verification logs are in `output/edit-audit-20260912/`: `final-unit-tests.log`, `paragraph-browser-final.log`, `mobile-browser.log`, `overflow-browser.log`, `real-fonts-controls.log`, `lint.log`, and `build.log`. The two Claude receipts are `claude-review.json` and `claude-followup.json`.

## Files changed

This audit adds to the related dirty editor work already present; that earlier work was preserved.

- `components/Tools/PdfTextBlockLayer.tsx` — font/style and caret repair; accurate selection outline and touch target; visible overflow guidance at the viewport edge.
- `services/pdfNativeTextPlanning.ts` — conservative matching of fragmented original-font text, including low punctuation and inferred spacing.
- `services/pdfNativeTextEditor.ts` — expose each object's original font identity and upright baseline to that matching.
- `scripts/verify-edit-pdf-paragraphs.mjs` — editing geometry, styling, IME and original-font export regressions; right-edge hint containment and waiting for the current direct-edit plan.
- `scripts/verify-edit-pdf-mobile.mjs` — paced touch-scroll verification; overflow guidance above the keyboard without covering the caret.
- `tests/services/pdfNativeTextPlanning.test.ts` — fragmented-word/glyph matching, punctuation, inferred spacing and unsafe-match refusals.
- `tests/ui/editPdfMobileContract.test.ts` — editable markup, composition, caret and outline contracts.
- `components/Tools/EditPDF.tsx` — direct Save no longer waits for preview renders.
- `services/pdfParagraphLayout.ts` and `services/pdfDocument.ts` — centre/right alignment for intentionally changed row counts.
- `tests/services/pdfParagraphLayout.test.ts` — alignment and original-origin regression.
- This report.

The related earlier dirty changes remain in place. `components/Tools/PdfParagraphInspector.tsx` was left untouched during this audit; some earlier layout/export files were extended to address review findings.

## Claude review and decisions

The substantive review used **claude-opus-5** at **xhigh**, in a read-only Claude Code session. Scoped file hashes were unchanged by the review.

- **Alignment regression:** accepted and fixed. New unit and browser cases verify centre/right alignment after Enter, Done and export.
- **Unnecessary preview wait:** accepted the direct-Save improvement. A browser regression pauses the preview queue and still completes Save. Preview patches remain available for all visible edited paragraphs so table backgrounds remain accurate.
- **Undo coverage gap:** added an assertion that Undo restores the actual original text, in addition to its geometry.
- **Possible browser merging of tagged spans:** not reproduced. No speculative DOM-repair rule was added; the observed wrapper-loss case is covered.
- **Empty fragment objects becoming spaces:** documented below. The existing PDFium empty-text workaround was retained.
- **Temporary offsets during IME composition:** retained the deliberate trade-off of leaving native composition intact and recalibrating when it finishes; the IME/caret regression passes.

A further real-file control found the low-punctuation/inferred-space issue above; it was fixed with regressions. Claude’s follow-up confirmed the alignment fix, Save guard and both font-matching corrections, with no concrete remaining blocker. Source hashes remained unchanged during both read-only reviews. The mobile rerun and production build passed afterward.

## Fresh verification requested afterward

The source initially matched all 12 file hashes from Claude's previous review. Fresh runs passed all **127 unit/contract tests**, the **paragraph and mobile browser suites**, **29 export-safety cases**, **four original-file font/baseline export controls**, and **lint**.

The statement was also reopened in Codex's in-app browser at 200%. Equal-length replacement, horizontal extension and Done retained one visual line, zero newlines, the original font, 55.9921875 CSS px target height and PDF-relative block top 0.42749524246997833. The table rules remained intact.

This visual check found the clipped hint described above. A new synthetic right-column test failed before its fix. Afterward, the hint ended at x=1240 inside the viewport's x=1248 right edge, and the text geometry still matched exactly. Only `PdfTextBlockLayer.tsx` and the paragraph/mobile browser scripts changed in this follow-up, plus this report.

The final **127 tests, lint, full paragraph suite and mobile suite passed again** after that change. The mobile case also checks the hint with a keyboard-sized viewport and verifies it does not cover the caret. One paragraph rerun initially read the earlier debounced redraw plan; its assertion now waits for the fitting replacement's direct-edit answer, retaining the same direct-export checks. The export/font services were unchanged by the hint fix, so their fresh successful checks were retained.

Claude Code **Opus 5 at Extra High** reviewed the small follow-up in the same read-only session and returned **READY**, with no material selection, mobile, export or font issue. Its optional concern about inspector mounting was not reproduced; the hint requires a settled edit preview, after the inspector has mounted. The reviewed file hashes stayed unchanged. A single production build for this follow-up then passed in **3.67 seconds**, with the existing chunk-size advisory.

Fresh evidence is in `output/edit-audit-20260912/`: `reverify-unit-final.log`, `reverify-lint-final.log`, `reverify-paragraphs-complete.log`, `reverify-mobile-final.log`, `reverify-overflow.log`, `reverify-real-fonts.log`, `reverify-statement.json`, `reverify-build.log`, and `reverify-claude.json`. The failing hint regression is preserved in `reverify-hint-before.log`. Diagnostic browser tabs and the local server were closed afterward.

## Limits and delivery

A PDF may embed only some characters, use unsupported encodings or contain only a scanned image. Exact-font editing cannot be guaranteed when the file does not supply a usable font/glyph. The existing substitution/redraw path remains available and explains its limitations; this fix removes unnecessary substitution for the tested fitting edits. Deliberate restyling and edits that require redraw may still use the stated substitute face.

Some PDFs store each letter separately. After a word is rewritten, the engine keeps emptied objects as spaces to avoid its empty-text failure. This can affect whitespace reported by text extraction even though the replacement word and its visible font are correct. During IME composition, precise run positioning may settle when composition finishes.

This is shared React/browser source. No Android Java/Kotlin, Gradle, manifest, signing, native reader, iOS native or packaged web assets were edited. No native sync was run. Browser checks do not constitute fresh physical Android/iOS device verification. This audit's changes have not been deployed.
