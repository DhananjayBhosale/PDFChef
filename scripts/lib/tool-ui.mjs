// Shared helpers for the UI control inventory and the browser checks that follow the new tool kit.
// Uses only qa-sample.pdf and files under tests/fixtures/ (the fixtures in tests/fixtures/ui/ are
// made here, never taken from a user's device).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixtureDir = resolve(root, 'tests/fixtures/ui');
export const qaPdf = resolve(root, 'qa-sample.pdf');
export const photo = (name) => resolve(root, 'tests/fixtures/photos', name);
export const settingsKey = 'pdfchef.workspace.settings.v1';
export const lockedPdfPassword = 'pdfchef-qa';

export const sizes = [
  { key: '390x844', width: 390, height: 844, phone: true },
  { key: '360x780', width: 360, height: 780, phone: true },
  { key: '1024x768', width: 1024, height: 768, phone: false },
  { key: '1440x900', width: 1440, height: 900, phone: false },
];

/** A browser context in the state a returning user has: onboarding done, no app-store welcome. */
export async function newContext(browser, size, settings = {}) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.phone ? 2 : 1,
    isMobile: size.phone,
    hasTouch: size.phone,
    acceptDownloads: true,
    locale: 'en-US',
  });
  await context.addInitScript(([key, extra]) => {
    localStorage.setItem(key, JSON.stringify({
      onboardingComplete: true, keepLocalHistory: false, autoDownload: false, confirmLargeJobs: false, ...extra,
    }));
    sessionStorage.setItem('pdfchef.mobile-app-welcome.dismissed.v1', 'true');
  }, [settingsKey, settings]);
  return context;
}

