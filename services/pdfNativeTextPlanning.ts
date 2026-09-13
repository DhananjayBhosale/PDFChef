export type PdfSpaceRect = [left: number, bottom: number, right: number, top: number];

export interface PdfTextObjectSnapshot {
  objectIndex: number;
  text: string;
  bounds: PdfSpaceRect;
  characters: PdfTextCharacterSnapshot[];
  appearance?: NativePdfTextAppearance;
  /** Engine-local font identity and upright baseline, used to match fragmented source runs. */
  fontId?: number;
  baseline?: [number, number];
}

export interface PdfTextCharacterSnapshot {
  pageCharacterIndex: number;
  text: string;
  start: number;
  end: number;
  bounds: PdfSpaceRect;
  /**
   * True when the PDF never stored this character and the extractor inferred it from the gap
   * between two glyphs.
   *
   * Documents that position every word separately — anything from TeX, and most typeset PDFs —
   * contain no space characters at all. The extractor supplies them so the text reads correctly,
   * and they have to be kept here or a run's characters no longer sit end to end and the run stops
   * matching its own text object. They are not ink, though: nothing may measure them, rewrite them,
   * or expect the same ones back after a save.
   */
  generated: boolean;
}

export interface NativePdfTextAppearance {
  fontFamily: 'Helvetica' | 'TimesRoman' | 'Courier';
  fontSize: number;
  color: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
}

export interface NativePdfTextTarget {
  sourceText: string;
  pdfRect: PdfSpaceRect;
  sourceRun?: {
    text: string;
    start: number;
    end: number;
    pdfRect: PdfSpaceRect;
  };
}

export interface ResolvedNativePdfTextTarget {
  objectIndex: number;
  objectText: string;
  start: number;
  end: number;
  score: number;
  pdfRect: PdfSpaceRect;
  objectPdfRect: PdfSpaceRect;
  appearance?: NativePdfTextAppearance;
}

export type NativePdfTextTargetResolution =
  | { supported: true; target: ResolvedNativePdfTextTarget }
  | { supported: false; reason: string };

export interface PlannedNativePdfTextEdit extends NativePdfTextTarget {
  replacementText: string;
}

export interface PlannedPdfTextObjectChange {
  objectIndex: number;
  originalText: string;
  replacementText: string;
}

/**
 * Whether a PDF engine's text object is the same run PDF.js reported.
 *
 * Engines synthesise a trailing space when the next object on the line starts after a gap, so a
 * run that stands alone — a bold lead-in, a column, a table cell — reads back one character longer
 * than it was written. Only trailing whitespace may differ: every character before it must be
 * identical, which keeps the character offsets used for the splice aligned.
 */
export const sameSourceRun = (objectText: string, sourceText: string) =>
  objectText === sourceText || objectText.replace(/\s+$/, '') === sourceText.replace(/\s+$/, '');

const normalizedRect = (rect: PdfSpaceRect): PdfSpaceRect => [
  Math.min(rect[0], rect[2]),
  Math.min(rect[1], rect[3]),
  Math.max(rect[0], rect[2]),
  Math.max(rect[1], rect[3]),
];

const rectArea = (rect: PdfSpaceRect) => Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);

const overlapArea = (first: PdfSpaceRect, second: PdfSpaceRect) => {
  const width = Math.min(first[2], second[2]) - Math.max(first[0], second[0]);
  const height = Math.min(first[3], second[3]) - Math.max(first[1], second[1]);
  return width > 0 && height > 0 ? width * height : 0;
};

const unionRects = (rects: PdfSpaceRect[]): PdfSpaceRect => [
  Math.min(...rects.map((rect) => rect[0])),
  Math.min(...rects.map((rect) => rect[1])),
  Math.max(...rects.map((rect) => rect[2])),
  Math.max(...rects.map((rect) => rect[3])),
];

/**
 * Resolve one PDF.js source item to one PDFium text object, then map the chosen
 * word through PDFium's real character boxes. The proportional PDF.js word box
 * is only a hit/ranking hint and never determines the string splice.
 */
