# PDFChef: audit of all 37 shared tools

Date: 12 September 2026. Scope: the shared React/Vite website source in this checkout.

All 37 catalog entries were traced through their controls, processing functions, error handling and output delivery. All 37 routes also opened in Chromium without a runtime error. The audit found and corrected problems in cleanup, page copying, Compare and Crop. This is evidence for the checked behavior and fixtures, not a guarantee for every possible PDF.

## What changed and why

| Before | After | Evidence |
| --- | --- | --- |
| Remove hidden info and Remove comments disconnected objects but left their private contents recoverable in the saved PDF. | Unreferenced PDF objects are removed before saving these outputs. | Synthetic XMP/comment markers are absent from saved bytes or decoded PDF objects. |
| Cleanup replaced dates with 1970 dates and overlooked metadata attached to individual pages. | Dates are removed. Standard XMP attached to pages and image/form objects is also removed. | Saved dates are undefined; document and page author markers are absent. |
| Clean Up removed form widgets while keeping their answers in the document. | It removes comments and preserves visible, editable form controls and their answers. | Reopened outputs contain the expected widget and field value. |
| Merge, Split, Extract, Delete, Reorder and Remove Blank Pages copied form appearances without the field catalog. | A shared page-copy function preserves retained field definitions, widget page links, geometry and font resources. Duplicate names from merged documents receive distinct suffixes. Removed-page fields and unused objects are excluded. | Reopened PDFs, split ZIPs and form tests cover text, checkbox, radio, dropdown, shared widgets, field name collisions and different fonts using the same resource name. |
| Compare summary extraction destroyed the cached document used by the on-screen preview. | Comparison owns a separate temporary document. | A second page can still be read from the active PDF after comparison. |
| Crop imposed a 36-point minimum, so repeated cropping stopped matching the chosen percentages. | Margins are applied to the current visible box, including small boxes. | Two 40% crops of a 320 × 480 page leave the expected 12.8 × 19.2 visible area. |
| Crop treated edge names as unrotated PDF coordinates. Trimming the top of a rotated page could trim a side instead. | Edge names follow the page as the reader sees it. | Top-only cropping is checked at 0°, 90°, 180° and 270°, with a nonzero crop origin. |

The existing Edit PDF fixes were preserved. No private PDF or recording was added to the repository. New regression fixtures are generated in memory.

## Coverage for each tool

Every row includes source inspection and a route-render check. The final column identifies additional evidence; a service check is not being described as a complete manual UI test.

