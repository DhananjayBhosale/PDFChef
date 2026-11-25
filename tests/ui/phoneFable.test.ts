import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';

// Fable's phone layout (owner decisions of 2026-11-15). Behaviour is checked in the browser by
// tests/browser/phoneFableChecks.mjs; these pin the contracts in the source.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('item 1: on a phone a setting shows once, as a value whose card holds its control', () => {
  // Each of these tools keeps its control beside the sentence on desktop and moves it into the
  // value's card on a phone, with the same element (same name and handler).
  const cases: Array<[string, RegExp, RegExp]> = [
    ['components/Tools/SplitPDF.tsx', /\.\.\.\(wide \? \{ focusTarget: \(\) => rangeRef\.current \} : \{ editor: rangeField \}\)/, /\{wide && rangeField\}\s*\{wide && sizeInline\}/],
    ['components/Tools/DeletePages.tsx', /\.\.\.\(wide \? \{ focusTarget: \(\) => rangeRef\.current \} : \{ editor: rangeEditor \}\)/, /\{wide && rangeEditor\}/],
    ['components/Tools/ExtractPages.tsx', /\.\.\.\(wide \? \{ focusTarget: \(\) => rangeRef\.current \} : \{ editor: rangeField \}\)/, /\{wide && rangeField\}/],
    ['components/Tools/MakePDF.tsx', /\.\.\.\(wide \? \{ focusTarget: \(\) => nameRef\.current \} : \{ editor: nameEditor, showTitle: false \}\)/, /\{wide && <div className="tk-inline-field tk-makepdf-namefield">\{nameEditor\}<\/div>\}/],
    ['components/Tools/PowerPointToPDF.tsx', /inline: \(\s*<ToggleValue/, /chips=\{wide \? orientationChoice : undefined\}/],
    ['components/Tools/OCRPDF.tsx', /inline: \(\s*<ToggleValue/, /chips=\{wide \? modeChoice : undefined\}/],
    ['components/Tools/BatchPDF.tsx', /const base: Partial<SlotDef> = wide \? \{ static: true \} : \{ editor: optionControl, showTitle: false \};/, /chips=\{wide \? settings : undefined\}/],
    ['components/Tools/CompressPDF.tsx', /editor: qualityBlock,/, /side=\{wide \? qualityBlock : undefined\}/],
  ];
  for (const [path, slot, chips] of cases) {
    const source = read(path);
    assert.match(source, slot, `${path}: the slot opens a card with the control on a phone`);
    assert.match(source, chips, `${path}: the control is on the screen only on desktop`);
    assert.match(source, /const wide = useWide\(\);/, `${path}: reads the width`);
  }
  // An open card repeats only an error or a pending line, never an outcome with its own button.
  const parts = read('components/Tool/parts.tsx');
  assert.match(parts, /if \(tone !== 'error' && tone !== 'pending'\) return null;/);
});

