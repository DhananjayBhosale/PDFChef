/**
 * Font matching for the inline PDF text editor.
 *
 * The editing overlay sits directly on top of the rendered page, so its text has to land on the
 * same pixels as the canvas underneath. That means using the PDF's own embedded font program
 * whenever it can be proven safe, and otherwise substituting a metric-compatible system font and
 * telling the user why. Silently falling back to Helvetica is what makes other editors visibly
 * shift text the moment you click it.
 */

export type FontClass = 'serif' | 'sans-serif' | 'monospace';

export interface PdfFontDescriptor {
  key: string;
  psName: string;
  loadedName: string;
  fallbackFamily: string;
  ascent: number;
  descent: number;
  vertical: boolean;
  bold: boolean;
  italic: boolean;
  isType3: boolean;
  embedded: boolean;
  data: Uint8Array | null;
  /**
   * Whether this document's own record of the font has been read yet.
   *
   * PDF.js only parses a font as a side effect of building a page's drawing operations, so a page
   * that has only had its text extracted reports nothing at all. Calling that "not embedded" is a
   * false statement about the reader's document, and acting on it refuses edits the real font
   * could have made — so an unread font is marked as such and never used to refuse anything.
   */
  resolution: 'pending' | 'read';
}

export interface ResolvedFont {
  mode: 'embedded' | 'substituted';
  cssFamily: string;
  cssWeight: string;
  cssStyle: string;
  klass: FontClass;
  /** Present only when the embedded program could not be used. */
  reason: string | null;
  missingGlyphs: string[];
}

export interface TextMetricFit {
  wordSpacing: number;
  letterSpacing: number;
}

const SERIF = /times|roman|serif|georgia|garamond|palatino|baskerville|caslon|minion|cambria|constantia|charter|utopia|nimbusrom|liberationserif|dejavuserif|pt.?serif|source.?serif|noto.?serif|merriweather|lora|crimson/i;
const SANS = /helvetica|arial|sans|verdana|tahoma|calibri|segoe|roboto|opensans|lato|montserrat|futura|gill|frutiger|univers|myriad|nimbussan|liberationsans|dejavusans|inter|poppins|nunito/i;
const MONO = /mono|courier|consolas|menlo|inconsolata|cmtt|liberationmono|dejavusansmono|sourcecodepro|jetbrains|fira.?code/i;

const FONT_FALLBACKS: Record<FontClass, string> = {
  serif: 'Georgia, "Times New Roman", Times, serif',
  'sans-serif': '"Helvetica Neue", Helvetica, Arial, sans-serif',
  monospace: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
};

/** Subset-prefixed PostScript names look like `ABCDEF+Times-Roman`. */
export const prettyFontName = (descriptor: Pick<PdfFontDescriptor, 'psName'>) =>
  descriptor.psName.replace(/^[A-Z]{6}\+/, '') || 'unnamed font';

export const classifyFont = (descriptor: Pick<PdfFontDescriptor, 'psName' | 'fallbackFamily'>): FontClass => {
  const name = descriptor.psName || '';
  if (MONO.test(name)) return 'monospace';
  if (SERIF.test(name)) return 'serif';
  if (SANS.test(name)) return 'sans-serif';
  const fallback = (descriptor.fallbackFamily || '').toLowerCase();
  if (fallback.includes('mono')) return 'monospace';
  if (fallback.includes('serif') && !fallback.includes('sans')) return 'serif';
  return 'sans-serif';
};

export const buildFontDescriptor = (page: any, fontKey: string, styles: any): PdfFontDescriptor => {
  const style = styles?.[fontKey];
  const descriptor: PdfFontDescriptor = {
    key: fontKey,
    psName: '',
    loadedName: '',
    fallbackFamily: style?.fontFamily || 'sans-serif',
    ascent: style?.ascent || 0.75,
    descent: style?.descent || -0.22,
    vertical: Boolean(style?.vertical),
    bold: false,
    italic: false,
    isType3: false,
    embedded: false,
    data: null,
    resolution: 'pending',
  };

  try {
    const common = page?.commonObjs?.get?.(fontKey);
    if (common) {
      descriptor.resolution = 'read';
      descriptor.psName = common.name || '';
      descriptor.loadedName = common.loadedName || '';
      descriptor.isType3 = Boolean(common.isType3Font);
      descriptor.data = common.data instanceof Uint8Array
        ? common.data
        : common.data
          ? new Uint8Array(common.data)
          : null;
      descriptor.embedded = Boolean(descriptor.data?.length && !common.missingFile);
      descriptor.bold = Boolean(common.bold) || /bold|black|heavy|semib|demi/i.test(common.name || '');
      descriptor.italic = Boolean(common.italic) || /italic|oblique|-it\b/i.test(common.name || '');
    }
  } catch {
    // commonObjs throws when the font has not finished loading. The substituted branch below is
    // the correct answer in that case, so there is nothing to recover.
  }

  return descriptor;
};

