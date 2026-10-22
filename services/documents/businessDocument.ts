import english from '../i18n/en-US.ts';
import { LocalizedError } from '../i18n/errors.ts';
import type { TranslationKey } from '../i18n/core.ts';
/**
 * Invoices, receipts and quotes, drawn from what someone typed.
 *
 * Every other tool here takes a PDF and changes it. This one starts from
 * nothing: a small, plain description of a piece of business, and a page laid
 * out from it. The three documents are one model because they are one document
 * at three moments — what you are owed, what you were paid, what you offered —
 * and nobody should have to learn three screens to say the same things.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type Color } from 'pdf-lib';

export type BusinessDocumentKind = 'invoice' | 'receipt' | 'quote';

/** Whoever is sending the document, and whoever is receiving it. */
export interface DocumentParty {
  name: string;
  address?: string;
  email?: string;
  phone?: string;
}

/** One line of work or goods. The money is computed, never stored twice. */
export interface DocumentLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface BusinessDocumentLogo {
  bytes: Uint8Array;
  /** Only the two formats every phone camera and design tool already writes. */
  format: 'png' | 'jpg';
}

export interface BusinessDocument {
  kind: BusinessDocumentKind;
  /** The number a person quotes on the phone: "invoice 1042". */
  reference: string;
  issuedOn: string;
  /**
   * Due date on an invoice, the day it was paid on a receipt, the day a quote
   * stops being good. One field because it is one thought: the other date.
   */
  settledOn?: string;
  from: DocumentParty;
  to: DocumentParty;
  items: readonly DocumentLineItem[];
  /** Whatever the reader writes: a symbol, a code, or nothing at all. */
  currency: string;
  taxLabel?: string;
  taxRate?: number;
  notes?: string;
  /** How it was paid. Only a receipt has an answer to this. */
  paymentMethod?: string;
  accentColor?: string;
  logo?: BusinessDocumentLogo;
}

export interface DocumentTotals {
  subtotal: number;
  tax: number;
  total: number;
}

/** What each document calls itself, and what it calls the number at the end. */
const WORDING: Record<BusinessDocumentKind, {
  title: string;
  reference: string;
  issued: string;
  settled: string;
  recipient: string;
  total: string;
}> = {
  invoice: {
    title: 'Invoice',
    reference: 'Invoice number',
    issued: 'Date',
    settled: 'Due',
    recipient: 'Bill to',
    total: 'Amount due',
  },
  receipt: {
    title: 'Receipt',
    reference: 'Receipt number',
    issued: 'Date',
    settled: 'Paid on',
    recipient: 'Received from',
    total: 'Amount paid',
  },
  quote: {
    title: 'Quote',
    reference: 'Quote number',
    issued: 'Date',
    settled: 'Valid until',
    recipient: 'Prepared for',
    total: 'Total',
  },
};

export const documentWording = (kind: BusinessDocumentKind) => WORDING[kind];

const round = (value: number) => Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER / 100;
const finiteOrZero = (value: number) => Number.isFinite(value) ? value : 0;

export class BusinessDocumentValidationError extends LocalizedError {}

