// Forced colours (Windows High Contrast and the like): every button, switch and choice keeps an
// edge, and every on/off control still shows which state it is in.
//
//   PDF_CHEF_URL=http://127.0.0.1:4173 node scripts/verify-forced-colors.mjs [--only id,id] [--sizes 1440,390] [--out file.json]
//
// Each screen (Home, Recent, Settings, and every tool empty and with its QA file) is read twice in
// the same page: once as drawn, once with forced colours on. It fails when
//   - a control that has an edge as drawn (a border, a ring, or a fill set apart from what is
//     behind it) has none under forced colours (no border, no outline, no fill it keeps), or
//   - a control that says it is on (aria-checked, aria-pressed, aria-selected) looks the same under
//     forced colours as its off state. The off state is read from a copy of the control with the
//     state flipped, placed beside it and removed again, so nothing on the screen changes.
// Slot editors are opened one at a time, so the choices inside them are read too.
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { ensureFixtures, loadFixture, newContext, rootScreens, settle, tools } from './lib/tool-ui.mjs';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index === -1 ? null : args[index + 1]; };
const base = process.env.PDF_CHEF_URL ?? 'http://127.0.0.1:4173';
const only = option('--only')?.split(',').filter(Boolean) ?? null;
const widths = (option('--sizes') ?? '1440,390').split(',').map(Number);
const out = option('--out');
const sizeFor = (width) => (width >= 768 ? { width, height: 900, phone: false } : { width, height: 844, phone: true });

/** Runs in the page: reads every visible button, switch and choice under the current colours. */
function readControls(scope) {
  const SELECTOR = [
    'button', '[role="button"]', '[role="switch"]', '[role="radio"]', '[role="tab"]', '[role="checkbox"]',
    '[role="menuitemradio"]', '[role="option"]', 'input[type="checkbox"]', 'input[type="radio"]', 'select',
    '[aria-pressed]', '[aria-checked]',
  ].join(',');
  const alpha = (color) => {
    if (!color || color === 'transparent') return 0;
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length > 3 ? Number(parts[3]) : 1;
  };
  const backdrop = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (alpha(bg) > 0.5) return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (el.closest('[hidden], [aria-hidden="true"], .sr-only, [inert]')) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const border = (cs) => sides.some((side) => parseFloat(cs[`border${side}Width`]) >= 1
    && !['none', 'hidden'].includes(cs[`border${side}Style`]) && alpha(cs[`border${side}Color`]) > 0.3);
  const outline = (cs) => parseFloat(cs.outlineWidth) >= 1 && !['none', 'hidden'].includes(cs.outlineStyle) && alpha(cs.outlineColor) > 0.3;
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 50);
  const state = (el) => el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-selected')
    ?? (el.matches('input[type="checkbox"], input[type="radio"]') ? String(el.checked) : null);
  // What the control looks like: its own colours and edge, and those of the parts inside it (a
  // switch's knob, a check mark), with each part's place in the control.
  const look = (el) => {
    const r = el.getBoundingClientRect();
    const parts = [el, ...el.querySelectorAll('*')].slice(0, 12);
    return parts.map((node) => {
      const cs = getComputedStyle(node);
      const nr = node.getBoundingClientRect();
      return [cs.backgroundColor, cs.color, cs.borderTopColor, cs.borderTopWidth, cs.outlineStyle, cs.outlineColor,
        cs.boxShadow, cs.fill, cs.stroke, cs.opacity, cs.visibility, cs.display, cs.transform,
        Math.round(nr.left - r.left), Math.round(nr.top - r.top), Math.round(nr.width), Math.round(nr.height)].join(' ');
    }).join(' | ');
  };
  const region = scope ? document.getElementById(scope) : null;
  const all = [...document.querySelectorAll(SELECTOR)]
    .filter((el) => !el.closest('[data-fc-copy]') && (!region || region.contains(el)));
  const unique = all.filter((el, index) => all.indexOf(el) === index && visible(el));
  return unique.map((el, index) => {
    el.setAttribute('data-fc-id', String(index));
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const filled = alpha(bg) > 0.5 && bg !== backdrop(el);
    const native = el.matches('input[type="checkbox"], input[type="radio"], select') && cs.appearance !== 'none';
    return {
      id: index,
      name: name(el),
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      state: state(el),
      native,
      border: border(cs),
      outline: outline(cs),
      ring: cs.boxShadow !== 'none',
      filled,
      keepsColours: cs.forcedColorAdjust === 'none',
      look: look(el),
    };
  });
}

