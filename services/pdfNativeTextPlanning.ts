export type PdfSpaceRect = [left: number, bottom: number, right: number, top: number];

export interface PdfTextObjectSnapshot {
  objectIndex: number;
  text: string;
  bounds: PdfSpaceRect;
  characters: PdfTextCharacterSnapshot[];
  appearance?: NativePdfTextAppearance;
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
    const exactCharacterRun = selectedCharacters[0].start === sourceRun.start
      && selectedCharacters[selectedCharacters.length - 1].end === sourceRun.end
      && selectedCharacters.every((character, index) => (
        index === 0 || selectedCharacters[index - 1].end === character.start
      ))
      && selectedCharacters.map((character) => character.text).join('') === sourceText;
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

/** Build one replacement string per text object and reject overlapping edits. */
export const planNativePdfTextEdits = (
  objects: PdfTextObjectSnapshot[],
  edits: PlannedNativePdfTextEdit[],
):
  | { supported: true; changes: PlannedPdfTextObjectChange[] }
  | { supported: false; reason: string } => {
  const resolved = edits.map((edit) => ({ edit, resolution: resolveNativePdfTextTarget(objects, edit) }));
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
