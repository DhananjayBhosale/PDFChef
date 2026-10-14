import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright';

const output = resolve(process.env.PDF_CHEF_VALIDATION_OUTPUT || 'output/pdf-label-validation');
const base = process.env.PDF_CHEF_BASE_URL || 'http://127.0.0.1:4195';
await mkdir(output, { recursive: true });
const pdf = await PDFDocument.create();
pdf.addPage([400, 600]);
const buffer = Buffer.from(await pdf.save());
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const route of ['watermark', 'page-numbers']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, onboardingComplete: true }));
      sessionStorage.setItem('pdfchef.mobileAppWelcome.dismissed', '1');
      window.__labelOutputs = [];
      window.addEventListener('pdfchef:output-ready', event => window.__labelOutputs.push(event.detail.name));
    });
    await page.goto(`${base}/${route}`);
    await page.locator('input[type=file]').setInputFiles({ name: 'labels.pdf', mimeType: 'application/pdf', buffer });
    await page.locator('img[src^="blob:"]').first().waitFor();
    const field = route === 'watermark' ? page.locator('input[placeholder="CONFIDENTIAL"]') : page.locator('#page-numbers-format');
    const save = page.getByRole('button', { name: route === 'watermark' ? /Save stamped PDF/i : /Save numbered PDF/i });
    for (const text of ['गोपनीय', '保密', '📄']) {
      await field.fill(text);
      await page.locator('[role=alert]').filter({ hasText: 'This PDF font cannot display' }).waitFor();
      assert.equal(await field.inputValue(), text, 'input must remain editable and intact');
      assert.equal(await save.isDisabled(), true);
      assert.equal(await page.getByRole('heading', { name: 'Unexpected Application Error!' }).count(), 0);
    }
    await page.screenshot({ path: `${output}/${route}-validation.png`, fullPage: true });
    await field.fill(route === 'watermark' ? 'Résumé' : 'Page {n} of {total}');
    await page.locator('[role=alert]').filter({ hasText: 'This PDF font cannot display' }).waitFor({ state: 'hidden' });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.waitForFunction(() => window.__labelOutputs.length === 1);
    assert.deepEqual(errors, []);
    results.push({ route, rejectedSafely: ['Hindi', 'CJK', 'emoji'], recoveredAndExported: true, errors });
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
