import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { setLocalePreference } from '../../services/i18n/core.ts';
import {
  LocalizedError,
  classifyPdfError,
  hasPdfHeader,
  localizeError,
  namedPdfError,
  pdfFailureMessage,
  pdfFailureNotice,
  pdfProblemMessage,
} from '../../services/i18n/errors.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(root, 'tests/fixtures/signatures', name)));
// Opens with no password but is encrypted to limit changes, which pdf-lib refuses.
const ownerOnly = () => fixture('layered-owner-only-rc4.pdf');
// Needs a password to open at all.
const userLocked = () => fixture('detached-sha256-rc4.pdf');
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(2000).fill(0x41)]);
const damaged = () => new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage');

const pdfLibError = async (bytes: Uint8Array) => PDFDocument.load(bytes).then(() => null, (error: unknown) => error);
const pdfJsError = async (bytes: Uint8Array) => {
  const task = pdfjs.getDocument({ data: bytes });
  try {
    await task.promise;
    return null;
  } catch (error) {
    return error;
  } finally {
    await task.destroy();
  }
};

// ORG-08, FIL-23, CNV-53: the library's own wording reached the screen.
test('real pdf-lib errors are classified from the error, not from its text on screen', async () => {
  assert.equal(classifyPdfError(await pdfLibError(ownerOnly())), 'locked');
  assert.equal(classifyPdfError(await pdfLibError(userLocked())), 'locked');
  assert.equal(classifyPdfError(await pdfLibError(jpeg())), 'notPdf');
  assert.equal(classifyPdfError(await pdfLibError(new Uint8Array())), 'notPdf');
  const locked = await pdfLibError(userLocked()) as Error;
  assert.match(locked.message, /ignoreEncryption/);
  assert.equal(localizeError(locked), 'This PDF is password-protected. Unlock it with Unlock PDF first.');
  assert.equal(localizeError(await pdfLibError(jpeg()) as Error), 'This file is not a PDF. Choose another file.');
});

// ORG-49, CNV-33: pdf.js said "No password given" and "Invalid PDF structure."
test('real pdf.js errors are classified by the exception name it keeps across the worker', async () => {
  assert.equal(await pdfJsError(ownerOnly()), null, 'an owner-only file opens, so Unlock PDF needs no password for it');
  const password = await pdfJsError(userLocked()) as Error;
  assert.equal(password.name, 'PasswordException');
  assert.equal(classifyPdfError(password), 'locked');
  assert.equal(localizeError(password), 'This PDF is password-protected. Unlock it with Unlock PDF first.');
  assert.equal(classifyPdfError(await pdfJsError(new Uint8Array())), 'notPdf');
  assert.equal(classifyPdfError(await pdfJsError(damaged())), 'unreadable');
  // pdf.js reports a JPEG like a damaged PDF; the missing header is what tells them apart.
  assert.equal(classifyPdfError(await pdfJsError(jpeg())), 'unreadable');
  assert.equal(hasPdfHeader(jpeg()), false);
  assert.equal(hasPdfHeader(damaged()), true);
  assert.equal(hasPdfHeader(new Uint8Array()), false);
  assert.equal(hasPdfHeader(new Uint8Array([...new Array(1019).fill(0x20), ...new TextEncoder().encode('%PDF-')])), true);
  assert.equal(hasPdfHeader(new Uint8Array([...new Array(1020).fill(0x20), ...new TextEncoder().encode('%PDF-')])), false);
});

test('a classified problem keeps its meaning after the interface language changes', async () => {
  const error = await pdfLibError(userLocked());
  try {
    await setLocalePreference('fr-FR', false);
    assert.equal(classifyPdfError(error), 'locked');
    assert.ok(pdfProblemMessage(error));
  } finally {
    await setLocalePreference('en-US', false);
  }
});

// ORG-08: Merge did not say which file was the problem.
test('a merge names the locked or non-PDF file and says what to do', async () => {
  const locked = namedPdfError(await pdfLibError(ownerOnly()), 'QA Encrypted.pdf') as Error;
  assert.ok(locked instanceof LocalizedError);
  assert.equal(localizeError(locked), 'QA Encrypted.pdf is password-protected. Unlock it first, or remove it.');
  assert.equal(classifyPdfError(locked), 'locked');
  assert.ok(locked.cause, 'the library error stays available for the console');
  const notPdf = namedPdfError(await pdfLibError(jpeg()), 'QA NotPdf.pdf') as Error;
  assert.equal(localizeError(notPdf), 'QA NotPdf.pdf is not a PDF. Remove it.');
  assert.equal(pdfProblemMessage(notPdf), 'QA NotPdf.pdf is not a PDF. Remove it.');
  const other = new Error('Expected instance of PDFDict');
  assert.equal(namedPdfError(other, 'x.pdf'), other);
});

