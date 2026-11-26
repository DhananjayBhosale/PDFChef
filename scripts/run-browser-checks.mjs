// Every browser check in one command (npm run test:browser:all).
// Builds into its own folder (never dist/), starts the preview and the dev server, runs each check
// against the server it needs, one at a time, writes one log per check, stops both servers, prints
// a table and exits 1 when a trusted check fails.
//   npm run test:browser:all [-- --only=save-separately,ui-controls] [--skip-build]
// Env: PDF_CHEF_ALL_DIR (default output/web/browser-all), PDF_CHEF_ALL_PREVIEW_PORT (4173),
// PDF_CHEF_ALL_DEV_PORT (4195).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const folder = resolve(root, process.env.PDF_CHEF_ALL_DIR || 'output/web/browser-all');
const dist = resolve(folder, 'dist');
const logs = resolve(folder, 'logs');
const ports = { preview: Number(process.env.PDF_CHEF_ALL_PREVIEW_PORT || 4173), dev: Number(process.env.PDF_CHEF_ALL_DEV_PORT || 4195) };
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}`))?.split('=')[1] ?? (process.argv.includes(`--${name}`) ? '' : undefined);
const only = option('only')?.split(',').filter(Boolean) ?? [];

// --- The table ---------------------------------------------------------------------------------
// Every `test:browser:*` npm script runs, on the preview (the built app) unless listed here: these
// load TypeScript source and need the dev server.
const DEV_SCRIPTS = new Set(['test:browser:preview-progress', 'test:browser:geometry', 'test:browser:tools', 'test:browser:edit-pdf:shared-forms', 'test:browser:edit-pdf:trailing-blank']);
// npm scripts that only chain others, which run on their own.
const AGGREGATES = new Set(['test:browser:all', 'test:browser:edit-pdf']);
// Extra arguments for an npm script.
const ARGS = { 'test:browser:ui-controls': ['--touch'] };
// Checks that no npm script runs. server: preview, dev or none (the check needs only the built
// files). trusted: false while the check has not passed on today's code; it runs and is reported,
// but does not fail the command.
const FILES = [
  { file: 'tests/browser/workspaceResultLifecycle.mjs', server: 'dev', trusted: true },
  { file: 'tests/browser/pairedSlidersLargeText.mjs', server: 'preview', trusted: true },
  { file: 'tests/browser/longWordValue.mjs', server: 'preview', trusted: true },
  { file: 'scripts/verify-editor-overlay-layout.mjs', server: 'dev', trusted: true },
  { file: 'scripts/verify-forced-colors.mjs', server: 'preview', trusted: false },
  { file: 'scripts/verify-localization-mobile.mjs', server: 'preview', trusted: true },
  { file: 'scripts/verify-localization-offline.mjs', server: 'preview', trusted: true },
  { file: 'scripts/verify-offline-assets.mjs', server: 'none', trusted: true },
  { file: 'scripts/verify-path-to-9-part1.mjs', server: 'preview', trusted: false },
  { file: 'scripts/verify-path-to-9-part2.mjs', server: 'preview', trusted: false },
  { file: 'scripts/verify-pdf-label-validation.mjs', server: 'dev', trusted: false },
  { file: 'scripts/verify-preview-lifecycle.mjs', server: 'preview', trusted: false },
  { file: 'scripts/verify-service-worker-updates.mjs', server: 'none', trusted: true },
  { file: 'tests/browser/conversionAndFormIntegrity.mjs', server: 'dev', trusted: true },
  { file: 'tests/browser/finalFixChecks.mjs', server: 'preview', trusted: false },
  { file: 'tests/browser/overnightChecksB.mjs', server: 'preview', trusted: true },
  { file: 'tests/browser/overnightChecksC.mjs', server: 'preview', trusted: true },
  { file: 'tests/browser/pdfCrossFontSelection.mjs', server: 'preview', trusted: true },
  { file: 'tests/browser/phoneLayoutChecks.mjs', server: 'preview', trusted: false },
  { file: 'tests/browser/syncFixChecks.mjs', server: 'preview', trusted: true },
];
// -----------------------------------------------------------------------------------------------

const scripts = Object.keys(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).scripts)
  .filter((name) => name.startsWith('test:browser:') && !AGGREGATES.has(name));
const checks = [
  ...scripts.map((name) => ({ name: name.slice('test:browser:'.length), command: ['npm', 'run', name, ...(ARGS[name] ? ['--', ...ARGS[name]] : [])], server: DEV_SCRIPTS.has(name) ? 'dev' : 'preview', trusted: true })),
  ...FILES.map((entry) => ({ name: entry.file.split('/').pop().replace(/\.mjs$/, ''), command: ['node', entry.file], server: entry.server, trusted: entry.trusted })),
].filter((check) => !only.length || only.includes(check.name));

const children = new Set();
const run = (command, env, logFile, timeoutMs = 20 * 60_000) => new Promise((done) => {
  const out = logFile ? createWriteStream(logFile) : null;
  const child = spawn(command[0], command.slice(1), { cwd: root, env: { ...process.env, ...env }, detached: true });
  children.add(child);
  child.stdout.on('data', (chunk) => out?.write(chunk));
  child.stderr.on('data', (chunk) => out?.write(chunk));
  const timer = setTimeout(() => { out?.write(`\nTimed out after ${timeoutMs / 60_000} min\n`); stop(child); }, timeoutMs);
  child.on('close', (code) => { clearTimeout(timer); children.delete(child); out?.end(); done(code ?? 1); });
});
const stop = (child) => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
const stopAll = () => children.forEach(stop);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const serve = (command, port, logFile) => {
  const out = createWriteStream(logFile);
  const child = spawn(command[0], command.slice(1), { cwd: root, env: { ...process.env, PDF_CHEF_DIST_DIR: dist }, detached: true });
  children.add(child);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  return waitFor(`http://127.0.0.1:${port}/`);
};
const waitFor = async (url) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((wait) => setTimeout(wait, 500));
  }
  throw new Error(`${url} did not answer`);
};

