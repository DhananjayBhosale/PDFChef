#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const fail = message => { throw new Error(`Android release-minification verification failed: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };

const appBuild = read('android/app/build.gradle');
const properties = read('android/gradle.properties');
const rules = read('android/app/proguard-rules.pro');

for (const required of [
  'minifyEnabled true',
  'shrinkResources true',
  "getDefaultProguardFile('proguard-android-optimize.txt')",
]) assert(appBuild.includes(required), `missing release setting: ${required}`);
assert(!appBuild.includes('minifyEnabled false'), 'release minification must not be disabled');
assert(!appBuild.includes("getDefaultProguardFile('proguard-android.txt')"), 'legacy non-optimizing default rules must not be used');
assert(properties.includes('android.r8.optimizedResourceShrinking=true'), 'AGP 8.13 optimized resource shrinking must be enabled');
assert(!properties.includes('android.enableR8.fullMode=false'), 'R8 full mode must not be disabled');

for (const forbidden of [
  /-dontshrink\b/,
  /-dontoptimize\b/,
  /-dontobfuscate\b/,
  /-ignorewarnings\b/,
  /-keep\s+class\s+\*\s*\{\s*\*;\s*\}/s,
  /-keep\s+class\s+com\.google\.\*\*/,
  /-keep\s+class\s+androidx\.\*\*/,
  /-keep\s+class\s+com\.getcapacitor\.\*\*/,
]) assert(!forbidden.test(rules), `broad or suppressive rule is forbidden: ${forbidden}`);

assert(rules.includes('com.google.mlkit.common.internal.CommonComponentRegistrar'),
  'the accepted narrow ML Kit registrar rule is missing');

const generated = [
  'android/app/build/outputs/apk/release/app-release-unsigned.apk',
  'android/app/build/outputs/bundle/release/app-release.aab',
  'android/app/build/outputs/mapping/release/configuration.txt',
  'android/app/build/outputs/mapping/release/mapping.txt',
  'android/app/build/outputs/mapping/release/seeds.txt',
  'android/app/build/outputs/mapping/release/usage.txt',
];
for (const path of generated) {
  const absolute = resolve(root, path);
  assert(existsSync(absolute), `missing generated R8 evidence: ${path}`);
  assert(statSync(absolute).size > 0, `generated R8 evidence is empty: ${path}`);
}

const configuration = read('android/app/build/outputs/mapping/release/configuration.txt');
for (const forbidden of ['-dontshrink', '-dontoptimize', '-dontobfuscate', '-ignorewarnings']) {
  assert(!configuration.split('\n').some(line => line.trim() === forbidden),
    `merged R8 configuration disables a required optimization: ${forbidden}`);
}

const mapping = read('android/app/build/outputs/mapping/release/mapping.txt');
for (const entryPoint of [
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.MainActivity',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderActivity',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.scanner.AndroidDocumentScannerPlugin',
  'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.AndroidDocumentsPlugin',
  'com.google.mlkit.common.internal.CommonComponentRegistrar',
]) assert(mapping.includes(`${entryPoint} -> ${entryPoint}:`),
  `required reflected/manifest entry point was removed or renamed: ${entryPoint}`);

for (const providerClass of [
  'org.bouncycastle.jcajce.provider.digest.SHA256$Digest',
  'org.bouncycastle.jcajce.provider.digest.SHA256$Mappings',
  'org.bouncycastle.jcajce.provider.asymmetric.rsa.DigestSignatureSpi$SHA256',
  'org.bouncycastle.jcajce.provider.asymmetric.RSA$Mappings',
  'org.bouncycastle.jcajce.provider.asymmetric.x509.CertificateFactory',
]) assert(mapping.includes(`${providerClass} -> ${providerClass}:`),
  `required signature provider class was removed or renamed: ${providerClass}`);

const resources = read('android/app/build/outputs/mapping/release/resources.txt');
for (const resource of [
  'style:PdfReaderTheme:',
  'layout:pdf_reader_activity:',
  'layout:pdf_reader_tools_sheet:',
  'drawable:pdf_reader_ic_search:',
  'drawable:pdf_reader_ic_share:',
  'raw:cca_india_2022:',
]) assert(resources.includes(resource), `required native-reader resource was removed: ${resource}`);

const releaseApk = resolve(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
const apkEntries = execFileSync('unzip', ['-Z1', releaseApk], { encoding: 'utf8' }).split('\n');
for (const asset of ['assets/public/index.html', 'assets/public/sw.js']) {
  assert(apkEntries.includes(asset), `release APK lost required offline web asset: ${asset}`);
}
const releaseBundle = resolve(root, 'android/app/build/outputs/bundle/release/app-release.aab');
const bundleEntries = execFileSync('unzip', ['-Z1', releaseBundle], { encoding: 'utf8' }).split('\n');
for (const entry of [
  'base/manifest/AndroidManifest.xml',
  'base/dex/classes.dex',
  'base/assets/public/index.html',
  'base/assets/public/sw.js',
]) assert(bundleEntries.includes(entry), `release AAB lost required base entry: ${entry}`);

console.log('Android release-minification verification passed: R8 code/resource optimization enabled with non-empty mapping, seeds, usage, and merged configuration evidence.');