| Tool | Main source | Additional verification |
| --- | --- | --- |
| View PDF | `ViewPDF.tsx` | Owned document loading/teardown, password and search paths inspected; PDF.js opens and reads generated outputs. |
| Create PDF | `MakePDF.tsx` | Two-image PDF has two pages; image conversion rejects partial output and respects EXIF orientation. Native camera capture not exercised. |
| Compress PDF | `CompressPDF.tsx` | Real size reduction; selectable text, page count and form values retained; trial/keep/discard paths inspected. |
| Merge PDF | `MergePDF.tsx` | Page order, count, fields, duplicate field names, independent values and font resources; cancellation refusal. |
| Split PDF | `SplitPDF.tsx` | Single PDF, multi-part ZIP, retained fields, actual maximum size and cancellation refusal. |
| Edit PDF | `EditPDF.tsx` | Graphics, undo/redo and Save browser checks; prior same-day paragraph/mobile/font/export verification remains applicable to the unchanged editor implementation. |
| Make Fillable | `MakeFillable.tsx` | Existing fields retained; real new fields saved; all five field types covered by geometry exports. |
| Sign PDF | `SignPDF.tsx` | Saved placement/orientation across rotations and crop offsets. This adds a visible signature, not a certificate-based signature. |
| Watermark PDF | `WatermarkPDF.tsx` | Preview geometry and saved placement/orientation across rotations and crop offsets. |
| Protect PDF | `SecurityPDF.tsx` | Real encryption and exact password round trip, including boundary spaces. |
| Unlock PDF | `UnlockPDF.tsx` | Encrypted PDF opens after decryption with the exact password. |
| Delete Pages | `DeletePages.tsx` | Correct retained pages/fields; removed fields absent; deleting all pages refused. |
| Page Numbers | `PageNumbersPDF.tsx` | Preview and saved geometry across rotations/crop offsets; range/format unit coverage. |
| Reorder Pages | `ReorderPDF.tsx` | Exact requested page order, retained fields and valid widget links; duplicate order refused. |
| Flatten PDF | `FlattenPDF.tsx` | Field definitions removed and visible answers retained as page content. |
| Extract Pages | `ExtractPages.tsx` | Correct pages/fields; empty and out-of-range selections refused. |
| Image to PDF | `ImageToPDF.tsx` | Real layout output, page count, image integrity and EXIF handling. |
| PDF to Image | `PDFToImage.tsx` | JPEG output type and dimensions; embedded image mode shares the tested extractor. |
| PDF to Word | `PDFToWord.tsx` | Valid DOCX ZIP containing text from every synthetic page; text-only scope inspected. |
| Word to PDF | `WordToPDF.tsx` | Real DOCX conversion, accented text and two-page output. |
| PowerPoint to PDF | `PowerPointToPDF.tsx` | Three-slide landscape output retaining the 16:9 page shape. |
| Extract Text | `OCRPDF.tsx` | Readable text-layer extraction and local English OCR of an image-only synthetic PDF. |
| Document Info | `MetadataPDF.tsx` | Clear then edit, explicit blank values, unrelated values retained. |
| Repair PDF | `RepairPDF.tsx` | Readable re-saved output retaining content/fields; invalid bytes and encrypted input refused. |
| Compare Summary | `ComparePDF.tsx` | Desktop/mobile scan comparison avoids claiming a text match; comparison leaves the active PDF readable. |
| Crop | `PdfAdvancedTools.tsx` | Exact margins, repeated small crops, visible edge names at all quarter turns, content and fields retained. |
| Header & Footer | `PdfAdvancedTools.tsx` | Saved geometry across all quarter-turn rotations and crop offsets. |
| Extract Images | `PdfAdvancedTools.tsx` | Embedded image recovered at its original pixel dimensions. |
| Remove hidden info | `PdfAdvancedTools.tsx` | Saved document/page XMP and dates removed; fields preserved. |
| Remove comments | `PdfAdvancedTools.tsx` | Removed comment data absent; widget and answer preserved. |
| Clean Up | `PdfAdvancedTools.tsx` | Metadata and comments removed; editable controls stay visible. |
| Remove blank pages | `PdfAdvancedTools.tsx` | Correct blank page removed; remaining text, fields and widget links retained. Near-empty detection remains heuristic. |
| Batch Processing | `BatchPDF.tsx` | All 13 dispatch branches inspected; two-file rotate ZIP and filenames checked through UI. Shared processors tested separately; not every option combination was clicked. |
| Invoice | `BusinessDocumentBuilder.tsx` | Real PDF with correct title, reference and tax total; validation, rounding and pagination unit cases. |
| Receipt | `BusinessDocumentBuilder.tsx` | Same output checks with receipt-specific wording. |
| Quote | `BusinessDocumentBuilder.tsx` | Same output checks with quote-specific wording. |

Tool component paths above are under `components/Tools/`. Processing implementations are under `services/`, with invoice/receipt/quote generation in `services/documents/businessDocument.ts`.

## Checks and receipts

Local logs are in `output/all-tools-audit-20260912/` (ignored diagnostic output).

