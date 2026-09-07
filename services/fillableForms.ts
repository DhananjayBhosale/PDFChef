import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { readFileAsArrayBuffer } from './pdfShared';
import { getPdfPageVisualGeometry } from './pdfPageGeometry';
import { getVisualPageSize, visualPointToPdf } from './pdfEditorGeometry';

export type FillableFieldKind = 'text' | 'multiline' | 'checkbox' | 'radio' | 'dropdown';

export interface FillableFieldPlacement {
  id: string;
  name: string;
  kind: FillableFieldKind;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  options?: string[];
  radioGroup?: string;
}

export interface VisualFormFieldSuggestion {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'text' | 'checkbox';
}

const loadImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('This page could not be checked for boxes to type into. Try another page, or draw the boxes yourself.'));
  image.src = source;
});

const overlaps = (left: VisualFormFieldSuggestion, right: VisualFormFieldSuggestion) => {
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = intersectionWidth * intersectionHeight;
  return intersection > Math.min(left.width * left.height, right.width * right.height) * 0.55;
};

/**
 * Finds common empty field outlines and writing lines without shipping the Android-only FFDNet model.
 * This intentionally prefers fewer, stronger candidates; the editor always requires human review.
 */
export const detectVisualFormFields = async (imageSource: string): Promise<VisualFormFieldSuggestion[]> => {
  const image = await loadImage(imageSource);
  const maximumWidth = 1200;
  const scale = Math.min(1, maximumWidth / Math.max(1, image.naturalWidth));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const dark = (x: number, y: number) => {
    const index = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
    return pixels[index + 3] > 80 && (pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114) < 118;
  };

  const horizontalRuns: Array<{ y: number; start: number; end: number }> = [];
  for (let y = 2; y < height - 2; y += 2) {
    let start = -1;
    let gaps = 0;
    for (let x = 2; x < width - 2; x += 1) {
      if (dark(x, y)) {
        if (start < 0) start = x;
        gaps = 0;
      } else if (start >= 0 && gaps < 2) {
        gaps += 1;
      } else if (start >= 0) {
        if (x - gaps - start >= 12) horizontalRuns.push({ y, start, end: x - gaps });
        start = -1;
        gaps = 0;
      }
    }
  }

  const suggestions: VisualFormFieldSuggestion[] = [];
  const add = (candidate: VisualFormFieldSuggestion) => {
    if (candidate.width < 0.025 || candidate.height < 0.012) return;
    if (suggestions.some((existing) => overlaps(existing, candidate))) return;
    suggestions.push(candidate);
  };

  // Closed small boxes are treated as checkbox candidates. Larger outlines become text fields.
  for (const top of horizontalRuns) {
    const runWidth = top.end - top.start;
    if (runWidth < 10 || runWidth > width * 0.75) continue;
    const maximumBoxHeight = Math.min(Math.round(width * 0.09), Math.round(height * 0.12));
    const bottom = horizontalRuns.find((candidate) => {
      const boxHeight = candidate.y - top.y;
      if (boxHeight < 8 || boxHeight > maximumBoxHeight) return false;
      return Math.abs(candidate.start - top.start) <= 4 && Math.abs(candidate.end - top.end) <= 4;
    });
    if (!bottom) continue;
    const boxHeight = bottom.y - top.y;
    const leftInk = Array.from({ length: boxHeight + 1 }, (_, offset) => dark(top.start, top.y + offset)).filter(Boolean).length / (boxHeight + 1);
    const rightInk = Array.from({ length: boxHeight + 1 }, (_, offset) => dark(top.end, top.y + offset)).filter(Boolean).length / (boxHeight + 1);
    if (leftInk < 0.55 || rightInk < 0.55) continue;
    const nearSquare = runWidth / boxHeight > 0.68 && runWidth / boxHeight < 1.45 && runWidth < width * 0.075;
    add({
      x: top.start / width,
      y: top.y / height,
      width: runWidth / width,
      height: boxHeight / height,
      kind: nearSquare ? 'checkbox' : 'text',
    });
  }

  // Long isolated writing lines become text fields positioned just above the baseline.
  for (const run of horizontalRuns) {
    const runWidth = run.end - run.start;
    if (runWidth < width * 0.11 || runWidth > width * 0.72) continue;
    const candidate: VisualFormFieldSuggestion = {
      x: run.start / width,
      y: Math.max(0, (run.y - Math.max(18, height * 0.035)) / height),
      width: runWidth / width,
      height: Math.max(18, height * 0.035) / height,
      kind: 'text',
    };
    add(candidate);
    if (suggestions.length >= 80) break;
  }

  return suggestions.slice(0, 80);
};

const fieldName = (raw: string, index: number, used: Set<string>) => {
  const base = raw.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_\-.]+|[_\-.]+$/g, '') || `field_${index + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(name);
  return name;
};

export const createFillablePdf = async (file: File, placements: FillableFieldPlacement[]): Promise<Uint8Array> => {
  if (!placements.length) throw new Error('Add at least one form field before exporting.');
  const pdf = await PDFDocument.load(await readFileAsArrayBuffer(file));
  const pages = pdf.getPages();
  if (!pages.length) throw new Error('Selected PDF has no pages.');
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const used = new Set(form.getFields().map((field) => field.getName()));
  const radioGroups = new Map<string, ReturnType<typeof form.createRadioGroup>>();

  placements.forEach((placement, index) => {
    const page = pages[placement.pageIndex];
    if (!page) return;
    const geometry = getPdfPageVisualGeometry(page);
    const size = getVisualPageSize(geometry);
    const name = fieldName(placement.name, index, used);
    const left = Math.max(0, Math.min(0.98, placement.x));
    const top = Math.max(0, Math.min(0.985, placement.y));
    const width = Math.min(1 - left, Math.max(0.02, placement.width)) * size.width;
    const height = Math.min(1 - top, Math.max(0.015, placement.height)) * size.height;
    const origin = visualPointToPdf(geometry, left * size.width, top * size.height + height);
    const appearance = {
      x: origin.x,
      y: origin.y,
      width,
      height,
      rotate: degrees(geometry.rotation),
      borderWidth: 1,
      borderColor: rgb(0.25, 0.45, 0.8),
      backgroundColor: rgb(0.97, 0.98, 1),
      textColor: rgb(0.05, 0.08, 0.14),
      font,
    };

    if (placement.kind === 'checkbox') {
      const field = form.createCheckBox(name);
      if (placement.required) field.enableRequired();
      field.addToPage(page, appearance);
      return;
    }

    if (placement.kind === 'radio') {
      const groupName = placement.radioGroup?.trim() || 'choice';
      let group = radioGroups.get(groupName);
      if (!group) {
        const uniqueGroupName = fieldName(groupName, index, used);
        group = form.createRadioGroup(uniqueGroupName);
        radioGroups.set(groupName, group);
      }
      if (placement.required) group.enableRequired();
      group.addOptionToPage(name, page, appearance);
      return;
    }

    if (placement.kind === 'dropdown') {
      const field = form.createDropdown(name);
      const options = (placement.options || []).map((option) => option.trim()).filter(Boolean);
      field.addOptions(options.length ? options : ['Choose…']);
      if (placement.required) field.enableRequired();
      field.addToPage(page, appearance);
      field.updateAppearances(font);
      return;
    }

    const field = form.createTextField(name);
    if (placement.kind === 'multiline') field.enableMultiline();
    if (placement.required) field.enableRequired();
    field.addToPage(page, appearance);
    field.setFontSize(Math.max(8, Math.min(16, height * 0.45)));
    field.updateAppearances(font);
  });

  return pdf.save();
};
