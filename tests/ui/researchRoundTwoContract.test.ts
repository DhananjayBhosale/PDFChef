import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Research round 2 (output/web/ui-redesign/audit/research-r2): fixes whose loss no other unit check
 * would notice. The browser checks for them are in that round's fix-scripts/.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('a Hindi watermark is drawn with Edit PDF\'s Devanagari writer, and a phone keeps its error on screen (mobile-01, mobile-02)', () => {
  const service = read('services/pdfDocument.ts');
  // The font name lives beside the Devanagari writer, so Watermark's screen can read it without pdf-lib.
  assert.match(read('services/pdfDevanagari.ts'), /export const WATERMARK_DEVANAGARI_FONT: DevanagariFontId = 'MuktaBold';/);
  const watermark = service.slice(service.indexOf('export const addWatermarkToPDF'));
  assert.match(watermark, /new DevanagariPdfWriter\(pdfDoc\)/);
  assert.match(watermark, /writer\.drawLine\(page,/);
  assert.match(watermark, /writer\?\.finish\(\);/);
  // Opacity reaches the shaped text through its own graphics state.
  assert.match(read('services/pdfDevanagari.ts'), /setGraphicsState\(page\.node\.newExtGState\('GS', state\)\)/);
  const screen = read('components/Tools/WatermarkPDF.tsx');
  assert.match(screen, /const canSave = [^;]*!textPending;/);
  assert.match(screen, /notice=\{!wide && textValidationMessage \? <Notice tone="error" id="watermark-text-error" role="alert">/);
});

test('a locked-file error links to Unlock PDF and hands the file on (mobile-06)', () => {
  const errorText = read('components/UI/ErrorText.tsx');
  assert.match(errorText, /name: \(\) => t\('tool-catalog\.unlock\.pdf\.893947'\),\s*to: '\/unlock'/);
  assert.match(errorText, /'error\.pdfLocked', 'compress-pdf\.this\.pdf\.is\.encrypted\.unlock\.it\.first\.7621b1'/);
  assert.match(errorText, /navigate\(step\.to, \{ state: \{ useOpenedPdf: true, openedPdfId: opened\.id \} \}\)/);
  assert.match(read('components/Tool/parts.tsx'), /<ErrorText text=\{status\.error\} \/>/);
  assert.match(read('components/UI/StatusToast.tsx'), /failed \? <ErrorText text=\{message\} \/> : message/);
  assert.match(read('components/UI/FileUpload.tsx'), /rememberPickedFile\(/);
});

test('phones keep the Tools word until the name needs more than two lines; tablets get Recent and Settings (mobile-03, mobile-05)', () => {
  const css = read('components/Tool/tool.css');
  assert.match(css, /\.tk-top-row:is\(\[data-compact="4"\], \[data-compact="5"\]\) \.tk-tools > span \{ position: absolute;/);
  assert.match(css, /\.tk-top-row\[data-compact="5"\] \.tk-top-title \{ -webkit-hyphens: auto; hyphens: auto; \}/);
  const top = read('components/Tool/ToolTop.tsx');
  assert.match(top, /const MAX_LEVEL = 5;/);
  assert.match(top, /const links = useHeaderLinks\(\) && !bare;/);
});

test('Extract applies a valid typed range as it is typed (H2-02)', () => {
  assert.match(read('components/UI/PageRangeSelector.tsx'), /if \(live && next\.trim\(\) && !unavailable && !composingRef\.current\)/);
  assert.match(read('components/Tools/ExtractPages.tsx'), /<PageRangeSelector[\s\S]{0,600}?\blive\b/);
});

test('Unlock says why its action waits, in the field, like Protect (H2-03)', () => {
  const unlock = read('components/Tools/UnlockPDF.tsx');
  assert.match(unlock, /<span id="unlock-password-required" className="tk-hintfield-hint">\{t\("android-parity\.password\.is\.required\.to\.unlock\.the\.pdf\.be2e2e"\)\}<\/span>/);
  assert.match(unlock, /aria-describedby=\{needsPassword && password\.length === 0 \? 'unlock-password-required' : undefined\}/);
});

test('PowerPoint to PDF shows the first slide, with its file card if that fails (H3-03)', () => {
  assert.match(read('services/officeDocument.ts'), /export const renderPptxFirstSlide = async \(file: File, longEdge = 960\): Promise<string>/);
  assert.match(read('components/Tools/PowerPointToPDF.tsx'), /renderPreview=\{renderFirstSlide\}/);
  // The fallback is the same compact file card Word shows (pass 5, item 7).
  const converter = read('components/Tool/ConverterScreen.tsx');
  assert.match(converter, /render=\{renderPreview\} fallback=\{fileCard\}/);
  assert.match(converter, /const fileCard = \(?\s*<div className="tk-cardstage">\s*<FileCard icon=\{icon\}/);
});

test('Skip to content and a new file land on the tool\'s own content (desktop-01..04)', () => {
  assert.match(read('App.tsx'), /document\.querySelector<HTMLElement>\('#main \[data-skip-target\]'\)/);
  assert.match(read('components/Tool/ToolScreen.tsx'), /'data-skip-target': ''/);
});