type FontkitFace = { hasGlyphForCodePoint?: (codePoint: number) => boolean };
type FontkitModule = { create: (data: Uint8Array) => FontkitFace };

let fontkitModule: FontkitModule | null = null;
let fontkitRequest: Promise<FontkitModule | null> | null = null;
const faceCache = new Map<string, FontkitFace | null>();

/** Load fontkit once, lazily: it is only needed the first time a block is inspected. */
export const loadFontkit = (): Promise<FontkitModule | null> => {
  if (fontkitModule) return Promise.resolve(fontkitModule);
  if (!fontkitRequest) {
    fontkitRequest = import('@pdf-lib/fontkit')
      .then((module) => {
        const candidate = ((module as any).default ?? module) as FontkitModule;
        fontkitModule = typeof candidate?.create === 'function' ? candidate : null;
        return fontkitModule;
      })
      .catch(() => null);
  }
  return fontkitRequest;
};

const getFace = (descriptor: PdfFontDescriptor): FontkitFace | null => {
  if (!descriptor.data?.length || !fontkitModule) return null;
  const cached = faceCache.get(`${descriptor.key}:${descriptor.resolution}`);
  if (cached !== undefined) return cached;
  let face: FontkitFace | null = null;
  try {
    face = fontkitModule.create(descriptor.data);
    if (typeof face?.hasGlyphForCodePoint !== 'function') face = null;
  } catch {
    face = null;
  }
  faceCache.set(`${descriptor.key}:${descriptor.resolution}`, face);
  return face;
};

export interface GlyphCoverage {
  checked: boolean;
  covered: boolean;
  missing: string[];
}

/**
 * Per-face record of which code points the font can draw. Coverage is rechecked on every
 * keystroke for every paragraph on the page, and a typed character is almost always one the font
 * has already been asked about, so the answers are kept rather than recomputed.
 */
const coverageCache = new Map<string, Map<number, boolean>>();

export const checkGlyphCoverage = (descriptor: PdfFontDescriptor, text: string): GlyphCoverage => {
  const face = getFace(descriptor);
  if (!face?.hasGlyphForCodePoint) return { checked: false, covered: false, missing: [] };

  // Keyed by how much of the font is known: a descriptor built before the page was read must not
  // poison the answers for the same font once it has been.
  const cacheKey = `${descriptor.key}:${descriptor.resolution}`;
  let known = coverageCache.get(cacheKey);
  if (!known) {
    known = new Map();
    coverageCache.set(cacheKey, known);
  }

  const missing = new Set<string>();
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 32 || codePoint === 10 || codePoint === 13 || codePoint === 9) continue;
    let present = known.get(codePoint);
    if (present === undefined) {
      present = face.hasGlyphForCodePoint(codePoint);
      known.set(codePoint, present);
    }
    if (!present) missing.add(character);
    if (missing.size > 8) break;
  }

  return { checked: true, covered: missing.size === 0, missing: [...missing] };
};

// A face either loaded when the page rendered or it did not, and asking the font system again on
// every keystroke costs a style recalculation for no new answer.
const loadedFaceCache = new Map<string, boolean>();

const browserLoadedFace = (loadedName: string) => {
  if (!loadedName || typeof document === 'undefined' || !document.fonts?.check) return false;
  const cached = loadedFaceCache.get(loadedName);
  if (cached !== undefined) return cached;
  let loaded = false;
  try {
    loaded = document.fonts.check(`16px "${loadedName}"`);
  } catch {
    loaded = false;
  }
  loadedFaceCache.set(loadedName, loaded);
  return loaded;
};

