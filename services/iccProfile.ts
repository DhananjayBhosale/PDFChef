// sRGB red, green and blue primaries as an ICC profile stores them (D50-adapted XYZ).
const SRGB_PRIMARIES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['rXYZ', [0.4361, 0.2225, 0.0139]],
  ['gXYZ', [0.3851, 0.7169, 0.0971]],
  ['bXYZ', [0.1431, 0.0606, 0.7141]],
];

/** What the tone curve at `at` turns a 50% input into, or null for a curve it does not read. */
const midTone = (view: DataView, type: string, at: number): number | null => {
  if (type === 'curv') {
    const count = view.getUint32(at + 8);
    if (count === 0) return 0.5;
    if (count === 1) return 0.5 ** (view.getUint16(at + 12) / 256);
    return view.getUint16(at + 12 + Math.floor((count - 1) / 2) * 2) / 65535;
  }
  if (type !== 'para') return null;
  const parameter = (index: number) => view.getInt32(at + 12 + index * 4) / 65536;
  const kind = view.getUint16(at + 8);
  if (kind === 0) return 0.5 ** parameter(0);
  if (kind !== 3) return null;
  return 0.5 >= parameter(4) ? (parameter(1) * 0.5 + parameter(2)) ** parameter(0) : parameter(3) * 0.5;
};

/**
 * True for an RGB profile with sRGB primaries and an sRGB-like tone curve: its pixels read the
 * same as DeviceRGB, so re-encoding them as DeviceRGB keeps their colours. Display P3, Adobe RGB,
 * linear and unreadable profiles are false.
 */
export const isSRGBProfile = (bytes: Uint8Array): boolean => {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (text(16) !== 'RGB ') return false;
    const tags = new Map<string, number>();
    const count = view.getUint32(128);
    for (let index = 0; index < count; index += 1) {
      tags.set(text(132 + index * 12), view.getUint32(136 + index * 12));
    }
    const primariesMatch = SRGB_PRIMARIES.every(([tag, expected]) => {
      const at = tags.get(tag);
      return at !== undefined && text(at) === 'XYZ ' && expected.every((value, index) =>
        Math.abs(view.getInt32(at + 8 + index * 4) / 65536 - value) < 0.01);
    });
    return primariesMatch && ['rTRC', 'gTRC', 'bTRC'].every((tag) => {
      const at = tags.get(tag);
      const tone = at === undefined ? null : midTone(view, text(at), at);
      // sRGB and gamma 2.2 put a 50% input near 21%; gamma 1.8, BT.709 and linear curves do not.
      return tone !== null && tone > 0.2 && tone < 0.235;
    });
  } catch {
    return false;
  }
};
