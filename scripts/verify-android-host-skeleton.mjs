import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const bytes = (path) => readFileSync(resolve(root, path));
const sha256 = (path) => createHash('sha256').update(bytes(path)).digest('hex');
const checks = [];
const check = (description, passed) => checks.push([description, Boolean(passed)]);
const match = (path, pattern, description) => check(description, pattern.test(read(path)));
const absent = (path, pattern, description) => check(description, !pattern.test(read(path)));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namedTag = (path, element, androidName) => [...read(path).matchAll(
  new RegExp(`<${element}\\b[^>]*\\bandroid:name="${escapeRegExp(androidName)}"[^>]*>`, 'g'),
)];
const xml = (path) => {
  try {
    execFileSync('xmllint', ['--noout', resolve(root, path)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const xpath = (path, expression) => {
  try {
    return execFileSync('xmllint', ['--xpath', expression, resolve(root, path)], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const treeContains = (path, pattern) => {
  const visit = (absolute) => readdirSync(absolute, { withFileTypes: true }).some((entry) => {
    const target = resolve(absolute, entry.name);
    return entry.isDirectory() ? visit(target) : pattern.test(readFileSync(target, 'utf8'));
  });
  return visit(resolve(root, path));
};

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
for (const name of ['@capacitor/core', '@capacitor/ios', '@capacitor/android']) {
  check(`${name} is exactly 8.5.3 in package.json`, packageJson.dependencies?.[name] === '8.5.3');
  check(`${name} is exactly 8.5.3 in package-lock root`, packageLock.packages?.['']?.dependencies?.[name] === '8.5.3');
  check(`${name} is exactly 8.5.3 in package-lock package`, packageLock.packages?.[`node_modules/${name}`]?.version === '8.5.3');
}
check('installed @capacitor/android is exactly 8.5.3', JSON.parse(read('node_modules/@capacitor/android/package.json')).version === '8.5.3');

match('capacitor.config.ts', /appId:\s*'com\.dhananjaytech\.pdfchef'/, 'base Capacitor application ID');
match('capacitor.config.ts', /webDir:\s*'dist'/, 'bundled dist web directory');
match('capacitor.config.ts', /cordova:\s*\{\s*accessOrigins:\s*\[\s*\]/s, 'Cordova accessOrigins is empty');
absent('capacitor.config.ts', /\bserver\s*:/, 'no Capacitor remote server configuration');

match('android/variables.gradle', /minSdkVersion\s*=\s*29/, 'minSdk 29');
match('android/variables.gradle', /compileSdkVersion\s*=\s*36/, 'compileSdk 36');
match('android/variables.gradle', /targetSdkVersion\s*=\s*36/, 'targetSdk 36');
match('android/app/build.gradle', /namespace\s*=\s*"com\.dhananjaytech\.zenpdf_allpdftoolsinoneplace"/, 'legacy namespace');
match('android/app/build.gradle', /applicationId\s+"com\.dhananjaytech\.pdfchef"/, 'base Android application ID');
match('android/app/build.gradle', /debug\s*\{\s*applicationIdSuffix\s+"\.debug"/s, 'debug application ID suffix');
match('android/app/build.gradle', /compileSdk\s*\{\s*version\s*=\s*release\(36\)\s*\{\s*minorApiLevel\s*=\s*1\s*\}\s*\}/s,
  'app compiles against Android 36.1 (extension 20)');
match('android/app/build.gradle', /implementation\s+'androidx\.pdf:pdf-viewer-fragment:1\.0\.0-beta01'/,
  'final AndroidX PDF viewer dependency');
for (const path of ['android/app/build.gradle', 'android/app/capacitor.build.gradle', 'node_modules/@capacitor/android/capacitor/build.gradle']) {
  match(path, /sourceCompatibility\s+JavaVersion\.VERSION_21/, `${path} uses Java 21 source compatibility`);
  match(path, /targetCompatibility\s+JavaVersion\.VERSION_21/, `${path} uses Java 21 target compatibility`);
  absent(path, /VERSION_17/, `${path} rejects Java 17`);
}

const manifest = 'android/app/src/main/AndroidManifest.xml';
for (const path of [manifest, 'android/app/src/main/res/xml/backup_rules.xml', 'android/app/src/main/res/xml/data_extraction_rules.xml', 'android/app/src/main/res/xml/config.xml', 'android/app/src/main/res/values/styles.xml', 'android/app/src/main/res/values/pdf_reader_styles.xml', 'android/app/src/main/res/values-night/pdf_reader_styles.xml', 'android/app/src/main/res/layout/pdf_reader_activity.xml', 'android/app/src/main/res/layout/pdf_reader_tools_sheet.xml']) check(`${path} is well-formed XML`, xml(path));
match(manifest, /android:allowBackup="false"/, 'backup disabled');
match(manifest, /android:usesCleartextTraffic="false"/, 'cleartext traffic disabled');
match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/, 'data extraction rules registered');
match(manifest, /android:fullBackupContent="@xml\/backup_rules"/, 'backup rules registered');
absent(manifest, /android\.permission\.INTERNET|android:scheme="file"/, 'no INTERNET permission or file VIEW scheme');
const providerTags = namedTag(manifest, 'provider', '.documents.ReadOnlyDocumentFileProvider');
check('exact read-only FileProvider registration', providerTags.length === 1
  && /android:authorities="\$\{applicationId\}\.fileprovider"/.test(providerTags[0][0])
  && /android:exported="false"/.test(providerTags[0][0])
  && /android:grantUriPermissions="true"/.test(providerTags[0][0]));
const readerTags = namedTag(manifest, 'activity', '.reader.PdfReaderActivity');
check('private PdfReaderActivity uses the frozen theme and adjustResize', readerTags.length === 1
  && /android:exported="false"/.test(readerTags[0][0])
  && /android:theme="@style\/PdfReaderTheme"/.test(readerTags[0][0])
  && /android:windowSoftInputMode="adjustResize"/.test(readerTags[0][0])
  && /\/>\s*$/.test(readerTags[0][0])
  && !/android:(?:process|permission|taskAffinity|screenOrientation|launchMode)=/.test(readerTags[0][0]));
check('Cordova config has zero access elements', xpath('android/app/src/main/res/xml/config.xml', 'count(/*[local-name()="widget"]/*[local-name()="access"])') === '0');

for (const path of ['android/app/src/main/res/xml/backup_rules.xml', 'android/app/src/main/res/xml/data_extraction_rules.xml']) {
  match(path, /domain="file" path="processed\/"/, `${path} excludes processed directory`);
  match(path, /domain="file" path="processed_index\.json"/, `${path} excludes processed index`);
  match(path, /domain="file" path="datastore\/app_settings\.preferences_pb"/, `${path} excludes DataStore settings`);
  match(path, /domain="sharedpref" path="app_settings\.preferences_pb"/, `${path} retains legacy shared-preference exclusion`);
}

const mainActivity = 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java';
match(mainActivity, /package com\.dhananjaytech\.zenpdf_allpdftoolsinoneplace;/, 'legacy MainActivity package');
match(mainActivity, /extends BridgeActivity/, 'MainActivity extends BridgeActivity');
const activity = read(mainActivity);
const registrationEntries = [
  'registerPlugin(AndroidLegacyInspectorPlugin.class)',
  'registerPlugin(AndroidLegacySettingsWriterPlugin.class)',
  'registerPlugin(AndroidAppMetadataPlugin.class)',
  'registerPlugin(AndroidStorageStatsPlugin.class)',
  'registerPlugin(AndroidDocumentsPlugin.class)',
  'registerPlugin(AndroidDocumentScannerPlugin.class)',
  'super.onCreate(savedInstanceState)',
];
const registrationPositions = registrationEntries.map(entry => activity.indexOf(entry));
check('six native plugins register once in accepted order before bridge creation',
  (activity.match(/registerPlugin\(/g) ?? []).length === 6
  && registrationEntries.slice(0, 6).every(entry => activity.split(entry).length === 2)
  && registrationPositions.every((position, index) => position >= 0
    && (index === 0 || position > registrationPositions[index - 1])));
check('no old scaffold package remains', !treeContains('android/app/src', /com\.getcapacitor\.myapp/));
absent('android/app/src/main/res/values/styles.xml', /@color\//, 'no unresolved scaffold style colors');
check('shared dist remains at the final frozen iOS/shared handback',
  sha256('dist/index.html') === 'd64e2b3c571b49eb935651349859c2c97c1cc240c232952f7d9ba67a0c0a8328'
  && sha256('dist/sw.js') === '8945563dfe6dc9a562ed4c0d5291d7ef885dd5f4966a4afc31e1504ebade440b');
const packagedIndex = read('android/app/src/main/assets/public/index.html');
const packagedMain = packagedIndex.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/);
const androidOnlyDispatch = packagedMain !== null
  && read(`android/app/src/main/assets/public/assets/${packagedMain[1]}`).includes('exportItem')
  && read(`android/app/src/main/assets/public/assets/${packagedMain[1]}`).includes('shareItem');
check('packaged index is either shared-dist-identical or a verified Android-only native-dispatch bundle',
  bytes('android/app/src/main/assets/public/index.html').equals(bytes('dist/index.html'))
  || androidOnlyDispatch);

for (const [description, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${description}`);
if (checks.some(([, passed]) => !passed)) process.exitCode = 1;
console.log('HOST_ACTIVATION_CONTRACT');
console.log('PRODUCTION_RELEASE_READY:NO');
