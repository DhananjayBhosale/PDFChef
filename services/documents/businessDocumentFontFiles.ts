/**
 * Where the invoice's fallback fonts live in the app.
 *
 * Kept apart from the renderer, which Node tests run with the same files read from disk. Liberation
 * Sans already ships for PDF.js's standard fonts, so only the small Noto subsets are added.
 */
import notoLatinExtRegular from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?url';
import notoLatinExtBold from '@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff?url';
import notoVietnameseRegular from '@fontsource/noto-sans/files/noto-sans-vietnamese-400-normal.woff?url';
import notoVietnameseBold from '@fontsource/noto-sans/files/noto-sans-vietnamese-700-normal.woff?url';
import type { BusinessFontName } from './businessDocument.ts';

const STANDARD_FONTS = '/vendor/pdfjs/standard_fonts';

const fontUrls: Record<BusinessFontName, string> = {
  'LiberationSans-Regular': `${STANDARD_FONTS}/LiberationSans-Regular.ttf`,
  'LiberationSans-Bold': `${STANDARD_FONTS}/LiberationSans-Bold.ttf`,
  'NotoSans-LatinExt-Regular': notoLatinExtRegular,
  'NotoSans-LatinExt-Bold': notoLatinExtBold,
  'NotoSans-Vietnamese-Regular': notoVietnameseRegular,
  'NotoSans-Vietnamese-Bold': notoVietnameseBold,
};

export const readBundledBusinessFont = async (name: BusinessFontName): Promise<Uint8Array> => {
  const response = await fetch(fontUrls[name]);
  if (!response.ok) throw new Error(`The ${name} font could not be loaded (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
};
