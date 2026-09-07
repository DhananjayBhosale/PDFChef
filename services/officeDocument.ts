import JSZip from 'jszip';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
// The `latin` subset, not `latin-ext`. The extended subset carries only the
// accented additions — it has no A-Z, a-z or digits at all, so every ordinary
// English word embedded from it comes out as .notdef boxes.
import notoSansUrl from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import type {
  PresentationData,
  PptxFiles,
  ZipParseLimits,
} from '@aiden0z/pptx-renderer';

export interface DocxBlock {
  text: string;
  breakAfter: boolean;
}

export type PptxPageRotation = 'keep' | 'rotate_clockwise';

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_XML_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 4000;
const MAX_PPTX_BYTES = 128 * 1024 * 1024;
const MAX_PPTX_SLIDES = 250;
const EMPTY_RELATIONSHIPS_XML = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

const stripExternalRelationshipsFromXml = (xml: string): string => {
  if (!xml) return xml;
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) return EMPTY_RELATIONSHIPS_XML;

  const relationships = Array.from(document.getElementsByTagNameNS('*', 'Relationship'));
  let changed = false;
  relationships.forEach((relationship) => {
    if (relationship.getAttribute('TargetMode')?.toLowerCase() !== 'external') return;
    relationship.parentNode?.removeChild(relationship);
    changed = true;
  });

  return changed ? new XMLSerializer().serializeToString(document) : xml;
};

const stripExternalPptxRelationships = (files: PptxFiles): PptxFiles => {
  const sanitizeMap = (entries: Map<string, string> | undefined) => entries
    ? new Map(Array.from(entries, ([path, xml]) => [path, stripExternalRelationshipsFromXml(xml)]))
    : undefined;

  return {
    ...files,
    presentationRels: stripExternalRelationshipsFromXml(files.presentationRels),
    slideRels: sanitizeMap(files.slideRels) ?? new Map(),
    slideLayoutRels: sanitizeMap(files.slideLayoutRels) ?? new Map(),
    slideMasterRels: sanitizeMap(files.slideMasterRels) ?? new Map(),
    chartRels: sanitizeMap(files.chartRels),
  };
};

const readableError = (error: unknown, fallback: string) => error instanceof Error && error.message
  ? error.message
  : fallback;

interface ZipByteStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipByteStream;
  on(event: 'end', callback: () => void): ZipByteStream;
  on(event: 'error', callback: (error: Error) => void): ZipByteStream;
  pause(): ZipByteStream;
  resume(): ZipByteStream;
}

type StreamableZipEntry = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): ZipByteStream;
  _data?: { uncompressedSize?: number };
};

const readZipEntryWithinLimit = (entry: JSZip.JSZipObject, maxBytes: number): Promise<Uint8Array> => {
  const streamable = entry as StreamableZipEntry;
  if ((streamable._data?.uncompressedSize ?? 0) > maxBytes) {
    return Promise.reject(new Error('This Word document is too large to convert safely in this browser.'));
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = streamable.internalStream('uint8array');

    stream
      .on('data', (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > maxBytes) {
          settled = true;
          chunks.length = 0;
          stream.pause();
          reject(new Error('This Word document is too large to convert safely in this browser.'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        chunks.forEach((chunk) => {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        });
        resolve(bytes);
      })
      .resume();
  });
};

const isPageBreak = (element: Element) => (
  element.getAttributeNS(WORD_NAMESPACE, 'type') === 'page' || element.getAttribute('w:type') === 'page'
);

const readParagraph = (paragraph: Element): DocxBlock[] => {
  const blocks: DocxBlock[] = [];
  let text = '';

  const flush = (breakAfter: boolean) => {
    blocks.push({ text: text.replace(/[ \t]+$/gm, ''), breakAfter });
    text = '';
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (element.namespaceURI === WORD_NAMESPACE && element.localName === 't') {
        text += element.textContent || '';
        return;
      }
      if (element.namespaceURI === WORD_NAMESPACE && element.localName === 'tab') {
        text += '\t';
        return;
      }
      if (element.namespaceURI === WORD_NAMESPACE && element.localName === 'br') {
        if (isPageBreak(element)) flush(true);
        else text += '\n';
        return;
      }
      if (element !== paragraph && element.namespaceURI === WORD_NAMESPACE && element.localName === 'p') {
        if (text && !text.endsWith('\n')) text += '\n';
      }
    }
    node.childNodes.forEach(visit);
  };

  paragraph.childNodes.forEach(visit);
  if (text || blocks.length === 0) flush(false);
  return blocks;
};