test('screens that used a fixed Repair PDF sentence show the real cause instead', async () => {
  const locked = await pdfJsError(userLocked());
  assert.equal(pdfFailureMessage(locked, 'fallback'), 'This PDF is password-protected. Unlock it with Unlock PDF first.');
  assert.equal(pdfFailureMessage(new Error('internal detail'), 'fallback'), 'fallback');
  // ADD1R-15: an all-blank file is this tool's own answer, not a reason to run Repair PDF.
  assert.equal(
    pdfFailureMessage(new LocalizedError('pdf-document.all.pages.look.blank.no.output.was.7f5ae1'), 'fallback'),
    'All pages look blank. No output was created.',
  );
  assert.deepEqual(pdfFailureNotice(locked, 'The pages could not be shown.'), {
    title: 'This PDF is password-protected. Unlock it with Unlock PDF first.',
  });
  assert.deepEqual(pdfFailureNotice(new Error('Canvas failed'), 'The pages could not be shown.'), {
    title: 'The pages could not be shown.',
    detail: 'Canvas failed',
  });
});

test('PDF services raise the classified problem instead of a count of zero or a raw sentence', () => {
  const documentService = read('services/pdfDocument.ts');
  // FIL-22: a JPEG renamed .pdf counted as zero pages, which read as "Selected PDF has no pages."
  const pageCount = documentService.slice(documentService.indexOf('export const getPDFPageCount'), documentService.indexOf('export const flattenPDF'));
  assert.doesNotMatch(pageCount, /return 0;/);
  assert.match(pageCount, /if \(pdfDoc\.isEncrypted\) throw new LocalizedError\('error\.pdfLocked'\)/);
  assert.match(pageCount, /new LocalizedError\('error\.pdfUnreadable'\)/);
  assert.match(documentService, /PDFDocument\.load\(arrayBuffer\)\.catch\(\(error\) => \{ throw namedPdfError\(error, file\.name\); \}\)/);
  // An owner-only file is refused by every pdf-lib tool and sent to Unlock PDF, which must take it.
  const unlock = documentService.slice(documentService.indexOf('export const unlockPDF'), documentService.indexOf('export interface EditorElement'));
  assert.doesNotMatch(unlock, /password\.is\.required/);
  assert.match(read('services/qpdfBrowser.ts'), /\.\.\.\(password \? \[`--password=\$\{password\}`\] : \[\]\)/);
  const browser = read('services/pdfBrowser.ts');
  const loader = browser.slice(browser.indexOf('const loadOwnedPDFDocument'), browser.indexOf('export const loadDisposablePDFDocument'));
  assert.ok(loader.indexOf('hasPdfHeader(data)') < loader.indexOf('pdfjs.getDocument('), 'the header is read before the bytes move to the worker');
  assert.match(loader, /new LocalizedError\('error\.pdfNotPdf'\)/);
});

// ADD1R-15: a page holding only "Signed" at 8 pt was removed.
test('blank-page removal keeps any page with words and counts fainter ink at a larger scale', () => {
  const documentService = read('services/pdfDocument.ts');
  const blank = documentService.slice(documentService.indexOf('const isPageBlank'), documentService.indexOf('export const removeBlankPagesFromPDF'));
  assert.ok(blank.indexOf('getTextContent()') < blank.indexOf('page.render('), 'words are checked before pixels');
  assert.match(blank, /item\.str\.trim\(\) !== ''\)\) return false;/);
  assert.match(documentService, /const BLANK_CHECK_SCALE = 0\.4;/);
  assert.match(documentService, /const DEFAULT_BLANK_INK_THRESHOLD = 0\.0003;/);
  assert.match(documentService, /options\?\.threshold \?\? DEFAULT_BLANK_INK_THRESHOLD/);
  const tools = read('components/Tools/PdfAdvancedTools.tsx');
  assert.match(tools, /pdfFailureMessage\(error, t\("pdf-advanced-tools\.the\.blank\.pages\.could\.not\.be\.removed\.e20ac8"\)\)/);
});

