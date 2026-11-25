import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { computeGridFit, GRID_LABEL_HEIGHT } from '../../components/Tool/gridFit.ts';

test('three pages on a 1440 × 900 desktop canvas fill it: three tiles 420 px wide (plan 2.4)', () => {
  const fit = computeGridFit({ width: 1376, height: 640, count: 3, aspect: 0.75, wide: true });
  assert.deepEqual(fit, { columns: 3, tile: 420, gap: 16, fits: true });
});

test('the column count with the largest tile wins, and every page stays in view', () => {
  for (const [width, height, count] of [[1376, 640, 12], [1376, 800, 10], [900, 700, 8], [366, 420, 4]] as const) {
    const wide = width > 1000;
    const fit = computeGridFit({ width, height, count, aspect: 0.75, wide });
    assert.equal(fit.fits, true, `${width}×${height} ${count}`);
    const rows = Math.ceil(count / fit.columns);
    assert.ok(fit.columns * fit.tile + (fit.columns - 1) * fit.gap <= width, 'fits across');
    assert.ok(rows * (fit.tile / 0.75 + GRID_LABEL_HEIGHT) + (rows - 1) * fit.gap <= height + 1, 'fits down');
    for (let columns = 1; columns <= Math.min(count, 12); columns += 1) {
      const r = Math.ceil(count / columns);
      const other = Math.min(wide ? 420 : width, (width - fit.gap * (columns - 1)) / columns, ((height - fit.gap * (r - 1)) / r - GRID_LABEL_HEIGHT) * 0.75);
      assert.ok(Math.floor(other) <= fit.tile, `${columns} columns would not be larger`);
    }
  }
});

test('a short phone canvas puts three pages in three columns', () => {
  const fit = computeGridFit({ width: 366, height: 180, count: 3, aspect: 0.75, wide: false });
  assert.deepEqual(fit, { columns: 3, tile: 114, gap: 12, fits: true });
});

test('a phone tile is never wider than the canvas', () => {
  const fit = computeGridFit({ width: 366, height: 2000, count: 1, aspect: 0.75, wide: false });
  assert.equal(fit.columns, 1);
  assert.equal(fit.tile, 366);
});

test('too many pages to fit: desktop uses 168 px tiles in as many columns as fit, phone uses 3 columns', () => {
  assert.deepEqual(computeGridFit({ width: 1376, height: 640, count: 200, aspect: 0.75, wide: true }), { columns: 7, tile: 168, gap: 16, fits: false });
  assert.deepEqual(computeGridFit({ width: 366, height: 400, count: 200, aspect: 0.75, wide: false }), { columns: 3, tile: 114, gap: 12, fits: false });
  assert.deepEqual(computeGridFit({ width: 366, height: 40, count: 2, aspect: 0.75, wide: false }).columns, 2);
});

test('a tile that carries controls keeps its minimum: Create PDF on a phone drops to two columns', () => {
  assert.deepEqual(computeGridFit({ width: 366, height: 400, count: 12, aspect: 0.75, wide: false, minTile: 150, labelHeight: 76 }), { columns: 2, tile: 177, gap: 12, fits: false });
  const roomy = computeGridFit({ width: 1376, height: 640, count: 3, aspect: 0.75, wide: true, minTile: 150, labelHeight: 76 });
  assert.equal(roomy.fits, true);
  assert.ok(roomy.tile >= 150);
  assert.equal(computeGridFit({ width: 1376, height: 300, count: 40, aspect: 0.75, wide: true, minTile: 200 }).tile, 200);
});

test('Reorder on a phone: a 3 or 4-page file fits above the foot sheet in two columns, arrows included (pass 4)', () => {
  // Canvas room under the grid at 390 × 844 (580 px) and 360 × 800 (536 px); 84 px is the label
  // and move row under each 3:4 picture, and 100 px keeps each move button 48 px wide.
  const sizing = { aspect: 0.75, wide: false, minTile: 100, labelHeight: 84 };
  for (const [width, height] of [[358, 580], [328, 536]] as const) {
    for (const count of [3, 4]) {
      const fit = computeGridFit({ width, height, count, ...sizing });
      assert.equal(fit.fits, true, `${width} ${count} pages fit`);
      assert.equal(fit.columns, 2, `${width} ${count} pages: two columns`);
      const rows = Math.ceil(count / fit.columns);
      assert.ok(rows * (fit.tile / 0.75 + 84) + (rows - 1) * fit.gap <= height, `${width} ${count} pages: last move row above the sheet`);
      assert.ok(fit.tile / 2 >= 48, 'each move button stays 48 px wide');
    }
    assert.equal(computeGridFit({ width, height, count: 2, ...sizing }).columns, 2);
    assert.equal(computeGridFit({ width, height, count: 6, ...sizing }).columns, 3);
    assert.deepEqual(computeGridFit({ width, height, count: 7, ...sizing }).fits, false);
  }
  // The phone grid reports its fit, so its pictures are redrawn sharp, and its page box stays 3:4.
  const reorder = readFileSync(new URL('../../components/Tools/ReorderPDF.tsx', import.meta.url), 'utf8');
  assert.match(reorder, /const phoneFit = usePageGridFit\(phoneGridRef, [^;]*\{ minTile: 100, labelHeight: 84 \}\);/);
  assert.match(reorder, /if \(phoneFit\) onGridFit\(phoneFit\);/);
  assert.match(reorder, /ref=\{phoneGridRef\}\s*className="tk-rgrid"/);
  const css = readFileSync(new URL('../../components/Tool/tool.css', import.meta.url), 'utf8');
  assert.match(css, /\.tk-rgrid\[data-fit="fill"\] \{ grid-template-columns: repeat\(var\(--grid-cols\), var\(--tile-w\)\);/);
  assert.match(css, /\.tk-rgrid \.tk-rtile-page \{ min-height: 0;/);
});