await mkdir(logs, { recursive: true });
const needs = new Set(checks.map((check) => check.server));
// The dev server first: it copies the PDF.js and OCR files into public/vendor/ as it starts, which
// would leave a build made before it older than its inputs (the offline-asset check refuses that).
try {
  if (needs.has('dev')) await serve(['npm', 'run', 'dev', '--', '--port', String(ports.dev), '--strictPort', '--host', '127.0.0.1'], ports.dev, resolve(logs, 'server-dev.log'));
} catch (error) {
  console.log(`FAIL dev server: ${error.message}`);
  stopAll();
  process.exit(1);
}
if (option('skip-build') === undefined) {
  console.log(`Building into ${dist}`);
  if (await run(['npm', 'run', 'build'], { PDF_CHEF_DIST_DIR: dist }, resolve(logs, 'build.log'))) {
    console.log(`FAIL build: see ${resolve(logs, 'build.log')}`);
    stopAll();
    process.exit(1);
  }
}
try {
  if (needs.has('preview')) await serve(['npx', 'vite', 'preview', '--port', String(ports.preview), '--strictPort', '--host', '127.0.0.1'], ports.preview, resolve(logs, 'server-preview.log'));
} catch (error) {
  console.log(`FAIL preview server: ${error.message}`);
  stopAll();
  process.exit(1);
}

const results = [];
for (const check of checks) {
  const url = check.server === 'none' ? '' : `http://127.0.0.1:${ports[check.server]}`;
  const logFile = resolve(logs, `${check.name}.log`);
  const started = Date.now();
  process.stdout.write(`${check.name} (${check.server}) … `);
  // PDF_CHEF_BASE_URL: the older name one check still reads.
  const code = await run(check.command, { PDF_CHEF_URL: url, PDF_CHEF_BASE_URL: url, PDF_CHEF_DIST_DIR: dist }, logFile);
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ ...check, code, seconds, logFile });
  console.log(`${code === 0 ? 'pass' : 'FAIL'} in ${seconds} s`);
}
stopAll();

console.log('\nCheck | Server | Trusted | Result | Log');
for (const result of results) console.log(`${result.name} | ${result.server} | ${result.trusted ? 'yes' : 'no'} | ${result.code === 0 ? 'pass' : 'FAIL'} | ${result.logFile}`);
const failed = results.filter((result) => result.code !== 0 && result.trusted);
const untrusted = results.filter((result) => result.code !== 0 && !result.trusted);
console.log(`\n${results.length - failed.length - untrusted.length} of ${results.length} passed.${untrusted.length ? ` Not yet trusted and failing: ${untrusted.map((result) => result.name).join(', ')}.` : ''}`);
process.exit(failed.length ? 1 : 0);