/** Runs in the page: the look of a copy of control `id` with its state flipped. */
function readFlipped(id) {
  const el = document.querySelector(`[data-fc-id="${id}"]`);
  if (!el) return null;
  const copy = el.cloneNode(true);
  copy.setAttribute('data-fc-copy', '');
  copy.removeAttribute('id');
  for (const attr of ['aria-checked', 'aria-pressed', 'aria-selected']) {
    const value = el.getAttribute(attr);
    if (value === 'true') copy.setAttribute(attr, 'false');
    else if (value === 'false') copy.setAttribute(attr, 'true');
  }
  if (el.matches('input[type="checkbox"], input[type="radio"]')) copy.checked = !el.checked;
  // Parts inside follow the same attribute (a switch's inner track).
  for (const node of copy.querySelectorAll('[aria-checked], [aria-pressed], [aria-selected]')) {
    for (const attr of ['aria-checked', 'aria-pressed', 'aria-selected']) {
      const value = node.getAttribute(attr);
      if (value === 'true') node.setAttribute(attr, 'false');
      else if (value === 'false') node.setAttribute(attr, 'true');
    }
  }
  el.after(copy);
  const r = copy.getBoundingClientRect();
  const parts = [copy, ...copy.querySelectorAll('*')].slice(0, 12);
  const look = parts.map((node) => {
    const cs = getComputedStyle(node);
    const nr = node.getBoundingClientRect();
    return [cs.backgroundColor, cs.color, cs.borderTopColor, cs.borderTopWidth, cs.outlineStyle, cs.outlineColor,
      cs.boxShadow, cs.fill, cs.stroke, cs.opacity, cs.visibility, cs.display, cs.transform,
      Math.round(nr.left - r.left), Math.round(nr.top - r.top), Math.round(nr.width), Math.round(nr.height)].join(' ');
  }).join(' | ');
  copy.remove();
  return look;
}

const problems = [];
const report = [];
let checked = 0;

/** Reads the screen as drawn and under forced colours, and records each problem. */
async function check(page, where, scope = null) {
  // Colours ease between states; read the end of each change, not its first frame.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.emulateMedia({ forcedColors: 'none' });
  const drawn = await page.evaluate(readControls, scope);
  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await page.evaluate(readControls, scope);
  const byName = new Map(forced.map((control) => [`${control.role}\u0000${control.name}\u0000${control.id}`, control]));
  const found = [];
  for (const before of drawn) {
    const after = byName.get(`${before.role}\u0000${before.name}\u0000${before.id}`);
    if (!after) continue;
    checked += 1;
    const hadEdge = before.border || before.ring || before.filled;
    const hasEdge = after.border || after.outline || (after.keepsColours && (after.filled || after.ring)) || after.native;
    if (hadEdge && !hasEdge) found.push({ where, kind: 'edge', control: `${after.role} "${after.name}"` });
    if (after.state === 'true' && !after.native) {
      const off = await page.evaluate(readFlipped, after.id);
      if (off !== null && off === after.look) found.push({ where, kind: 'state', control: `${after.role} "${after.name}"` });
    }
  }
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-fc-id]')) el.removeAttribute('data-fc-id'); });
  problems.push(...found);
  report.push({ where, controls: drawn.length, problems: found.length });
  return found;
}

/** Opens each slot editor in turn and checks the screen with it open. */
async function checkEditors(page, where) {
  const openers = await page.locator('[aria-haspopup="dialog"][aria-controls]:visible').all();
  for (const [index, opener] of openers.entries()) {
    try {
      if (await opener.isDisabled()) continue;
      const id = await opener.getAttribute('aria-controls');
      const label = ((await opener.getAttribute('aria-label')) || (await opener.innerText())).trim().replace(/\s+/g, ' ').slice(0, 30);
      await opener.click({ timeout: 3_000 });
      const region = page.locator(`[id="${id}"]`);
      await region.waitFor({ state: 'visible', timeout: 3_000 });
      await page.waitForTimeout(150);
      // Only what the editor holds: the screen around it was read at rest.
      await check(page, `${where} › editor "${label}"`, id);
      await page.keyboard.press('Escape');
      await region.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
    } catch { /* an editor that does not open is not this check's concern */ }
  }
}

const browser = await chromium.launch();
try {
  await ensureFixtures(chromium);
  const screens = [
    ...rootScreens.map((screen) => ({ ...screen, files: () => [] })),
    ...tools,
  ].filter((screen) => !only || only.includes(screen.id));
  for (const width of widths) {
    const size = sizeFor(width);
    for (const screen of screens) {
      const states = screen.files().length ? ['empty', 'loaded'] : ['empty'];
      for (const stateName of states) {
        const context = await newContext(browser, size);
        const page = await context.newPage();
        try {
          await loadFixture(page, screen.route, stateName === 'loaded' ? screen.files() : [], { origin: base, perInput: screen.perInput });
          await settle(page, 600);
          const where = `${screen.id} ${stateName} ${width}`;
          await check(page, where);
          await checkEditors(page, where);
        } catch (error) {
          problems.push({ where: `${screen.id} ${stateName} ${width}`, kind: 'load', control: String(error).split('\n')[0] });
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}

// One line per control and problem on each screen, however many editors were open around it.
const seen = new Set();
const unique = problems.filter((problem) => {
  const key = `${problem.kind}\u0000${problem.where.split(' › ')[0]}\u0000${problem.control}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
problems.length = 0;
problems.push(...unique);
for (const problem of problems) console.log(`FAIL ${problem.kind.padEnd(5)} ${problem.where}: ${problem.control}`);
console.log(`forced colours: ${report.length} screens, ${checked} controls read, ${problems.length} problems`);
if (out) await writeFile(out, `${JSON.stringify({ base, widths, report, problems }, null, 2)}\n`);
process.exit(problems.length ? 1 : 0);