- `npm run test:catalog`: passed; 37 tools, 48 routes, 26 Android mappings and 41 sitemap entries.
- Final `npm run test:unit`: 486 tests, 485 passed. The single failure is Android packaged-asset verification: the existing Android bundle is missing the new web build's assets. The web artifact check passes; this is not a shared service failure.
- `tests/services/pdfPageCopy.test.ts`: seven new form-copy regression cases passed.
- `PDF_CHEF_URL=http://127.0.0.1:3011 npm run test:browser:tools`: passed, including the new output/route/OCR suite and existing image integrity checks.
- `npm run test:browser:parity`: passed for Office conversion, forms, editor graphics/history, passwords, batch output and Recent. Despite its script name, this run used Chromium, not an Android device.
- `npm run test:browser:geometry`: passed, with 40 actual PDF exports across page rotations and crop offsets.
- `npm run lint`: passed.
- One `npm run build`: passed; generated web cache `4fc504f12c7d` with 400 precached files.
- `node scripts/verify-offline-assets.mjs`: passed; 400 precached files, 8 OCR assets and 64 fonts.
- One production-browser control: imported two form PDFs, merged them through the built UI, saved the result and reopened it. Both pages and independent field values were preserved.

Negative evidence was captured before the fixes: hidden metadata retention, lost form definitions, destroyed comparison document and incorrect small-crop geometry all failed their corresponding new probes or assertions.

## Claude review and follow-up

The requested Claude Code review completed using **`claude-opus-5` at `xhigh`**, verified in the returned model usage. It reviewed the new shared changes read-only and reported no blocking issue. Source hashes were identical before and after its review.

Its four comments led to these checked improvements:

1. Resolve indirect widget types and field names, so unusual but valid PDFs retain their fields. Cleanup uses the same resolved widget check.
2. Preserve unnamed groups when their descendant names do not collide; give real collisions separate names so merged answers remain independent.
3. Resolve default font and colour-space aliases within their respective resource categories, preserving the correct font when resource names overlap.
4. Confirmed and fixed the rotated-page crop issue described above.

Three additional form regressions and four crop-rotation cases cover these follow-ups. They pass, along with the final type check, browser suite and build. The review receipt is `output/all-tools-audit-20260912/claude-review.json`; the follow-up changes were verified locally after that review rather than described as a second Claude review.

## Changed files in this audit

- `services/pdfDocument.ts`: cleanup, page-copy integration and crop correction. Pre-existing editor/export changes in this file were retained.
- `services/pdfPageCopy.ts`: shared form-aware page copying.
- `services/pdfBrowser.ts`: separate document ownership for comparison extraction.
- `tests/services/pdfPageCopy.test.ts`: form-copy regression tests.
- `scripts/verify-pdf-tool-correctness.mjs`: saved-object cleanup and Compare regressions.
- `scripts/verify-pdf-tool-outputs.mjs`: generated-PDF output, invalid-input, route and OCR checks.
- `package.json`: runs the new output checks with the existing browser tools suite.
- This report.

## Limits

No Android/iOS native files, packaged web assets, signing or store configuration were changed. The code audit did not run native sync or deploy the website. Android's existing packaged bundle is older than the shared website source; this audit does not certify that bundle as current. Native file delivery, physical-device camera/keyboard behavior and store releases were not tested here.

Existing product limits remain visible: OCR is English and can make recognition mistakes; Office conversions have limited layout fidelity; Repair can only re-save readable PDFs; blank-page detection is heuristic; unsupported XFA forms are refused by the corrected page-copy path instead of being silently damaged. Form scripts that refer to renamed fields across merged documents are not comprehensively verified.

## Production deployment after the audit — 12 September 2026

Following explicit deployment authorization, the tested website build was published to Cloudflare Pages project `pdftools`, production branch `main`. It is live at [PDFChef](https://pdfchef.dhananjaytech.app/), deployment `1b7977a6-3580-4a29-9aca-6cd57315d041`.

The deployment reused the verified build with cache `4fc504f12c7d`. All 404 built files remained unchanged. The deployment URL and public domain passed checks for the home, Edit and Merge routes, route-specific Functions middleware, and exact SHA-256 matches for the entry JS/CSS, editor/PDF bundles and service worker. A fresh browser imported two generated form PDFs on the live website, merged and downloaded them, and reopened the result with both pages and independent form answers intact. No browser page errors occurred.

Deployment and verification receipts are in `output/cloudflare-deploy-20260912/`. No native sync or app packaging was performed.
