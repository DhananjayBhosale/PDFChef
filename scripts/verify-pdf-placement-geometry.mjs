import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, degrees } from 'pdf-lib';

// Run against the source Vite server so the real service exports can be exercised.
const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const outputDir = path.resolve('output/pdf-geometry-verification');
await fs.mkdir(outputDir, { recursive: true });
const fixtures = [];
for (const rotation of [0, 90, 180, 270]) {
  for (const cropped of [false, true]) {
    const pdf = await PDFDocument.create();
    const width = rotation % 180 ? 600 : 400;
    const height = rotation % 180 ? 400 : 600;
    const page = pdf.addPage([width + (cropped ? 110 : 0), height + (cropped ? 130 : 0)]);
    if (cropped) page.setCropBox(40, 60, width, height);
    page.setRotation(degrees(rotation));
    fixtures.push({ rotation, cropped, bytes: Array.from(await pdf.save()) });
  }
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({ onboardingComplete: true, autoDownload: false, keepLocalHistory: false, confirmLargeJobs: false, largeFileWarningMb: 80 }));
  });
  // Other audit agents may edit unrelated files; HMR must not reload an in-flight check.
  await page.routeWebSocket("**", (socket) => socket.close());
  await page.goto(baseUrl);
  const report = await page.evaluate(async (fixtures) => {
    const services = await import('/services/pdfDocument.ts');
    const { createFillablePdf } = await import('/services/fillableForms.ts');
    const { loadPDFDocument } = await import('/services/pdfBrowser.ts');
    const { getPdfPreviewLayoutSize } = await import('/services/pdfPageGeometry.ts');
    const signature = document.createElement('canvas');
    signature.width = 120;
    signature.height = 50;
    const signContext = signature.getContext('2d');
    signContext.fillStyle = '#e11d48';
    signContext.fillRect(0, 0, 120, 50);
    signContext.fillStyle = '#1d4ed8';
    signContext.fillRect(0, 0, 30, 15);
    const operations = {
      signature: (file) => services.applySignaturesToPDF(file, [{ pageIndex: 0, dataUrl: signature.toDataURL(), x: 0.2, y: 0.35, width: 0.3, aspectRatio: 2.4 }]),
      watermark: (file) => services.addWatermarkToPDF(file, { text: 'CONFIDENTIAL', size: 28, opacity: 1, rotation: 32, color: '#225599', xPercent: 0.35, yPercent: 0.4 }),
      pageNumber: (file) => services.addPageNumbersToPDF(file, { format: 'Page {n}', fontSize: 16, xPercent: 0.25, yPercent: 0.2, startPage: 1, endPage: 1 }),
      headerFooter: (file) => services.addHeaderFooterToPDF(file, { headerText: 'HEADER', footerText: 'FOOTER', fontSize: 14, includePageNumbers: false }),
      fillable: (file) => createFillablePdf(file, ['text', 'multiline', 'checkbox', 'radio', 'dropdown'].map((kind, index) => ({ id: `field-${index}`, name: `field_${index}`, kind, pageIndex: 0, x: 0.2, y: 0.15 + index * 0.15, width: 0.3, height: 0.08, required: true, options: ['First', 'Second'], radioGroup: 'choice' }))),
    };
    const results = [];
    for (const [operation, exportPdf] of Object.entries(operations)) {
      let reference;
      for (const fixture of fixtures) {
        const bytes = await exportPdf(new File([new Uint8Array(fixture.bytes)], 'geometry.pdf', { type: 'application/pdf' }));
        const pdf = await loadPDFDocument(new File([bytes], 'result.pdf', { type: 'application/pdf' }));
        try {
          const pdfPage = await pdf.getPage(1);
          const size = getPdfPreviewLayoutSize(pdfPage);
          if (size.width !== 400 || size.height !== 600) throw new Error(`Wrong visible size: ${JSON.stringify(size)}`);
          const viewport = pdfPage.getViewport({ scale: 1 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          await pdfPage.render({ canvasContext: context, viewport }).promise;
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const ink = pixels.reduce((sum, value, index) => sum + (index % 4 !== 3 && value < 230 ? 1 : 0), 0);
          if (ink < 50) throw new Error(`${operation} produced a blank preview`);
          if (!reference) reference = pixels;
          let mismatchedPixels = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (Math.max(...[0, 1, 2].map((channel) => Math.abs(pixels[i + channel] - reference[i + channel]))) > 20) mismatchedPixels++;
          }
          // Equivalent visual pages must put marks at the same position and orientation.
          // A few edge pixels may differ due to font rasterization after a right-angle transform.
          if (mismatchedPixels > 100) throw new Error(`${operation}: rotation ${fixture.rotation}, crop ${fixture.cropped}: ${mismatchedPixels} different pixels`);
          if (operation === 'fillable') {
            const annotations = await pdfPage.getAnnotations();
            if (annotations.length !== 5) throw new Error(`Expected 5 form widgets, got ${annotations.length}`);
            annotations.forEach((annotation, index) => {
              const [a, b, c, d, e, f] = viewport.transform;
              const [x1, y1, x2, y2] = annotation.rect;
              const rect = [a * x1 + c * y1 + e, b * x1 + d * y1 + f, a * x2 + c * y2 + e, b * x2 + d * y2 + f];
              const actual = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1])];
              const expected = [80, (0.15 + index * 0.15) * 600, 120, 48];
              if (actual.some((value, offset) => Math.abs(value - expected[offset]) > 1.1)) throw new Error(`Field misplaced: ${JSON.stringify({ actual, expected })}`);
              if (annotation.rotation !== fixture.rotation) throw new Error(`Field orientation ${annotation.rotation} does not compensate page rotation ${fixture.rotation}`);
            });
          }
          results.push({ operation, rotation: fixture.rotation, cropped: fixture.cropped, mismatchedPixels, ink });
        } finally { await pdf.destroy(); }
      }
    }
    return results;
  }, fixtures);
  assert.equal(report.length, 40);
  const previewResults = [];
  const fixture = fixtures.find((item) => item.rotation === 90 && item.cropped);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of ['/watermark', '/page-numbers']) {
      await page.goto(`${baseUrl}${route}`);
      await page.locator('input[type=file]').setInputFiles({ name: 'rotated-cropped.pdf', mimeType: 'application/pdf', buffer: Buffer.from(fixture.bytes) });
      const preview = page.locator('svg').filter({ has: page.locator('text') }).first();
      await preview.waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('svg')).some((svg) => svg.querySelector('text') && svg.viewBox.baseVal.width === 400));
      const geometry = await preview.evaluate((svg) => ({ width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height, fontSize: Number(svg.querySelector('text').getAttribute('font-size')), textWidth: Number(svg.querySelector('text').getAttribute('textLength')) }));
      assert.equal(geometry.width, 400);
      assert.equal(geometry.height, 600);
      assert.ok(geometry.fontSize > 0 && geometry.textWidth > 0, 'Preview must use actual export font metrics');
      previewResults.push({ route, viewport, ...geometry });
      await page.screenshot({ path: path.join(outputDir, `${route.slice(1)}-${viewport.width}.png`), fullPage: true });
    }
  }
  await fs.writeFile(path.join(outputDir, 'preview-report.json'), `${JSON.stringify(previewResults, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS: ${report.length} actual PDF exports preserve placement and orientation across crop offsets and all page rotations.`);
} finally { await browser.close(); }
