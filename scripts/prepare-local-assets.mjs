import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'core/tesseract-core-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'core/tesseract-core-simd-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', 'core/tesseract-core-relaxedsimd-lstm.wasm'],
];

/**
 * PDF.js loads these from a URL, never from the bundle, and refuses outright when the URL is not
 * configured — there is no fallback in this build. Without them a JPEG 2000 page renders with no
 * images at all, a CJK document with a non-Identity encoding extracts nothing usable, and the
 * standard fourteen fonts get measured from guesses. They are vendored for the same reason the OCR
 * assets are: this app has to work with no network.
 */
const pdfjsAssetDirectories = ['wasm', 'cmaps', 'standard_fonts'];

export const preparePdfjsAssets = async (targetRoot = resolve(root, 'public/vendor/pdfjs')) => {
  let copied = 0;
  for (const directory of pdfjsAssetDirectories) {
    const source = resolve(root, 'node_modules/pdfjs-dist', directory);
    const target = resolve(targetRoot, directory);
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyFile(resolve(source, entry), resolve(target, entry));
      copied += 1;
    }
  }
  return copied;
};

export const prepareLocalAssets = async (targetRoot = resolve(root, 'public/vendor/tesseract')) => {
  for (const [source, destination] of assets) {
    const target = resolve(targetRoot, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(root, source), target);
  }

  // AAPT decompresses .gz assets and removes their suffix. Prepare that format
  // before Vite/native copying so every platform serves the URL OCR requests.
  const model = gunzipSync(await readFile(resolve(root, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')));
  await mkdir(resolve(targetRoot, 'lang'), { recursive: true });
  await writeFile(resolve(targetRoot, 'lang/eng.traineddata'), model);
  await rm(resolve(targetRoot, 'lang/eng.traineddata.gz'), { force: true });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareLocalAssets();
  const pdfjsFiles = await preparePdfjsAssets();
  console.log(`Prepared ${assets.length + 1} local OCR assets and ${pdfjsFiles} local PDF.js assets.`);
}