// CNV-53, ORG-49, CNV-33: these screens dropped the error for a fixed "run Repair PDF" sentence.
test('every screen that used a fixed sentence asks the classifier first', () => {
  const expectations: Array<[string, RegExp[]]> = [
    ['components/Tools/FlattenPDF.tsx', [/pdfProblemMessage\(error\) \?\? t\("flatten-pdf\./]],
    ['components/Tools/ExtractPages.tsx', [/pdfProblemMessage\(error\) \?\? t\("extract-pages\.the\.pages\.could\.not/, /pdfFailureMessage\(error, t\("extract-pages\.the\.selected/]],
    ['components/Tools/PdfAdvancedTools.tsx', [/pdfProblemMessage\(error\) \?\? t\("pdf-advanced-tools\.this\.pdf\.could\.not\.be\.changed/, /pdfProblemMessage\(error\) \?\? t\("pdf-advanced-tools\.this\.pdf\.could\.not\.be\.cropped/, /pdfProblemMessage\(error\) \?\? t\("pdf-advanced-tools\.the\.header\.and\.footer/, /pdfProblemMessage\(error\) \?\? t\("pdf-advanced-tools\.the\.pictures\.could\.not\.be\.saved/]],
    ['components/Tools/PDFToImage.tsx', [/pdfProblemMessage\(error\) \?\? t\("pdfto-image\.this\.pdf\.could\.not\.be\.opened/]],
    ['components/Tools/ComparePDF.tsx', [/pdfProblemMessage\(error\) \?\? t\("compare-pdf\.could\.not\.be\.opened/]],
    ['components/Tools/PageNumbersPDF.tsx', [/pdfProblemMessage\(error\) \?\? t\("page-numbers-pdf\.the\.preview/]],
    ['components/Tools/MetadataPDF.tsx', [/pdfProblemMessage\(error\) \?\? t\("metadata-pdf\./]],
    ['components/Tools/RepairPDF.tsx', [/classifyPdfError\(error\) !== 'unreadable' && pdfProblemMessage\(error\)/]],
    ['components/Tools/SignPDF.tsx', [/pdfProblemMessage\(error\) \?\? t\("sign-pdf\./]],
    ['components/Tools/OCRPDF.tsx', [/pdfProblemMessage\(error\) \?\? \(extractionMode === 'ocr'/]],
    ['components/Tools/RotatePDF.tsx', [/pdfFailureNotice\(err, t\("rotate-pdf\.the\.pages/, /\{previewError\.title\}/]],
    ['components/Tools/ReorderPDF.tsx', [/pdfFailureNotice\(error, t\("reorder-pdf\.the\.pages/, /\{previewError\.title\}/]],
    ['components/Tools/DeletePages.tsx', [/pdfFailureNotice\(error, t\("delete-pages\.the\.pages/, /\{previewError\.title\}/]],
  ];
  for (const [path, patterns] of expectations) {
    const source = read(path);
    for (const pattern of patterns) assert.match(source, pattern, path);
  }
  // A regex over translated text stopped matching the moment the message was not English.
  const compress = read('components/Tools/CompressPDF.tsx');
  assert.doesNotMatch(compress, /\/password\|encrypted\/i/);
  assert.match(compress, /classifyPdfError\(error\) === 'locked'/);
});

test('Unlock PDF asks for no password when the file opens without one', () => {
  const unlock = read('components/Tools/UnlockPDF.tsx');
  assert.match(unlock, /opensWithoutPassword\(selected\)/);
  assert.match(unlock, /\{needsPassword && <div>/);
  assert.match(unlock, /unlockPDF\(file\.file, needsPassword \? password : ''\)/);
  assert.match(unlock, /disabled=\{needsPassword !== false && password\.length === 0\}/);
});

// NAV-45, FIL-31: "Open with PDF Chef" failed silently.
test('a refused Open with hand-over shows why', () => {
  const handler = read('components/Layout/AndroidIncomingPdfHandler.tsx');
  assert.match(handler, /addIncomingPdfRejectedListener\(reason =>/);
  assert.match(handler, /"android-incoming-pdf-handler\.this\.pdf\.is\.too\.large\.to\.open\.080096"/);
  assert.match(handler, /'error\.pdfNotPdf'/);
  assert.match(handler, /"android-incoming-pdf-handler\.this\.file\.could\.not\.be\.opened\.bf6e8b"/);
});
