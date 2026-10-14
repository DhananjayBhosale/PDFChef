# Adversarial bug review — 9 October 2026

**Original review: 24 confirmed issues (2 P1 and 22 P2). All 24 were subsequently fixed and locally rechecked; see the [fix report](/Users/dhananjaybhosale/Documents/PDFTools-main/docs/adversarial-fixes-2026-10-09.md).** Nine review agents covered the project in separate areas; a second reviewer challenged each accepted issue. The main reviewer also independently reproduced the deleted-page/internal-link, pan, Unicode matching, preview-worker and service-worker failures. Several candidates were rejected or narrowed after counterchecks.

Target: the current checkout at `39cd8bf50b3d2c4cb19d278ffb45c29ba87bdcb2`, including its existing uncommitted website and native changes. This report does not assert that every native finding is present in a shipped store build. No application code was changed during the original review. Later source fixes are recorded in the linked fix report; no commit or deployment was performed.

P1: prioritize because of privacy or destructive data-handling consequences. P2: reproducible correctness, reliability or compatibility problem. “Confirmed” describes the evidence below; it does not imply a fix.

## Checked issue list

| ID | Priority | Confirmed issue | Area |
|---|---|---|---|
| BUG-01 | P1 | [Removed pages remain recoverable through internal links](#bug-01) | Web PDF operations |
| BUG-05 | P1 | [Completed iOS migration restores deleted files and reverses renames](#bug-05) | iOS upgrades with legacy browser outputs |
| BUG-02 | P2 | [Reordering breaks internal links in PDFs without forms](#bug-02) | Web PDF operations |
| BUG-03 | P2 | [Zoomed previews keep dragging after mouse release](#bug-03) | Web shared preview and PDF to Image |
| BUG-04 | P2 | [Case-insensitive Find/Replace edits the wrong characters after Unicode case expansion](#bug-04) | Web Edit PDF |
| BUG-06 | P2 | [Changing PDFs leaves old preview workers running](#bug-06) | Web Split, Delete Pages, Rotate and Reorder |
| BUG-07 | P2 | [Service-worker updates break offline loading in an already-open tab](#bug-07) | Web offline operation |
| BUG-08 | P2 | [Typing across font runs changes the untouched suffix style](#bug-08) | Web Edit PDF |
| BUG-09 | P2 | [Devanagari glyph positions are wrong when saving a rotated page](#bug-09) | Web Edit PDF |
| BUG-10 | P2 | [New text boxes wrap in the editor but export beyond the visible page](#bug-10) | Web Edit PDF |
| BUG-11 | P2 | [Inserted images stretch on Save despite a proportional preview](#bug-11) | Web Edit PDF |
| BUG-12 | P2 | [Non-Latin text crashes Watermark and Page Numbers](#bug-12) | Web Watermark and Page Numbers |
| BUG-13 | P2 | [Compression comparison does not show the resolution that is exported](#bug-13) | Web Compress PDF, raster mode |
| BUG-14 | P2 | [Crop percentages can include invisible space outside the page](#bug-14) | Web Crop |
| BUG-15 | P2 | [An older Save completion falsely marks the next result saved](#bug-15) | Web/native output menu |
| BUG-16 | P2 | [Recent misses background results even after Show in Recent](#bug-16) | Web Recent and Batch |
| BUG-17 | P2 | [Discarded exports still run when delayed native authorization succeeds](#bug-17) | Native export permission through shared UI |
| BUG-18 | P2 | [Word conversion drops paragraph and section page breaks](#bug-18) | Web Word to PDF |
| BUG-19 | P2 | [Rotating a signature can enlarge it beyond the page and clip it](#bug-19) | Web Sign PDF |
| BUG-20 | P2 | [Changing a placed form field to Dropdown creates no usable choices](#bug-20) | Web Make Fillable |
| BUG-21 | P2 | [Protected-PDF search can leave decrypted scratch after process death](#bug-21) | Android native reader |
| BUG-22 | P2 | [Shared collection files report a generic per-file MIME type](#bug-22) | Android legacy collection sharing |
| BUG-23 | P2 | [Canceled incoming PDFs leave hidden files that Settings cannot clear](#bug-23) | Android native document ingress |
| BUG-24 | P2 | [Canceled or failed large-PDF splitting consumes iOS free jobs](#bug-24) | iOS native Create Smaller Parts |

## Reproduction and validation details

<a id="bug-01"></a>
### BUG-01 — P1 — Removed pages remain recoverable through internal links

**Source:** [pdfPageCopy.ts:28](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfPageCopy.ts:28>), [pdfDocument.ts:447](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:447>)

**Trigger:** A two-page PDF has a link on page 1 targeting page 2. Delete page 2, or extract only page 1.

**Observed:** The saved PDF has one visible page but also retains the excluded page object and its complete content stream. The existing object-pruning pass keeps it because the retained link references it. Sharing the result can disclose the removed page.

**Double-check:** The first reviewer executed the current service. The main reviewer independently generated a different fixture, tested linked and unlinked controls, saved/reopened the results, and recovered the private marker only from the linked one-page outputs.

**Evidence:** [verified-core.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verified-core.json>) · [verify-core.mjs](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verify-core.mjs>) · [findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/operations/findings.md>)

**Fix direction:** Map retained page references and remove destinations/actions pointing to excluded pages before pruning.

**Scope/limits:** Delete and Extract were executed. Split shares the helper, but was not separately reproduced for this finding.

<a id="bug-02"></a>
### BUG-02 — P2 — Reordering breaks internal links in PDFs without forms

**Source:** [pdfPageCopy.ts:28](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfPageCopy.ts:28>), [pdfDocument.ts:467](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:467>)

**Trigger:** Reorder both pages of the same linked PDF, retaining the source and destination pages.

**Observed:** The link targets a duplicate page object outside the saved page tree. Independent output had two visible pages and one hidden page; navigation cannot resolve the target as a visible page.

**Double-check:** Saved-output object inspection by the first reviewer and a separate main-reviewer fixture with an unlinked control.

**Evidence:** [verified-core.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verified-core.json>) · [linked-reorder.pdf](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/linked-reorder.pdf>) · [findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/operations/findings.md>)

**Fix direction:** Use a consistent source-page-reference to output-page-reference map even when the PDF has no AcroForm.

**Scope/limits:** Related to BUG-01 and suitable for one coordinated fix, but this case breaks links even when no page is excluded.

<a id="bug-03"></a>
### BUG-03 — P2 — Zoomed previews keep dragging after mouse release

**Source:** [PDFPreviewModal.tsx:201](</Users/dhananjaybhosale/Documents/PDFTools-main/components/UI/PDFPreviewModal.tsx:201>), [PDFToImage.tsx:251](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/PDFToImage.tsx:251>)

**Trigger:** Open a preview, zoom to 125%, drag the page, release the mouse, then move the pointer with no button held.

**Observed:** The deferred pointerup handler dereferences a cleared React currentTarget and throws before removing global listeners. The page keeps following ordinary pointer movement.

**Double-check:** Separate reviewers reproduced both components. The main reviewer reproduced the modal exception and a transform changing from (25,25) to (70,50) after release.

**Evidence:** [verified-core.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verified-core.json>) · [pan-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/pan-result.json>) · [repro-results.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/conversions/repro-results.json>)

**Fix direction:** Retain the DOM element/pointer ID and make release, pointercancel and unmount cleanup unconditional.

<a id="bug-04"></a>
### BUG-04 — P2 — Case-insensitive Find/Replace edits the wrong characters after Unicode case expansion

**Source:** [pdfBlockEditPlanning.ts:334](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfBlockEditPlanning.ts:334>)

**Trigger:** With Match case off, replace test with X in the text İstanbul test.

**Observed:** The result is İstanbul tX. Lowercasing İ expands its length, so offsets from the folded text no longer point to the same characters in the original text.

**Double-check:** Main reviewer ran the production helper and traced Replace/Replace All callers. An independent reviewer used another sentence and a correct case-sensitive control.

**Evidence:** [verified-core.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verified-core.json>) · [casefold.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/casefold.json>)

**Fix direction:** Maintain original-string offset mapping during case-insensitive matching.

**Scope/limits:** Production-helper execution and UI caller tracing; this exact case was not exported through a full browser workflow.

<a id="bug-05"></a>
### BUG-05 — P1 — Completed iOS migration restores deleted files and reverses renames

**Source:** [legacyWorkspaceMigration.ts:194](</Users/dhananjaybhosale/Documents/PDFTools-main/services/platform/capacitor/legacyWorkspaceMigration.ts:194>), [iosDocumentServices.ts:368](</Users/dhananjaybhosale/Documents/PDFTools-main/services/platform/capacitor/iosDocumentServices.ts:368>)

**Trigger:** Migrate existing legacy IndexedDB output files, then rename or delete a migrated result, Clear All, or Delete Every File, and restart the app.

**Observed:** Migration reruns because the native document or Recent metadata differs from the original legacy record. Deleted bytes are retained again and renamed files regain their old names, even though the migration journal says complete.

**Double-check:** Two independent adapter reproductions. The stronger check used the actual production journal and recent repositories, exercised all four supported actions, and verified restart reversed them. Active iOS initialization was traced.

**Evidence:** [migration-repro.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/migration-repro.log>) · [verification.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/ios/migration-challenge/verification.md>) · [repro.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/ios/migration-challenge/repro.log>)

**Fix direction:** Distinguish interrupted migration repair from completed migration followed by a deliberate user change; preserve deletion/rename intent and stop replaying completed source records.

**Scope/limits:** Applies to iOS installations with legacy v1 blobs. Fresh native-only documents are unaffected. No simulator or device execution claimed.

<a id="bug-06"></a>
### BUG-06 — P2 — Changing PDFs leaves old preview workers running

**Source:** [pdfBrowser.ts:269](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfBrowser.ts:269>), [pdfBrowser.ts:141](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfBrowser.ts:141>), [SplitPDF.tsx:107](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/SplitPDF.tsx:107>)

**Trigger:** In Split, upload a PDF, wait for previews, click Change, and choose it again. Repeat.

**Observed:** Five upload/reset cycles left five live PDF.js workers and zero terminations, including after forced garbage collection. The helper uses a shared cached document but these callers only abort rendering and revoke image URLs; they never release the document/worker.

**Double-check:** Independent reviewer and main reviewer browser runs, worker creation/termination instrumentation, live-worker inspection, and caller cleanup tracing.

**Evidence:** [worker-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/worker-result.json>) · [worker-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/worker-result.json>) · [verify-workers.mjs](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verify-workers.mjs>)

**Fix direction:** Give preview jobs a disposable document or an explicit shared ownership/release contract.

**Scope/limits:** Progressive resource retention is proven. No actual device out-of-memory crash was induced. Split was executed; the other callers were source-checked.

<a id="bug-07"></a>
### BUG-07 — P2 — Service-worker updates break offline loading in an already-open tab

**Source:** [sw.js:13](</Users/dhananjaybhosale/Documents/PDFTools-main/public/sw.js:13>), [sw.js:19](</Users/dhananjaybhosale/Documents/PDFTools-main/public/sw.js:19>)

**Trigger:** Keep an old app tab open while a new service worker installs and activates; go offline, then open a tool whose old lazy chunk has not been imported.

**Observed:** Immediate activation claims the old tab and deletes its old cache. The tab still references old chunk names, so the tool fails to load although the new worker has fully cached the new version.

**Double-check:** Two Chromium runs used the exact current service-worker source with two build versions. Both confirmed old app v1 remained open, its cache disappeared, old import failed offline and new import succeeded.

**Evidence:** [sw-upgrade-evidence.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/security/sw-upgrade-evidence.json>) · [sw-upgrade-evidence.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/sw-upgrade-evidence.json>) · [verify-sw.mjs](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/parent/verify-sw.mjs>)

**Fix direction:** Coordinate activation with open clients or retain required old caches until those clients reload/close.

**Scope/limits:** Local service-worker lifecycle reproduction. No claim that every online upgrade fails; the confirmed trigger is offline use after activation.

<a id="bug-08"></a>
### BUG-08 — P2 — Typing across font runs changes the untouched suffix style

**Source:** [pdfBlockEditPlanning.ts:170](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfBlockEditPlanning.ts:170>), [PdfTextBlockLayer.tsx:402](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/PdfTextBlockLayer.tsx:402>)

**Trigger:** A line contains regular First followed by bold BOLDTAIL. Select First BOLD and type New, leaving TAIL unselected.

**Observed:** The planner puts the rebuilt string into the first regular run and empties the bold run. Editable-DOM reconstruction preserves that loss, and Save exports wholly regular NewTAIL.

**Double-check:** Actual editor typing/Save/PDF font inspection, independently repeated with Alpha BETAending -> Qending. A Find/Replace control narrowed the affected path.

**Evidence:** [crossfont-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/crossfont-result.json>) · [crossfont.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/crossfont.json>) · [findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/findings.md>)

**Fix direction:** Preserve the untouched prefix/suffix run styles when distributing replacement text across source spans.

**Scope/limits:** Selected typing loses the style in export. The independent Find/Replace case had a wrong preview but its fallback export preserved the suffix; do not generalize export loss to every replacement path.

<a id="bug-09"></a>
### BUG-09 — P2 — Devanagari glyph positions are wrong when saving a rotated page

**Source:** [pdfDevanagari.ts:235](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDevanagari.ts:235>), [pdfDocument.ts:1313](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:1313>)

**Trigger:** Open a PDF with /Rotate 90 and source text upright in the viewer. Replace that text with नमस्ते भारत and Save.

**Observed:** The preview is horizontal, but the saved visible glyphs descend vertically and overlap. Glyph matrices rotate while advance/mark offsets remain in unrotated PDF axes.

**Double-check:** Actual browser Save, text extraction and rendered PDF; independent writer/geometry reproduction with another word and unrotated control. The main reviewer inspected source and the rendered failure.

**Evidence:** [rotated-browser-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/rotated-browser-result.json>) · [rotated-browser-export-1.png](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/rotated-browser-export-1.png>) · [geometry.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/geometry.json>)

**Fix direction:** Rotate glyph advances and offsets with the same transformation used for each glyph.

**Scope/limits:** Logical text extraction can remain correct despite visible corruption. The source block appears upright, so the existing rotated-paragraph rejection does not prevent this case.

<a id="bug-10"></a>
### BUG-10 — P2 — New text boxes wrap in the editor but export beyond the visible page

**Source:** [pdfDocument.ts:1502](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:1502>), [pdfDocument.ts:1525](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:1525>), [EditPDF.tsx:958](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/EditPDF.tsx:958>)

**Trigger:** Add a new text box and type a long sentence without explicit newline characters.

**Observed:** The editor soft-wraps the sentence, while export only splits explicit newlines and draws an unlimited-width line. The saved suffix falls outside the page and is not visible; Save succeeds.

**Double-check:** Browser Save and rendered output, plus an independent narrower-box fixture and content-stream inspection.

**Evidence:** [textbox-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/textbox-result.json>) · [textbox-export-1.png](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/textbox-export-1.png>) · [geometry.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/geometry.json>) · [text-content.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/text-content.json>)

**Fix direction:** Use the same width-based line layout in preview and export, and validate vertical overflow.

**Scope/limits:** The full sentence remains encoded in the PDF. This is visible clipping/off-page content, not deletion of the text bytes.

<a id="bug-11"></a>
### BUG-11 — P2 — Inserted images stretch on Save despite a proportional preview

**Source:** [pdfDocument.ts:1475](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:1475>), [EditPDF.tsx:979](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/EditPDF.tsx:979>)

**Trigger:** Insert a rectangular image and save it in the default element box without manual resizing.

**Observed:** The preview uses object-fit contain, but export stretches the bitmap to the full box width and height. A 2:1 image became approximately 1.08:1; an independent portrait image was exported square.

**Double-check:** Actual browser insertion/Save, saved PDF drawing matrices, rendered output, and a separate portrait fixture.

**Evidence:** [image-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/image-result.json>) · [image-export-1.png](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/image-export-1.png>) · [geometry.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/preview/editor-challenge/geometry.json>)

**Fix direction:** Apply the preview’s aspect-fit geometry to the saved image, including its contained origin.

<a id="bug-12"></a>
### BUG-12 — P2 — Non-Latin text crashes Watermark and Page Numbers

**Source:** [WatermarkPDF.tsx:152](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/WatermarkPDF.tsx:152>), [PageNumbersPDF.tsx:192](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/PageNumbersPDF.tsx:192>)

**Trigger:** Upload a PDF, wait for preview, then enter Devanagari/CJK watermark text or an emoji/non-Latin page-number format.

**Observed:** Standard-font text measurement throws during React rendering. The tool is replaced by the router’s Unexpected Application Error screen and the user loses access to the current workflow.

**Double-check:** One reviewer reproduced Devanagari in both UIs; a second independently reproduced Chinese watermark text and an emoji page-number format. Export try/catch cannot catch this render-time exception.

**Evidence:** [unicode-ui.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/operations/unicode-ui.json>) · [results.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/operations-challenge/results.json>)

**Fix direction:** Use supported Unicode fonts or show recoverable inline validation before measuring unsupported glyphs.

**Scope/limits:** This finding is the whole-tool crash, not a blanket promise that every writing system must be supported by these tools.

<a id="bug-13"></a>
### BUG-13 — P2 — Compression comparison does not show the resolution that is exported

**Source:** [pdfBrowser.ts:973](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfBrowser.ts:973>), [pdfBrowser.ts:1141](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfBrowser.ts:1141>)

**Trigger:** Disable Keep text selectable and compare a page in the compression preview.

**Observed:** The comparison renders at config.scale, but export uses config.scale × 1.5. A 600×800-point page was previewed at 600×800 pixels and exported at 900×1200; the preview is visibly less detailed than the download.

**Double-check:** Two current-source browser/API reproductions compared decoded preview image dimensions with saved PDF image dimensions using different page sizes and slider values.

**Evidence:** [reproduce.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/operations/reproduce.json>) · [results.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/operations-challenge/results.json>) · [verdict.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/operations-challenge/verdict.md>)

**Fix direction:** Share one rendering/encoding configuration between comparison and export; calculate effective DPI from that actual configuration.

**Scope/limits:** Related calibration: nominal DPI and actual output also differ (lowest tested output 54 DPI despite a 72-DPI safety check). This is not a separate claim that the UI promises 300 DPI or that High has no effect; High still changes JPEG quality.

<a id="bug-14"></a>
### BUG-14 — P2 — Crop percentages can include invisible space outside the page

**Source:** [pdfDocument.ts:816](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:816>)

**Trigger:** Crop a PDF whose CropBox extends outside its MediaBox, using 10% for each visible edge.

**Observed:** Margins are computed from the oversized CropBox instead of the visible intersection. One 600×800 page remained visibly unchanged; a second fixture became 544×696 instead of the requested visible 480×640.

**Double-check:** Two independent fixtures, actual crop service outputs and PDF.js visible-page bounds. Normal contained CropBoxes were identified as working controls.

**Evidence:** [crop.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/operations/crop.json>) · [results.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/editor/operations-challenge/results.json>)

**Fix direction:** Calculate margins from the visible CropBox/MediaBox intersection and retain the existing rotation mapping.

<a id="bug-15"></a>
### BUG-15 — P2 — An older Save completion falsely marks the next result saved

**Source:** [OutputCenter.tsx:149](</Users/dhananjaybhosale/Documents/PDFTools-main/components/UI/OutputCenter.tsx:149>)

**Trigger:** With automatic history off, start Save for result A, close the sheet while persistence waits, then generate result B before A finishes.

**Observed:** Save(A) calls setRetained(true) without checking which result is current. B is shown as kept, Save(B) is disabled and Show in Recent is offered, although storage contains only A.

**Double-check:** Initial real-adapter delay reproduction and independent ordinary Flatten A -> Save -> Escape -> Flatten B UI workflow, with IndexedDB inspection.

**Evidence:** [output-repro.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/output-repro.log>) · [ui-races-evidence.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/security/workspace-challenge/ui-races-evidence.json>)

**Fix direction:** Apply save-completion UI state only if the current output identity still matches the saved result.

**Scope/limits:** Persistence latency was deliberately injected. No false claim that B itself was actually saved; that mismatch is the defect.

<a id="bug-16"></a>
### BUG-16 — P2 — Recent misses background results even after Show in Recent

**Source:** [useWorkspaceRuntime.tsx:352](</Users/dhananjaybhosale/Documents/PDFTools-main/hooks/useWorkspaceRuntime.tsx:352>), [OutputCenter.tsx:282](</Users/dhananjaybhosale/Documents/PDFTools-main/components/UI/OutputCenter.tsx:282>)

**Trigger:** Start Batch processing, navigate to Recent before completion, then click Show in Recent on the completed output.

**Observed:** Recent only refreshes on mount/platform change. Same-route navigation leaves its stale empty list mounted even though the result is persisted; reload reveals the file.

**Double-check:** An initial component reproduction was strengthened with actual Batch clicks and a delayed worker request. The result appeared only after reload.

**Evidence:** [recent-refresh-repro.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/recent-refresh-repro.log>) · [ui-races-evidence.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/security/workspace-challenge/ui-races-evidence.json>)

**Fix direction:** Refresh the Recent repository view on completed outputs and when the Show in Recent action targets an already-open list.

**Scope/limits:** Batch is the checked producer. PDF to Word invalidates its job on unmount and is not a valid trigger for this finding.

<a id="bug-17"></a>
### BUG-17 — P2 — Discarded exports still run when delayed native authorization succeeds

**Source:** [monetization.tsx:203](</Users/dhananjaybhosale/Documents/PDFTools-main/services/monetization/monetization.tsx:203>)

**Trigger:** Save a locked result while native authorization waits, close its sheet and Dismiss the result, then let authorization return allowed.

**Observed:** Cancellation removes the request, but the successful authorization branch executes the captured operation unconditionally. The discarded result is still persisted.

**Double-check:** Provider-level proof and independent actual Flatten/OutputCenter Save -> Escape -> Dismiss flow using the documented injected native authority.

**Evidence:** [export-cancel-repro.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/export-cancel-repro.log>) · [export-ui-cancel-evidence.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/security/workspace-challenge/export-ui-cancel-evidence.json>)

**Fix direction:** Check that the request is still active immediately before executing the authorized operation.

**Scope/limits:** Browser component/native-bridge boundary reproduction. This is not physical iOS evidence; the ordinary non-native browser branch has no native permission wait.

<a id="bug-18"></a>
### BUG-18 — P2 — Word conversion drops paragraph and section page breaks

**Source:** [officeDocument.ts:148](</Users/dhananjaybhosale/Documents/PDFTools-main/services/officeDocument.ts:148>)

**Trigger:** Convert DOCX with pageBreakBefore on a paragraph, or a nextPage section break.

**Observed:** Two-page input becomes one PDF page. Inline w:br page breaks work, but paragraph/section properties are never converted into output page boundaries despite the UI saying page breaks are kept.

**Double-check:** Independent tests used complete DOCX packages, an inline-break control producing two pages and no-break control producing one; both omitted-break cases incorrectly produced one.

**Evidence:** [repro-results.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/conversions/repro-results.json>) · [docx-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/conversions-challenge/docx-result.json>) · [challenge.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/conversions-challenge/challenge.md>)

**Fix direction:** Translate supported paragraph and section break properties into the same block/page-break representation used by inline page breaks.

**Scope/limits:** Disclosed loss of Word styling, images and table grids is not included as a bug.

<a id="bug-19"></a>
### BUG-19 — P2 — Rotating a signature can enlarge it beyond the page and clip it

**Source:** [SignPDF.tsx:769](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/SignPDF.tsx:769>), [pdfDocument.ts:1568](</Users/dhananjaybhosale/Documents/PDFTools-main/services/pdfDocument.ts:1568>)

**Trigger:** Add a wide typed signature to an A4 page, rotate it 90 degrees and export without manually resizing it.

**Observed:** Rotation changes the bitmap/aspect ratio while keeping width and position. Tested stamp height grew from about 39 to 714 points/pixels at the default view; it extended below the page and the saved signature was visibly cut off.

**Double-check:** Actual UI export, saved image matrix with y=-251.2965 points, rendered output, and independent verification that rotate bypasses drag/resize boundary guards.

**Evidence:** [sign-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/conversions/sign-result.json>) · [sign-export-render.png](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/conversions/sign-export-render.png>) · [artifact-check.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/conversions-challenge/artifact-check.json>)

**Fix direction:** Preserve the intended physical size when rotating and reapply page-boundary constraints before preview/export.

**Scope/limits:** This concerns visible signature stamps, not cryptographic signature validity.

<a id="bug-20"></a>
### BUG-20 — P2 — Changing a placed form field to Dropdown creates no usable choices

**Source:** [MakeFillable.tsx:357](</Users/dhananjaybhosale/Documents/PDFTools-main/components/Tools/MakeFillable.tsx:357>), [fillableForms.ts:203](</Users/dhananjaybhosale/Documents/PDFTools-main/services/fillableForms.ts:203>)

**Trigger:** Draw or accept a Text field, then change that already placed field’s review-panel Type to Dropdown.

**Observed:** Only kind changes. No options editor is available for that field; the Options input affects new fields only. Export succeeds with a non-editable dropdown containing just Choose….

**Double-check:** Browser workflow, saved AcroForm inspection, and independent reopening that confirmed the placeholder is the sole option and custom typing is disabled.

**Evidence:** [form-result.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/conversions/form-result.json>) · [artifact-check.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/conversions-challenge/artifact-check.json>) · [challenge.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/workspace/conversions-challenge/challenge.md>)

**Fix direction:** Expose and validate choices for already placed dropdown fields before marking them ready for export.

**Scope/limits:** This is a newly placed/suggested field in the editor, not modification of an existing embedded source AcroForm field.

<a id="bug-21"></a>
### BUG-21 — P2 — Protected-PDF search can leave decrypted scratch after process death

**Source:** [PdfReaderSearchEngine.java:62](</Users/dhananjaybhosale/Documents/PDFTools-main/android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/reader/PdfReaderSearchEngine.java:62>)

**Trigger:** Unlock a protected PDF, search a document large enough to exceed the 8 MiB PDFBox memory limit, then the process dies before the document closes.

**Observed:** Mixed-memory parsing spills decrypted streams into app-private PDFBox temporary files. The original file is encrypted, but a retained scratch file contains its plaintext; no matching startup cleanup was found.

**Double-check:** Exact pinned Android PDFBox host reproduction with an encrypted 12 MiB fixture and simulated abrupt process death, plus independent residual-byte inspection and active Search/cleanup/provider tracing.

**Evidence:** [scratch-proof.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/android/proof/scratch-proof.log>) · [scratch-independent-inspection.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/scratch-independent-inspection.json>) · [checked-findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/checked-findings.md>)

**Fix direction:** Use memory-only parsing for protected-document search or a protected, bounded scratch lifecycle with recovery cleanup.

**Scope/limits:** The residual is app-private. No upload, public access, unprivileged other-app access or physical-device process-kill proof is claimed; normal close deletes scratch, and OS cache clearing may remove it.

<a id="bug-22"></a>
### BUG-22 — P2 — Shared collection files report a generic per-file MIME type

**Source:** [AndroidDocumentSharer.java:610](</Users/dhananjaybhosale/Documents/PDFTools-main/android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/AndroidDocumentSharer.java:610>)

**Trigger:** Share PDF or image children from a migrated legacy collection to a recipient that queries each content URI’s MIME type.

**Observed:** Staged children use physical .bin filenames. AndroidX FileProvider.getType derives MIME from that suffix and returns application/octet-stream despite PDF/JPEG content.

**Double-check:** Current Java staging reproduction and independent inspection of the exact AndroidX 1.17.0 provider implementation and active collection share path.

**Evidence:** [collection-and-single.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/android/proof/collection-and-single.log>) · [FileProvider-getType-source.txt](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/android/proof/FileProvider-getType-source.txt>) · [checked-findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/checked-findings.md>)

**Fix direction:** Use typed staging suffixes or provide accurate per-URI MIME resolution.

**Scope/limits:** Intent/ClipData MIME and display names are correct. Some recipients work; rejection/misclassification depends on recipients querying the URI. No named recipient was device-tested.

<a id="bug-23"></a>
### BUG-23 — P2 — Canceled incoming PDFs leave hidden files that Settings cannot clear

**Source:** [OwnedPendingImportStore.java:115](</Users/dhananjaybhosale/Documents/PDFTools-main/android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/OwnedPendingImportStore.java:115>), [OwnedPendingImportStore.java:138](</Users/dhananjaybhosale/Documents/PDFTools-main/android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/documents/OwnedPendingImportStore.java:138>)

**Trigger:** A single incoming PDF is interrupted after its payload is published but before its pending record/batch becomes complete.

**Observed:** The payload and incomplete batch survive, but no deliverable batch or visible pending record exists. Startup and both Settings cleanup methods leave them behind, so users cannot remove them through the app.

**Double-check:** Current Java classes were compiled into isolated host fixtures. An independent proof canceled at the publish boundary, advanced the clock by one year, restarted, and invoked both actual cleanup methods; the orphan remained.

**Evidence:** [collection-and-single.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/android/proof/collection-and-single.log>) · [pending-clear.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/pending-clear.log>) · [checked-findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/checked-findings.md>)

**Fix direction:** Rollback published artifacts on failed staging and recover or expire incomplete batches, including orphan payloads.

**Scope/limits:** This is app-private storage retention. Android Clear app storage/uninstall removes it; no absolute permanence, external exposure or physical-device lifecycle proof is claimed.

<a id="bug-24"></a>
### BUG-24 — P2 — Canceled or failed large-PDF splitting consumes iOS free jobs

**Source:** [PdfChefDocumentsPlugin.swift:344](</Users/dhananjaybhosale/Documents/PDFTools-main/ios/App/App/PdfChefDocumentsPlugin.swift:344>), [PdfChefDocumentsPlugin.swift:396](</Users/dhananjaybhosale/Documents/PDFTools-main/ios/App/App/PdfChefDocumentsPlugin.swift:396>)

**Trigger:** For a large PDF, start Create Smaller Parts and then cancel, or let preparation fail before producing an output. Repeat with distinct documents.

**Observed:** The quota is charged before the batcher checks cancellation, space and input validity. Five failed/canceled distinct documents can exhaust the five-job allowance while producing zero retained outputs.

**Double-check:** Host Swift execution of the real quota/batcher/store and independent idempotency/entitlement/call-path analysis. Five canceled jobs produced zero outputs and exhausted the allowance.

**Evidence:** [quota-cancel.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/ios/quota-cancel.log>) · [quota-idempotency.log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/quota-idempotency.log>) · [checked-findings.md](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/validation-native/checked-findings.md>)

**Fix direction:** Reserve access first, then charge after successful retained output, or roll back the reservation on failure/cancellation.

**Scope/limits:** Paid users bypass quota, and retrying the same document is idempotent. The initial confirmation Cancel does not charge. No iPhone device test is claimed.

## Coverage and verification limits

- Reviewed PDF editing/fonts/shaping, page operations/compression, conversions/OCR/forms/signing, preview/input lifecycles, local workspace/result actions, monetization, service-worker/security boundaries, and native Android/iOS document/reader paths.
- Browser proofs used the current local source with synthetic PDFs/DOCX/images. Saved PDFs were reopened and inspected; geometry/signature/Devanagari failures include rendered-page inspection. No user documents were sent to a processing service.
- Native evidence uses active-path source tracing, actual pinned libraries, host Java/Swift execution, and injected native adapters. Android/iOS device, simulator, signing, store and deployed-build behavior were not tested in this review.
- TypeScript and the catalog verifier passed. Catalog verification covered 38 tool entries, 49 routes and 41 sitemap entries; that is not an end-to-end test of every tool. The security reviewer also ran 31 focused existing checks. Broad build/test matrices were not repeated because the task was defect discovery and targeted reproduction.
- A reproduction assertion passing means the reported defect was observed. Logs from corrected test-harness attempts are preserved separately and are not counted as product bugs.
- The source preservation receipt and review inventory are [integrity.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/integrity.json>) and [checked-issues.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-review-20261009/checked-issues.json>).

## Candidates not counted

- Free-angle rotation/form-loss theory: the damaging branch is not reachable from the current quarter-turn UI.
- Extract Images result replacement race: ordinary Change/reset controls are disabled while processing, so no reachable user reproduction was established.
- Sanitize retaining scripts/attachments/custom properties: reproduced as a limitation, but current visible copy promises narrower metadata/comments cleanup; no broader deletion guarantee was assumed.
- Browser Rename not renaming history: adapter explicitly declares persistentRename false; product intent needs resolution before treating that behavior as a verified defect.
- Android Clear All deleting owned files: current contract intentionally specifies that behavior.
- Compression nominal DPI versus effective DPI: arithmetic discrepancy is documented under BUG-13, not counted again as a claim that High is ineffective or that the UI promises 300 DPI.
- Documented conversion simplifications, protected rotated-paragraph refusals and guarded unsupported-font fallbacks were not treated as bugs.

## Suggested repair order

Address BUG-01 and BUG-05 first. Then repair successful exports that visibly disagree with preview (BUG-08 through BUG-11 and BUG-19), crash/resource failures (BUG-03, BUG-06, BUG-12), and false-save/cancellation behavior (BUG-15, BUG-17). Group related fixes and use the preserved failing fixtures as regression controls. The other confirmed items remain actionable; this ordering does not mark them resolved.
