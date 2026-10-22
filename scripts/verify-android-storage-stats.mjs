#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const assert = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_STORAGE_STATS: ${message}`);
};
const count = (source, pattern) => [...source.matchAll(pattern)].length;

const calculatorPath = 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidStorageStatsCalculator.java';
const pluginPath = 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidStorageStatsPlugin.java';
const calculatorTestPath = 'android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidStorageStatsCalculatorTest.java';
const pluginTestPath = 'android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/AndroidStorageStatsPluginContractTest.java';
const clientPath = 'services/platform/android/androidStorageStats.ts';
const clientTestPath = 'tests/platform/androidStorageStats.test.ts';
const calculator = read(calculatorPath);
const plugin = read(pluginPath);
const client = read(clientPath);
const mainActivity = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java');

assert(/MAXIMUM_SAFE_INTEGER\s*=\s*9_007_199_254_740_991L/.test(calculator), 'safe integer bound missing');
assert(calculator.includes('pdfchef_documents') && calculator.includes('owned'), 'approved owned root missing');
assert(/Files\.newDirectoryStream\(ownedDirectory\)/.test(calculator), 'immediate directory enumeration missing');
assert(!/Files\.walk\s*\(|walkFileTree\s*\(|list\s*\(/.test(calculator), 'recursive or broad traversal forbidden');
assert(calculator.includes('LinkOption.NOFOLLOW_LINKS') && calculator.includes('Files.isSymbolicLink'), 'no-follow checks missing');
assert(calculator.includes('Math.addExact') && calculator.includes('retainedBytes > MAXIMUM_SAFE_INTEGER'), 'checked retained-byte bound missing');
assert(/result\(filesDirectory,\s*expectedFilesDirectory,\s*0\)/.test(calculator)
  && !calculator.includes('createDirectory'), 'missing root must return zero without creation');
assert(calculator.includes('return null;') && calculator.includes('safePublicBytes'), 'invalid space values must map to null');

assert(/@CapacitorPlugin\s*\(\s*name\s*=\s*"AndroidStorageStats"\s*\)/.test(plugin), 'plugin name drift');
assert(count(plugin, /@PluginMethod\b/g) === 1, 'plugin must expose exactly one method');
assert(/@PluginMethod\s+public\s+void\s+getStorageStats\s*\(\s*PluginCall\s+call\s*\)/.test(plugin), 'getStorageStats method missing');
assert(plugin.includes('request.length() != 0'), 'request must be exactly empty');
assert(count(plugin, /output\.put\("(?:retainedBytes|availableBytes|capacityBytes|memoryBytes)"/g) === 4, 'exact four-field DTO missing');
assert(!/getMessage\s*\(|printStackTrace\s*\(|\bLog\.|System\.out/.test(plugin), 'plugin detail leak');
assert(!/addListener|stat\s*\(|exists\s*\(|list\s*\(/.test(plugin), 'unaccepted storage method exposed');
assert(!/AndroidStorageStatsPlugin/.test(mainActivity), 'registration must remain gated');

assert(/getStorageStats\(\):\s*Promise<unknown>/.test(client), 'strict no-argument native shape missing');
assert(client.includes("registerPlugin<AndroidStorageStatsNativePlugin>('AndroidStorageStats')"), 'native proxy drift');
assert(!/export\s+const\s+AndroidStorageStatsNative\b/.test(client), 'raw native proxy must remain private');
assert(client.includes("OUTPUT_KEYS = ['availableBytes', 'capacityBytes', 'memoryBytes', 'retainedBytes']"), 'exact response keys missing');
assert(client.includes('Reflect.ownKeys') && client.includes('Object.getPrototypeOf(value) !== Object.prototype'), 'strict plain DTO validation missing');
assert(client.includes('Number.isSafeInteger(value)') && client.includes('value >= 0'), 'safe nonnegative validation missing');
assert(!/path|filename|uri|telemetry|permission/i.test(client), 'private or unauthorized client surface');

for (const path of [calculatorPath, pluginPath, calculatorTestPath, pluginTestPath, clientPath, clientTestPath, 'scripts/verify-android-storage-stats.mjs']) {
  console.log(`OWNED ${hash(path)}  ${path}`);
}
console.log('ANDROID_STORAGE_STATS_VERIFIER: PASS');
console.log('ANDROID_STORAGE_STATS_SURFACE: getStorageStats only; retainedBytes/availableBytes/capacityBytes/memoryBytes');
console.log('RUNTIME_DISCOVERY: NOT_CHECKED');
console.log('PRODUCTION_RELEASE_READY: NO');
