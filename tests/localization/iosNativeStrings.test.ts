import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../../ios/App/App');
const read = (name: string) => readFileSync(resolve(app, name), 'utf8');

/** The app's languages besides English, as the native `.lproj` folders name them. */
const languages = ['ar', 'da', 'de', 'es-419', 'es', 'fr-CA', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'pt-PT', 'sv', 'tr', 'zh-Hans', 'zh-Hant'];

type Unit = { stringUnit: { state: string; value: string } };
type Localization = Unit | { variations: { plural: Record<string, Unit> } };
const catalog: { sourceLanguage: string; strings: Record<string, { localizations: Record<string, Localization> }> } =
  JSON.parse(read('Localizable.xcstrings'));

const literals = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((match) => JSON.parse(`"${match[1]}"`) as string);
const literal = '"((?:[^"\\\\]|\\\\.)*)"';

/** Every English text a native screen shows, found the way the Swift code passes it to `localized`. */
const nativeTexts = () => {
  const texts = new Set<string>();
  for (const name of readdirSync(app).filter((file) => file.endsWith('.swift'))) {
    for (const text of literals(read(name), new RegExp(`\\blocalized\\(\\s*${literal}`, 'g'))) texts.add(text);
  }
  // Reader tool titles and signature check details are shown through localized(tool.title) and localized(check.detail).
  for (const text of literals(read('PdfChefReaderViewController.swift'), new RegExp(`\\(${literal}, "/`, 'g'))) texts.add(text);
  const verifier = read('PdfChefSignatureVerifier.swift');
  for (const pattern of [`detail: ${literal}`, `warnings\\.append\\(${literal}`, `failedReport\\(\\.\\w+, ${literal}`, `VerificationFailure\\(\\.\\w+, ${literal}`, `^\\s*[?:] ${literal}`]) {
    for (const text of literals(verifier, new RegExp(pattern, 'gm'))) texts.add(text);
  }
  return texts;
};

const value = (localization: Localization) => 'stringUnit' in localization ? localization.stringUnit.value : localization.variations.plural.other.stringUnit.value;
const placeholders = (text: string) => (text.match(/%(\d+\$)?(lld|@)/g) ?? []).map((spec) => spec.replace(/\d+\$/, '')).sort();

test('every native iOS text is in the string catalog in English and all 20 app languages', () => {
  const texts = nativeTexts();
  assert.ok(texts.size > 150, `only ${texts.size} native texts were found`);
  assert.equal(catalog.sourceLanguage, 'en');
  for (const text of texts) {
    const entry = catalog.strings[text];
    assert.ok(entry, `missing from Localizable.xcstrings: ${text}`);
    for (const language of ['en', ...languages]) {
      const localization = entry.localizations[language];
      assert.ok(localization && value(localization).trim(), `${language} is missing for: ${text}`);
      assert.deepEqual(placeholders(value(localization)), placeholders(text), `${language} placeholders differ for: ${text}`);
    }
  }
  assert.deepEqual(Object.keys(catalog.strings).filter((text) => !texts.has(text)), [], 'the catalog has texts no screen shows');
});

test('the camera permission text is translated for every app language', () => {
  const infoPlist: typeof catalog = JSON.parse(read('InfoPlist.xcstrings'));
  const camera = infoPlist.strings.NSCameraUsageDescription;
  assert.ok(read('Info.plist').includes(value(camera.localizations.en)));
  for (const language of languages) assert.ok(value(camera.localizations[language]).includes('PDF Chef'), language);
});

// Without a Photos permission text, choosing Save Image for a shared picture would end the app on
// the iOS versions that still offer it.
test('sharing a picture never offers Save Image while the app has no Photos permission text', () => {
  if (read('Info.plist').includes('NSPhotoLibraryAddUsageDescription')) return;
  assert.match(read('PdfChefDocumentPresentation.swift'), /excludedActivityTypes = \[\.saveToCameraRoll\]/);
});
