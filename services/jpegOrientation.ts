/**
 * The EXIF orientation of a JPEG: 1 when it is upright or carries none, 2-8 when a viewer must
 * turn or flip it, and null when the bytes cannot be read. Browsers apply it when decoding, PDF
 * readers do not, so a turned JPEG inside a PDF must not be redrawn through the browser.
 */
export const jpegExifOrientation = (bytes: Uint8Array): number | null => {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0) !== 0xffd8) return null;
    let at = 2;
    while (at + 4 <= bytes.length) {
      const marker = view.getUint16(at);
      if ((marker & 0xff00) !== 0xff00) return null;
      // Metadata comes before the first scan, so none was found.
      if (marker === 0xffda) return 1;
      if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0) {
        const tiff = at + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const directory = tiff + view.getUint32(tiff + 4, little);
        const entries = view.getUint16(directory, little);
        for (let index = 0; index < entries; index += 1) {
          const entry = directory + 2 + index * 12;
          if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
        }
        return 1;
      }
      at += 2 + view.getUint16(at + 2);
    }
    return 1;
  } catch {
    return null;
  }
};
