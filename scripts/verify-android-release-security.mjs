#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const paths = {
  rootBuild: 'android/build.gradle', appBuild: 'android/app/build.gradle',
  sourceManifest: 'android/app/src/main/AndroidManifest.xml',
  debugManifest: 'android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml',
  releaseManifest: 'android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
  debugApk: 'android/app/build/outputs/apk/debug/app-debug.apk',
  releaseApk: 'android/app/build/outputs/apk/release/app-release-unsigned.apk',
  testManifest: 'android/app/build/intermediates/packaged_manifests/debugAndroidTest/processDebugAndroidTestManifest/AndroidManifest.xml',
  testApk: 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
};
const telemetryNamespaces = [
  'com.google.firebase.analytics.', 'com.google.android.gms.measurement.', 'com.google.android.gms.ads.',
  'com.google.firebase.crashlytics.', 'io.sentry.', 'com.mixpanel.', 'com.amplitude.', 'io.appmetrica.', 'com.yandex.metrica.',
  'Lcom/google/firebase/analytics/', 'Lcom/google/android/gms/measurement/', 'Lcom/google/android/gms/ads/',
  'Lio/sentry/', 'Lcom/mixpanel/', 'Lcom/amplitude/', 'Lio/appmetrica/', 'Lcom/yandex/metrica/',
];
const ANY_RESOURCE = '__ANY_RESOURCE__';

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function text(path) { return readFileSync(resolve(root, path), 'utf8'); }
function lower(value) { return value.toLowerCase(); }
function same(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} drifted:\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
}
function requireArtifacts() {
  const missing = [paths.debugManifest, paths.releaseManifest, paths.debugApk, paths.releaseApk,
    paths.testManifest, paths.testApk]
    .filter(path => !existsSync(resolve(root, path)));
  assert(missing.length === 0,
    `Required generated security artifacts are missing:\n${missing.map(path => `- ${path}`).join('\n')}\n`
      + 'Run :app:assembleDebug :app:assembleRelease :app:assembleDebugAndroidTest, then rerun this verifier.');
}
function attributesFromTag(tag) {
  return Object.fromEntries([...tag.matchAll(/\bandroid:([\w-]+)\s*=\s*"([^"]*)"/g)]
    .map(match => [match[1], match[2]]).sort(([a], [b]) => a.localeCompare(b)));
}
function manifestNodes(manifest, types) {
  return [...manifest.matchAll(new RegExp(`<(${types.join('|')})\\b[^>]*>`, 'g'))].map(match => ({
    type: match[1], attrs: attributesFromTag(match[0]),
  }));
}
function xmltreeValue(line) {
  return line.match(/\(Raw: "([^"]*)"\)/)?.[1]
    ?? line.match(/="([^"]*)"/)?.[1]
    ?? line.match(/\)=(?:\(type 0x[0-9a-f]+\))?(0x[0-9a-f]+)/)?.[1]
    ?? line.match(/\)=(@0x[0-9a-f]+)/)?.[1]
    ?? fail(`Cannot parse aapt attribute: ${line}`);
}
function xmltreeNodes(xmltree, types) {
  const lines = xmltree.split('\n');
  const nodes = [];
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index].match(/^(\s*)E: ([\w-]+) \(line=/);
    if (!start || !types.includes(start[2])) continue;
    const indent = start[1].length;
    const attrs = {};
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const nextElement = lines[cursor].match(/^(\s*)E: /);
      if (nextElement && nextElement[1].length <= indent) break;
      const attribute = lines[cursor].match(new RegExp(`^\\s{${indent + 2}}A: android:([\\w-]+)`));
      if (attribute) attrs[attribute[1]] = xmltreeValue(lines[cursor]);
    }
    nodes.push({ type: start[2], attrs: Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) });
  }
  return nodes;
}
function expectedPermissions(packageName, binary) {
  const permission = `${packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;
  return [
    // Optional Google Play support (AndroidSupportPlugin) needs only the Play Billing permission.
    { type: 'uses-permission', attrs: { name: 'com.android.vending.BILLING' } },
    { type: 'permission', attrs: { name: permission, protectionLevel: binary ? '0x2' : 'signature' } },
    { type: 'uses-permission', attrs: { name: permission } },
    { type: 'uses-permission', attrs: { name: 'android.permission.ACCESS_NETWORK_STATE' } },
    { type: 'uses-permission', attrs: { name: 'android.permission.INTERNET' } },
  ];
}
function expectedComponents(packageName, debug, binary) {
  const bool = value => binary ? (value ? '0xffffffff' : '0x0') : String(value);
  const catalogue = [];
  if (debug) catalogue.push({ type: 'service', attrs: { exported: bool(false), name: 'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.LegacyThemeCrashService', process: ':legacyThemeCrash' } });
  catalogue.push(
    { type: 'activity', attrs: { configChanges: binary ? '0xdf0' : 'orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|screenLayout|navigation', exported: bool(false), name: 'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderActivity', theme: binary ? ANY_RESOURCE : '@style/PdfReaderTheme', windowSoftInputMode: binary ? '0x10' : 'adjustResize' } },
    { type: 'activity', attrs: { configChanges: binary ? '0x1ff4' : 'orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density', exported: bool(true), label: binary ? ANY_RESOURCE : '@string/title_activity_main', launchMode: binary ? '0x2' : 'singleTask', name: 'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.MainActivity', theme: binary ? ANY_RESOURCE : '@style/AppTheme.NoActionBarLaunch' } },
    { type: 'provider', attrs: { authorities: `${packageName}.fileprovider`, exported: bool(false), grantUriPermissions: bool(true), name: 'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.ReadOnlyDocumentFileProvider' } },
    { type: 'activity', attrs: { exported: bool(false), name: 'com.google.mlkit.vision.documentscanner.internal.GmsDocumentScanningDelegateActivity', screenOrientation: binary ? '0x1' : 'portrait', theme: binary ? ANY_RESOURCE : '@android:style/Theme.Black.NoTitleBar.Fullscreen' } },
    { type: 'provider', attrs: { authorities: `${packageName}.mlkitinitprovider`, exported: bool(false), initOrder: binary ? '0x63' : '99', name: 'com.google.mlkit.common.internal.MlKitInitProvider' } },
    { type: 'service', attrs: { directBootAware: bool(true), exported: bool(false), name: 'com.google.mlkit.common.internal.MlKitComponentDiscoveryService' } },
    { type: 'service', attrs: { exported: bool(false), isolatedProcess: bool(true), name: 'androidx.pdf.service.PdfDocumentServiceImpl' } },
    { type: 'activity', attrs: { configChanges: binary ? '0x5b0' : 'keyboard|keyboardHidden|screenLayout|screenSize|orientation', exported: bool(false), name: 'com.android.billingclient.api.ProxyBillingActivity', theme: binary ? ANY_RESOURCE : '@android:style/Theme.Translucent.NoTitleBar' } },
    { type: 'activity', attrs: { configChanges: binary ? '0x5b0' : 'keyboard|keyboardHidden|screenLayout|screenSize|orientation', exported: bool(false), name: 'com.android.billingclient.api.ProxyBillingActivityV2', theme: binary ? ANY_RESOURCE : '@android:style/Theme.Translucent.NoTitleBar' } },
    { type: 'activity', attrs: { exported: bool(false), name: 'com.google.android.gms.common.api.GoogleApiActivity', theme: binary ? ANY_RESOURCE : '@android:style/Theme.Translucent.NoTitleBar' } },
    { type: 'provider', attrs: { authorities: `${packageName}.androidx-startup`, exported: bool(false), name: 'androidx.startup.InitializationProvider' } },
    { type: 'service', attrs: { exported: bool(false), name: 'com.google.android.datatransport.runtime.backends.TransportBackendDiscovery' } },
    { type: 'service', attrs: { exported: bool(false), name: 'com.google.android.datatransport.runtime.scheduling.jobscheduling.JobInfoSchedulerService', permission: 'android.permission.BIND_JOB_SERVICE' } },
    { type: 'receiver', attrs: { exported: bool(false), name: 'com.google.android.datatransport.runtime.scheduling.jobscheduling.AlarmManagerSchedulerBroadcastReceiver' } },
    { type: 'receiver', attrs: { directBootAware: bool(false), enabled: bool(true), exported: bool(true), name: 'androidx.profileinstaller.ProfileInstallReceiver', permission: 'android.permission.DUMP' } },
    { type: 'activity', attrs: { exported: bool(false), name: 'com.google.android.play.core.common.PlayCoreDialogWrapperActivity', stateNotNeeded: bool(true), theme: binary ? ANY_RESOURCE : '@style/Theme.PlayCore.Transparent' } },
  );
  return catalogue.map(({ type, attrs }) => ({ type, attrs: Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) }));
}
function assertCatalogue(actual, expected, label) {
  assert(actual.length === expected.length, `${label} component count drifted`);
  for (let index = 0; index < expected.length; index++) {
    assert(actual[index].type === expected[index].type, `${label} component order/type drifted`);
    for (const [key, value] of Object.entries(expected[index].attrs)) {
      if (value === ANY_RESOURCE) {
        assert(/^@0x[0-9a-f]+$/.test(actual[index].attrs[key]), `${label} ${actual[index].type} ${key} must be a resource`);
      } else {
        assert(actual[index].attrs[key] === value, `${label} ${actual[index].type} ${key} drifted`);
      }
    }
    const allowed = new Set(Object.keys(expected[index].attrs));
    assert(Object.keys(actual[index].attrs).every(key => allowed.has(key)), `${label} ${actual[index].type} has an unapproved attribute`);
  }
}
function assertManifestCatalogue(manifest, variant) {
  const packageName = variant === 'debug' ? 'com.dhananjaytech.pdfchef.debug' : 'com.dhananjaytech.pdfchef';
  assert(new RegExp(`<manifest\\b[^>]*\\bpackage="${packageName}"`).test(manifest), `${variant} merged manifest identity drifted`);
  assert(manifest.includes('android:usesCleartextTraffic="false"'), `${variant} merged manifest must disable cleartext traffic`);
  same(manifestNodes(manifest, ['permission', 'uses-permission']), expectedPermissions(packageName, false), `${variant} merged permissions`);
  assertCatalogue(manifestNodes(manifest, ['activity', 'service', 'receiver', 'provider']), expectedComponents(packageName, variant === 'debug', false), `${variant} merged`);
}
function assertXmltreeCatalogue(xmltree, variant) {
  const packageName = variant === 'debug' ? 'com.dhananjaytech.pdfchef.debug' : 'com.dhananjaytech.pdfchef';
  assert(xmltree.includes(`A: package="${packageName}"`), `${variant} APK manifest identity drifted`);
  assert(xmltree.includes('A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0'), `${variant} APK cleartext flag drifted`);
  same(xmltreeNodes(xmltree, ['permission', 'uses-permission']), expectedPermissions(packageName, true), `${variant} APK permissions`);
  assertCatalogue(xmltreeNodes(xmltree, ['activity', 'service', 'receiver', 'provider']), expectedComponents(packageName, variant === 'debug', true), `${variant} APK`);
}
function findAapt() {
  const sdk = text('android/local.properties').match(/^sdk\.dir=(.+)$/m)?.[1]?.trim();
  assert(sdk, 'android/local.properties must declare sdk.dir so APK inspection is deterministic');
  const aapt = readdirSync(resolve(sdk, 'build-tools')).sort().reverse().map(version => resolve(sdk, 'build-tools', version, 'aapt')).find(existsSync);
  assert(aapt, `No aapt executable found under ${resolve(sdk, 'build-tools')}`);
  return aapt;
}
function command(name, args, encoding = 'utf8') {
  try { return execFileSync(name, args, { encoding, maxBuffer: 64 * 1024 * 1024 }); }
  catch (error) { fail(`${name} ${args.join(' ')} failed: ${error.stderr || error.message}`); }
}
function dexStrings(apk) {
  const entries = command('unzip', ['-Z1', apk]).split('\n').filter(entry => /^classes\d*\.dex$/.test(entry));
  assert(entries.length > 0, `APK has no classes*.dex entries: ${apk}`);
  return entries.flatMap(entry => {
    const dex = command('unzip', ['-p', apk, entry], null);
    assert(dex.subarray(0, 4).toString('ascii') === 'dex\n', `Invalid DEX header: ${entry}`);
    const size = dex.readUInt32LE(0x38), offset = dex.readUInt32LE(0x3c);
    assert(offset + size * 4 <= dex.length, `Invalid DEX string table: ${entry}`);
    return Array.from({ length: size }, (_, index) => {
      let at = dex.readUInt32LE(offset + index * 4);
      while (at < dex.length && (dex[at] & 0x80) !== 0) at++;
      at++;
      const end = dex.indexOf(0, at);
      assert(end >= 0, `Unterminated DEX string: ${entry}`);
      return dex.subarray(at, end).toString('utf8');
    });
  });
}
function assertNoSdkNamespaces(apk, variant) {
  const strings = dexStrings(apk);
  for (const namespace of telemetryNamespaces) assert(!strings.some(value => value.includes(namespace)), `${variant} APK DEX contains forbidden SDK namespace ${namespace}`);
}

const rootBuild = text(paths.rootBuild), appBuild = text(paths.appBuild), sourceManifest = text(paths.sourceManifest);
const releaseVersionCode = appBuild.match(/\bversionCode\s+(\d+)\b/)?.[1];
const releaseVersionName = appBuild.match(/\bversionName\s+"([^"]+)"/)?.[1];
assert(releaseVersionCode && releaseVersionName, 'Gradle release version identity is missing');
for (const forbidden of ['com.google.gms:google-services', 'com.google.gms.google-services', 'google-services.json', 'crashlytics', 'analytics', 'measurement', 'admob']) assert(!lower(rootBuild).includes(forbidden) && !lower(appBuild).includes(forbidden), `Gradle activates forbidden service: ${forbidden}`);
for (const required of ['namespace = "com.dhananjaytech.zenpdf_allpdftoolsinoneplace"', 'applicationId "com.dhananjaytech.pdfchef"', 'applicationIdSuffix ".debug"', 'minifyEnabled true', 'shrinkResources true', "getDefaultProguardFile('proguard-android-optimize.txt')", 'JavaVersion.VERSION_21', 'androidx.datastore:datastore-preferences-proto:1.2.1', 'com.google.code.gson:gson:2.13.2', "implementation 'com.google.android.gms:play-services-mlkit-document-scanner:16.0.0'", "implementation 'com.google.android.play:app-update:2.1.0'"]) assert(appBuild.includes(required), `Required Gradle invariant missing: ${required}`);
assert(/compileSdk\s*\{\s*version\s*=\s*release\(36\)\s*\{\s*minorApiLevel\s*=\s*1\s*\}\s*\}/s.test(appBuild),
  'App must compile against Android 36.1 (extension 20)');
assert((appBuild.match(/androidx\.pdf:pdf-viewer-fragment:1\.0\.0-beta01/g) ?? []).length === 1,
  'AndroidX PDF viewer dependency must be the one accepted beta01 coordinate');
assert((appBuild.match(/androidx\.pdf:pdf-viewer-fragment:/g) ?? []).length === 1,
  'AndroidX PDF viewer dependency must remain singular');
assert((appBuild.match(/play-services-mlkit-document-scanner:16\.0\.0/g) ?? []).length === 1,
  'scanner dependency must remain singular');
assert(!appBuild.includes('exclude group:'), 'scanner dependency must remain the official plain graph');
assert(sourceManifest.includes('android:usesCleartextTraffic="false"'), 'Source manifest must disable cleartext traffic');
assert(!sourceManifest.includes('<uses-permission'), 'Source manifest must declare no permissions');
const sourceReaderTags = [...sourceManifest.matchAll(
  /<activity\b[^>]*android:name="\.reader\.PdfReaderActivity"[^>]*>/g,
)];
assert(sourceReaderTags.length === 1, 'Source manifest must declare one PdfReaderActivity');
const sourceReader = sourceReaderTags[0][0];
for (const required of [
  'android:exported="false"',
  'android:theme="@style/PdfReaderTheme"',
  'android:windowSoftInputMode="adjustResize"',
]) assert(sourceReader.includes(required), `Reader Activity invariant missing: ${required}`);
assert(/\/>\s*$/.test(sourceReader)
  && !/android:(?:process|permission|taskAffinity|launchMode|screenOrientation)=/.test(sourceReader),
  'Reader Activity must be sealed, filter-free, and free of process/task/orientation broadening');
requireArtifacts();
assertManifestCatalogue(text(paths.debugManifest), 'debug');
assertManifestCatalogue(text(paths.releaseManifest), 'release');
const aapt = findAapt();
for (const [variant, apk] of [['debug', paths.debugApk], ['release', paths.releaseApk]]) {
  const absolute = resolve(root, apk);
  const badging = command(aapt, ['dump', 'badging', absolute]);
  const packageName = variant === 'debug' ? 'com.dhananjaytech.pdfchef.debug' : 'com.dhananjaytech.pdfchef';
  assert(badging.includes(`package: name='${packageName}'`)
    && badging.includes(`versionCode='${releaseVersionCode}'`)
    && badging.includes(`versionName='${releaseVersionName}'`), `${variant} APK identity/version drifted`);
  assertXmltreeCatalogue(command(aapt, ['dump', 'xmltree', absolute, 'AndroidManifest.xml']), variant);
  assertNoSdkNamespaces(absolute, variant);
  assert(!dexStrings(absolute).some(value => value.includes('DocumentRecipientProbeService')),
    `${variant} APK must exclude the test recipient probe`);
}
const testManifest = text(paths.testManifest);
assert(testManifest.includes('package="com.dhananjaytech.pdfchef.debug.test"'),
  'androidTest package identity drifted');
assert(testManifest.includes('android:name="com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentRecipientProbeService"')
  && testManifest.includes('android:exported="true"')
  && testManifest.includes('android:process=":recipient"'),
  'androidTest recipient component drifted');
const testAbsolute = resolve(root, paths.testApk);
const testXmltree = command(aapt, ['dump', 'xmltree', testAbsolute, 'AndroidManifest.xml']);
const recipient = xmltreeNodes(testXmltree, ['service']).find(node =>
  node.attrs.name === 'com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentRecipientProbeService');
assert(recipient && recipient.attrs.exported === '0xffffffff' && recipient.attrs.process === ':recipient',
  'androidTest APK recipient component drifted');
assert(dexStrings(testAbsolute).some(value => value.includes('DocumentRecipientProbeService')),
  'androidTest APK must contain the recipient probe');
console.log('ANDROID_RELEASE_SECURITY_VERIFIER: PASS');
console.log('SECURITY_CONTRACT: exact source, merged-manifest, APK-manifest, and DEX SDK catalogues verified');
