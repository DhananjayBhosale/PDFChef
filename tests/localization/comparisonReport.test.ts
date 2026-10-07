import assert from 'node:assert/strict';
import test from 'node:test';
import { createComparisonReport } from '../../services/comparisonReport.ts';
import { formatDate, formatNumber, formatPercent, getLocale } from '../../services/i18n/core.ts';

const dateOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
};

test('comparison report localizes labels and formatting while preserving files and extracted text', () => {
  const generatedAt = new Date(2026, 0, 2, 3, 4, 5);
  const longExcerpt = `${'Keep {v0} <original> € '.repeat(20)}TRAILING_SENTINEL`;
  const report = createComparisonReport({
    generatedAt,
    fileA: { name: 'Invoice <draft> — original.pdf', pageCount: 1200, sizeBytes: 1_234_567 },
    fileB: { name: 'فاتورة final.pdf', pageCount: 1199, sizeBytes: 9_876_543 },
    pageCountEqual: false,
    firstPageTextEqual: null,
    firstPageSignatureA: '',
    firstPageSignatureB: 'Customer {v0}: original wording €29.00',
    pageSignaturesA: ['', longExcerpt, 'Old wording', 'Four', 'Five'],
    pageSignaturesB: ['', 'New wording', 'Changed wording', 'Four', 'Five'],
    pagesCompared: 5,
    identicalPageCount: 2,
    differentPages: [2, 3],
    unavailablePages: [1],
    matchRatio: 50,
    commonPages: 7,
  });

  assert.match(report, /PDF Chef Compare Summary/);
  assert.match(report, new RegExp(`Generated: ${formatDate(generatedAt, dateOptions).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(report, /File A: Invoice <draft> — original\.pdf/);
  assert.match(report, /File B: فاتورة final\.pdf/);
  assert.match(report, new RegExp(`Pages: ${formatNumber(1200)}`));
  assert.match(report, new RegExp(`Size: ${formatNumber(1_234_567)} bytes`));
  assert.match(report, /Page count equal: No/);
  assert.match(report, /First-page extracted text equal: unavailable/);
  assert.match(report, /First-page text excerpt A:\n<empty>/);
  assert.match(report, /Customer \{v0\}: original wording €29\.00/);
  assert.match(report, new RegExp(`Share of pages with extractable text where wording matches: ${formatPercent(50)}`));
  assert.match(report, /compared first 5 common pages only/);

  const list = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format([formatNumber(2), formatNumber(3)]);
  assert.ok(report.includes(`Pages with different extracted text:\n${list}`));
  assert.ok(report.includes(longExcerpt.slice(0, 180)));
  assert.ok(!report.includes('TRAILING_SENTINEL'));
  assert.ok(report.includes('A extracted text: Keep {v0} <original> €'));
  assert.ok(report.includes('B extracted text: New wording'));
});

test('comparison report localizes empty and unavailable markers when no wording can be compared', () => {
  const report = createComparisonReport({
    generatedAt: new Date(2026, 0, 2),
    fileA: { name: 'scan-a.pdf', pageCount: 1, sizeBytes: 10 },
    fileB: { name: 'scan-b.pdf', pageCount: 1, sizeBytes: 20 },
    pageCountEqual: true,
    firstPageTextEqual: null,
    firstPageSignatureA: '',
    firstPageSignatureB: '',
    pageSignaturesA: [''],
    pageSignaturesB: [''],
    pagesCompared: 1,
    identicalPageCount: 0,
    differentPages: [],
    unavailablePages: [1],
    matchRatio: null,
    commonPages: 1,
  });

  assert.match(report, /Page count equal: Yes/);
  assert.match(report, /First-page extracted text equal: unavailable/);
  assert.match(report, /Share of pages with extractable text where wording matches: unavailable/);
  assert.match(report, /First-page text excerpt A:\n<empty>/);
  assert.match(report, /First-page text excerpt B:\n<empty>/);
  assert.match(report, /Pages with different extracted text:\n<none>/);
  assert.match(report, /Extracted-text details \(truncated\):\n<none>/);
});
