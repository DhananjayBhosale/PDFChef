import { IMAGE_HEADER_BYTES, readJpegFrame } from './imageIntake.ts';

/**
 * A photo PDF written straight from JPEG files, one photo per A4 page.
 *
 * pdf-lib copies every photo into its own buffers, writes the whole PDF into one more, and the
 * caller wraps that in a Blob: about three copies of every photo at once, which took a 30-photo
 * PDF to 1.3 GB on a phone. A JPEG goes into a PDF unchanged (DCTDecode), so here each photo is a
 * part of the output Blob as it is, and its bytes are never copied into JavaScript at all.
 *
 * The photos must already be upright: like pdf-lib, this ignores EXIF orientation.
 */

const A4 = { width: 595.28, height: 841.89 };

/** Baseline, extended and progressive JPEGs, grey or colour: what every PDF reader decodes. */
const COLOUR_SPACES: Readonly<Record<number, string>> = { 1: '/DeviceGray', 3: '/DeviceRGB' };

const number = (value: number) => String(Math.round(value * 1000) / 1000);

/** Null when any file is not a JPEG this can place; the caller then uses the general writer. */
export const createJpegPhotoPdf = async (files: readonly Blob[]): Promise<Blob | null> => {
  if (files.length === 0) return null;
  const frames = [];
  for (const file of files) {
    if (file.type !== 'image/jpeg') return null;
    const frame = readJpegFrame(new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer()));
    if (!frame || frame.marker > 0xc2 || !COLOUR_SPACES[frame.components] || !frame.width || !frame.height) return null;
    frames.push(frame);
  }

  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const write = (part: string | Blob) => {
    if (typeof part === 'string') {
      const bytes = encoder.encode(part);
      parts.push(bytes);
      length += bytes.length;
    } else {
      parts.push(part);
      length += part.size;
    }
  };
  const object = (id: number, body: string) => {
    offsets[id] = length;
    write(`${id} 0 obj\n${body}\nendobj\n`);
  };

  // The second line's high bytes mark the file as binary for any tool that sniffs it.
  write('%PDF-1.4\n%âãÏÓ\n');
  const pageId = (index: number) => 3 + index * 3;
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${files.map((_, index) => `${pageId(index)} 0 R`).join(' ')}] /Count ${files.length} >>`);
  files.forEach((file, index) => {
    const frame = frames[index];
    const page = pageId(index);
    // Fitted whole and centred on the page, as the pdf-lib writer places it.
    const scale = Math.min(A4.width / frame.width, A4.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    const contents = `q\n${number(width)} 0 0 ${number(height)} ${number((A4.width - width) / 2)} ${number((A4.height - height) / 2)} cm\n/Im0 Do\nQ\n`;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    object(page + 1, `<< /Length ${contents.length} >>\nstream\n${contents}endstream`);
    offsets[page + 2] = length;
    write(`${page + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${frame.width} /Height ${frame.height} /ColorSpace ${COLOUR_SPACES[frame.components]} /BitsPerComponent 8 /Filter /DCTDecode /Length ${file.size} >>\nstream\n`);
    write(file);
    write('\nendstream\nendobj\n');
  });

  const size = offsets.length;
  const table = offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const startXref = length;
  write(`xref\n0 ${size}\n0000000000 65535 f \n${table}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
};
