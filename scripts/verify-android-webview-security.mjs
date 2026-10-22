#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const requireMatch = (text, pattern, label) => {
  if (!pattern.test(text)) throw new Error(`Missing ${label}`);
};
const requireAbsent = (text, pattern, label) => {
  if (pattern.test(text)) throw new Error(`Forbidden ${label}`);
};
const occurrences = (text, value) => text.split(value).length - 1;

const activity = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java');
const policy = read('android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/security/PdfChefWebViewPolicy.java');
const config = read('capacitor.config.ts');

const inspector = 'registerPlugin(AndroidLegacyInspectorPlugin.class)';
const writer = 'registerPlugin(AndroidLegacySettingsWriterPlugin.class)';
const metadata = 'registerPlugin(AndroidAppMetadataPlugin.class)';
const storage = 'registerPlugin(AndroidStorageStatsPlugin.class)';
const documents = 'registerPlugin(AndroidDocumentsPlugin.class)';
const scanner = 'registerPlugin(AndroidDocumentScannerPlugin.class)';
const support = 'registerPlugin(AndroidSupportPlugin.class)';
const bridge = 'super.onCreate(savedInstanceState)';
const registrations = [inspector, writer, metadata, storage, documents, scanner, support];
if (![...registrations, bridge].every((needle) => activity.includes(needle))) {
  throw new Error('accepted registrations and bridge creation must remain explicit');
}
const registrationOffsets = registrations.map(needle => activity.indexOf(needle));
if (!registrationOffsets.every((offset, index) => index === 0 || registrationOffsets[index - 1] < offset)
  || registrationOffsets.at(-1) >= activity.indexOf(bridge)) {
  throw new Error('the accepted seven plugins must register in order before bridge creation');
}
if ((activity.match(/registerPlugin\(/g) ?? []).length !== registrations.length
  || registrations.some(needle => occurrences(activity, needle) !== 1)) {
  throw new Error('MainActivity may register exactly the accepted seven plugins once each');
}

requireMatch(config, /allowMixedContent:\s*false/, 'Capacitor mixed-content configuration');
requireAbsent(config, /server\s*:\s*\{[^}]*url\s*:/s, 'remote Capacitor server URL');
requireAbsent(config, /allowNavigation\s*:/, 'Capacitor navigation allowlist');
requireMatch(policy, /PACKAGED_ORIGIN\s*=\s*"https:\/\/localhost"/, 'fixed packaged HTTPS localhost origin');
for (const [method, label] of [
  ['setMixedContentMode\\(WebSettings\\.MIXED_CONTENT_NEVER_ALLOW\\)', 'mixed content block'],
  ['setAllowFileAccess\\(false\\)', 'file access block'],
  ['setAllowContentAccess\\(false\\)', 'content access block'],
  ['setAllowFileAccessFromFileURLs\\(false\\)', 'file URL access block'],
  ['setAllowUniversalAccessFromFileURLs\\(false\\)', 'universal file URL block'],
  ['setJavaScriptCanOpenWindowsAutomatically\\(false\\)', 'JavaScript popup block'],
  ['setSupportMultipleWindows\\(false\\)', 'multiple-window block'],
  ['WebView\\.setWebContentsDebuggingEnabled\\(false\\)', 'WebView debugging block'],
]) requireMatch(policy, new RegExp(method), label);

requireMatch(activity, /bridge\.setWebViewClient\(new PdfChefWebViewClient\(bridge\)\)/, 'policy WebView client installation');
requireMatch(activity, /config = CapConfig\.loadDefault\(this\)[\s\S]*PdfChefWebViewPolicy\.apply\(webView\);\s*(?:configureGraphicsLayer\(webView\);\s*)?super\.load\(\);/, 'pre-bridge WebView hardening');
requireMatch(activity, /!PdfChefWebViewPolicy\.isTrustedConfig\(bridge\.getConfig\(\)\)[\s\S]*!PdfChefWebViewPolicy\.isPackagedOrigin\(bridge\.getAppUrl\(\)\)/, 'fail-closed configured bridge origin');
requireMatch(activity, /OPEN_EXTERNAL_BROWSER[\s\S]*startActivity\(new Intent\(Intent\.ACTION_VIEW, request\.getUrl\(\)\)\)/, 'visible external HTTP(S) link handoff');
requireMatch(policy, /"mailto"\.equals\(scheme\)/, 'existing email-link handoff');
requireMatch(activity, /ServiceWorkerController\.getInstance\(\)\.setServiceWorkerClient/, 'service-worker request boundary');
requireMatch(activity, /onPageStarted[\s\S]*!PdfChefWebViewPolicy\.isPackagedOrigin\(url\)[\s\S]*view\.stopLoading\(\)/, 'redirect fail-closed guard');
requireMatch(activity, /return blockedResponse\(\)/, 'remote subresource block');
requireAbsent(activity, /bridge\.launchIntent\(/, 'Capacitor broad intent launcher');
requireMatch(activity, /PlayInAppUpdateController\.create\(this, inAppUpdateLauncher\)/,
  'lifecycle-owned Play update controller');

console.log('WEBVIEW_SECURITY_VERIFIER: PASS');
