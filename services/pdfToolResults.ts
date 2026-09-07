import { groupPositionedTextItems } from './pdfTextLineGrouping.ts';

/** Reserve names before writing to an archive: JSZip replaces an existing entry silently. */
export const reserveArchiveName = (filename: string, used: Set<string>): string => {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  let candidate = filename;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${suffix++})${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
};

export const compareExtractedPageText = (left: string, right: string): 'matches' | 'differs' | 'unavailable' => {
  if (!left.trim() || !right.trim()) return 'unavailable';
  return left.trim() === right.trim() ? 'matches' : 'differs';
};

/** Selection targets are words, not lines. Reassemble nearby words before copying/exporting. */
export const textFromSelectionTargets = (
  words: ReadonlyArray<{ text: string; left: number; top: number; width: number; height: number }>,
): string => {
  return groupPositionedTextItems(words.map((word) => ({
    text: `${word.text.trim()} `,
    left: word.left,
    top: word.top,
    right: word.left + word.width,
    bottom: word.top + word.height,
    height: word.height,
    centerY: word.top + word.height / 2,
  }))).map((line) => line.text).join('\n');
};
