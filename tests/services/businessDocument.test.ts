import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inflateSync } from 'node:zlib';

import {
  businessDocumentFileName,
  BusinessDocumentValidationError,
  lineAmountOf,
  parseDocumentNumber,
  documentWording,
  formatMoney,
  formatUnitPrice,
  renderBusinessDocument,
  totalsOf,
  type BusinessDocument,
  type BusinessFontName,
  type BusinessFontSource,
} from '../../services/documents/businessDocument.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { loadDevanagariFonts, type DevanagariFontId } from '../../services/pdfDevanagari.ts';

const party = { name: 'Harlow & Wren Ltd', address: '4 Cathedral Square', email: 'a@b.co' };

const document = (over: Partial<BusinessDocument> = {}): BusinessDocument => ({
  kind: 'invoice',
  reference: 'INV-1042',
  issuedOn: '7 September 2026',
  from: { name: 'Bright Fox Studio' },
  to: party,
  currency: '£',
  items: [
    { description: 'Design', quantity: 2, unitPrice: 100 },
    { description: 'Build', quantity: 1, unitPrice: 50.5 },
  ],
  ...over,
});

const startsWithPdfHeader = (bytes: Uint8Array) =>
  String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';

/* ------------------------------------------------------------- totals --- */

test('a total is the sum of its lines, never a number stored beside them', () => {
  const totals = totalsOf(document());
  assert.equal(totals.subtotal, 250.5);
  assert.equal(totals.tax, 0);
  assert.equal(totals.total, 250.5);
});

test('tax is a percentage of the subtotal, rounded to the penny', () => {
  // 250.5 x 20% is 50.1 exactly; the classic float result is 50.099999999999994.
  const totals = totalsOf(document({ taxRate: 20 }));
  assert.equal(totals.tax, 50.1);
  assert.equal(totals.total, 300.6);
});

test('a line someone half-typed counts as nothing rather than breaking the sum', () => {
  const totals = totalsOf(document({
    items: [
      { description: 'Real', quantity: 2, unitPrice: 10 },
      { description: 'Blank', quantity: Number.NaN, unitPrice: Number.NaN },
      { description: 'Empty', quantity: 0, unitPrice: 0 },
    ],
  }));
  assert.equal(totals.total, 20);
});

/* -------------------------------------------------------------- money --- */

test('money reads the way it is written down', () => {
  assert.equal(formatMoney(1234567.5, '£'), '£1,234,567.50');
  assert.equal(formatMoney(0, '$'), '$0.00');
  assert.equal(formatMoney(-40, '£'), '-£40.00');
  // A word needs air where a single mark does not.
  assert.equal(formatMoney(12, 'USD'), 'USD 12.00');
  assert.equal(formatMoney(12, ''), '12.00');
});

/* ------------------------------------------------------------ wording --- */

test('each document says what it is and what its last number means', () => {
  assert.equal(documentWording('invoice').total, 'Amount due');
  assert.equal(documentWording('receipt').total, 'Amount paid');
  assert.equal(documentWording('quote').settled, 'Valid until');
  // The three are one form, so the recipient line has to change with the kind.
  assert.equal(documentWording('receipt').recipient, 'Received from');
});

/* ------------------------------------------------------------ drawing --- */

for (const kind of ['invoice', 'receipt', 'quote'] as const) {
  test(`a ${kind} renders to a real PDF`, async () => {
    const bytes = await renderBusinessDocument(document({ kind, taxRate: 20 }));
    assert.ok(startsWithPdfHeader(bytes), 'output must be a PDF');
    assert.ok(bytes.length > 800, 'a drawn page is not a stub');
  });
}