export interface FontOverride {
  klass?: FontClass | null;
  bold?: boolean | null;
  italic?: boolean | null;
}

/**
 * Decide what the overlay should draw with. The embedded program is only used when every check
 * passes, because a partially usable face produces missing glyphs mid-word on export.
 */
export const resolveFont = (
  descriptor: PdfFontDescriptor,
  sampleText: string,
  override?: FontOverride,
): ResolvedFont => {
  const klass = override?.klass ?? classifyFont(descriptor);
  const bold = override?.bold ?? descriptor.bold;
  const italic = override?.italic ?? descriptor.italic;
  const forced = Boolean(override?.klass || override?.bold != null || override?.italic != null);
  const coverage = checkGlyphCoverage(descriptor, sampleText);
  const loaded = browserLoadedFace(descriptor.loadedName);

  if (
    !forced
    && descriptor.embedded
    && !descriptor.isType3
    && coverage.checked
    && coverage.covered
    && loaded
  ) {
    return {
      mode: 'embedded',
      cssFamily: `"${descriptor.loadedName}", ${FONT_FALLBACKS[klass]}`,
      cssWeight: 'normal',
      cssStyle: 'normal',
      klass,
      reason: null,
      missingGlyphs: [],
    };
  }

  const reason = forced
    ? 'font overridden for this paragraph'
    : descriptor.resolution === 'pending'
      ? 'this page’s own fonts have not been read yet'
      : !descriptor.embedded
      ? 'font is not embedded in this PDF'
      : descriptor.isType3
        ? 'Type 3 font: its glyphs are drawing programs, not outlines'
        : !coverage.checked
          ? 'font program could not be parsed'
          : !coverage.covered
            ? `font is missing glyphs for ${coverage.missing.slice(0, 6).join(' ')}`
            : 'the browser did not load this face';

  return {
    mode: 'substituted',
    cssFamily: FONT_FALLBACKS[klass],
    cssWeight: bold ? '700' : '400',
    cssStyle: italic ? 'italic' : 'normal',
    klass,
    reason,
    missingGlyphs: coverage.missing,
  };
};

let measureContext: CanvasRenderingContext2D | null | undefined;

const getMeasureContext = () => {
  if (measureContext !== undefined) return measureContext;
  measureContext = typeof document === 'undefined'
    ? null
    : document.createElement('canvas').getContext('2d');
  return measureContext;
};

