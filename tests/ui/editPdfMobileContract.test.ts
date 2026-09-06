import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const app = read('App.tsx');
const editor = read('components/Tools/EditPDF.tsx');
const nativeTextEditor = read('services/pdfNativeTextEditor.ts');
const blockLayer = read('components/Tools/PdfTextBlockLayer.tsx');
const paragraphInspector = read('components/Tools/PdfParagraphInspector.tsx');
const findReplace = read('components/Tools/PdfFindReplace.tsx');

test('Edit PDF runs inside the data router required by the navigation blocker', () => {
  assert.match(app, /createBrowserRouter/);
  assert.match(app, /<RouterProvider router=\{router\}/);
  assert.match(editor, /const navigationBlocker = useBlocker\(hasUnsavedEdits\)/);
});

test('compact browser and iOS viewports share the immersive editor', () => {
  assert.match(editor, /matchMedia\('\(max-width: 767px\)'\)/);
  assert.match(editor, /const isCompactViewportEditor = Boolean\(file\) && compactViewport/);
  assert.match(editor, /const isImmersiveEditor = isNativeAndroidEditor \|\| isCompactViewportEditor/);
  assert.doesNotMatch(editor, /!Capacitor\.isNativePlatform\(\) && compactViewport/);
});

test('dirty edits block routes and unload, while load and save establish clean baselines', () => {
  assert.match(editor, /const hasUnsavedEdits = Boolean\(file\) && currentSnapshot !== savedSnapshot/);
  assert.match(editor, /window\.addEventListener\('beforeunload', handleBeforeUnload\)/);
  assert.match(editor, /setSavedSnapshot\(serializeEditorState\(\[\], \{\}\)\)/);
  // The page appears before its form fields are looked for, which on a long report is seconds.
  assert.match(editor, /void getPdfFormFields\(doc\)\.then\(/);
  assert.match(editor, /setSavedSnapshot\(serializeEditorState\(elementsRef\.current, formValues, savedBlockEdits\)\)/);
  assert.match(editor, /navigationBlocker\.proceed\(\)/);
  assert.match(editor, /navigationBlocker\.reset\(\)/);
  const save = editor.slice(editor.indexOf('const handleSave'), editor.indexOf('if (isImmersiveEditor)'));
  assert.match(save, /await deliverBlob\([\s\S]*setSavedSnapshot\(/);
  assert.match(save, /error\.name === 'AbortError'/);
});

test('selection-only pointer presses preserve Redo and history writes stay outside state updaters', () => {
  const pointerStarts = editor.slice(editor.indexOf('const handleStart'), editor.indexOf('const handleKeyDown'));
  assert.doesNotMatch(pointerStarts, /onBeginChange\(\)/);
  assert.match(editor, /if \(!gestureChanged\.current\) \{\s*onBeginChange\(\);\s*gestureChanged\.current = true;/);

  const commit = editor.slice(editor.indexOf('const commitElements'), editor.indexOf('const undo ='));
  assert.match(commit, /const next = updater\(elementsRef\.current\)/);
  assert.match(commit, /undoStack\.current = [\s\S]*replaceElements\(next\)/);
  assert.doesNotMatch(commit, /setElements\(\(current\) =>/);
});

test('added elements support movement and resizing from the keyboard', () => {
  assert.match(editor, /\['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'\]\.includes\(event\.key\)/);
  assert.match(editor, /const step = event\.shiftKey \? 0\.05 : 0\.01/);
  assert.match(editor, /if \(nextX === element\.x && nextY === element\.y\) return/);
  assert.match(editor, /if \(clampedWidth === width && clampedHeight === height\) return/);
  assert.equal((editor.match(/if \(!event\.repeat\) onBeginChange\(\)/g) ?? []).length, 2);
  assert.match(editor, /onKeyDown=\{handleResizeKeyDown\}/);
  assert.match(editor, /aria-label="Resize selected element with arrow keys"/);
  assert.match(editor, /use arrow keys to move/);
});

test('selected text annotations edit directly on the page with one history snapshot per focus session', () => {
  assert.match(editor, /const inlineTextEditorRef = useRef<HTMLTextAreaElement>\(null\)/);
  assert.match(editor, /inlineTextEditor\.setSelectionRange\(0, inlineTextEditor\.value\.length\)/);
  assert.match(editor, /aria-label=\{`Edit text on page \$\{element\.pageIndex \+ 1\}`\}/);
  assert.match(editor, /if \(!inlineTextChanged\.current\) \{\s*onBeginChange\(\);\s*inlineTextChanged\.current = true;/);
  assert.match(editor, /onUpdate\(element\.id, \{ content: event\.currentTarget\.value \}\)/);
  assert.match(editor, /onBlur=\{\(event\) => \{\s*inlineTextChanged\.current = false;\s*event\.currentTarget\.scrollLeft = 0;\s*event\.currentTarget\.scrollTop = 0;/);
  assert.match(editor, /onKeyDown=\{\(event\) => \{\s*event\.stopPropagation\(\);/);
  assert.equal((editor.match(/lineHeight: 1\.2/g) ?? []).length, 2);
});

test('mobile and desktop inspector text fields group typing into one undo snapshot', () => {
  assert.match(editor, /const inspectorTextChanged = useRef\(false\)/);
  assert.match(editor, /if \(!inspectorTextChanged\.current\) \{\s*rememberSnapshot\(\);\s*inspectorTextChanged\.current = true;/);
  assert.equal(
    (editor.match(/onChange=\{\(event\) => updateInspectorText\(selectedElement\.id, event\.currentTarget\.value\)\}/g) ?? []).length,
    2,
  );
  assert.equal((editor.match(/onBlur=\{finishInspectorTextChange\}/g) ?? []).length, 2);
  assert.doesNotMatch(editor, /Text<input[^>]*onChange=\{\(event\) => commitElementUpdate/);
});

test('paragraphs, not single words, are the editable unit on the page', () => {
  assert.match(editor, /getPageTextBlocks/);
  assert.match(editor, /<PdfTextBlockLayer/);
  assert.match(blockLayer, /contentEditable=\{enabled \? 'plaintext-only' : false\}/);
  assert.match(blockLayer, /data-testid="pdf-text-block"/);
  assert.match(blockLayer, /aria-label=\{`Paragraph on page \$\{block\.pageIndex \+ 1\}/);
  assert.match(blockLayer, /role="textbox"/);
  assert.match(blockLayer, /aria-multiline="true"/);
  // The word-at-a-time targets and their replacement drafts are gone entirely.
  assert.doesNotMatch(editor, /existing-pdf-text-target/);
  assert.doesNotMatch(editor, /replacementSource/);
});

test('the browser keeps ownership of an editable paragraph while it is being typed into', () => {
  // React re-rendering these children replaces the text node the selection points at, which sends
  // the caret back to the start of the paragraph on every keystroke.
  assert.match(blockLayer, /const writeBlockContent = \(/);
  assert.match(blockLayer, /element\.replaceChildren\(fragment\)/);
  assert.match(blockLayer, /if \(written\.current && committedText\.current === text\) return/);
  const editable = blockLayer.slice(blockLayer.indexOf('data-testid="pdf-text-block"'));
  assert.doesNotMatch(editable.slice(0, editable.indexOf('</div>')), /\{lines\.map\(/);
  // Spacing corrections are cleared in place for the same reason.
  assert.match(blockLayer, /span\.style\.wordSpacing = ''/);
});

test('each run keeps the face the PDF drew it in, in the overlay and on export', () => {
  assert.match(blockLayer, /span\.dataset\.font = run\.fontKey/);
  assert.match(blockLayer, /const fontsByKey = new Map<string, ResolvedFont>\(\)/);
  assert.match(blockLayer, /export const readStyledSegments/);
  // The edited paragraph is reported back as styled segments so a redraw can reproduce them.
  assert.match(blockLayer, /readStyledSegments\(element, block\.fontKey, keepsNonBreakingSpace\)/);
  // Browsers swap in a non-breaking space while typing; a document that never used one gets a
  // plain space back, so an untouched paragraph does not read as edited.
  assert.match(blockLayer, /const keepsNonBreakingSpace = block\.text\.includes/);
  assert.match(editor, /wrapStyledText\(/);
  assert.match(editor, /const toFace = \(fontKey: string\): ParagraphFace/);
});

test('leaving a page mid-render stops the draw instead of letting it finish', () => {
  assert.match(editor, /renderTask = page\.render\(\{ canvasContext: ctx, viewport \}\)/);
  assert.match(editor, /renderTask\?\.cancel\(\)/);
  assert.match(editor, /RenderingCancelledException/);
  assert.equal((editor.match(/if \(cancelled\) return/g) ?? []).length, 3);
});

test('a rewrite that the document cannot express falls back to a clean redraw first', () => {
  // A rewrite in place uses the document's own font, so only new characters can be a problem
  // there. Whether that font actually has them is something only the PDF engine can answer.
  // A rewrite in place uses the document's own font, so only new characters can be a problem
  // there; a redraw is checked run by run, against the face that will actually draw each one.
  assert.match(editor, /const unencodable = plan\.mode === 'reflow'/);
  assert.match(editor, /unencodableCharacters\(run\.text, face\.resolved, face\.descriptor\)/);
  assert.match(editor, /unencodableCharacters\(introduced, font \?\? FALLBACK_RESOLVED_FONT, descriptor\)/);
  // When it cannot, the redraw that removes the originals is tried before the one that covers them.
  assert.match(editor, /buildParagraphSaveEdits\(\{ forceReflow: true, plans: \[\.\.\.redrawable\] \}\)/);
  assert.match(editor, /buildParagraphSaveEdits\(\{ forceReflow: true, deleteOriginalRuns: false, plans: \[\.\.\.redrawable\] \}\)/);
  assert.match(editor, /your old wording is still in the file underneath the new text/);
});

test('what the reader placed on the page stays above the paragraph overlay', () => {
  // A form field or an added shape is the more specific thing to reach for. On a dense form —
  // an IRS 1040 carries nearly two hundred fields — a label's paragraph box covers its input.
  assert.match(blockLayer, /const PARAGRAPH_ACTIVE_LAYER = 150/);
  // Only a paragraph that actually grew steps aside; a replace-all keeps its shape and its place.
  assert.match(blockLayer, /const hasOutgrownItsBox = isDirty && text\.split\('\\n'\)\.length > block\.lines\.length/);
  assert.match(blockLayer, /PARAGRAPH_LAYER_BASE \+ Math\.round\(\(index \/ last\) \* PARAGRAPH_LAYER_SPAN\)/);
  assert.match(editor, /\/\/ Above the transparent paragraph overlay[\s\S]*zIndex: 400/);
  assert.match(editor, /absolute z-\[300\]/);
  assert.match(editor, /isSelected \? 'z-\[320\]/);
});

test('an untouched paragraph shows the canvas through it and only paints out once edited', () => {
  assert.match(blockLayer, /color: isDirty \? inkColor : 'transparent'/);
  assert.match(blockLayer, /caretColor: inkColor/);
  assert.match(blockLayer, /whiteSpace: isDirty \? 'pre-wrap' : 'pre'/);
  assert.match(blockLayer, /data-testid="pdf-block-patch"/);
  assert.match(editor, /getPageTextBackgroundPatch/);
  assert.match(editor, /samplePageBlockColors/);
});

test('the editing overlay leaves scrolling, pinch zoom and native selection to the platform', () => {
  assert.match(blockLayer, /touchAction: 'pan-x pan-y'/);
  assert.match(blockLayer, /WebkitUserSelect: 'text'/);
  assert.match(blockLayer, /const TOUCH_TARGET = 44/);
  // A pointer gets a hint that the text is editable; touch gets the same answer by tapping.
  assert.match(blockLayer, /className="chef-pdf-paragraph"/);
  assert.match(read('index.css'), /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*chef-pdf-paragraph:hover/);
  // Tap targets grow towards the neighbours but never past halfway between two paragraphs.
  assert.match(blockLayer, /Math\.min\(wanted, gapAbove \/ 2, gapBelow \/ 2\)/);
  assert.match(blockLayer, /paddingTop: unit\(hitPadding \* displayScale\)/);
  // Page zoom makes the text legible but leaves the computed font size alone, and the computed
  // size is what iOS reads before zooming a focused editable itself. The overlay lays out in
  // larger units and scales back so its computed size clears that threshold.
  assert.match(blockLayer, /const MINIMUM_COMPUTED_FONT_PX = 16/);
  assert.match(blockLayer, /const iosZoomGuard = fontSizePx > 0[\s\S]*?MINIMUM_COMPUTED_FONT_PX \/ fontSizePx\)/);
  assert.match(blockLayer, /transform: iosZoomGuard > 1 \? `scale\(\$\{1 \/ iosZoomGuard\}\)` : undefined/);
  assert.match(editor, /const MINIMUM_EDITING_FONT_PX = 16/);
  assert.match(editor, /const EDITOR_MAX_ZOOM = 4/);
  assert.match(editor, /setExactZoom\(Math\.min\(EDITOR_MAX_ZOOM, zoom \* \(MINIMUM_EDITING_FONT_PX \/ renderedFontSize\)\)\)/);
  assert.match(blockLayer, /window\.visualViewport/);
  assert.match(editor, /useKeyboardSafeFocus\(pdfZoomViewportRef\.current, activeBlockId\)/);
});

test('a paragraph edit states whether it rewrites the PDF or redraws the paragraph', () => {
  assert.match(editor, /planBlockEdit\(block, edit\.text/);
  assert.match(editor, /mode: 'direct'/);
  assert.match(editor, /mode: 'reflow'/);
  assert.match(paragraphInspector, /goes straight into the document/);
  assert.match(paragraphInspector, /redrawn rather than typed over/);
  assert.match(paragraphInspector, /data-testid="pdf-paragraph-provenance"/);
  // "Original" is a selectable state, so a paragraph is never silently restyled.
  assert.match(paragraphInspector, /\{ value: 'original', label: 'Original' \}/);
  // A phone lays the controls out in two rows rather than a strip that scrolls sideways.
  assert.match(paragraphInspector, /\{compact \? \(\s*<div className="flex flex-col gap-1\.5">/);
  assert.doesNotMatch(paragraphInspector, /overflow-x-auto/);
  assert.match(paragraphInspector, /prettyFontName\(descriptor\)/);
  assert.match(paragraphInspector, /Substituted \$\{font\?\.klass/);
  // A paragraph that cannot be saved says so from anywhere, not only while it is selected.
  assert.match(editor, /const blockedNotice = blockedParagraphs\.length > 0/);
  assert.equal((editor.match(/\{blockedNotice\}/g) ?? []).length, 2);
  // One paragraph the file cannot express must not discard every other edit in the document.
  assert.match(editor, /if \(plan\.mode === 'blocked'\) return \[\]/);
  assert.match(editor, /const savablePlans = plans\.filter\(\(entry\) => entry\.plan\.mode !== 'blocked'\)/);
  // What was not written stays dirty, so the leave-guard still protects it.
  assert.match(editor, /const savedBlockEdits = Object\.fromEntries\(/);
  assert.match(editor, /!skipped\.has\(blockId\)/);
  // And the reader can reach it and undo it.
  assert.match(editor, /const reviewNextBlockedParagraph = useCallback/);
  assert.match(editor, /const revertBlockedParagraphs = useCallback/);
  assert.match(editor, /const describeBlockedParagraphs = \(/);
});

test('find and replace covers the whole document, not just the visible page', () => {
  assert.match(editor, /const scanAllPages = useCallback/);
  assert.match(editor, /!pageTextRef\.current\.has\(index\)/);
  assert.match(editor, /findInStyledLines/);
  assert.match(editor, /replaceInStyledLines/);
  // A match is revealed by selecting it, so it is ready to type over.
  assert.match(editor, /selectRangeInBlock\(element, match\.offset/);
  assert.match(editor, /setFindOpen\(true\)/);
  assert.match(findReplace, /data-testid="pdf-find-replace"/);
  assert.match(findReplace, /data-testid="pdf-find-count"/);
  // Replace-all reports what it did, because it can change pages the reader never opened.
  assert.match(editor, /Replaced \$\{total\.toLocaleString\(\)\}/);
  // Every match on the page is painted at once, through the browser's highlight registry rather
  // than by wrapping matches in elements the browser owns while someone types.
  assert.match(blockLayer, /export const paintFindHighlights/);
  assert.match(blockLayer, /registry\.set\(FIND_HIGHLIGHT/);
  assert.match(editor, /paintFindHighlights\(ranges\)/);
  assert.match(read('index.css'), /::highlight\(pdfchef-find\)/);
  // Stepping through matches moves the page inside its own box, not the document around it.
  assert.match(blockLayer, /export const scrollBlockIntoViewport/);
  assert.match(editor, /scrollBlockIntoViewport\(viewport, element\)/);
  assert.doesNotMatch(editor, /scrollIntoView\(/);
});

test('the find bar stacks its rows on a phone so the query field keeps its width', () => {
  assert.match(findReplace, /compact \? 'flex flex-col gap-1\.5' : 'flex items-center gap-1\.5'/);
  assert.match(findReplace, /\{compact && \(/);
  assert.match(findReplace, /\{!compact && \(/);
});

test('the one action a reader cannot guess at keeps its word on every phone', () => {
  // Save is spelled out at every width. A lone disk glyph is the icon a reader who did not grow up
  // with it has to guess at, and guessing wrong here means losing the edit.
  assert.match(editor, /aria-label="Save"[\s\S]*?<span>Save<\/span>/);
  assert.doesNotMatch(editor, /max-\[400px\]:sr-only/, 'the Save label must not be hidden on narrow phones');
  // The badge is what gives up its width instead; it says something useful but nothing urgent.
  assert.match(editor, /Badge tone="caution" className="shrink-0 max-\[400px\]:hidden"/);
});

test('a page with no text layer says so and names the tool that fixes it', () => {
  assert.match(editor, /const scannedNotice = pagesWithoutText\.includes\(targetPageIndex\)/);
  assert.match(editor, /has no text layer/);
  assert.match(editor, /to="\/ocr"/);
  assert.equal((editor.match(/\{scannedNotice\}/g) ?? []).length, 2);
});

test('an edit the document cannot draw is refused while it is being typed', () => {
  assert.match(editor, /const unencodable = plan\.mode === 'reflow'/);
  assert.match(editor, /no font available here can draw/);
  // A character the reader did not type is one only the document's own font ever had, and the
  // paragraph can still be shortened or replaced even though it cannot be made longer.
  assert.match(editor, /shortened or replaced in place, but not made longer/);
  // A document with no usable character map decodes to invisible controls; quoting those verbatim
  // produced refusals that read as "cannot be saved:      can only be drawn by".
  assert.match(read('services/pdfFontResolution.ts'), /export const describeCharacter = /);
  assert.match(editor, /describeCharacters\(/);
  // Typography with a plain equivalent is written as that, rather than refused.
  assert.match(read('services/pdfFontResolution.ts'), /export const substituteForStandardFont/);
  assert.match(read('services/pdfDocument.ts'), /substituteForStandardFont\(rawSegment\)\.text/);
  // The refusal is an answer the editor chose, so it is not also logged as a fault.
  assert.match(editor, /!message\.startsWith\('This edit cannot be saved'\) && message !== PDF_EDIT_PERMISSION_MESSAGE/);
});

test('a password-protected PDF is explained rather than reported as broken', () => {
  assert.match(editor, /PasswordException/);
  assert.match(editor, /password protected/);
  assert.match(editor, /Unlock PDF tool/);
  // A damaged file is not a mystery either.
  assert.match(editor, /InvalidPDFException/);
  assert.match(editor, /Repair PDF tool/);
  // A document that permits reading but not changes says so on open, not after the work is done.
  assert.match(editor, /doc\.getPermissions\?\.\(\)/);
  assert.match(editor, /allows reading but not changes/);
  assert.match(read('services/pdfDocument.ts'), /PDF_EDIT_PERMISSION_MESSAGE/);
});

test("the keyboard drives the editor history, not a paragraph's own undo", () => {
  // A focused paragraph would otherwise swallow the shortcut, so the listener runs in capture.
  assert.match(editor, /document\.addEventListener\('keydown', handleHistoryShortcut, true\)/);
  assert.match(editor, /const redoing = key === 'y' \|\| \(key === 'z' && event\.shiftKey\)/);
  assert.match(editor, /historyKeysRef\.current\.redo\(\)/);
  assert.match(editor, /historyKeysRef\.current\.undo\(\)/);
  // Our own text fields keep the undo their users expect.
  assert.match(editor, /target instanceof HTMLInputElement \|\| target instanceof HTMLTextAreaElement/);
  // Save and find answer the shortcuts every editor uses for them.
  assert.match(editor, /if \(key === 's'\) \{\s*event\.preventDefault\(\);\s*void saveRef\.current\(\)/);
  assert.match(editor, /if \(key === 'f'\) \{\s*event\.preventDefault\(\);\s*setFindOpen\(true\)/);
});

test('paragraph edits share the editor history and the unsaved-changes guard', () => {
  assert.match(editor, /blockEdits: Record<string, BlockEditState>;/);
  assert.match(editor, /const captureSnapshot = \(\): EditorSnapshot/);
  assert.match(editor, /restoreSnapshot\(previous\)/);
  assert.match(editor, /restoreSnapshot\(next\)/);
  assert.match(editor, /serializeEditorState\(elements, formValues, blockEdits\)/);
  assert.match(editor, /const handleBeginBlockChange = useCallback[\s\S]*rememberSnapshot\(\)/);
  // Font keys are per document, so the resolved-font caches cannot outlive one.
  assert.match(editor, /resetFontResolutionCaches\(\)/);
});

test('native text analysis budget starts only after the reusable PDFium document is open', () => {
  const open = nativeTextEditor.indexOf('const cached = await openInspectionDocument(engine, file);');
  const started = nativeTextEditor.indexOf('const startedAt = performance.now();', open);
  const inspected = nativeTextEditor.indexOf('const result = inspectTarget(', started);
  assert.ok(open >= 0 && started > open && inspected > started);
});

test('immersive content reserves the measured bottom bar height', () => {
  assert.match(editor, /const immersiveBottomBarRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(editor, /const observer = new ResizeObserver\(updateHeight\)/);
  assert.match(editor, /ref=\{immersiveBottomBarRef\}/);
  assert.match(editor, /paddingBottom: `calc\(\$\{immersiveBottomBarHeight\}px \+ var\(--chef-keyboard-inset, 0px\)\)`/);
  assert.doesNotMatch(editor, /pb-\[calc\(6rem\+env\(safe-area-inset-bottom/);
});

test('what the editor tells a reader is said in their words, not ours', () => {
  // Someone correcting a name on a form should not have to know how a PDF is built. These are the
  // sentences everyone meets — the plan shown while typing, and the result shown after saving.
  const ours = /text object|content stream|glyph|encoding|serializ|reflow|raster|operator|CID|subset/i;
  const shown = [
    ...paragraphInspector.matchAll(/^\s*[?:]\s*'([^']{40,})'/gm),
    ...editor.matchAll(/`(Edited PDF ready[^`]{20,})`/g),
  ].map(match => match[1]);
  assert.ok(shown.length >= 3, `expected to find the reader-facing sentences, found ${shown.length}`);
  shown.forEach(sentence => {
    assert.doesNotMatch(sentence, ours, `this is shown to a reader and uses our vocabulary: ${sentence.slice(0, 90)}`);
  });
});

test("a form's own fields do not make the phone zoom the page away from Save", () => {
  // A W-4's boxes are small, so their text is small, and iOS reads that computed size before
  // deciding to magnify the page around a focused input — which carried Save off the screen.
  assert.match(editor, /const iosZoomGuard = Math\.max\(1, MINIMUM_EDITING_FONT_PX \/ rawFontSize\)/);
  assert.match(editor, /transform: iosZoomGuard > 1 \? `scale\(\$\{1 \/ iosZoomGuard\}\)` : undefined/);
  // Every length inside the field moves to the same units, or the box stops matching the page.
  assert.match(editor, /width: unit\(field\.width\)/);
  assert.match(editor, /height: unit\(field\.height\)/);
  assert.match(editor, /'--chef-field-hit-w': `\$\{Math\.round\(unit\(hitArea\.width\)\)\}px`/);
});

test('an in-place rewrite is only used when the PDF\'s own font has the glyphs', () => {
  // Most PDFs embed only the glyphs they already used, and the PDF engine does not refuse when a
  // replacement needs one that is missing — it writes the character code anyway. The file then
  // reads back correctly through the engines that wrote it while rendering as an empty box in
  // Preview, Acrobat and print, which no downstream check catches. So the font is asked here.
  assert.match(editor, /const missingFromOwnFont = planned\.mode === 'direct' && descriptor && introduced/);
  assert.match(editor, /\? checkGlyphCoverage\(descriptor, introduced\)/);
  // Missing glyphs downgrade the plan to a redraw, which uses a face that can draw them — they
  // must not block the edit outright, and must not be left to the in-place path.
  assert.match(editor, /missingFromOwnFont\?\.checked && !missingFromOwnFont\.covered\s*\?\s*\{\s*mode: 'reflow'/);
});