const fontFiles: Record<BusinessFontName, string> = {
  'LiberationSans-Regular': 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
  'LiberationSans-Bold': 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf',
  'NotoSans-LatinExt-Regular': 'node_modules/@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff',
  'NotoSans-LatinExt-Bold': 'node_modules/@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff',
  'NotoSans-Vietnamese-Regular': 'node_modules/@fontsource/noto-sans/files/noto-sans-vietnamese-400-normal.woff',
  'NotoSans-Vietnamese-Bold': 'node_modules/@fontsource/noto-sans/files/noto-sans-vietnamese-700-normal.woff',
};
const devanagariFiles: Record<DevanagariFontId, string> = {
  MuktaRegular: 'Mukta-Regular.ttf', MuktaBold: 'Mukta-Bold.ttf', MartelRegular: 'Martel-Regular.ttf', MartelBold: 'Martel-Bold.ttf',
};
const fontsRead: BusinessFontName[] = [];
const diskFonts: BusinessFontSource = {
  read: async (name) => {
    fontsRead.push(name);
    return new Uint8Array(readFileSync(fontFiles[name]));
  },
  loadDevanagari: () => loadDevanagariFonts(async (id) => new Uint8Array(readFileSync(
    new URL(`../../assets/fonts/pdf-edit/${devanagariFiles[id as keyof typeof devanagariFiles]}`, import.meta.url),
  ))),
};

const pageText = async (bytes: Uint8Array) => {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const content = await (await pdf.getPage(number)).getTextContent();
    pages.push(content.items.map((item: any) => item.str).join(''));
  }
  return pages.join('\n');
};

const embeddedFontPrograms = async (bytes: Uint8Array) => {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context.enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object) => object instanceof PDFDict && object.get(PDFName.of('Type'))?.toString() === '/FontDescriptor')
    .filter((object) => (object as PDFDict).get(PDFName.of('FontFile2')) || (object as PDFDict).get(PDFName.of('FontFile3')))
    .map((object) => String((object as PDFDict).get(PDFName.of('FontName'))));
};

test('text Helvetica can write keeps Helvetica, with no font file embedded and none read', async () => {
  fontsRead.length = 0;
  const bytes = await renderBusinessDocument(document({ notes: 'Café “Quoted” — and … €' }), diskFonts);
  assert.deepEqual(fontsRead, []);
  assert.deepEqual(await embeddedFontPrograms(bytes), []);
});

test('Polish, Turkish, Vietnamese, Cyrillic and Greek text, and zł, ₺ and ₩, are drawn with embedded fonts', async () => {
  const samples = {
    from: 'Łódź Spółka zł',
    to: 'İstanbul Şirketi Ğ ı ₺',
    notes: 'Nguyễn Đức Thắng, ước mơ ở Việt Nam ₫',
    address: 'Москва, улица Ленина',
    reference: 'Αθήνα 42',
  };
  const bytes = await renderBusinessDocument(document({
    reference: samples.reference,
    from: { name: samples.from },
    to: { name: samples.to, address: samples.address },
    currency: '₩',
    notes: samples.notes,
  }), diskFonts);
  const drawn = await pageText(bytes);
  for (const sample of Object.values(samples)) assert.ok(drawn.includes(sample), `${sample} is missing from: ${drawn}`);
  assert.ok(drawn.includes('₩200.00'), 'the won sign prints beside its amount');
  const fonts = await embeddedFontPrograms(bytes);
  assert.ok(fonts.some((name) => name.includes('Liberation')) && fonts.some((name) => name.includes('Noto')), String(fonts));
  // Liberation Sans alone is 140 KB a weight; only the letters used are embedded.
  assert.ok(bytes.length < 60_000, `a short invoice stays small, got ${bytes.length} bytes`);
});

test('Hindi is shaped with the Devanagari fonts and reads back in order', async () => {
  const bytes = await renderBusinessDocument(document({
    to: { name: 'राहुल शर्मा' },
    notes: 'धन्यवाद, फिर मिलेंगे।',
  }), diskFonts);
  const drawn = await pageText(bytes);
  assert.ok(drawn.includes('राहुल') && drawn.includes('शर्मा'), drawn);
  assert.ok(drawn.includes('धन्यवाद') && drawn.includes('मिलेंगे।'), drawn);
});

test('text no font here can draw is refused, and the message names the field to fix', async () => {
  const cases: Array<[Partial<BusinessDocument>, RegExp]> = [
    [{ to: { name: '東京商事' } }, /^Client name uses letters this PDF cannot print yet: 東 京 商 事$/],
    [{ from: { name: 'Studio', address: 'شارع' } }, /^Your address uses letters this PDF cannot print yet: ش/],
    [{ items: [{ description: 'Fine', quantity: 1, unitPrice: 1 }, { description: '서울 출장', quantity: 1, unitPrice: 1 }] }, /^Line 2 uses letters this PDF cannot print yet: 서/],
    [{ notes: 'Congratulations 🎉' }, /^Notes uses letters this PDF cannot print yet: 🎉$/],
    [{ notes: 'Hidden \u0080 control' }, /^Notes uses letters this PDF cannot print yet: U\+0080$/],
    [{ reference: '№ 東' }, /^Invoice number uses letters/],
  ];
  for (const [over, message] of cases) {
    await assert.rejects(renderBusinessDocument(document(over), diskFonts), (error: unknown) =>
      error instanceof BusinessDocumentValidationError && message.test(error.message));
  }
});