export const resolveNativePdfTextTarget = (
  objects: PdfTextObjectSnapshot[],
  input: NativePdfTextTarget,
): NativePdfTextTargetResolution => {
  const sourceText = input.sourceText;
  if (!sourceText) return { supported: false, reason: 'Empty source text cannot be matched.' };
  if (!input.pdfRect.every(Number.isFinite)) {
    return { supported: false, reason: 'The selected word has invalid PDF coordinates.' };
  }
  const sourceRun = input.sourceRun;
  if (!sourceRun || !sourceRun.pdfRect.every(Number.isFinite)) {
    return { supported: false, reason: 'The selected word has no stable source text run.' };
  }
  if (
    sourceRun.start < 0
    || sourceRun.end <= sourceRun.start
    || sourceRun.end > sourceRun.text.length
    || sourceRun.text.slice(sourceRun.start, sourceRun.end) !== sourceText
  ) {
    return { supported: false, reason: 'The selected word no longer matches its source text run.' };
  }

  const sourceRunRect = normalizedRect(sourceRun.pdfRect);
  const sourceRunArea = Math.max(rectArea(sourceRunRect), 1e-6);
  const candidates: ResolvedNativePdfTextTarget[] = [];

  objects.forEach((object) => {
    const bounds = normalizedRect(object.bounds);
    if (!sameSourceRun(object.text, sourceRun.text)) return;
    const sharedArea = overlapArea(bounds, sourceRunRect);
    if (sharedArea <= 0) return;

    const selectedCharacters = object.characters.filter((character) => (
      character.start >= sourceRun.start && character.end <= sourceRun.end
    ));
    if (selectedCharacters.length === 0) return;
    // PDFium can attach an inferred space to the object's text without attaching a character
    // record to that object. Permit those whitespace-only holes; every visible glyph must match.
    let cursor = sourceRun.start;
    const exactCharacterRun = selectedCharacters.every((character) => {
      if (character.start < cursor || sourceRun.text.slice(cursor, character.start).trim()
        || sourceRun.text.slice(character.start, character.end) !== character.text) return false;
      cursor = character.end;
      return true;
    }) && !sourceRun.text.slice(cursor, sourceRun.end).trim();
    if (!exactCharacterRun) return;

    const objectArea = Math.max(rectArea(bounds), 1e-6);
    const score = sharedArea / sourceRunArea + sharedArea / objectArea;
    candidates.push({
      objectIndex: object.objectIndex,
      objectText: object.text,
      start: sourceRun.start,
      end: sourceRun.end,
      score,
      // Generated spacing carries no box worth trusting, so the run's own rectangle is measured
      // from the glyphs the PDF really stores.
      pdfRect: unionRects((selectedCharacters.some((character) => !character.generated)
        ? selectedCharacters.filter((character) => !character.generated)
        : selectedCharacters).map((character) => normalizedRect(character.bounds))),
      objectPdfRect: bounds,
      appearance: object.appearance,
    });
  });

  candidates.sort((first, second) => second.score - first.score);
  const best = candidates[0];
  if (!best) {
    return {
      supported: false,
      reason: 'This visible word could not be mapped to one editable PDF text object.',
    };
  }

  const runnerUp = candidates[1];
  if (runnerUp && best.score < runnerUp.score * 2) {
    return {
      supported: false,
      reason: 'This word maps to more than one PDF text object, so a direct edit would be unsafe.',
    };
  }

  return { supported: true, target: best };
};

const expandDeletionGroups = (
  originalText: string,
  edits: Array<{ start: number; end: number; replacementText: string; objectText: string }>,
) => {
  const ordered = [...edits].sort((first, second) => first.start - second.start);
  const grouped: typeof ordered = [];

  ordered.forEach((edit) => {
    const previous = grouped[grouped.length - 1];
    if (
      previous
      && previous.replacementText === ''
      && edit.replacementText === ''
      && /^\s*$/.test(originalText.slice(previous.end, edit.start))
    ) {
      previous.end = edit.end;
      return;
    }
    grouped.push({ ...edit });
  });

  return grouped.map((edit) => {
    if (edit.replacementText !== '') return edit;
    let { start, end } = edit;
    if (end < originalText.length && /\s/.test(originalText[end])) {
      while (end < originalText.length && /\s/.test(originalText[end])) end += 1;
    } else {
      while (start > 0 && /\s/.test(originalText[start - 1])) start -= 1;
    }
    return { ...edit, start, end };
  });
};

/**
 * PDF.js can join separately positioned words or glyphs into one source item. Keep a fitting
 * edit in those original objects instead of changing its font just because the engines disagree
 * about where an item ends. This path requires an exact, unambiguous upright run in one font.
 */
