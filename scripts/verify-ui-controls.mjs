// No control removed: records every control each screen has today, then checks later builds against it.
//
//   PDF_CHEF_URL=http://127.0.0.1:4194 node scripts/verify-ui-controls.mjs --record   # phase 0, today's build
//   PDF_CHEF_URL=http://127.0.0.1:4194 node scripts/verify-ui-controls.mjs            # compare with the record
//
// Options: --only=split,merge  --sizes=390x844,1440x900  --states=empty,loaded,result
//          --inventory=<path>  --concurrency=4  --touch (also fail on controls under 48 px on phones)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  collectControls, controlKey, editorControls, ensureFixtures, loadFiles, newContext, root, rootScreens, settle, sizes, tools,
} from './lib/tool-ui.mjs';

const args = new Map(process.argv.slice(2).map(arg => { const [k, v = 'true'] = arg.replace(/^--/, '').split('='); return [k, v]; }));
const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4194';
const record = args.has('record');
const inventoryPath = resolve(root, args.get('inventory') || 'output/web/ui-redesign/build/inventory/today.json');
const exceptionsPath = resolve(root, 'scripts/lib/ui-control-exceptions.json');
const only = args.get('only')?.split(',');
const sizeFilter = args.get('sizes')?.split(',');
const stateFilter = args.get('states')?.split(',');
const concurrency = Number(args.get('concurrency') || 4);

const screens = [
  ...rootScreens.map(screen => ({ ...screen, kind: 'root', states: ['empty'] })),
  ...tools.map(tool => ({
    ...tool, kind: 'tool',
    states: ['empty', ...(tool.files().length ? ['loaded'] : []), ...(tool.result ? ['result'] : [])],
  })),
].filter(screen => !only || only.includes(screen.id));
const usedSizes = sizes.filter(size => !sizeFilter || sizeFilter.includes(size.key));
const wantState = (state) => !stateFilter || stateFilter.includes(state);

// Everything routable must be covered, so a new tool cannot slip past the inventory.
const catalog = await readFile(resolve(root, 'components/Tools/toolCatalog.ts'), 'utf8');
const catalogRoutes = [...catalog.matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]);
if (!only) {
  const covered = new Set(tools.map(tool => tool.route));
  assert.deepEqual(catalogRoutes.filter(route => !covered.has(route)), [], 'toolCatalog routes missing from scripts/lib/tool-ui.mjs');
  assert.equal(tools.length, 38, 'expected 38 tools');
}

await ensureFixtures(chromium);
const browser = await chromium.launch({ headless: true });

/** One screen, one state, one size, in a fresh context. */
async function capture(screen, state, size) {
  const context = await newContext(browser, size);
  const errors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + screen.route, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 10_000 });
    await settle(page, 600);
    if (state !== 'empty') {
      await loadFiles(page, screen.files(), { perInput: screen.perInput });
      await settle(page, 1800);
    }
    let editors = true;
    if (state === 'result') {
      editors = await editorControls(page);
      const action = page.getByRole('button', { name: screen.result }).first();
      await action.click({ timeout: 10_000 });
      await page.getByRole('dialog').or(page.getByText(/Result ready|PDF exported|Ready to save|Already as small as it gets/)).first().waitFor({ timeout: 45_000 });
      await settle(page, 400);
    }
    return { ...(await collectControls(page, { editors })), errors };
  } catch (error) {
    return { error: String(error?.message ?? error).split('\n')[0], controls: [], errors };
  } finally { await context.close(); }
}