// ---------------------------------------------------------------- fixtures

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const rels = (items) => `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
const relation = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', rels(relation('rId1', 'officeDocument', 'word/document.xml')));
  zip.file('word/document.xml', `${xmlHeader}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>PDF Chef QA document</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph for the converter.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function makePptx() {
  const zip = new JSZip();
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const types = [
    ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
    ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
    ['/ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
  ].map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('');
  zip.file('[Content_Types].xml', `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}</Types>`);
  zip.file('_rels/.rels', rels(relation('rId1', 'officeDocument', 'ppt/presentation.xml')));
  zip.file('ppt/presentation.xml', `${xmlHeader}<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels(relation('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') + relation('rId2', 'slide', 'slides/slide1.xml') + relation('rId3', 'theme', 'theme/theme1.xml')));
  const emptyTree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
  zip.file('ppt/slideMasters/slideMaster1.xml', `${xmlHeader}<p:sldMaster ${ns}>${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(relation('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') + relation('rId2', 'theme', '../theme/theme1.xml')));
  zip.file('ppt/slideLayouts/slideLayout1.xml', `${xmlHeader}<p:sldLayout ${ns} type="blank">${emptyTree}</p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(relation('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')));
  zip.file('ppt/slides/slide1.xml', `${xmlHeader}<p:sld ${ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="685800"/><a:ext cx="7772400" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>PDF Chef QA slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels(relation('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')));
  const colour = (name, value) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
  zip.file('ppt/theme/theme1.xml', `${xmlHeader}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="QA"><a:themeElements><a:clrScheme name="QA">${colour('dk1', '000000')}${colour('lt1', 'FFFFFF')}${colour('dk2', '333333')}${colour('lt2', 'EEEEEE')}${['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(n => colour(n, '3366CC')).join('')}${colour('hlink', '0000FF')}${colour('folHlink', '800080')}</a:clrScheme><a:fontScheme name="QA"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="QA"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function makeFillablePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawText('PDF Chef QA form', { x: 40, y: 250, size: 18 });
  const form = doc.getForm();
  const name = form.createTextField('qa.name');
  name.addToPage(page, { x: 40, y: 200, width: 220, height: 24 });
  const agree = form.createCheckBox('qa.agree');
  agree.addToPage(page, { x: 40, y: 160, width: 18, height: 18 });
  return Buffer.from(await doc.save());
}

/** Encrypts qa-sample.pdf with qpdf's WASM build (browser-only), served to a blank page from node_modules. */
async function makeLockedPdf(chromium) {
  const source = await readFile(qaPdf);
  const base = resolve(root, 'node_modules/qpdf-run');
  const origin = 'http://qpdf.invalid';
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>qpdf</title>' });
      const file = resolve(base, `.${path.replace(/^\/qpdf-run/, '')}`);
      if (!file.startsWith(base) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const ext = file.slice(file.lastIndexOf('.'));
      return route.fulfill({ contentType: types[ext] ?? 'application/octet-stream', body: await readFile(file) });
    });
    await page.goto(`${origin}/`);
    const encoded = await page.evaluate(async ({ bytes, password }) => {
      const { createQpdfRunner } = await import('/qpdf-run/src/index.js');
      const runner = await createQpdfRunner({
        workerUrl: '/qpdf-run/src/worker.js', qpdfJsUrl: '/qpdf-run/vendor/qpdf/lib/qpdf.js',
        wasmUrl: '/qpdf-run/vendor/qpdf/lib/qpdf.wasm', timeoutMs: 60_000,
      });
      try {
        const out = await runner.runOne({
          input: Uint8Array.from(atob(bytes), c => c.charCodeAt(0)), inputName: 'input.pdf', outputName: 'output.pdf',
          args: ['--encrypt', password, password, '128', '--use-aes=y', '--print=full', '--modify=none', '--extract=n', '--', 'input.pdf', 'output.pdf'],
        });
        const data = out.output ?? out.outputs?.['output.pdf'] ?? out;
        let binary = '';
        for (const byte of data instanceof Uint8Array ? data : new Uint8Array(data)) binary += String.fromCharCode(byte);
        return btoa(binary);
      } finally { await runner.destroy(); }
    }, { bytes: source.toString('base64'), password: lockedPdfPassword });
    return Buffer.from(encoded, 'base64');
  } finally { await browser.close(); }
}

export const fixtureFiles = {
  docx: resolve(fixtureDir, 'sample.docx'),
  pptx: resolve(fixtureDir, 'sample.pptx'),
  fillable: resolve(fixtureDir, 'fillable.pdf'),
  locked: resolve(fixtureDir, 'locked.pdf'),
};

/** Writes any missing fixture. Existing files are kept so a run never changes tracked bytes. */
export async function ensureFixtures(chromium) {
  await mkdir(fixtureDir, { recursive: true });
  const makers = {
    docx: makeDocx, pptx: makePptx, fillable: makeFillablePdf, locked: () => makeLockedPdf(chromium),
  };
  for (const [name, make] of Object.entries(makers)) {
    if (existsSync(fixtureFiles[name])) continue;
    await writeFile(fixtureFiles[name], await make());
  }
  const note = resolve(fixtureDir, 'README.md');
  if (!existsSync(note)) {
    await writeFile(note, `# UI fixtures\n\nMade by \`scripts/lib/tool-ui.mjs\` (\`ensureFixtures\`). Delete a file to have it rebuilt.\n\n- \`sample.docx\`: one page, two paragraphs.\n- \`sample.pptx\`: one blank-layout slide.\n- \`fillable.pdf\`: a text field and a checkbox.\n- \`locked.pdf\`: \`qa-sample.pdf\` encrypted with AES-128, password \`${lockedPdfPassword}\`.\n`);
  }
}

// ---------------------------------------------------------------- tools

const F = () => fixtureFiles;
/** Every tool route, the files that put it in its "loaded" state, and a button that reaches a result. */
export const tools = [
  { id: 'view', route: '/view', files: () => [qaPdf] },
  { id: 'make-pdf', route: '/make-pdf', files: () => [photo('tall.jpg'), photo('wide.jpg')] },
  { id: 'compress', route: '/compress', files: () => [qaPdf], result: /^Compress$/ },
  { id: 'merge', route: '/merge', files: () => [qaPdf, F().fillable], result: /^Save the combined PDF$/ },
  { id: 'split', route: '/split', files: () => [qaPdf], result: /^Save the split files$/ },
  { id: 'edit', route: '/edit', files: () => [qaPdf] },
  { id: 'make-fillable', route: '/make-fillable', files: () => [qaPdf] },
  { id: 'sign', route: '/sign', files: () => [qaPdf] },
  // Native-only: the browser build has no file input here, so only the empty state exists.
  { id: 'verify-signatures', route: '/verify-signatures', files: () => [] },
  { id: 'watermark', route: '/watermark', files: () => [qaPdf] },
  { id: 'protect', route: '/protect', files: () => [qaPdf] },
  { id: 'unlock', route: '/unlock', files: () => [F().locked] },
  { id: 'delete-pages', route: '/delete-pages', files: () => [qaPdf] },
  { id: 'page-numbers', route: '/page-numbers', files: () => [qaPdf] },
  { id: 'reorder', route: '/reorder', files: () => [qaPdf] },
  { id: 'rotate', route: '/rotate', files: () => [qaPdf] },
  { id: 'flatten', route: '/flatten', files: () => [F().fillable], result: /^Lock the answers and save$/ },
  { id: 'extract', route: '/extract', files: () => [qaPdf] },
  { id: 'image-to-pdf', route: '/image-to-pdf', files: () => [photo('tall.jpg'), photo('wide.jpg')] },
  { id: 'pdf-to-jpg', route: '/pdf-to-jpg', files: () => [qaPdf] },
  { id: 'pdf-to-word', route: '/pdf-to-word', files: () => [qaPdf] },
  { id: 'word-to-pdf', route: '/word-to-pdf', files: () => [F().docx] },
  { id: 'powerpoint-to-pdf', route: '/powerpoint-to-pdf', files: () => [F().pptx] },
  { id: 'ocr', route: '/ocr', files: () => [qaPdf] },
  { id: 'metadata', route: '/metadata', files: () => [qaPdf] },
  { id: 'repair', route: '/repair', files: () => [qaPdf] },
  { id: 'compare', route: '/compare', files: () => [qaPdf, F().fillable], perInput: true },
  { id: 'crop', route: '/crop', files: () => [qaPdf] },
  { id: 'header-footer', route: '/header-footer', files: () => [qaPdf] },
  { id: 'extract-images', route: '/extract-images', files: () => [qaPdf] },
  { id: 'remove-metadata', route: '/remove-metadata', files: () => [qaPdf] },
  { id: 'remove-annotations', route: '/remove-annotations', files: () => [qaPdf] },
  { id: 'sanitize', route: '/sanitize', files: () => [qaPdf] },
  { id: 'remove-blank-pages', route: '/remove-blank-pages', files: () => [qaPdf] },
  { id: 'batch', route: '/batch', files: () => [qaPdf, F().fillable] },
  { id: 'invoice', route: '/invoice', files: () => [] },
  { id: 'receipt', route: '/receipt', files: () => [] },
  { id: 'quote', route: '/quote', files: () => [] },
];

export const rootScreens = [
  { id: 'home', route: '/' },
  { id: 'recent', route: '/recent' },
  { id: 'settings', route: '/settings' },
];

/** Waits until the screen has no progress bar and no spinner, then lets thumbnails settle. */
export async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.locator('h1').first().waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[role="progressbar"], [aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

/** Puts files into the route's file inputs. `perInput` gives each input one file (Compare). */
export async function loadFiles(page, files, { perInput = false } = {}) {
  const inputs = page.locator('input[type=file]');
  await inputs.first().waitFor({ state: 'attached', timeout: 10_000 });
  if (perInput) {
    const count = await inputs.count();
    for (let index = 0; index < Math.min(count, files.length); index += 1) await inputs.nth(index).setInputFiles(files[index]);
    return;
  }
  const multiple = await inputs.first().evaluate(input => input.multiple);
  await inputs.first().setInputFiles(multiple ? files : files.slice(0, 1));
}

/** Opens a route and, when given files, loads them the way a person would (the file input). */
export async function loadFixture(page, route, files, options = {}) {
  await page.goto(new URL(route, options.origin ?? page.url()).toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor({ timeout: 10_000 });
  if (files.length) {
    await loadFiles(page, files, options);
    await settle(page, options.settleMs);
  }
}

/** Presses the slot (or any opener) whose accessible name matches, and waits for its editor. */
export async function openSlot(page, name) {
  const opener = page.getByRole('button', { name }).first();
  await opener.click();
  const expanded = await opener.getAttribute('aria-expanded');
  if (expanded !== null) await page.waitForFunction(el => el.getAttribute('aria-expanded') === 'true', await opener.elementHandle());
  return opener;
}

export async function closeEditor(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

/**
 * The result sheet, opened with "More actions" when it did not open by itself. It opens by itself
 * only when the person must act: a result already saved and placed stays on the strip (Q1).
 */
export async function openResultSheet(page) {
  const sheet = page.getByRole('dialog').filter({ has: page.locator('[data-result-sheet]') });
  const more = page.getByRole('button', { name: /^More actions for / }).first();
  await more.waitFor();
  // The strip and a sheet that opens by itself arrive together; give the sheet a moment.
  await page.waitForTimeout(300);
  if (await sheet.count() === 0) await more.click();
  await sheet.waitFor();
  return sheet;
}

// ---------------------------------------------------------------- inventory

const interactive = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'combobox', 'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

/** Adds the interactive lines of an aria snapshot to `found`, one record per (role, name). */
function readSnapshot(yaml, found) {
  for (const line of yaml.split('\n')) {
    const match = line.match(/^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)/);
    if (!match || !interactive.has(match[1])) continue;
    const [, role, rawName = '', flagText] = match;
    const name = rawName.replace(/\\(.)/g, '$1');
    const flags = [...flagText.matchAll(/\[([a-z-]+)(?:=[^\]]*)?\]/g)].map(m => m[1])
      .filter(flag => ['expanded', 'haspopup', 'disabled'].includes(flag)).sort();
    const key = `${role}\u0000${name}`;
    const entry = found.get(key) ?? { role, name, count: 0, flags: new Set() };
    entry.count += 1;
    for (const flag of flags) entry.flags.add(flag);
    found.set(key, entry);
  }
}

/**
 * The controls inside slot editors (plan 6.2). A sentence keeps its editors mounted but
 * hidden, so the tree at rest does not list them: press each visible opener with
 * aria-haspopup="dialog" and aria-controls, read the region it opens, then press Escape.
 * Controls already counted at rest are not counted again.
 */
async function readEditors(page, found) {
  for (const [key, entry] of await editorControls(page, new Set(found.keys()))) found.set(key, entry);
}

/**
 * The editor controls on the screen as it is now, minus `atRest`. A result sheet is modal,
 * so the result state reads its editors just before the result action and passes them
 * to collectControls as `editors`.
 */
export async function editorControls(page, atRest) {
  if (!atRest) {
    const rest = new Map();
    readSnapshot(await page.locator('body').ariaSnapshot({ timeout: 20_000 }), rest);
    atRest = new Set(rest.keys());
  }
  const openers = await page.locator('[aria-haspopup="dialog"][aria-controls]:visible').all();
  const extra = new Map();
  for (const opener of openers) {
    try {
      if (await opener.isDisabled()) continue;
      const id = await opener.getAttribute('aria-controls');
      await opener.click({ timeout: 3_000 });
      const region = page.locator(`[id="${id}"]`);
      await region.waitFor({ state: 'visible', timeout: 3_000 });
      const local = new Map();
      readSnapshot(await region.ariaSnapshot({ timeout: 10_000 }), local);
      for (const [key, entry] of local) {
        if (atRest.has(key)) continue;
        const kept = extra.get(key);
        if (!kept || kept.count < entry.count) extra.set(key, entry);
      }
      await page.keyboard.press('Escape');
      await region.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
    } catch { /* an opener that cannot open is reported by the comparison as missing controls */ }
  }
  return extra;
}

/** Reads the accessibility tree and returns one record per (role, name): count and state flags. */
export async function collectControls(page, { editors = true } = {}) {
  const yaml = await page.locator('body').ariaSnapshot({ timeout: 20_000 });
  const found = new Map();
  readSnapshot(yaml, found);
  if (editors instanceof Map) {
    for (const [key, entry] of editors) if (!found.has(key)) found.set(key, entry);
  } else if (editors) await readEditors(page, found);
  const controls = [...found.values()].map(e => ({ role: e.role, name: e.name, count: e.count, flags: [...e.flags] }))
    .sort((a, b) => (a.role + a.name).localeCompare(b.role + b.name));
  const dom = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    // The touch target, not the drawn box: a control may keep a smaller visual box and reach
    // 48 px through an absolutely placed ::before/::after (the kit's hit-area extension), and an
    // input inside a <label> (or named by one) is pressed through that label.
    const px = (value) => (value === 'auto' || value === '' || value === 'none' ? null : parseFloat(value));
    // The used box of each absolutely placed pseudo-element (its resolved insets and size, plus its
    // transform's translation), joined with the element's own box.
    const hitBox = (el) => {
      const r = el.getBoundingClientRect();
      let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      if (getComputedStyle(el).position !== 'static') {
        for (const pseudo of ['::before', '::after']) {
          const style = getComputedStyle(el, pseudo);
          if (style.content === 'none' || style.content === 'normal' || style.position !== 'absolute' || style.display === 'none') continue;
          const width = px(style.width);
          const height = px(style.height);
          const left = px(style.left);
          const top = px(style.top);
          if (width === null || height === null || left === null || top === null) continue;
          const m = style.transform.match(/matrix\(([^)]+)\)/);
          const [tx, ty] = m ? m[1].split(',').slice(4).map(Number) : [0, 0];
          const x = r.left + el.clientLeft + left + tx;
          const y = r.top + el.clientTop + top + ty;
          box = {
            left: Math.min(box.left, x), top: Math.min(box.top, y),
            right: Math.max(box.right, x + width), bottom: Math.max(box.bottom, y + height),
          };
        }
      }
      return [Math.round(box.right - box.left), Math.round(box.bottom - box.top)];
    };
    // An input is also pressed through its <label>: count whichever of the two is the larger target.
    const measure = (el) => {
      const own = hitBox(el);
      if (!el.matches('input')) return own;
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (!label || !visible(label)) return own;
      const viaLabel = hitBox(label);
      return Math.min(...viaLabel) > Math.min(...own) ? viaLabel : own;
    };
    const describe = (el) => {
      const name = el.getAttribute('aria-label') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) || el.getAttribute('title') || el.getAttribute('type') || '';
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} "${name}"`;
    };
    const smallList = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="link"], input:not([type=hidden]):not([type=file])')]
      // A visually hidden element (sr-only, 1x1 and clipped) is not a touch target until focus shows it.
      .filter(el => visible(el) && !(el.getBoundingClientRect().width <= 1 && el.getBoundingClientRect().height <= 1))
      .map(el => ({ el, size: measure(el) }))
      .filter(({ size }) => size[0] < 48 || size[1] < 48)
      .map(({ el, size }) => `${describe(el)} ${size[0]}x${size[1]}`);
    const small = smallList.length;
    return {
      colorInputs: [...document.querySelectorAll('input[type=color]')].filter(visible).length,
      fileInputs: [...document.querySelectorAll('input[type=file]')].map(i => ({ multiple: i.multiple, accept: i.accept })),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      headings: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()),
      under48: small,
      under48List: smallList.slice(0, 40),
    };
  });
  return { controls, ...dom };
}

export const controlKey = (control) => `${control.role}\u0000${control.name}`;
