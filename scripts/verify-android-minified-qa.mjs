#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const fail = message => { throw new Error(`Android minified-QA verification failed: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };

const appBuild = read('android/app/build.gradle');
const rules = read('android/app/proguard-rules.pro');
const minifiedBlock = appBuild.match(/minifiedQa\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
for (const required of [
  'initWith release',
  'applicationIdSuffix ".minifiedqa"',
  'versionNameSuffix "-minified-qa"',
  'signingConfig signingConfigs.debug',
  'debuggable false',
  "matchingFallbacks = ['release']",
]) assert(minifiedBlock.includes(required), `missing isolated QA invariant: ${required}`);
assert(/sourceSets\s*\{[\s\S]*?minifiedQa\s*\{[\s\S]*?java\.srcDir 'src\/release\/java'/m.test(appBuild),
  'minified QA must compile the accepted release-only Application source set');
assert(!appBuild.includes('testBuildType'),
  'QA runtime proof must not replace or complicate the ordinary debug instrumentation target');
// Release is signed only when all four ZENPDF_RELEASE_* values are supplied; otherwise unsigned.
assert(/if \(hasReleaseSigningConfig\) \{\s*signingConfig signingConfigs\.release\s*\}/.test(appBuild)
  && (appBuild.match(/signingConfig signingConfigs\.release/g) ?? []).length === 1,
  'production release may be signed only from the complete ZENPDF_RELEASE_* configuration');
assert(!rules.includes('minifiedQa'), 'QA-only keep rules are forbidden');

const outputs = {
  apk: 'android/app/build/outputs/apk/minifiedQa/app-minifiedQa.apk',
  mapping: 'android/app/build/outputs/mapping/minifiedQa/mapping.txt',
  configuration: 'android/app/build/outputs/mapping/minifiedQa/configuration.txt',
  seeds: 'android/app/build/outputs/mapping/minifiedQa/seeds.txt',
  usage: 'android/app/build/outputs/mapping/minifiedQa/usage.txt',
  resources: 'android/app/build/outputs/mapping/minifiedQa/resources.txt',
  manifest: 'android/app/build/intermediates/merged_manifests/minifiedQa/processMinifiedQaManifest/AndroidManifest.xml',
};
for (const [label, path] of Object.entries(outputs)) {
  const absolute = resolve(root, path);
  assert(existsSync(absolute), `missing ${label}: ${path}`);
  assert(statSync(absolute).size > 0, `empty ${label}: ${path}`);
}

const manifest = read(outputs.manifest);
assert(manifest.includes('package="com.dhananjaytech.pdfchef.minifiedqa"'),
  'merged manifest package must be the isolated QA identity');
assert(!manifest.includes('android:debuggable="true"'), 'QA manifest must be non-debuggable');
assert(manifest.includes('android:name="com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication"'),
  'QA manifest must use the accepted release Application');
assert(!manifest.includes('LegacyThemeCrashService'), 'QA manifest must exclude debug-only crash service');

const mapping = read(outputs.mapping);
for (const entryPoint of [
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.MainActivity',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderActivity',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.scanner.AndroidDocumentScannerPlugin',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.AndroidDocumentsPlugin',
]) assert(mapping.includes(`${entryPoint} -> ${entryPoint}:`),
  `required QA entry point was removed or renamed: ${entryPoint}`);

for (const providerClass of [
  'org.bouncycastle.jcajce.provider.digest.SHA256$Digest',
  'org.bouncycastle.jcajce.provider.digest.SHA256$Mappings',
  'org.bouncycastle.jcajce.provider.asymmetric.rsa.DigestSignatureSpi$SHA256',
  'org.bouncycastle.jcajce.provider.asymmetric.RSA$Mappings',
  'org.bouncycastle.jcajce.provider.asymmetric.x509.CertificateFactory',
]) assert(mapping.includes(`${providerClass} -> ${providerClass}:`),
  `required QA signature provider class was removed or renamed: ${providerClass}`);

const resources = read(outputs.resources);
for (const resource of [
  'style:PdfReaderTheme:',
  'layout:pdf_reader_activity:',
  'layout:pdf_reader_tools_sheet:',
  'raw:cca_india_2022:',
]) assert(resources.includes(resource), `reader resource removed from QA: ${resource}`);

const entries = execFileSync('unzip', ['-Z1', resolve(root, outputs.apk)],
  { encoding: 'utf8' }).split('\n');
for (const asset of ['assets/public/index.html', 'assets/public/sw.js']) {
  assert(entries.includes(asset), `QA APK lost offline asset: ${asset}`);
}

console.log('Android minified-QA verification passed: isolated release-inherited, debug-signed configuration has non-empty R8 artifacts and preserved runtime entry points.');