const expandFragmentedRunEdit = (
  objects: PdfTextObjectSnapshot[],
  edit: PlannedNativePdfTextEdit,
): PlannedNativePdfTextEdit[] | null => {
  const source = edit.sourceRun;
  if (!source || source.start !== 0 || source.end !== source.text.length
    || source.text !== edit.sourceText || !source.pdfRect.every(Number.isFinite)) return null;
  const rect = normalizedRect(source.pdfRect);
  const fragments = objects.filter((object) => {
    if (!object.text.trim() || !object.baseline || object.fontId === undefined) return false;
    // PDF.js reports the advance box from the baseline upwards. Commas and other low ink can
    // sit entirely below it, so use the actual baseline to identify the row, not glyph centres.
    if (Math.abs(object.baseline[1] - rect[1]) > 0.5) return false;
    const ink = object.characters.filter((character) => !character.generated && character.text.trim());
    return ink.length > 0 && ink.every(({ bounds }) => {
      const cx = (bounds[0] + bounds[2]) / 2;
      return cx >= rect[0] && cx <= rect[2];
    });
  }).sort((a, b) => a.baseline![0] - b.baseline![0]);
  if (fragments.length < 2 || fragments.some((object) => (
    object.fontId !== fragments[0].fontId
    || Math.abs(object.baseline![1] - fragments[0].baseline![1]) > 0.15
  ))) return null;

  let offset = 0;
  const spans: Array<{ object: PdfTextObjectSnapshot; start: number; end: number }> = [];
  for (const object of fragments) {
    // Extractors can infer a trailing space as well as reporting a separate space object.
    // Skip only spacing; every visible character still has to match in its original order.
    while (/\s/.test(source.text[offset] ?? '') && offset < source.text.length) offset += 1;
    const text = object.text.trimEnd();
    if (!source.text.startsWith(text, offset)) return null;
    spans.push({ object, start: offset, end: offset + text.length });
    offset += text.length;
  }
  if (source.text.slice(offset).trim()) return null;

  let prefix = 0;
  while (prefix < source.text.length && source.text[prefix] === edit.replacementText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(source.text.length, edit.replacementText.length) - prefix
    && source.text.at(-suffix - 1) === edit.replacementText.at(-suffix - 1)) suffix += 1;
  let start = prefix;
  let end = source.text.length - suffix;
  // Rewrite an affected word together. Keeping a narrow replacement glyph in a wider glyph's
  // old slot creates a gap that extractors mistake for a new space ("note" -> "t one").
  // Other words and lines keep their own objects and positions.
  while (start > 0 && !/\s/.test(source.text[start - 1])) start -= 1;
  while (end < source.text.length && !/\s/.test(source.text[end])) end += 1;
  const touched = spans.filter((span) => span.start < end && span.end > start);
  if (!touched.length || start < touched[0].start || end > touched.at(-1)!.end) return null;
  const first = touched[0];
  const last = touched.at(-1)!;
  const rebuilt = source.text.slice(first.start, start)
    + edit.replacementText.slice(start, edit.replacementText.length - (source.text.length - end))
    + last.object.text.slice(end - last.start);

  return touched.flatMap(({ object }, index) => {
    const replacement = index === 0 ? rebuilt : '';
    if (replacement === object.text) return [];
    return [{
      sourceText: object.text, pdfRect: object.bounds, replacementText: replacement,
      sourceRun: { text: object.text, start: 0, end: object.text.length, pdfRect: object.bounds },
    }];
  });
};

/** Build one replacement string per text object and reject overlapping edits. */
export const planNativePdfTextEdits = (
  objects: PdfTextObjectSnapshot[],
  edits: PlannedNativePdfTextEdit[],
):
  | { supported: true; changes: PlannedPdfTextObjectChange[] }
  | { supported: false; reason: string } => {
  const resolved = edits.flatMap((edit) => {
    const resolution = resolveNativePdfTextTarget(objects, edit);
    if (resolution.supported) return [{ edit, resolution }];
    const fragments = expandFragmentedRunEdit(objects, edit);
    return fragments?.length
      ? fragments.map((fragment) => ({ edit: fragment, resolution: resolveNativePdfTextTarget(objects, fragment) }))
      : [{ edit, resolution }];
  });
  const unsupported = resolved.find(({ resolution }) => 'reason' in resolution);
  if (unsupported && 'reason' in unsupported.resolution) {
    return { supported: false, reason: unsupported.resolution.reason };
  }

  const byObject = new Map<number, Array<{
    start: number;
    end: number;
    replacementText: string;
    objectText: string;
  }>>();

  resolved.forEach(({ edit, resolution }) => {
    if (!resolution.supported) return;
    const list = byObject.get(resolution.target.objectIndex) ?? [];
    list.push({
      start: resolution.target.start,
      end: resolution.target.end,
      replacementText: edit.replacementText,
      objectText: resolution.target.objectText,
    });
    byObject.set(resolution.target.objectIndex, list);
  });

  const changes: PlannedPdfTextObjectChange[] = [];
  for (const [objectIndex, objectEdits] of byObject) {
    const originalText = objectEdits[0]?.objectText ?? '';
    const ordered = expandDeletionGroups(originalText, objectEdits)
      .sort((first, second) => second.start - first.start);
    let previousStart = originalText.length + 1;
    let replacementText = originalText;

    for (const edit of ordered) {
      if (edit.end > previousStart) {
        return {
          supported: false,
          reason: 'Two pending direct edits overlap inside the same PDF text object.',
        };
      }
      replacementText = `${replacementText.slice(0, edit.start)}${edit.replacementText}${replacementText.slice(edit.end)}`;
      previousStart = edit.start;
    }

    changes.push({ objectIndex, originalText, replacementText });
  }

  return { supported: true, changes };
};
