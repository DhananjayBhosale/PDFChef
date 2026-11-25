#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const assert = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_APP_METADATA: ${message}`);
};
const count = (source, pattern) => [...source.matchAll(pattern)].length;

const pluginPath = 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidAppMetadataPlugin.java';
const pluginTestPath = 'android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidAppMetadataPluginContractTest.java';
const clientPath = 'services/platform/android/androidAppMetadata.ts';
const clientTestPath = 'tests/platform/androidAppMetadata.test.ts';
const plugin = read(pluginPath);
const client = read(clientPath);
const mainActivity = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java');

assert(/@CapacitorPlugin\s*\(\s*name\s*=\s*"AndroidAppMetadata"\s*\)/.test(plugin), 'plugin name drift');
assert(count(plugin, /@PluginMethod\b/g) === 1, 'plugin must expose exactly one method');
assert(/@PluginMethod\s+public\s+void\s+getMetadata\s*\(\s*PluginCall\s+call\s*\)/.test(plugin), 'getMetadata method missing');
assert(plugin.includes('request.length() != 0'), 'request must be exactly empty');
assert(count(plugin, /output\.put\("(?:name|version|build)"/g) === 3, 'exact three-field DTO missing');
assert(plugin.includes('loadLabel(packageManager)') && plugin.includes('packageInfo.versionName'), 'public label/version lookup missing');
assert(plugin.includes('getLongVersionCode()') && plugin.includes('Long.toString(versionCode)'), 'build must be a string');
assert(plugin.includes('build == null ? JSONObject.NULL : build'), 'unavailable build must remain an explicit null field');
assert(plugin.includes('text.isBlank()') && plugin.includes("text.indexOf('\\0')"), 'public text validation missing');
assert(plugin.includes('APP_METADATA_INVALID_ARGUMENT') && plugin.includes('APP_METADATA_UNAVAILABLE'), 'fixed errors missing');
assert(!/getMessage\s*\(|printStackTrace\s*\(|\bLog\.|System\.out/.test(plugin), 'plugin detail leak');
assert(!/output\.put\("(?:package|installer|signer|certificate|path|device|channel|telemetry|permission)/.test(plugin), 'private metadata output forbidden');
assert(!/addListener|set[A-Z]|getPackageId|getInstaller|signer|certificate/.test(plugin), 'unaccepted method or private surface exposed');
assert(count(mainActivity, /registerPlugin\(AndroidAppMetadataPlugin\.class\)/g) === 1, 'MainActivity must register the plugin exactly once');

assert(/getMetadata\(\):\s*Promise<unknown>/.test(client), 'strict no-argument native shape missing');
assert(client.includes("registerPlugin<AndroidAppMetadataNativePlugin>('AndroidAppMetadata')"), 'native proxy drift');
assert(!/export\s+const\s+AndroidAppMetadataNative\b/.test(client), 'raw native proxy must remain private');
assert(client.includes("OUTPUT_KEYS = ['build', 'name', 'version']"), 'exact response keys missing');
assert(client.includes('Reflect.ownKeys') && client.includes('Object.getPrototypeOf(value) !== Object.prototype'), 'strict plain DTO validation missing');
assert(client.includes("!value.includes('\\0')") && client.includes('/^\\s*$/u.test(value)'), 'nonblank NUL-free validation missing');
assert(!/package|installer|signer|certificate|path|device|channel|telemetry|permission/i.test(client), 'private or unauthorized client surface');

for (const path of [pluginPath, pluginTestPath, clientPath, clientTestPath, 'scripts/verify-android-app-metadata.mjs']) {
  console.log(`OWNED ${hash(path)}  ${path}`);
}
console.log('ANDROID_APP_METADATA_VERIFIER: PASS');
console.log('ANDROID_APP_METADATA_SURFACE: getMetadata only; name/version/build');
console.log('RUNTIME_DISCOVERY: NOT_CHECKED');
console.log('PRODUCTION_RELEASE_READY: NO');