test('the field named in the message is translated with the rest of it', async () => {
  const error = await renderBusinessDocument(document({ to: { name: '東' } }), diskFonts).catch((caught) => caught);
  assert.equal(localizeError(error), 'Client name uses letters this PDF cannot print yet: 東');
  assert.equal(error.translatedValues.v0, 'business-document.client.name.b6626c');
});

const pageStreams = async (bytes: Uint8Array) => {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map(page => {
    const contents = page.node.Contents() as PDFArray;
    return Array.from({ length: contents.size() }, (_, i) => {
      const stream = pdf.context.lookup(contents.get(i)) as PDFRawStream;
      return inflateSync(stream.contents).toString();
    }).join('\n');
  });
};

const assertTextOnPages = (streams: string[]) => {
  for (const stream of streams) {
    for (const match of stream.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)) {
      assert.ok(Number(match[1]) >= 53.9 && Number(match[1]) <= 541.3, `text outside horizontal margin: ${match[0]}`);
      assert.ok(Number(match[2]) >= 54 && Number(match[2]) <= 788, `text outside vertical margin: ${match[0]}`);
    }
  }
};

test('Helvetica-supported accents and smart punctuation retain their actual glyphs', async () => {
  const streams = await pageStreams(await renderBusinessDocument(document({ notes: 'Café “Quoted” — and … €' })));
  assert.ok(streams.join('').includes('436166E9209351756F74656494209720616E6420852080'));
});

test('decimal parsing preserves grouped values and refuses ambiguous or malformed input', () => {
  for (const [raw, value] of [['1,234.50', 1234.5], ['12.', 12], ['.25', .25], ['', 0], ['-2.5', -2.5]] as const) {
    assert.equal(parseDocumentNumber(raw), value);
  }
  for (const raw of ['1e3', '$12', '12abc34', '1,2', '1.2.3', '-', 'Infinity']) {
    assert.ok(Number.isNaN(parseDocumentNumber(raw)), raw);
  }
});

test('subtotal and displayed line amounts share the same rounding, including credits', () => {
  for (const sign of [1, -1]) {
    const items = [1, 2].map(() => ({ description: 'Fractional price', quantity: 1, unitPrice: sign * .005 }));
    assert.equal(lineAmountOf(items[0]), sign * .01);
    assert.equal(totalsOf(document({ items })).subtotal, sign * .02);
    assert.equal(formatMoney(sign * .005, '$'), sign > 0 ? '$0.01' : '-$0.01');
  }
});

test('invalid or overflowing financial values cannot be exported as zero or infinity', async () => {
  for (const unitPrice of [NaN, Infinity, 1e22, 1e308]) {
    await assert.rejects(renderBusinessDocument(document({
      items: [{ description: 'Invalid', quantity: 10, unitPrice }],
    })), BusinessDocumentValidationError);
  }
});

test('one description can continue across many pages without losing its last line', async () => {
  const streams = await pageStreams(await renderBusinessDocument(document({
    items: [{ description: [...Array(200).fill('One item with many lines'), 'END OF DESCRIPTION'].join('\n'), quantity: 1, unitPrice: 10 }],
  })));
  assert.ok(streams.length >= 4);
  assert.ok(streams.join('').includes('454E44204F46204445534352495054494F4E'));
  assertTextOnPages(streams);
});

test('long header and recipient blocks paginate before the table begins', async () => {
  const streams = await pageStreams(await renderBusinessDocument(document({
    from: { name: 'Sender '.repeat(100), address: Array(100).fill('Sender address').join('\n') },
    reference: 'Reference '.repeat(150),
    to: { name: 'Recipient '.repeat(100), address: Array(58).fill('Recipient address').join('\n') },
  })));
  assert.ok(streams.length >= 4);
  assertTextOnPages(streams);
});

