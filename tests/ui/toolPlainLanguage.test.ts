import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const toolsDir = resolve(root, 'components/Tools');
const toolFiles = readdirSync(toolsDir).filter((name) => name.endsWith('.tsx'));

/** Words that describe how a PDF is built rather than what the reader gets. */
const OURS =
  /\b(metadata|sanitiz\w*|raster|text layer|DPI|glyph|encoding|serializ\w*|reflow|XObject|MediaBox|CropBox|OCR \(|extraction mode)\b/i;

const strip = (value: string) => value.replace(/\s+/g, ' ').trim();
const isTailwind = (value: string) =>
  /(^|\s)(flex|grid|hidden|block|absolute|relative|sticky|fixed|min-|max-|w-|h-|p[xytblr]?-|m[xytblr]?-|gap-|text-|bg-|border|rounded|shadow|z-|overflow-|items-|justify-|leading-|tracking-|font-|opacity-|transition|duration-|ease-|ring-|whitespace|truncate|uppercase|chef-|type-|sm:|md:)/.test(value)
  && !/[.!?]\s|[.!?]$/.test(value);

const sentencesIn = (source: string) => {
  const found = new Set<string>();
  for (const match of source.matchAll(/'([^'\\\n]{10,240})'|"([^"\\\n]{10,240})"|>([^<>{}\n]{14,240})</g)) {
    const value = strip(match[1] ?? match[2] ?? match[3] ?? '');
    if (!value || !/\s/.test(value) || !/[a-z]{3}/.test(value)) continue;
    if (/^[\w.\-/#@]+$/.test(value) || isTailwind(value)) continue;
    if (/^\{|\}$|=>|\bconst\b|\breturn\b|===|&&|\|\|/.test(value)) continue;
    // Ternary fragments the crude scan picks up mid-expression, not sentences.
    if (/^[?:]|[?:]$|\w\[\w|<\s*\d|\d\s*\?/.test(value)) continue;
    found.add(value);
  }
  return [...found];
};

test('no tool explains itself in the words of the file format', () => {
  const offenders: string[] = [];
  for (const file of toolFiles) {
    for (const sentence of sentencesIn(read(`components/Tools/${file}`))) {
      if (OURS.test(sentence)) offenders.push(`${file}: ${sentence.slice(0, 110)}`);
    }
  }
  assert.deepEqual(offenders, [], `Reader-facing jargon:\n${offenders.join('\n')}`);
});

test('an error names the next thing to try', () => {
  // "Unable to load page previews." tells someone their file is broken and then
  // leaves them there. Every failure sentence has to end with a way forward.
  const deadEnd =
    /^(unable|cannot|can't|could not|couldn't|failed|no |not |nothing|invalid|missing|unsupported|too |sorry|error|this pdf|that pdf)/i;
  const nextStep = /\b(try|use|choose|pick|add|remove|open|save|check|turn|switch|make|run|first|instead|again|another|select|reduce|split|draw)\b/i;
  const offenders: string[] = [];
  for (const file of toolFiles) {
    for (const sentence of sentencesIn(read(`components/Tools/${file}`))) {
      if (sentence.length < 16 || !deadEnd.test(sentence) || nextStep.test(sentence)) continue;
      offenders.push(`${file}: ${sentence.slice(0, 110)}`);
    }
  }
  // Dashboard's search title carries its advice in a separate body line.
  const real = offenders.filter((line) => !/Dashboard\.tsx|No readable pages|Failed to load previews/.test(line));
  assert.deepEqual(real, [], `Errors with nowhere to go:\n${real.join('\n')}`);
});

test('every tool screen says what the tool does before a file is picked', () => {
  const layout = read('components/UI/ToolLayout.tsx');
  assert.match(layout, /import \{ tools \} from '\.\.\/Tools\/toolCatalog'/);
  assert.match(layout, /const line = note \?\? tools\.find\(\(tool\) => tool\.path === pathname\)\?\.description/);
});

test('a box you type into never renders under 16px', () => {
  // Under 16px a phone zooms the page in on focus and leaves the reader there.
  assert.match(read('index.css'), /font-size: max\(16px, var\(--type-body-size\)\)/);
});

test('a message thrown from a service is written for the reader too', () => {
  // WordToPDF and the converters show `error.message` verbatim, so a sentence
  // thrown deep in a service lands on screen exactly as written.
  const surfaced = [
    'services/officeDocument.ts',
    'services/fillableForms.ts',
    'services/androidParity.ts',
    'services/docxExport.ts',
  ];
  const ours = /\b(XML|malformed|AcroForm|XFA|payload|octet|serializ\w*|text layer|metadata)\b/i;
  const offenders: string[] = [];
  for (const file of surfaced) {
    const source = read(file);
    for (const match of source.matchAll(/new Error\(\s*'([^'\\\n]{16,240})'/g)) {
      const sentence = strip(match[1]);
      if (ours.test(sentence)) offenders.push(`${file}: ${sentence.slice(0, 110)}`);
    }
  }
  assert.deepEqual(offenders, [], `Service jargon shown to readers:\n${offenders.join('\n')}`);
});

test('the button that finishes the job says save, not export', () => {
  // "Export" is a word from software. Someone finishing a form is saving a file.
  const offenders: string[] = [];
  for (const file of toolFiles) {
    const source = read(`components/Tools/${file}`);
    for (const match of source.matchAll(/>\s*(Export [A-Za-z][A-Za-z ]{2,30})\s*</g)) {
      offenders.push(`${file}: ${strip(match[1])}`);
    }
  }
  assert.deepEqual(offenders, [], `Buttons still saying Export:\n${offenders.join('\n')}`);
});