const jobs = [];
for (const screen of screens) for (const state of screen.states) if (wantState(state)) for (const size of usedSizes) jobs.push({ screen, state, size });
const results = new Map();
let cursor = 0;
let done = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const result = await capture(job.screen, job.state, job.size);
    results.set(`${job.screen.id}|${job.state}|${job.size.key}`, result);
    done += 1;
    if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length}`);
  }
}));
await browser.close();

const gitHead = (() => { try { return execFileSync('git', ['log', '-1', '--format=%h'], { cwd: root }).toString().trim(); } catch { return 'unknown'; } })();

if (record) {
  const inventory = {
    recordedAt: new Date().toISOString(), commit: gitHead, origin: 'vite preview of a production build',
    sizes: usedSizes.map(s => s.key), screens: {},
  };
  const failed = [];
  for (const [key, result] of results) {
    const [id, state, size] = key.split('|');
    const screen = screens.find(s => s.id === id);
    const entry = (inventory.screens[id] ??= { route: screen.route, kind: screen.kind, states: {} });
    (entry.states[state] ??= {})[size] = result.error ? { error: result.error } : {
      controls: result.controls.map(c => `${c.role}|${c.name}|x${c.count}${c.flags.length ? `|${c.flags.join(',')}` : ''}`),
      colorInputs: result.colorInputs, fileInputs: result.fileInputs, headings: result.headings,
      overflowX: result.overflowX, under48: result.under48, pageErrors: result.errors,
    };
    if (result.error) failed.push(`${key}: ${result.error}`);
  }
  await mkdir(dirname(inventoryPath), { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 1)}\n`);
  const total = [...results.values()].reduce((sum, r) => sum + r.controls.length, 0);
  console.log(`Recorded ${results.size} captures (${total} control kinds) -> ${inventoryPath}`);
  if (failed.length) { console.error(`Could not capture:\n${failed.join('\n')}`); process.exitCode = 1; }
} else {
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const exceptions = JSON.parse(await readFile(exceptionsPath, 'utf8'));
  const failures = [];
  const parse = (line) => { const [role, name, count, flags] = line.split('|'); return { role, name, count: Number(count.slice(1)), flags: flags?.split(',') ?? [] }; };
  // Default file names carry today's date ("Merge PDF 12 Nov.pdf"): compare them without it,
  // so the baseline does not fail on every later day.
  const undate = (text) => text.replace(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, '<date>');
  const appliesTo = (rule, id, kind) => (!rule.screens || rule.screens.includes(id)) && (!rule.kind || rule.kind === kind);
  for (const [id, entry] of Object.entries(inventory.screens)) {
    if (only && !only.includes(id)) continue;
    for (const [state, bySize] of Object.entries(entry.states)) {
      if (!wantState(state)) continue;
      for (const [sizeKey, before] of Object.entries(bySize)) {
        if (sizeFilter && !sizeFilter.includes(sizeKey)) continue;
        const now = results.get(`${id}|${state}|${sizeKey}`);
        const label = `${id} [${state}] ${sizeKey}`;
        if (!now) continue;
        if (now.error) { failures.push(`${label}: could not capture: ${now.error}`); continue; }
        if (before.error) continue; // today could not reach this state either
        const present = new Set(now.controls.map(c => undate(controlKey(c))));
        const presentLower = new Set(now.controls.map(c => controlKey(c).toLowerCase()));
        const roleNames = new Map();
        for (const c of now.controls) roleNames.set(c.name, [...(roleNames.get(c.name) ?? []), c.role]);
        for (const line of before.controls) {
          const control = parse(line);
          if (present.has(undate(controlKey(control)))) continue;
          const excuse = exceptions.rules.find((rule) => appliesTo(rule, id, entry.kind) && (
            (rule.type === 'absent' && rule.role === control.role && rule.names.includes(control.name))
            || (rule.type === 'sameControl' && rule.names.includes(control.name) && rule.roles.includes(control.role)
              && rule.roles.some(role => present.has(`${role}\u0000${control.name}`)))
            || (rule.type === 'caseOnly' && presentLower.has(controlKey(control).toLowerCase()))
            || (rule.type === 'renamed' && rule.role === control.role && rule.from === control.name && present.has(`${rule.role}\u0000${rule.to}`))));
          if (!excuse) failures.push(`${label}: missing ${control.role} "${control.name}"`);
        }
        if ((before.colorInputs ?? 0) > now.colorInputs) failures.push(`${label}: colour inputs ${before.colorInputs} -> ${now.colorInputs}`);
        if (!before.overflowX && now.overflowX) failures.push(`${label}: new horizontal overflow`);
        if (before.pageErrors.length === 0 && now.errors.length) failures.push(`${label}: page error: ${now.errors[0]}`);
        if (args.has('touch') && sizes.find(s => s.key === sizeKey)?.phone && now.under48 > 0) failures.push(`${label}: ${now.under48} controls under 48 px: ${(now.under48List ?? []).join('; ')}`);
      }
    }
  }
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(failures.length
    ? `${failures.length} problems against ${inventoryPath}`
    : `PASS: ${results.size} captures keep every control recorded in ${inventoryPath}`);
  if (failures.length) process.exitCode = 1;
}