test('item 2: the phone foot sheet is capped at 40% of the screen, never under 17.5rem', () => {
  const css = read('components/Tool/tool.css');
  // Never under 17.5rem, so a short screen keeps the strip, the sentence and the action (fix review, finding 8).
  assert.match(css, /\.tk-tool:not\(\[data-wide\]\) > \.tk-sheet:not\(:has\(> \.tk-notice :is\(\[data-tone=\"error\"\], \[data-tone=\"caution\"\], \[role=\"alert\"\]\)\)\) \{ max-height: min\(80%, max\(40vh, 17\.5rem\)\); max-height: min\(80%, max\(40dvh, 17\.5rem\)\); \}/);
  // With a result, the outcome line gives way; errors, pending lines and cautions stay.
  assert.match(css, /\.tk-sheet:has\(> \.tk-result > \*\) > \.tk-notice:not\(:has\(\[data-tone="error"\], \[data-tone="pending"\], \[data-tone="caution"\], \[role="alert"\]\)\) \{ display: none; \}/);
  assert.match(css, /\.tk-chips:empty \{ display: none; \}/);
});

test('item 3: four or more values on a phone read as labelled rows', () => {
  const sentence = read('components/Tool/Sentence.tsx');
  // A control drawn inline (Rotate's words, Watermark's colour swatch) is not a value (review 2, Watermark short sentence).
  assert.match(sentence, /const valueCount = names\.filter\(\(name\) => !slots\[name\]\.static && !slots\[name\]\.inline\)\.length;/);
  assert.match(sentence, /const many = !wide && valueCount >= 4;/);
  assert.match(sentence, /form === 'auto' && \(overflow \|\| many\)/);
  assert.match(sentence, /data-many=\{many \? '' : undefined\}/);
  const css = read('components/Tool/tool.css');
  assert.match(css, /\.tk-band-top \.tk-rows\[data-many\] \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test('item 4: an open card leaves a live preview at least 30% of the screen (40% when it fits)', () => {
  const pop = read('components/Tool/Popover.tsx');
  assert.match(pop, /export const PREVIEW_FLOOR = 0\.3;/);
  // Page Numbers' Position card alone keeps 20% (pass 5, item 10), so its controls fit a 360×800 phone.
  assert.match(pop, /previewFloor = PREVIEW_FLOOR, children \}/);
  assert.match(pop, /: room\.top \+ window\.innerHeight \* previewFloor;/);
  // With the keyboard up, the card may reach the top of the tool (Android sync, 2026-11-15).
  assert.match(pop, /const typing = document\.documentElement\.hasAttribute\('data-chef-keyboard'\);/);
  assert.match(pop, /style=\{cardCap !== null \? \{ \.\.\.style, maxHeight: cardCap \} : style\}/);
  const css = read('components/Tool/tool.css');
  // Any descendant: on a phone the expand button sits in the position pill's row (pass 3).
  assert.match(css, /\.tk-tool\[data-editor-cover\] \.tk-pframe \.tk-pframe-tools \{ display: none; \}/);
});

test('item 5: every card closes the same way', () => {
  const pop = read('components/Tool/Popover.tsx');
  // One close control, no Done, no modal scrim that swallows the tap.
  assert.equal((pop.match(/className="tk-pop-close chef-pressable"/g) ?? []).length, 1);
  assert.doesNotMatch(pop, /tk-pop-done|needsDone/);
  assert.doesNotMatch(pop, /swallow/);
  assert.match(pop, /data-pass=""/);
  // A tap outside closes every open card; Escape closes it.
  assert.match(pop, /useEffect\(\(\) => \{\s*if \(!open\) return undefined;\s*const onPointerDown/);
  assert.match(pop, /if \(event\.key === 'Escape'\) \{/);
  // Enter in a card: a field's own form (the page range, now only in its card on a phone) applies
  // and closes; text still being composed by an input method never closes the card.
  assert.match(pop, /if \(field\.form\) return;/);
  assert.match(pop, /event\.nativeEvent\.isComposing \|\| composing\.current\) return;/);
  const css = read('components/Tool/tool.css');
  assert.match(css, /\.tk-scrim:not\(\[data-wide\]\) \{ background: transparent; \}/);
});

test('Sign: the reset is "Fit page"; Edit PDF and Read PDF keep "Reset zoom to 100%"', () => {
  assert.equal(english['sign-pdf.fit.page'], 'Fit page');
  const sign = read('components/Tools/SignPDF.tsx');
  assert.equal((sign.match(/resetLabel=\{t\('sign-pdf\.fit\.page'\)\}/g) ?? []).length, 2);
  for (const path of ['components/Tools/EditPDF.tsx', 'components/Tools/ViewPDF.tsx']) {
    assert.doesNotMatch(read(path), /resetLabel/, path);
  }
  const zoom = read('components/UI/ZoomControls.tsx');
  assert.match(zoom, /aria-label=\{resetLabel \?\? t\("zoom-controls\.reset\.zoom\.to\.100\.39cdc8"\)\}/);
  const rules = JSON.parse(read('scripts/lib/ui-control-exceptions.json')).rules as Array<Record<string, unknown>>;
  const fit = rules.filter((rule) => rule.to === 'Fit page');
  assert.equal(fit.length, 1);
  assert.deepEqual(fit[0], { type: 'renamed', screens: ['sign'], role: 'button', from: 'Reset zoom to 100%', to: 'Fit page', reason: 'owner decision 2026-11-15' });
});

test('polish item 1: a card keeps its head; only its body scrolls', () => {
  const css = read('components/Tool/tool.css');
  assert.match(css, /\.tk-pop \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*overflow: hidden;/);
  assert.match(css, /\.tk-pop-body \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
});

test('polish item 3: a two-choice value keeps today\'s radios', () => {
  const toggle = read('components/Tool/ToggleValue.tsx');
  assert.match(toggle, /role="radiogroup"/);
  assert.match(toggle, /type="radio"/);
  assert.match(toggle, /aria-label=\{option\.label\}/);
  assert.match(read('components/Tools/PowerPointToPDF.tsx'), /<ToggleValue/);
  assert.match(read('components/Tools/OCRPDF.tsx'), /<ToggleValue/);
});

test('polish item 4: Delete\'s Mark closes its card when the range is accepted', () => {
  assert.match(read('components/Tool/Popover.tsx'), /onClick=\{\(\) => \{ if \(apply\(\) && close\) close\(\); \}\}/);
  assert.match(read('components/Tools/DeletePages.tsx'), /<ApplyButton apply=\{markRange\}/);
});
