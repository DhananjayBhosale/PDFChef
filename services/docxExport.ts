import JSZip from 'jszip';
import { loadPDFDocument } from './pdfBrowser';

/**
 * Mirrors `NO_EXTRACTABLE_TEXT_MESSAGE` in the Android app
 * (`data/repository/processors/OcrTextToolProcessor.kt`).
 *
 * A .docx whose only content is "no text found" is not a conversion, so both platforms
 * fail instead of handing back a junk file.
 */
export const NO_EXTRACTABLE_TEXT_MESSAGE =
  'This PDF is a scan, so its pages are pictures rather than words. Run Extract Text on it first to make the words readable, then try again.';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELATIONSHIPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const escapeXml = (value: string): string => {
  let escaped = '';

  for (const char of value) {
    if (char === '&') escaped += '&amp;';
    else if (char === '<') escaped += '&lt;';
    else if (char === '>') escaped += '&gt;';
    else if (char === '"') escaped += '&quot;';
    else if (char === "'") escaped += '&apos;';
    else if (char === '\t' || char === '\n' || char === '\r' || (char.codePointAt(0) ?? 0) >= 0x20) escaped += char;
  }

  return escaped;
};

const paragraphXml = (line: string): string => {
  if (line.trim().length === 0) return '<w:p/>';
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
};

export const buildDocxDocumentXml = (pages: string[]): string => {
  let body = '';

  pages.forEach((page, pageIndex) => {
    const lines = page.split('\n').map((line) => line.replace(/\s+$/, ''));
    const pageLines = lines.length > 0 ? lines : [''];

    for (const line of pageLines) {
      body += paragraphXml(line);
    }

    if (pageIndex < pages.length - 1) {
      body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
};

export const buildDocxBlob = async (pages: string[]): Promise<Blob> => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', PACKAGE_RELATIONSHIPS_XML);
  zip.file('word/document.xml', buildDocxDocumentXml(pages));

  return zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME_TYPE });
};

/**
 * One string per page, with line breaks kept. pdf.js marks the last item of a visual
 * line with `hasEOL`, which is what keeps paragraphs from collapsing into one run.
 */
export const extractPageTextForExport = async (
  file: File,
  onProgress?: (current: number, total: number) => void,
): Promise<string[]> => {
  const pdf = await loadPDFDocument(file);
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();

    let pageText = '';
    for (const item of textContent.items as any[]) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
    }

    pages.push(pageText.replace(/[ \t]+$/gm, ''));
    onProgress?.(pageNumber, pdf.numPages);
  }

  return pages;
};

/**
 * Browser equivalent of the Android `PdfToDocToolProcessor`: export the existing text
 * layer to DOCX. It does no optical recognition, so a scan has nothing to export.
 */
export const convertPDFToDocx = async (
  file: File,
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> => {
  const pages = await extractPageTextForExport(file, onProgress);

  if (pages.length === 0) throw new Error('Selected PDF has no pages.');
  if (!pages.some((page) => page.trim().length > 0)) throw new Error(NO_EXTRACTABLE_TEXT_MESSAGE);

  return buildDocxBlob(pages);
};

export const docxFileNameFor = (pdfName: string): string => `${pdfName.replace(/\.pdf$/i, '')}.docx`;

export { DOCX_MIME_TYPE };
