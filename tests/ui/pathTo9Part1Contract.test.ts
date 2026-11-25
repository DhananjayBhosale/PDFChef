import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import english from '../../services/i18n/en-US.ts';

// Path to 9, part 1 (owner decisions of 2026-11-14). Behaviour is checked in the browser by
// scripts/verify-path-to-9-part1.mjs; these pin the contracts in the source.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('item 1: a phone editor closes on a pick or Enter, and has one close control', () => {
  const pop = read('components/Tool/Popover.tsx');
  assert.match(pop, /export const pickCloses = \(body: HTMLElement, option: Element\): boolean =>/);
  assert.match(pop, /if \(option\.matches\('\[data-tk-preset\]'\)\) return true;/);
  assert.match(pop, /controls\.every\(\(item\) => group\.contains\(item\)\)/);
  // Enter applies and closes, but never over an invalid value or a key a field already handled.
  assert.match(pop, /event\.key !== 'Enter' \|\| event\.defaultPrevented \|\| event\.nativeEvent\.isComposing/);
  assert.match(pop, /field\.getAttribute\('aria-invalid'\) === 'true' \|\| field\.closest\('\[data-enter-invalid\]'\)/);
  // Owner decision 2026-11-15, item 5: Done is gone; every card has the one close control
  // (tests/ui/phoneFable.test.ts pins it).
  assert.doesNotMatch(pop, /tk-pop-done/);
});

test('item 1: size, opacity and angle editors offer tap choices beside the slider', () => {
  const parts = read('components/Tool/parts.tsx');
  assert.match(parts, /export const TapChoices/);
  assert.match(parts, /data-tk-preset=""/);
  const watermark = read('components/Tools/WatermarkPDF.tsx');
  for (const presets of ['[24, 36, 50, 72]', '[10, 30, 50, 75]', '[-45, 0, 45, 90]']) {
    assert.ok(watermark.includes(presets), `Watermark presets ${presets}`);
  }
  assert.ok(read('components/Tools/PageNumbersPDF.tsx').includes('[8, 10, 12, 14]'));
  assert.ok(read('components/Tools/PdfAdvancedTools.tsx').includes('[10, 12, 14, 18]'));
});

test('item 3: the result strip has its own Download, and the sheet keeps its buttons', () => {
  const output = read('components/UI/OutputCenter.tsx');
  assert.match(output, /aria-label=\{t\('output-center\.download\.named', \{ v0: safeName \}\)\}/);
  // Final fix, item 3: an outdated result ("Earlier result") gives no one-tap Download on the
  // strip; the sheet keeps it.
  assert.match(output, /\{\(primary === 'save' \|\| !isPdf\) && !stale && \(\s*<button[\s\S]*?onClick=\{\(\) => void act\(downloadResult/);
  assert.match(output, /const downloadButton = \(primary === 'save' \|\| !isPdf\) && \(/);
  assert.equal(english['output-center.download.named'], 'Download {v0}');
});

test('item 4: the wide layout starts at 768 px, so a tablet in portrait gets it', () => {
  assert.match(read('hooks/useMediaQuery.ts'), /export const MQ_LG = '\(min-width: 768px\) and \(min-height: 480px\)';/);
  const css = read('components/Tool/tool.css');
  assert.doesNotMatch(css, /\((?:min|max)-width:\s*(?:1024px|1023\.98px)\)/);
  assert.match(css, /\(min-width: 768px\) and \(min-height: 480px\)/);
  assert.match(css, /\(max-width: 767\.98px\), \(max-height: 479\.98px\)/);
});

test('item 6: focus never drops to the page, and Cancel says "Canceled."', () => {
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /const useFocusRescue = /);
  assert.match(screen, /new MutationObserver\(rescue\)/);
  assert.match(screen, /if \(active && active !== document\.body && active !== document\.documentElement\) \{ last = null; return; \}/);
  const parts = read('components/Tool/parts.tsx');
  assert.match(parts, /if \(!quietRef\.current\) voice\.announce\(t\('tool\.canceled'\)\);/);
  assert.match(parts, /onClickCapture=\{\(\) => \{ if \(voice\) voice\.cancelAsked\.current = true; \}\}/);
  // The tools that say their own cancel line do not hear it twice.
  for (const tool of ['CompressPDF', 'PDFToImage']) {
    assert.match(read(`components/Tools/${tool}.tsx`), /<ProgressLine[\s\S]*?quietCancel/, tool);
  }
  // Extract Text's Cancel sits in the header.
  assert.match(read('components/Tool/ToolTop.tsx'), /if \(cancels\) noteCancel\(\);/);
  // A removed row says what went.
  assert.match(read('components/Tool/QueueRow.tsx'), /announce\(t\('tool\.removed', \{ v0: name \}\)\)/);
  assert.equal(english['tool.canceled'], 'Canceled.');
});

test('item 7: the header links ask before leaving a loaded file or a running job', () => {
  const top = read('components/Tool/ToolTop.tsx');
  assert.match(top, /export const LeaveAskContext = React\.createContext/);
  assert.equal(top.match(/useAskingLink\(/g)?.length, 4); // Tools, Recent and Settings, the brand, the phone name link
  const screen = read('components/Tool/ToolScreen.tsx');
  assert.match(screen, /<LeaveAskContext\.Provider value=\{askLeave\}>/);
  assert.match(screen, /if \(leaveGuarded\(\)\) return false;/);
  assert.match(screen, /if \(!running && \(holds === false \|\| \(holds === undefined && dropZoneShown\(\)\)\)\) return false;/);
  // A tool's own "Discard your unsaved edits?" asks instead, so nobody is asked twice.
  // One blocker for the whole screen (fix round 2, item 2): a tool's guard hands it its question.
  assert.match(read('hooks/useConfirmDiscard.tsx'), /useLeaveGuarded\(unsaved, ask\);/);
  assert.doesNotMatch(read('hooks/useConfirmDiscard.tsx'), /useBlocker/);
  assert.match(read('components/Tools/EditPDF.tsx'), /useLeaveGuarded\(hasUnsavedEdits, askToDiscard\);/);
  assert.doesNotMatch(read('components/Tools/EditPDF.tsx'), /useBlocker/);
});

test('item 7: theme and text size follow another open tab', () => {
  const appearance = read('hooks/useAppearance.tsx');
  assert.match(appearance, /window\.addEventListener\('storage', onStorage\)/);
  assert.match(appearance, /event\.key === null \|\| event\.key === THEME_KEY\) setThemeState\(readTheme\(\)\)/);
  assert.match(appearance, /event\.key === null \|\| event\.key === TEXT_SCALE_KEY\) setTextScaleState\(readTextScale\(\)\)/);
});

test('item 7: wording fits a mouse as well as a finger, and Replace all says so', () => {
  const tapFirst = Object.entries(english)
    .filter(([, value]) => typeof value === 'string' && /^Tap\b/.test(value))
    .map(([key]) => key);
  assert.deepEqual(tapFirst, []);
  for (const kind of ['text', 'image', 'rectangle', 'ellipse', 'line', 'arrow']) {
    assert.match(english[`editor.${kind}.choose` as keyof typeof english] as string, /^Choose where on the page to place /);
  }
  assert.equal(english['pdf-find-replace.replace.all'], 'Replace all');
  assert.match(read('components/Tools/PdfFindReplace.tsx'), /t\('pdf-find-replace\.replace\.all'\)/);
  assert.equal(english['page-range-selector.pending.select'], 'Press Select to use these pages.');
});
