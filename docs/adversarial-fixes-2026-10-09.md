# Adversarial review fixes — 9 October 2026

**All 24 original findings are fixed and locally verified. Independent challenges have no unresolved findings in the reviewed fixes.** Changes remain in the working tree; no commit, push, website deployment, native package sync, or store release was performed. Existing unrelated work was preserved.

This continues the [original 24-issue review](</Users/dhananjaybhosale/Documents/PDFTools-main/docs/adversarial-review-2026-10-09.md>). Findings were checked again against the current source and saved reproductions before implementation. Independent reviewers challenged the fixes and found three missed paths during implementation: manual Save with history off, repeated-text selection across fonts, and unsupported text disappearing from the new deselected preview. All three have corrective changes and targeted regressions.

## Checked issue list

| ID | Issue resolved | Verification record |
|---|---|---|
| BUG-01 | Removed pages remain recoverable through internal links | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/page-copy/report.md>) |
| BUG-02 | Reordering breaks internal links in PDFs without forms | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/page-copy/report.md>) |
| BUG-03 | Zoomed previews keep dragging after mouse release | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/preview/report.md>) |
| BUG-04 | Case-insensitive Find/Replace edits the wrong characters after Unicode case expansion | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/editor/report.md>) |
| BUG-05 | Completed iOS migration restores deleted files and reverses renames | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/workspace/report.md>) |
| BUG-06 | Changing PDFs leaves old preview workers running | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/preview/report.md>) |
| BUG-07 | Service-worker updates break offline loading in an already-open tab | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/sw/report.md>) |
| BUG-08 | Typing across font runs changes the untouched suffix style | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/editor/report.md>) |
| BUG-09 | Devanagari glyph positions are wrong when saving a rotated page | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/editor/report.md>) |
| BUG-10 | New text boxes wrap in the editor but export beyond the visible page | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/geometry/report.md>) |
| BUG-11 | Inserted images stretch on Save despite a proportional preview | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/geometry/report.md>) |
| BUG-12 | Non-Latin text crashes Watermark and Page Numbers | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/report.md>) |
| BUG-13 | Compression comparison does not show the resolution that is exported | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/preview/report.md>) |
| BUG-14 | Crop percentages can include invisible space outside the page | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/geometry/report.md>) |
| BUG-15 | An older Save completion falsely marks the next result saved | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/workspace/report.md>) |
| BUG-16 | Recent misses background results even after Show in Recent | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/workspace/report.md>) |
| BUG-17 | Discarded exports still run when delayed native authorization succeeds | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/workspace/report.md>) |
| BUG-18 | Word conversion drops paragraph and section page breaks | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/conversions/report.md>) |
| BUG-19 | Rotating a signature can enlarge it beyond the page and clip it | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/conversions/report.md>) |
| BUG-20 | Changing a placed form field to Dropdown creates no usable choices | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/conversions/report.md>) |
| BUG-21 | Protected-PDF search can leave decrypted scratch after process death | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/android/report.md>) |
| BUG-22 | Shared collection files report a generic per-file MIME type | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/android/report.md>) |
| BUG-23 | Canceled incoming PDFs leave hidden files that Settings cannot clear | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/android/report.md>) |
| BUG-24 | Canceled or failed large-PDF splitting consumes iOS free jobs | [Checks and limits](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/ios/report.md>) |

A related defect found during geometry verification was also corrected: added text, images, rectangles and ellipses now rotate in the same direction in preview and export. It shares the geometry regression and independent review above.

## Final integration checks

- **Website TypeScript and production build: passed.** Isolated output: `output/adversarial-fixes-20261009/dist`; service-worker cache identity `23e79406752b`. [Build log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/build-final.log>); [TypeScript log](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/lint-reviewed.log>).
- **Website source unit tests:** 565 executed on the final source; 564 passed in the concurrent run. One existing 50 ms page-range timing assertion took 55 ms while the build/browser checks ran. Its entire five-test file passed when rerun alone (the assertion took 9.8 ms). No parser or timing threshold was changed. [Full results](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/source-unit-reviewed.log>); [Isolated recheck](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/page-range-timing-recheck.log>).
- **Browser checks:** the complete paragraph suite passed 31 checks on final source; 20 font scenarios and two safety/lifecycle controls passed. Focused saved-PDF and UI regressions passed for repeated selections, Devanagari, geometry/mobile viewport, page copying, compression, preview lifecycle, offline updates, output actions, conversions and form choices. [Paragraph results](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/paragraph-browser-final.log>).
- **Fresh offline assets: passed.** 431 precached files, eight OCR assets and 64 fonts verified in the isolated final build. [Offline verification](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/root/offline-final.log>).
- **Catalog check: passed.** 38 tools, 49 routes, 41 sitemap entries. Three corrective messages were added to all 21 runtime catalogs; English regional variants inherit English.
- **Android:** 94 focused Gradle JVM tests and 35 direct host tests passed; main and instrumentation Java compilation passed. Protected-PDF scratch, sharing suffix and failed-import filesystem reproductions passed.
- **iOS:** 15 simulator tests passed, including purchase policy and actual PDF batch processing; universal simulator build passed. A before/after native Swift reproduction confirms canceled attempts retain their free credits.

## Independent challenges

- [Page-copy and workspace fixes](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/challenge-security/review.md>).
- [Editor fixes and repeated-selection follow-up](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/workspace/editor-challenge/review.md>).
- [Geometry and Unicode input recovery](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/challenge-geometry/review.md>).
- [Android storage/search/sharing](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/challenge-android/review.md>).
- [iOS quota reservations](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/challenge-ios/review.md>).

## Verification limits

- The initial unfiltered unit command also invoked an existing generated-artifact gate against the old shared `dist` and Android package. It failed because `dist` predates current source. That artifact test file was excluded from source-unit verification; the new isolated build was separately checked with the real offline verifier. Native packaged web assets were deliberately not synchronized in this source-fixing task. Fresh native packaging remains required before an app release.
- No physical Android/iOS device, Android instrumentation runtime, external receiving-app share, signed release, StoreKit sandbox transaction, TestFlight/App Store/Play rollout or deployed URL was tested. Native shared-web changes take effect after the next package sync/build.
- Watermark/Page Numbers and added text boxes still use their existing standard font choices. Unsupported characters now remain editable and get a recoverable refusal; this fix does not promise new Unicode font support in those tools. Added text uses native textarea layout while editing; the deselected preview and export share exact PDF metrics.
- Compression preview fidelity is corrected while preserving existing export resolution and memory use; nominal DPI calibration is unchanged.
- Android protected search prevents new disk scratch. It does not claim to remove files left by an older installed version. Very large searches can exceed the bounded memory allowance and report search unavailable.
- Existing build chunk-size warnings, PDF.js test font-path warnings and documented Swift sendability warnings remain. These did not fail the listed builds/tests.

Machine-readable resolution list: [checked-issues.json](</Users/dhananjaybhosale/Documents/PDFTools-main/output/adversarial-fixes-20261009/checked-issues.json>).