export const measureTextWidth = (text: string, font: ResolvedFont, fontSizePx: number) => {
  const context = getMeasureContext();
  if (!context) return text.length * fontSizePx * 0.5;
  context.font = `${font.cssStyle} ${font.cssWeight} ${fontSizePx}px ${font.cssFamily}`;
  return context.measureText(text).width;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * Absorb the difference between what the browser draws and the width the PDF actually used.
 * Word spacing is tried first because it is invisible at normal reading sizes; letter spacing is
 * a last resort and is capped tightly so text never looks stretched.
 */
export const fitTextMetrics = (
  text: string,
  targetWidth: number,
  font: ResolvedFont,
  fontSizePx: number,
): TextMetricFit => {
  if (!(targetWidth > 0) || !(fontSizePx > 0) || !text) return { wordSpacing: 0, letterSpacing: 0 };
  const measured = measureTextWidth(text, font, fontSizePx);
  const delta = targetWidth - measured;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return { wordSpacing: 0, letterSpacing: 0 };

  const spaces = (text.match(/ /g) || []).length;
  const characters = Math.max(text.length, 1);
  const maxLetterSpacing = 0.09 * fontSizePx;
  const maxWordSpacing = 0.6 * fontSizePx;
  const minWordSpacing = -0.25 * fontSizePx;

  if (spaces > 0) {
    const perSpace = delta / spaces;
    if (perSpace >= minWordSpacing && perSpace <= maxWordSpacing) {
      return { wordSpacing: perSpace, letterSpacing: 0 };
    }
  }

  const letterSpacing = clamp(delta / characters, -maxLetterSpacing, maxLetterSpacing);
  const remaining = delta - letterSpacing * characters;
  const wordSpacing = spaces > 0
    ? clamp(remaining / spaces, minWordSpacing, maxWordSpacing)
    : 0;

  return { wordSpacing, letterSpacing };
};

/** Called when a different document is opened: font keys are only unique within one document. */
export const resetFontResolutionCaches = () => {
  faceCache.clear();
  coverageCache.clear();
  loadedFaceCache.clear();
};

/**
 * Code points the PDF standard fonts can draw. They are encoded with WinAnsi, which covers Latin-1
 * plus the punctuation and currency signs Windows added; anything else — CJK, Cyrillic, Greek,
 * emoji — has no glyph to point at and cannot be written with them.
 */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

const encodableByStandardFont = (codePoint: number) =>
  (codePoint >= 0x20 && codePoint <= 0x7e)
  || (codePoint >= 0xa0 && codePoint <= 0xff)
  || codePoint === 0x0a
  || codePoint === 0x0d
  || codePoint === 0x09
  || WIN_ANSI_EXTRAS.has(codePoint);

/**
 * Typography a standard PDF font has no code for, but an obvious plain equivalent for.
 *
 * Real documents are full of these — a non-breaking hyphen between model numbers, a thin space in
 * a measurement, an fi ligature from a typesetter. Refusing to save because of one would be
 * pedantic when the substitution is invisible at reading size and unambiguous in meaning.
 */
const STANDARD_FONT_SUBSTITUTIONS: Record<string, string> = {
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2015': '-', '\u2212': '-', '\u2027': '-',
  '\u2000': ' ', '\u2001': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ', '\u2005': ' ',
  '\u2006': ' ', '\u2007': ' ', '\u2008': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ',
  '\u205f': ' ', '\u3000': ' ',
  '\u2060': '', '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '',
  '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl',
  '\ufb05': 'st', '\ufb06': 'st',
  '\u2032': "'", '\u2033': '"', '\u2035': "'", '\u2036': '"',
  // Marks that typesetting reaches for and a standard font has no code for, each with a plain
  // twin that reads the same. The footnote star is the one that matters most in practice: a paper
  // whose author line carries a single "∗" would otherwise refuse to save at all.
  '\u2217': '*', '\u066d': '*',
  '\u2044': '/', '\u2215': '/', '\u2216': '\\',
  '\u223c': '~', '\u02dc': '~',
  '\u2028': '\n', '\u2029': '\n',
  '\u00ad': '',
};

/** Replace typography a standard font cannot encode with the plain equivalent it does have. */
export const substituteForStandardFont = (text: string) => {
  let output = '';
  let changed = false;
  for (const character of text) {
    const replacement = STANDARD_FONT_SUBSTITUTIONS[character];
    if (replacement === undefined) {
      output += character;
      continue;
    }
    output += replacement;
    changed = true;
  }
  return { text: output, changed };
};

/**
 * The characters in `text` that the resolved face cannot draw, capped at a handful because the
 * point is to name the problem rather than list every occurrence.
 */
export const unencodableCharacters = (
  text: string,
  font: ResolvedFont,
  descriptor?: PdfFontDescriptor,
): string[] => {
  // Nothing is refused on the strength of a font nobody has read. The caller resolves the page and
  // asks again; until then the honest answer is that we do not know of anything missing.
  if (descriptor?.resolution === 'pending') return [];
  if (font.mode === 'embedded' && descriptor) {
    return checkGlyphCoverage(descriptor, text).missing.slice(0, 6);
  }
  const missing = new Set<string>();
  for (const character of substituteForStandardFont(text).text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || encodableByStandardFont(codePoint)) continue;
    missing.add(character);
    if (missing.size >= 6) break;
  }
  return [...missing];
};

/**
 * Name a character for a message.
 *
 * A document whose text layer has no usable mapping decodes to control characters, and quoting
 * those verbatim produced refusals that read as "cannot be saved:      can only be drawn by" —
 * six invisible characters and no explanation. Anything a reader cannot see is named by its code.
 */
export const describeCharacter = (character: string) => {
  const codePoint = character.codePointAt(0) ?? 0;
  const invisible = codePoint < 0x20
    || codePoint === 0x7f
    || (codePoint >= 0x80 && codePoint <= 0x9f)
    || codePoint === 0xfffd
    || /^\s$/.test(character);
  return invisible
    ? `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
    : character;
};

export const describeCharacters = (characters: string[]) =>
  characters.map(describeCharacter).join(' ');