export const extractDocxBlocks = async (file: File): Promise<DocxBlock[]> => {
  if (!file.name.toLowerCase().endsWith('.docx')) {
    throw new Error('Choose a .docx Word file. Legacy .doc files are not supported.');
  }
  if (file.size > MAX_DOCX_BYTES) {
    throw new Error('This Word document is too large to convert safely in this browser.');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error('This is not a readable Word file. Make sure it ends in .docx, then try again.');
  }
  if (Object.keys(zip.files).length > MAX_DOCX_ENTRIES) {
    throw new Error('This Word document contains too many files to convert safely.');
  }

  const documentPart = zip.file('word/document.xml');
  if (!documentPart) throw new Error('This package does not contain a Word document.');

  const documentXmlBytes = await readZipEntryWithinLimit(documentPart, MAX_DOCX_XML_BYTES);
  const xml = new TextDecoder().decode(documentXmlBytes);

  const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
  if (documentXml.querySelector('parsererror')) throw new Error('This Word file is damaged, so its text could not be read. Try re-saving it from Word and converting again.');

  const paragraphs = Array.from(documentXml.getElementsByTagNameNS(WORD_NAMESPACE, 'p'))
    .filter((paragraph) => {
      let parent = paragraph.parentElement;
      while (parent) {
        if (parent.namespaceURI === WORD_NAMESPACE && parent.localName === 'p') return false;
        parent = parent.parentElement;
      }
      return true;
    });

  const blocks = paragraphs.flatMap(readParagraph);
  if (!blocks.some((block) => block.text.trim())) {
    throw new Error('There is no readable text in this Word file. If the pages are pictures or shapes, they cannot be converted here.');
  }
  return blocks;
};

const splitLongWord = (word: string, font: PDFFont, size: number, width: number): string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const character of Array.from(word)) {
    const candidate = current + character;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

const wrapLine = (line: string, font: PDFFont, size: number, width: number): string[] => {
  if (!line) return [''];
  const words = line.replace(/\t/g, ' ').split(/ +/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      return;
    }
    if (current) lines.push(current);
    const chunks = splitLongWord(word, font, size, width);
    lines.push(...chunks.slice(0, -1));
    current = chunks[chunks.length - 1] || '';
  });
  if (current) lines.push(current);
  return lines.length ? lines : [''];
};

/**
 * Which characters this font has no glyph for.
 *
 * This used to ask pdf-lib to measure each character and treat a throw as
 * "missing". It never throws: a codepoint the font does not cover maps to glyph
 * 0 and measures at the .notdef advance, so the check passed for text that was
 * about to be drawn as a row of boxes. Ask the font itself instead.
 */
const unsupportedCharacters = (coverage: FontCoverage, blocks: DocxBlock[]) => {
  const unsupported = new Set<string>();
  for (const block of blocks) {
    for (const character of Array.from(block.text)) {
      if (/\s/.test(character)) continue;
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && !coverage.has(codePoint)) unsupported.add(character);
      if (unsupported.size >= 6) return [...unsupported];
    }
  }
  return [...unsupported];
};

interface FontCoverage {
  has(codePoint: number): boolean;
}

export const convertDocxToPdf = async (
  file: File,
  onProgress?: (current: number, total: number) => void,
): Promise<Uint8Array> => {
  const blocks = await extractDocxBlocks(file);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontBytes = await fetch(notoSansUrl).then((response) => {
    if (!response.ok) throw new Error('The font needed for the PDF could not be loaded. Check you are online for a moment, then try again.');
    return response.arrayBuffer();
  });
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const coverage = fontkit.create(new Uint8Array(fontBytes)) as unknown as {
    hasGlyphForCodePoint(codePoint: number): boolean;
  };
  const unsupported = unsupportedCharacters(
    { has: (codePoint) => coverage.hasGlyphForCodePoint(codePoint) },
    blocks,
  );
  if (unsupported.length) {
    throw new Error(`PDF text cannot be exported exactly. Unsupported characters: ${unsupported.join(' ')}.`);
  }

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const fontSize = 11;
  const lineHeight = 16;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  let pageBreakPending = false;

  const newPage = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };

  blocks.forEach((block, index) => {
    if (pageBreakPending) {
      newPage();
      pageBreakPending = false;
    }

    const lines = block.text.split('\n').flatMap((line) => wrapLine(line, font, fontSize, pageWidth - margin * 2));
    lines.forEach((line) => {
      if (y < margin) newPage();
      if (line) page.drawText(line, { x: margin, y, font, size: fontSize, color: rgb(0.08, 0.1, 0.14) });
      y -= lineHeight;
    });
    if (block.breakAfter) pageBreakPending = true;
    onProgress?.(index + 1, blocks.length);
  });

  return pdf.save();
};

const settleLayout = async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};