test('unbroken words wrap within the column instead of disappearing off the page', async () => {
  const streams = await pageStreams(await renderBusinessDocument(document({
    notes: 'W'.repeat(500),
    items: [{ description: 'W'.repeat(500), quantity: 1, unitPrice: 10 }],
  })));
  // W is 9.44pt at 10pt. No description line can contain 24 of them.
  assert.ok(!streams.join('').includes('57'.repeat(58)), 'even the wider notes column must wrap');
  assert.equal((streams.join('').match(/57/g) ?? []).length >= 1000, true);
  assertTextOnPages(streams);
});

test('a long document runs onto more pages instead of off the first one', async () => {
  const many = await renderBusinessDocument(document({
    items: Array.from({ length: 45 }, (_, index) => ({
      description: `Line ${index + 1} with a description long enough to wrap inside its column`,
      quantity: 1,
      unitPrice: 10,
    })),
  }));
  // Object streams are compressed, so the page tree has to be read, not grepped.
  const pageCount = (await PDFDocument.load(many)).getPageCount();
  assert.ok(pageCount >= 2, `expected more than one page, got ${pageCount}`);
});

/* ----------------------------------------------------------- file name --- */

test('the saved file is named the way someone would name it themselves', () => {
  assert.equal(
    businessDocumentFileName(document()),
    'Invoice INV-1042 Harlow & Wren Ltd.pdf',
  );
});

test('a name cannot escape its folder or break a filesystem', () => {
  const name = businessDocumentFileName(document({
    reference: '../../etc/passwd',
    to: { name: 'A:B*C?D"E<F>G|H' },
  }));
  assert.ok(!name.includes('/'), name);
  assert.ok(!/[\\:*?"<>|]/.test(name), name);
});

test('an untitled document still gets a usable name', () => {
  const name = businessDocumentFileName(document({ reference: '', to: { name: '' } }));
  assert.equal(name, 'Invoice.pdf');
});

test('a line break someone typed into Notes survives onto the page', async () => {
  // drawable() folds control characters into spaces, and a newline is one. Wrapping
  // before splitting ran bank details and addresses together into one paragraph.
  const bytes = await renderBusinessDocument(document({
    notes: 'Bank: Barclays\nSort code: 20-00-00\nAccount: 12345678',
  }));
  const oneLine = await renderBusinessDocument(document({
    notes: 'Bank: Barclays Sort code: 20-00-00 Account: 12345678',
  }));
  // Three drawn lines is a different content stream from one.
  assert.notEqual(bytes.length, oneLine.length);
});

test('notes longer than a page keep running onto the next one', async () => {
  // The break used to be checked once for the whole block, so everything past
  // the first page was drawn below the paper: in the file, invisible in a viewer.
  const bytes = await renderBusinessDocument(document({
    notes: Array.from({ length: 200 }, (_, index) => `Term ${index + 1}: lorem ipsum dolor`).join('\n'),
  }));
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 4, `200 note lines need several pages, got ${pdf.getPageCount()}`);
});

test('a long recipient address does not run off the bottom of the page', async () => {
  const bytes = await renderBusinessDocument(document({
    to: { name: 'B', address: Array.from({ length: 90 }, (_, i) => `Address line ${i + 1}`).join('\n') },
  }));
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 2);
});


test('fractional unit prices remain exact beside cent-rounded line amounts', async () => {
  assert.equal(formatUnitPrice(.005, '$'), '$0.005');
  assert.equal(formatUnitPrice(12, '$'), '$12.00');
  const streams = await pageStreams(await renderBusinessDocument(document({
    currency: '$', items: [{ description: 'Fractional units', quantity: 2, unitPrice: .005 }],
  })));
  assert.ok(streams.join('').includes('24302E303035'), 'unit price is $0.005');
  assert.ok(streams.join('').includes('24302E3031'), 'line amount is $0.01');
});


test('an unreadable logo is reported instead of silently missing from the saved document', async () => {
  await assert.rejects(renderBusinessDocument(document({
    logo: { bytes: new Uint8Array([0, 1, 2]), format: 'png' },
  })), /logo could not be read/);
});

test('oversized monetary labels are refused instead of overlapping financial columns', async () => {
  await assert.rejects(renderBusinessDocument(document({ currency: 'Long currency '.repeat(30) })),
    /too long to fit legibly/);
});
