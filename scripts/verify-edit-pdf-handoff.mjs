/** Closing a PDF handed off from Read must not consume the same history request again. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([600, 800]).drawText('Handoff close regression', { x: 70, y: 700, size: 18, font });
const fixture = { name: 'handoff.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, keepLocalHistory: false, autoDownload: false })));
  await page.goto(`${process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173'}/view`);
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit PDF', exact: true }).click();
  await page.getByRole('button', { name: 'Close editor', exact: true }).waitFor({ timeout: 60000 });
  console.log('Handoff opened editor');
  await page.locator('[data-testid="pdf-text-block"]').first().waitFor({ timeout: 60000 });
  console.log('Initial paragraph rendered');
  assert.equal(await page.evaluate(() => history.state?.usr?.useOpenedPdf), false);
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: 'Choose file', exact: true }).waitFor();
  // Allow pending PDF loading/cleanup effects to finish before asserting the upload stays put.
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole('button', { name: 'Close editor', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Choose file', exact: true }).isVisible(), true);
  // The explicit action still works after consuming the automatic handoff.
  console.log('Closed editor stayed closed');
  await page.getByRole('button', { name: 'Use handoff.pdf', exact: true }).click();
  await page.locator('[data-testid="pdf-text-block"]').first().waitFor({ timeout: 60000 });
  assert.match(await page.locator('[data-testid="pdf-text-block"]').first().textContent(), /Handoff close regression/);
  console.log('PASS Read → Edit → Close remains closed; explicit reuse renders the document again.');
} finally { await browser.close(); }