/** Accept decimal amounts (including grouped thousands), never reinterpret text. */
export const parseDocumentNumber = (value: string): number => {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export const lineAmountOf = (item: DocumentLineItem): number =>
  round(finiteOrZero(item.quantity) * finiteOrZero(item.unitPrice));

/**
 * Totals are derived on every read.
 *
 * A stored total that disagrees with its own lines is the one error nobody
 * catches by eye, so there is nowhere for the two to drift apart.
 */
export const totalsOf = (
  document: Pick<BusinessDocument, 'items' | 'taxRate'>,
): DocumentTotals => {
  const subtotal = round(
    document.items.reduce(
      (sum, item) => sum + lineAmountOf(item),
      0,
    ),
  );
  const tax = round((subtotal * (Number(document.taxRate) || 0)) / 100);
  return { subtotal, tax, total: round(subtotal + tax) };
};

/** Grouped thousands and at least two decimals, with the entered currency. */
export const formatMoney = (amount: number, currency: string, precision = 2): string => {
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT) return '—';
  const rounded = precision === 2 ? round(amount) : amount;
  const [whole, fraction] = Math.abs(rounded).toFixed(precision).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${grouped}.${fraction}`;
  const symbol = currency.trim();
  // The minus sits outside the currency, the way a credit note is written:
  // -£40.00, never £-40.00.
  const sign = amount < 0 ? '-' : '';
  if (!symbol) return `${sign}${body}`;
  // A one-character mark hugs the number; a word like "USD" needs air.
  return symbol.length <= 2 ? `${sign}${symbol}${body}` : `${sign}${symbol} ${body}`;
};

/** Fractional unit prices remain visible even though line amounts settle to cents. */
export const formatUnitPrice = (amount: number, currency: string): string => {
  const [mantissa, exponent = '0'] = String(amount).split('e');
  const precision = Math.max(2, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent));
  if (precision > 20) {
    throw new BusinessDocumentValidationError("business-document.error.8eb8807e13");
  }
  return formatMoney(amount, currency, precision);
};

const HEX = /^#?([0-9a-f]{6})$/i;

/** A colour we could not read is not a reason to refuse to draw the page. */
const accentOf = (value: string | undefined) => {
  const match = HEX.exec((value ?? '').trim());
  if (!match) return rgb(0.11, 0.13, 0.16);
  const channel = (start: number) => parseInt(match[1].slice(start, start + 2), 16) / 255;
  return rgb(channel(0), channel(2), channel(4));
};

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 54;
const INK = rgb(0.11, 0.13, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const HAIRLINE = rgb(0.87, 0.88, 0.9);

/**
 * Preserve supported text; the renderer rejects missing glyphs before drawing. Composed form, so
 * a Vietnamese "\u1ebf" typed as e plus two marks is one letter the font has, not three it stacks wrong.
 */
const drawable = (value: string): string => (value ?? '')
  .normalize('NFC')
  .replace(/\r\n?/g, '\n')
  .replace(/[\n\t]/g, ' ')
  .replace(/\u20b9/g, 'INR ');

/**
 * One font a run of text is drawn in.
 *
 * Text that Helvetica can write keeps Helvetica: a small file, and byte-for-byte what it was.
 * Anything else is drawn from embedded fonts, each only as far as its letters are used.
 */
interface Face {
  has: (codePoint: number) => boolean;
  width: (text: string, size: number) => number;
  draw: (page: PDFPage, text: string, x: number, y: number, size: number, color: Color) => Promise<void>;
  /** A run with every letter present that the face still cannot join up correctly. */
  rejects?: (text: string) => boolean;
}

/** Faces in the order they are tried; a run stays in its face while that face has the letter. */
type Typeface = readonly Face[];

const runsOf = (typeface: Typeface, value: string) => {
  const runs: Array<{ face: Face; text: string }> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const current = runs[runs.length - 1];
    const face = current?.face.has(codePoint)
      ? current.face
      : typeface.find((candidate) => candidate.has(codePoint)) ?? typeface[0];
    if (current && current.face === face) current.text += character;
    else runs.push({ face, text: character });
  }
  return runs;
};

const widthOf = (typeface: Typeface, value: string, size: number) =>
  runsOf(typeface, drawable(value)).reduce((sum, run) => sum + run.face.width(run.text, size), 0);

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Break a paragraph to a column, keeping whole words wherever one fits. */
const wrap = (font: Typeface, value: string, size: number, maxWidth: number): string[] => {
  // Split first: drawable() folds control characters into spaces, and a newline
  // is one of them. Cleaning before splitting silently ran every line someone
  // typed into Notes — bank details, an address — together into one paragraph.
  const paragraphs = (value ?? '').split(/\r\n?|\n/).map((line) => drawable(line).trim());
  if (!paragraphs.some(Boolean)) return [];
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && widthOf(font, `${line} ${word}`, size) <= maxWidth) {
        line += ` ${word}`;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // Whole letters, so a Hindi vowel sign never lands on the next line without its consonant.
      for (const { segment: character } of graphemes.segment(word)) {
        if (line && widthOf(font, line + character, size) > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
};

interface Fonts {
  regular: Typeface;
  bold: Typeface;
}

const text = async (
  page: PDFPage,
  value: string,
  x: number,
  y: number,
  font: Typeface,
  size: number,
  color = INK,
) => {
  let cursor = x;
  for (const run of runsOf(font, drawable(value))) {
    await run.face.draw(page, run.text, cursor, y, size, color);
    cursor += run.face.width(run.text, size);
  }
};

const rightText = (
  page: PDFPage,
  value: string,
  right: number,
  y: number,
  font: Typeface,
  size: number,
  color = INK,
) => text(page, value, right - widthOf(font, value, size), y, font, size, color);

const fittedRightText = async (
  page: PDFPage, value: string, right: number, y: number, font: Typeface,
  size: number, maxWidth: number, color = INK,
) => {
  const width = widthOf(font, value, size);
  const fittedSize = width > maxWidth ? size * maxWidth / width : size;
  if (fittedSize < 6) {
    throw new BusinessDocumentValidationError("business-document.error.3d41df31ef");
  }
  await rightText(page, value, right, y, font, fittedSize, color);
};

const rule = (
  page: PDFPage,
  y: number,
  from: number,
  to: number,
  color = HAIRLINE,
  thickness = 0.75,
) => {
  page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color });
};

const partyLines = (party: DocumentParty): string[] =>
  [party.address, party.email, party.phone]
    .flatMap((value) => (value ?? '').split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);

const COLUMN = { qty: 300, unit: 380, amount: A4.width - MARGIN };
const ROW_GAP = 8;
const BOTTOM_LIMIT = MARGIN + 90;

/**
 * The item table's heading row, repeated on every page it continues onto.
 *
 * A column of numbers whose heading is two pages back is a column of numbers
 * nobody can check.
 */
const drawTableHead = async (
  page: PDFPage,
  fonts: Fonts,
  y: number,
  accent: ReturnType<typeof accentOf>,
) => {
  await text(page, 'Description', MARGIN, y, fonts.bold, 9, MUTED);
  await rightText(page, 'Qty', COLUMN.qty, y, fonts.bold, 9, MUTED);
  await rightText(page, 'Unit price', COLUMN.unit, y, fonts.bold, 9, MUTED);
  await rightText(page, 'Amount', COLUMN.amount, y, fonts.bold, 9, MUTED);
  rule(page, y - 7, MARGIN, COLUMN.amount, accent, 1);
  return y - 23;
};

/** The fonts drawn when Helvetica cannot write the text, each read only when it is needed. */
export type BusinessFontName =
  | 'LiberationSans-Regular' | 'LiberationSans-Bold'
  | 'NotoSans-LatinExt-Regular' | 'NotoSans-LatinExt-Bold'
  | 'NotoSans-Vietnamese-Regular' | 'NotoSans-Vietnamese-Bold';

export interface BusinessFontSource {
  read: (name: BusinessFontName) => Promise<Uint8Array>;
  /** Hindi is shaped with the editor's own Devanagari fonts. */
  loadDevanagari: () => Promise<void>;
}

const bundledFonts: BusinessFontSource = {
  read: async (name) => (await import('./businessDocumentFontFiles.ts')).readBundledBusinessFont(name),
  loadDevanagari: async () => (await import('../pdfDevanagari.ts')).loadDevanagariFonts(),
};

/**
 * Liberation Sans has Helvetica's widths and covers Polish, Turkish, Cyrillic and Greek. Noto
 * Sans adds the currency signs it lacks (₺, ₩ and the rest) and Vietnamese. Chinese, Japanese,
 * Korean, Arabic and the like are not drawn yet, and say so by field.
 */
const FALLBACK_FACES: ReadonlyArray<Record<'regular' | 'bold', BusinessFontName>> = [
  { regular: 'LiberationSans-Regular', bold: 'LiberationSans-Bold' },
  { regular: 'NotoSans-LatinExt-Regular', bold: 'NotoSans-LatinExt-Bold' },
  { regular: 'NotoSans-Vietnamese-Regular', bold: 'NotoSans-Vietnamese-Bold' },
];

const isDevanagari = (codePoint: number) =>
  (codePoint >= 0x0900 && codePoint <= 0x097f) || (codePoint >= 0xa8e0 && codePoint <= 0xa8ff) ||
  (codePoint >= 0x1cd0 && codePoint <= 0x1cff) || codePoint === 0x200c || codePoint === 0x200d;

let helveticaCharacters: Promise<ReadonlySet<number>> | null = null;
/** WinAnsi, read from a scratch document so a page drawn in other fonts carries no unused Helvetica. */
const helveticaCoverage = () => helveticaCharacters ??= PDFDocument.create()
  .then((scratch) => scratch.embedFont(StandardFonts.Helvetica))
  .then((font) => new Set(font.getCharacterSet()));

const standardFace = (font: PDFFont, characters: ReadonlySet<number>): Face => ({
  has: (codePoint) => characters.has(codePoint),
  width: (value, size) => font.widthOfTextAtSize(value, size),
  draw: async (page, value, x, y, size, color) => { page.drawText(value, { x, y, size, font, color }); },
});

interface FontkitFace {
  unitsPerEm: number;
  characterSet: number[];
  layout: (text: string) => { glyphs: Array<{ advanceWidth: number }> };
}

const fontkitModule = async () => {
  const module = await import('@pdf-lib/fontkit');
  return ((module as { default?: unknown }).default ?? module) as {
    create: (bytes: Uint8Array) => FontkitFace;
  };
};

/** Embedded on the first run drawn in it, and then only the glyphs used. */
const embeddedFace = (pdf: PDFDocument, bytes: Uint8Array, face: FontkitFace): Face => {
  const characters = new Set(face.characterSet);
  let font: Promise<PDFFont> | null = null;
  return {
    has: (codePoint) => characters.has(codePoint),
    // The same sum pdf-lib makes from the same glyphs, so measuring needs no embedded font.
    width: (value, size) => face.layout(value).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * size / face.unitsPerEm,
    draw: async (page, value, x, y, size, color) => {
      font ??= pdf.embedFont(bytes, { subset: true });
      page.drawText(value, { x, y, size, font: await font, color });
    },
  };
};

interface LabeledText {
  value: string | undefined;
  /** The field's own label, as the form shows it. */
  label?: TranslationKey;
  line?: number;
}

const fieldsOf = (document: BusinessDocument): LabeledText[] => [
  { label: `business.${document.kind}.reference`, value: document.reference },
  { label: `business.${document.kind}.issued`, value: document.issuedOn },
  { label: `business.${document.kind}.settled`, value: document.settledOn },
  { label: 'business-document-builder.your.name.or.business.5a3dbc', value: document.from.name },
  { label: 'business-document.your.address.aa7eb8', value: document.from.address },
  { label: 'business-document.your.email.33fe95', value: document.from.email },
  { label: 'business-document.your.phone.807163', value: document.from.phone },
  { label: 'business-document.client.name.b6626c', value: document.to.name },
  { label: 'business-document.client.address.0a1312', value: document.to.address },
  { label: 'business-document.client.email.c94f0a', value: document.to.email },
  { label: 'business-document.client.phone.ab4f49', value: document.to.phone },
  { label: 'business-document-builder.money.symbol.e4928f', value: document.currency },
  { label: 'business-document-builder.tax.name.ae6611', value: document.taxLabel },
  { label: 'business-document-builder.notes.8a7525', value: document.notes },
  { label: 'business-document-builder.paid.by.a891cb', value: document.paymentMethod },
  ...document.items.map((item, index) => ({ line: index + 1, value: item.description })),
];

/** A letter as a person can recognise it; an invisible control character by its code. */
const shown = (character: string) => /\p{C}/u.test(character)
  ? `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
  : character;

const unprintable = (field: LabeledText, characters: string[]) => {
  const letters = [...new Set(characters)].slice(0, 6).map(shown).join(' ');
  if (field.line) {
    return new BusinessDocumentValidationError("business-document.line.uses.letters.this.pdf.cannot.print.3a4bac", { v0: field.line, v1: letters });
  }
  return new BusinessDocumentValidationError(
    "business-document.uses.letters.this.pdf.cannot.print.yet.791429",
    { v0: english[field.label!] as string, v1: letters },
    { v0: field.label },
  );
};

/**
 * The fonts this document is drawn in, after every field is checked against them.
 *
 * Text a font cannot draw is refused, naming the field, rather than dropped from a financial
 * document that will be sent to someone.
 */
const chooseFonts = async (pdf: PDFDocument, document: BusinessDocument, source: BusinessFontSource) => {
  const fields = fieldsOf(document).map((field) => ({ ...field, value: drawable(field.value ?? '') }));
  const helvetica = await helveticaCoverage();
  if (fields.every((field) => [...field.value].every((character) => helvetica.has(character.codePointAt(0)!)))) {
    return {
      regular: [standardFace(await pdf.embedFont(StandardFonts.Helvetica), helvetica)],
      bold: [standardFace(await pdf.embedFont(StandardFonts.HelveticaBold), helvetica)],
      finish: () => {},
    };
  }

  const fontkit = await fontkitModule();
  pdf.registerFontkit(fontkit as unknown as Parameters<PDFDocument['registerFontkit']>[0]);
  const typeface = async (weight: 'regular' | 'bold') => Promise.all(FALLBACK_FACES.map(async (names) => {
    const bytes = await source.read(names[weight]);
    return embeddedFace(pdf, bytes, fontkit.create(bytes));
  }));
  const fonts = { regular: [...await typeface('regular')], bold: [...await typeface('bold')] };
  let finish = () => {};
  if (fields.some((field) => [...field.value].some((character) => isDevanagari(character.codePointAt(0)!)))) {
    await source.loadDevanagari();
    const devanagari = await import('../pdfDevanagari.ts');
    const writer = new devanagari.DevanagariPdfWriter(pdf);
    const face = (fontId: 'MuktaRegular' | 'MuktaBold'): Face => ({
      has: isDevanagari,
      width: (value, size) => devanagari.measureDevanagariText(value, fontId, size),
      draw: (page, value, x, y, size, color) => writer.drawLine(page, [{
        text: value, fontId, x, y, width: devanagari.measureDevanagariText(value, fontId, size),
      }], size, color, 0),
      rejects: (value) => !devanagari.canShapeDevanagari(value, fontId),
    });
    fonts.regular.push(face('MuktaRegular'));
    fonts.bold.push(face('MuktaBold'));
    finish = () => writer.finish();
  }

  for (const field of fields) {
    const missing: string[] = [];
    for (const font of [fonts.regular, fonts.bold]) {
      for (const run of runsOf(font, field.value)) {
        if (run.face.rejects?.(run.text)) missing.push(...run.text.replace(/\s/gu, ''));
        for (const character of run.text) {
          if (!run.face.has(character.codePointAt(0)!) || /\p{Cc}/u.test(character)) missing.push(character);
        }
      }
    }
    if (missing.length) throw unprintable(field, missing);
  }
  return { ...fonts, finish };
};

/**
 * Draw the document.
 *
 * Blank fields remain optional. Unsupported text and invalid amounts are
 * rejected explicitly so a saved financial document cannot silently lose data.
 */
export const renderBusinessDocument = async (
  document: BusinessDocument,
  fontSource: BusinessFontSource = bundledFonts,
): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const { finish, ...fonts }: Fonts & { finish: () => void } = await chooseFonts(pdf, document, fontSource);
  if (document.items.some(item => !Number.isFinite(item.quantity) || !Number.isFinite(item.unitPrice) ||
      !Number.isFinite(item.quantity * item.unitPrice)) ||
      (document.taxRate !== undefined && !Number.isFinite(document.taxRate))) {
    throw new BusinessDocumentValidationError("business-document.error.875bd9ac91");
  }
  const accent = accentOf(document.accentColor);
  const wording = WORDING[document.kind];
  const totals = totalsOf(document);
  if (!Object.values(totals).every(value => Number.isFinite(value) && Math.abs(value) <= MAX_AMOUNT) ||
      document.items.some(item => Math.abs(item.unitPrice) > MAX_AMOUNT || Math.abs(item.quantity * item.unitPrice) > MAX_AMOUNT)) {
    throw new BusinessDocumentValidationError("business-document.error.ee57a4151e");
  }

  let page = pdf.addPage([A4.width, A4.height]);
  const top = A4.height - MARGIN;

  // ---- the sender, and what this piece of paper is ------------------------
  let headerBottom = top;
  let logoDrawn = false;
  if (document.logo) {
    try {
      const image = document.logo.format === 'png'
        ? await pdf.embedPng(document.logo.bytes)
        : await pdf.embedJpg(document.logo.bytes);
      const scaled = image.scaleToFit(150, 54);
      page.drawImage(image, {
        x: MARGIN,
        y: top - scaled.height,
        width: scaled.width,
        height: scaled.height,
      });
      headerBottom = top - scaled.height - 12;
      logoDrawn = true;
    } catch {
      throw new BusinessDocumentValidationError("business-document.error.dc4e508e0a");
    }
  }
  const headerPage = page;
  const columnWidth = 225;
  // Both header columns may continue independently; body content begins below
  // the longest one, on its final page.
  const drawHeaderColumn = async (entries: Array<{ value: string; size: number; bold?: boolean }>, startY: number, right = false) => {
    let pageIndex = 0;
    let columnPage = headerPage;
    let columnY = startY;
    for (const entry of entries) {
      const font = entry.bold ? fonts.bold : fonts.regular;
      for (const line of wrap(font, entry.value, entry.size, columnWidth)) {
        if (columnY < MARGIN + entry.size) {
          pageIndex += 1;
          columnPage = pdf.getPages()[pageIndex] ?? pdf.addPage([A4.width, A4.height]);
          columnY = top;
        }
        if (right) await rightText(columnPage, line, COLUMN.amount, columnY, font, entry.size, MUTED);
        else await text(columnPage, line, MARGIN, columnY, font, entry.size);
        columnY -= entry.size + 4;
      }
    }
    return { pageIndex, y: columnY };
  };
  const senderEnd = await drawHeaderColumn([
    { value: document.from.name || 'Your business', size: logoDrawn ? 11 : 16, bold: true },
    ...partyLines(document.from).map(value => ({ value, size: 9 })),
  ], logoDrawn ? headerBottom - 11 : top - 15);

  const titleY = top - 18;
  await rightText(headerPage, wording.title.toUpperCase(), COLUMN.amount, titleY, fonts.bold, 22, accent);
  const meta: Array<[string, string | undefined]> = [
    [wording.reference, document.reference],
    [wording.issued, document.issuedOn],
    [wording.settled, document.settledOn],
    ['Paid by', document.kind === 'receipt' ? document.paymentMethod : undefined],
  ];
  const metaEnd = await drawHeaderColumn(meta.filter(([, value]) => value?.trim()).map(([label, value]) => ({
    value: `${label}   ${value!.trim()}`, size: 9,
  })), titleY - 20, true);
  const lastHeaderPage = Math.max(senderEnd.pageIndex, metaEnd.pageIndex);
  page = pdf.getPages()[lastHeaderPage];
  let y = Math.min(
    senderEnd.pageIndex === lastHeaderPage ? senderEnd.y : top,
    metaEnd.pageIndex === lastHeaderPage ? metaEnd.y : top,
  ) - 22;
  const ensureSpace = (height: number) => {
    if (y - height < MARGIN) {
      page = pdf.addPage([A4.width, A4.height]);
      y = top;
    }
  };

  // ---- who it is for ------------------------------------------------------
  ensureSpace(28);
  await text(page, wording.recipient.toUpperCase(), MARGIN, y, fonts.bold, 8, MUTED);
  y -= 15;
  for (const entry of [
    { value: document.to.name, font: fonts.bold, size: 11 },
    ...partyLines(document.to).map(value => ({ value, font: fonts.regular, size: 9 })),
  ]) {
    for (const line of wrap(entry.font, entry.value, entry.size, COLUMN.amount - MARGIN)) {
      ensureSpace(entry.size + 3);
      await text(page, line, MARGIN, y, entry.font, entry.size);
      y -= entry.size + 3;
    }
  }

  // ---- what it is for -----------------------------------------------------
  ensureSpace(26 + 23 + 13 + 90);
  y -= 26;
  y = await drawTableHead(page, fonts, y, accent);

  for (const item of document.items) {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const lines = wrap(fonts.regular, item.description || '', 10, COLUMN.qty - MARGIN - 60);
    if (!lines.length) lines.push('');
    if (y - Math.min(lines.length * 13, top - 23 - BOTTOM_LIMIT) < BOTTOM_LIMIT) {
      page = pdf.addPage([A4.width, A4.height]);
      y = await drawTableHead(page, fonts, top, accent);
    }
    await fittedRightText(page, String(quantity), COLUMN.qty, y, fonts.regular, 10, 45);
    await fittedRightText(page, formatUnitPrice(unitPrice, document.currency), COLUMN.unit, y, fonts.regular, 10, 72);
    await fittedRightText(page, formatMoney(lineAmountOf(item), document.currency), COLUMN.amount, y, fonts.regular, 10, COLUMN.amount - COLUMN.unit - 10);
    for (const line of lines) {
      if (y - 13 < BOTTOM_LIMIT) {
        page = pdf.addPage([A4.width, A4.height]);
        y = await drawTableHead(page, fonts, top, accent);
      }
      await text(page, line, MARGIN, y, fonts.regular, 10);
      y -= 13;
    }
    y -= ROW_GAP;
    rule(page, y + ROW_GAP - 4, MARGIN, COLUMN.amount);
  }

  // ---- what it comes to ---------------------------------------------------
  if (y - (document.taxRate ? 62 : 46) < BOTTOM_LIMIT) {
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  }
  y -= 10;
  const labelRight = COLUMN.amount - 110;
  await rightText(page, 'Subtotal', labelRight, y, fonts.regular, 10, MUTED);
  await fittedRightText(page, formatMoney(totals.subtotal, document.currency), COLUMN.amount, y, fonts.regular, 10, 100);
  y -= 15;
  if (document.taxRate) {
    const label = (document.taxLabel || 'Tax').trim() || 'Tax';
    await fittedRightText(page, `${label} ${document.taxRate}%`, labelRight, y, fonts.regular, 10, labelRight - MARGIN, MUTED);
    await fittedRightText(page, formatMoney(totals.tax, document.currency), COLUMN.amount, y, fonts.regular, 10, 100);
    y -= 15;
  }
  rule(page, y + 5, labelRight - 60, COLUMN.amount, accent, 1);
  y -= 9;
  await rightText(page, wording.total, labelRight, y, fonts.bold, 11, accent);
  await fittedRightText(page, formatMoney(totals.total, document.currency), COLUMN.amount, y, fonts.bold, 13, 100, accent);

  // ---- anything else they wanted to say -----------------------------------
  const notes = (document.notes ?? '').trim();
  if (notes) {
    y -= 34;
    const lines = wrap(fonts.regular, notes, 9, COLUMN.amount - MARGIN);
    if (y - 26 < MARGIN) {
      page = pdf.addPage([A4.width, A4.height]);
      y = A4.height - MARGIN;
    }
    await text(page, 'NOTES', MARGIN, y, fonts.bold, 8, MUTED);
    y -= 14;
    for (const line of lines) {
      // Checked per line, not once for the block. Terms and conditions run to
      // pages; a single break up front drew the rest below the paper, where the
      // text is in the file and invisible in every viewer.
      if (y < MARGIN) {
        page = pdf.addPage([A4.width, A4.height]);
        y = A4.height - MARGIN;
      }
      await text(page, line, MARGIN, y, fonts.regular, 9, MUTED);
      y -= 12;
    }
  }

  finish();
  return pdf.save();
};

/** The file name someone would have given it themselves. */
export const businessDocumentFileName = (document: BusinessDocument): string => {
  const safe = (value: string) => value.trim().replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '-');
  const parts = [
    WORDING[document.kind].title,
    safe(document.reference || ''),
    safe(document.to.name || ''),
  ].filter(Boolean);
  return `${parts.join(' ').slice(0, 90).trim()}.pdf`;
};