const renderPresentation = async (
  file: File,
  parseZip: (buffer: ArrayBuffer, limits?: ZipParseLimits) => Promise<PptxFiles>,
  buildPresentation: (files: PptxFiles) => PresentationData,
  zipLimits: Readonly<ZipParseLimits>,
): Promise<PresentationData> => {
  if (!file.name.toLowerCase().endsWith('.pptx')) throw new Error('Choose a .pptx PowerPoint file.');
  if (file.size > MAX_PPTX_BYTES) throw new Error('This presentation is too large to convert safely in this browser.');
  const files = stripExternalPptxRelationships(await parseZip(await file.arrayBuffer(), {
    ...zipLimits,
    maxConcurrency: 2,
  }));
  const presentation = buildPresentation(files);
  if (!presentation.slides.length) throw new Error('This presentation does not contain any slides.');
  if (presentation.slides.length > MAX_PPTX_SLIDES) throw new Error('This presentation has too many slides to convert safely.');
  if (!(presentation.width > 0) || !(presentation.height > 0)) throw new Error('This presentation does not say how big its slides are, so it cannot be converted. Try re-saving it from PowerPoint.');
  return presentation;
};

export const convertPptxToPdf = async (
  file: File,
  rotation: PptxPageRotation,
  onProgress?: (current: number, total: number) => void,
): Promise<Uint8Array> => {
  if (!file.name.toLowerCase().endsWith('.pptx')) throw new Error('Choose a .pptx PowerPoint file.');
  if (file.size > MAX_PPTX_BYTES) throw new Error('This presentation is too large to convert safely in this browser.');

  const [html2canvasModule, renderer, jsPdfModule] = await Promise.all([
    import('html2canvas'),
    import('@aiden0z/pptx-renderer'),
    import('jspdf'),
  ]);
  let presentation: PresentationData;
  try {
    presentation = await renderPresentation(
      file,
      renderer.parseZip,
      renderer.buildPresentation,
      renderer.RECOMMENDED_ZIP_LIMITS,
    );
  } catch (error) {
    throw new Error(readableError(error, 'Unable to read this PowerPoint presentation.'));
  }

  const sourceWidth = presentation.width;
  const sourceHeight = presentation.height;
  const rotated = rotation === 'rotate_clockwise';
  const pageWidth = rotated ? sourceHeight : sourceWidth;
  const pageHeight = rotated ? sourceWidth : sourceHeight;
  const orientation = pageWidth >= pageHeight ? 'landscape' : 'portrait';
  const pdf = new jsPdfModule.jsPDF({ unit: 'pt', format: [pageWidth, pageHeight], orientation, compress: true });

  const longEdge = 1280;
  const scale = longEdge / Math.max(sourceWidth, sourceHeight);
  const renderWidth = Math.max(1, Math.round(sourceWidth * scale));
  const renderHeight = Math.max(1, Math.round(sourceHeight * scale));
  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  Object.assign(root.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${renderWidth}px`,
    height: `${renderHeight}px`,
    overflow: 'hidden',
    background: '#ffffff',
    pointerEvents: 'none',
  });
  document.body.appendChild(root);

  try {
    for (let index = 0; index < presentation.slides.length; index += 1) {
      const handle = renderer.renderSlide(presentation, presentation.slides[index], {
        pdfjs: undefined,
        onNavigate: () => undefined,
        onNodeError: (_nodeId, error) => console.warn('PowerPoint node render warning', error),
      });
      try {
        root.replaceChildren(handle.element);
        Object.assign(handle.element.style, {
          position: 'absolute',
          left: '0',
          top: '0',
          transform: `scale(${scale})`,
          transformOrigin: 'left top',
        });
        await handle.ready;
        await settleLayout();
        const canvas = await html2canvasModule.default(root, {
          backgroundColor: '#ffffff',
          width: renderWidth,
          height: renderHeight,
          scale: 1,
          logging: false,
          useCORS: false,
        });

        let imageCanvas = canvas;
        if (rotated) {
          const rotatedCanvas = document.createElement('canvas');
          rotatedCanvas.width = canvas.height;
          rotatedCanvas.height = canvas.width;
          const context = rotatedCanvas.getContext('2d');
          if (!context) throw new Error('A slide could not be turned the right way up. Try re-saving the file from PowerPoint.');
          context.translate(rotatedCanvas.width, 0);
          context.rotate(Math.PI / 2);
          context.drawImage(canvas, 0, 0);
          imageCanvas = rotatedCanvas;
        }

        if (index > 0) pdf.addPage([pageWidth, pageHeight], orientation);
        pdf.addImage(imageCanvas.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');
        onProgress?.(index + 1, presentation.slides.length);
      } finally {
        handle.dispose();
        root.replaceChildren();
      }
    }
  } finally {
    root.remove();
  }

  return new Uint8Array(pdf.output('arraybuffer'));
};
