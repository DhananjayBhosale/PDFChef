/**
 * Invoices, receipts and quotes, drawn from what someone typed.
 *
 * Every other tool here takes a PDF and changes it. This one starts from
 * nothing: a small, plain description of a piece of business, and a page laid
 * out from it. The three documents are one model because they are one document
 * at three moments — what you are owed, what you were paid, what you offered —
 * and nobody should have to learn three screens to say the same things.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

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

export class BusinessDocumentValidationError extends Error {}

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
    throw new BusinessDocumentValidationError('A unit price has too many decimal places to display. Use at most 20 decimal places.');
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

/** Preserve supported text; the renderer rejects missing glyphs before drawing. */
const drawable = (value: string): string => (value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\n\t]/g, ' ')
  .replace(/\u20b9/g, 'INR ');

const widthOf = (font: PDFFont, value: string, size: number) =>
  font.widthOfTextAtSize(drawable(value), size);

/** Break a paragraph to a column, keeping whole words wherever one fits. */
const wrap = (font: PDFFont, value: string, size: number, maxWidth: number): string[] => {
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
      for (const character of word) {
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
  regular: PDFFont;
  bold: PDFFont;
}

const text = (
  page: PDFPage,
  value: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = INK,
) => {
  page.drawText(drawable(value), { x, y, size, font, color });
};

const rightText = (
  page: PDFPage,
  value: string,
  right: number,
  y: number,
  font: PDFFont,
  size: number,
  color = INK,
) => {
  text(page, value, right - widthOf(font, value, size), y, font, size, color);
};

const fittedRightText = (
  page: PDFPage, value: string, right: number, y: number, font: PDFFont,
  size: number, maxWidth: number, color = INK,
) => {
  const width = widthOf(font, value, size);
  const fittedSize = width > maxWidth ? size * maxWidth / width : size;
  if (fittedSize < 6) {
    throw new BusinessDocumentValidationError('An amount, currency or tax label is too long to fit legibly. Shorten it before saving.');
  }
  rightText(page, value, right, y, font, fittedSize, color);
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
const drawTableHead = (
  page: PDFPage,
  fonts: Fonts,
  y: number,
  accent: ReturnType<typeof accentOf>,
) => {
  text(page, 'Description', MARGIN, y, fonts.bold, 9, MUTED);
  rightText(page, 'Qty', COLUMN.qty, y, fonts.bold, 9, MUTED);
  rightText(page, 'Unit price', COLUMN.unit, y, fonts.bold, 9, MUTED);
  rightText(page, 'Amount', COLUMN.amount, y, fonts.bold, 9, MUTED);
  rule(page, y - 7, MARGIN, COLUMN.amount, accent, 1);
  return y - 23;
};

/**
 * Draw the document.
 *
 * Blank fields remain optional. Unsupported text and invalid amounts are
 * rejected explicitly so a saved financial document cannot silently lose data.
 */
export const renderBusinessDocument = async (
  document: BusinessDocument,
): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const strings = [document.reference, document.issuedOn, document.settledOn,
    ...Object.values(document.from), ...Object.values(document.to), document.currency,
    document.taxLabel, document.notes, document.paymentMethod, ...document.items.map(item => item.description)];
  const coverage = new Set(fonts.regular.getCharacterSet());
  for (const value of strings) {
    for (const character of drawable(value ?? '')) {
      if (!coverage.has(character.codePointAt(0)!)) {
        const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
        throw new BusinessDocumentValidationError(`This PDF font cannot display ${JSON.stringify(character)} (U+${code}). Replace that character or use a supported spelling before previewing or saving; your text has not been removed.`);
      }
    }
  }
  if (document.items.some(item => !Number.isFinite(item.quantity) || !Number.isFinite(item.unitPrice) ||
      !Number.isFinite(item.quantity * item.unitPrice)) ||
      (document.taxRate !== undefined && !Number.isFinite(document.taxRate))) {
    throw new BusinessDocumentValidationError('Enter valid decimal quantities, prices and tax rates, such as 12.50. Letters and currency symbols do not belong in amount fields.');
  }
  const accent = accentOf(document.accentColor);
  const wording = WORDING[document.kind];
  const totals = totalsOf(document);
  if (!Object.values(totals).every(value => Number.isFinite(value) && Math.abs(value) <= MAX_AMOUNT) ||
      document.items.some(item => Math.abs(item.unitPrice) > MAX_AMOUNT || Math.abs(item.quantity * item.unitPrice) > MAX_AMOUNT)) {
    throw new BusinessDocumentValidationError('These amounts are too large. Reduce them before saving.');
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
      throw new BusinessDocumentValidationError('The logo could not be read as a JPG or PNG. Replace it or remove it before saving.');
    }
  }
  const headerPage = page;
  const columnWidth = 225;
  // Both header columns may continue independently; body content begins below
  // the longest one, on its final page.
  const drawHeaderColumn = (entries: Array<{ value: string; size: number; bold?: boolean }>, startY: number, right = false) => {
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
        if (right) rightText(columnPage, line, COLUMN.amount, columnY, font, entry.size, MUTED);
        else text(columnPage, line, MARGIN, columnY, font, entry.size);
        columnY -= entry.size + 4;
      }
    }
    return { pageIndex, y: columnY };
  };
  const senderEnd = drawHeaderColumn([
    { value: document.from.name || 'Your business', size: logoDrawn ? 11 : 16, bold: true },
    ...partyLines(document.from).map(value => ({ value, size: 9 })),
  ], logoDrawn ? headerBottom - 11 : top - 15);

  const titleY = top - 18;
  rightText(headerPage, wording.title.toUpperCase(), COLUMN.amount, titleY, fonts.bold, 22, accent);
  const meta: Array<[string, string | undefined]> = [
    [wording.reference, document.reference],
    [wording.issued, document.issuedOn],
    [wording.settled, document.settledOn],
    ['Paid by', document.kind === 'receipt' ? document.paymentMethod : undefined],
  ];
  const metaEnd = drawHeaderColumn(meta.filter(([, value]) => value?.trim()).map(([label, value]) => ({
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
  text(page, wording.recipient.toUpperCase(), MARGIN, y, fonts.bold, 8, MUTED);
  y -= 15;
  for (const entry of [
    { value: document.to.name, font: fonts.bold, size: 11 },
    ...partyLines(document.to).map(value => ({ value, font: fonts.regular, size: 9 })),
  ]) {
    for (const line of wrap(entry.font, entry.value, entry.size, COLUMN.amount - MARGIN)) {
      ensureSpace(entry.size + 3);
      text(page, line, MARGIN, y, entry.font, entry.size);
      y -= entry.size + 3;
    }
  }

  // ---- what it is for -----------------------------------------------------
  ensureSpace(26 + 23 + 13 + 90);
  y -= 26;
  y = drawTableHead(page, fonts, y, accent);

  for (const item of document.items) {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const lines = wrap(fonts.regular, item.description || '', 10, COLUMN.qty - MARGIN - 60);
    if (!lines.length) lines.push('');
    if (y - Math.min(lines.length * 13, top - 23 - BOTTOM_LIMIT) < BOTTOM_LIMIT) {
      page = pdf.addPage([A4.width, A4.height]);
      y = drawTableHead(page, fonts, top, accent);
    }
    fittedRightText(page, String(quantity), COLUMN.qty, y, fonts.regular, 10, 45);
    fittedRightText(page, formatUnitPrice(unitPrice, document.currency), COLUMN.unit, y, fonts.regular, 10, 72);
    fittedRightText(page, formatMoney(lineAmountOf(item), document.currency), COLUMN.amount, y, fonts.regular, 10, COLUMN.amount - COLUMN.unit - 10);
    for (const line of lines) {
      if (y - 13 < BOTTOM_LIMIT) {
        page = pdf.addPage([A4.width, A4.height]);
        y = drawTableHead(page, fonts, top, accent);
      }
      text(page, line, MARGIN, y, fonts.regular, 10);
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
  rightText(page, 'Subtotal', labelRight, y, fonts.regular, 10, MUTED);
  fittedRightText(page, formatMoney(totals.subtotal, document.currency), COLUMN.amount, y, fonts.regular, 10, 100);
  y -= 15;
  if (document.taxRate) {
    const label = (document.taxLabel || 'Tax').trim() || 'Tax';
    fittedRightText(page, `${label} ${document.taxRate}%`, labelRight, y, fonts.regular, 10, labelRight - MARGIN, MUTED);
    fittedRightText(page, formatMoney(totals.tax, document.currency), COLUMN.amount, y, fonts.regular, 10, 100);
    y -= 15;
  }
  rule(page, y + 5, labelRight - 60, COLUMN.amount, accent, 1);
  y -= 9;
  rightText(page, wording.total, labelRight, y, fonts.bold, 11, accent);
  fittedRightText(page, formatMoney(totals.total, document.currency), COLUMN.amount, y, fonts.bold, 13, 100, accent);

  // ---- anything else they wanted to say -----------------------------------
  const notes = (document.notes ?? '').trim();
  if (notes) {
    y -= 34;
    const lines = wrap(fonts.regular, notes, 9, COLUMN.amount - MARGIN);
    if (y - 26 < MARGIN) {
      page = pdf.addPage([A4.width, A4.height]);
      y = A4.height - MARGIN;
    }
    text(page, 'NOTES', MARGIN, y, fonts.bold, 8, MUTED);
    y -= 14;
    for (const line of lines) {
      // Checked per line, not once for the block. Terms and conditions run to
      // pages; a single break up front drew the rest below the paper, where the
      // text is in the file and invisible in every viewer.
      if (y < MARGIN) {
        page = pdf.addPage([A4.width, A4.height]);
        y = A4.height - MARGIN;
      }
      text(page, line, MARGIN, y, fonts.regular, 9, MUTED);
      y -= 12;
    }
  }

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
