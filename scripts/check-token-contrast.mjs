// WCAG contrast gate for the design tokens (plain Node, no browser).
//   node scripts/check-token-contrast.mjs [--markdown]
// Reads assets/design-tokens.css, checks every text pair at 4.5:1 and --border-strong at 3:1 in
// light and dark, and asserts assets/design-tokens.json carries the same values as the CSS.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const css = await readFile(resolve(root, 'assets/design-tokens.css'), 'utf8');
const json = JSON.parse(await readFile(resolve(root, 'assets/design-tokens.json'), 'utf8'));
const markdown = process.argv.includes('--markdown');
const failures = [];

const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in design-tokens.css`);
  const end = css.indexOf('\n}', start);
  const tokens = {};
  for (const match of css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[match[1]] = match[2].trim();
  return tokens;
};
const light = block(':root');
const dark = { ...light, ...block('.dark') };
const resolveToken = (tokens, name, depth = 0) => {
  let value = tokens[name];
  if (value === undefined) throw new Error(`Missing token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref && depth < 8) value = resolveToken(tokens, ref[1], depth + 1);
  return value;
};

/** Parses #rgb, #rrggbb and rgba() into [r, g, b, a]. */
const parse = (value) => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(',').map(Number);
    return [r, g, b, a];
  }
  throw new Error(`Cannot parse colour ${value}`);
};
const over = (top, base) => {
  const [r, g, b, a] = top;
  return [0, 1, 2].map(i => Math.round(top[i] * a + base[i] * (1 - a))).concat(1).map((v, i) => (i === 3 ? 1 : v));
};
const luminance = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const rows = [];
for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
  const get = (name) => parse(resolveToken(tokens, name));
  const surfaces = ['--surface-canvas', '--surface-raised', '--surface-sunken'];
  const flat = Object.fromEntries(surfaces.map(name => [name, get(name)]));
  const check = ({ label, fg, bgs, min, bgLabel }) => {
    const worst = bgs.map(bg => {
      const base = bg.base ? bg.base : bg;
      const fill = bg.tint ? over(bg.tint, base) : base;
      return ratio(over(get(fg), fill), fill);
    });
    const value = Math.min(...worst);
    rows.push({ theme, label, bg: bgLabel, ratio: value, min, perSurface: worst });
    if (value < min) failures.push(`${theme}: ${label} on ${bgLabel} is ${value.toFixed(2)}:1, needs ${min}:1`);
  };
  const onSurfaces = [flat['--surface-canvas'], flat['--surface-raised'], flat['--surface-sunken']];
  for (const token of ['--text-primary', '--text-body', '--text-secondary', '--text-tertiary', '--accent-text']) {
    check({ label: token, fg: token, bgs: onSurfaces, min: 4.5, bgLabel: 'canvas / raised / sunken' });
  }
  check({ label: '--border-strong', fg: '--border-strong', bgs: onSurfaces, min: 3, bgLabel: 'canvas / raised / sunken' });
  check({ label: '--text-on-accent', fg: '--text-on-accent', bgs: [get('--accent-rest')], min: 4.5, bgLabel: '--accent-rest' });
  const quiet = (name) => onSurfaces.map(base => ({ base, tint: get(name) }));
  check({ label: '--accent-text', fg: '--accent-text', bgs: quiet('--accent-quiet'), min: 4.5, bgLabel: '--accent-quiet' });
  check({ label: '--accent-on-quiet', fg: '--accent-on-quiet', bgs: quiet('--accent-quiet'), min: 4.5, bgLabel: '--accent-quiet' });
  for (const status of ['success', 'caution', 'danger']) {
    check({ label: `--status-${status}-text`, fg: `--status-${status}-text`, bgs: onSurfaces, min: 4.5, bgLabel: 'canvas / raised / sunken' });
    check({ label: `--status-${status}-text`, fg: `--status-${status}-text`, bgs: quiet(`--status-${status}-quiet`), min: 4.5, bgLabel: `--status-${status}-quiet` });
  }
}

// ---- JSON mirror
const norm = (value) => String(value).trim().toLowerCase().replace(/\s+/g, ' ');
const same = (label, jsonValue, cssValue) => {
  if (cssValue === undefined) failures.push(`mirror: ${label} has no CSS token`);
  else if (norm(jsonValue) !== norm(cssValue)) failures.push(`mirror: ${label} is "${jsonValue}" in JSON and "${cssValue}" in CSS`);
};
const kebab = (key) => `--${key.replace(/\./g, '-').replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
for (const family of ['paper', 'ink', 'success', 'caution', 'danger']) {
  for (const [step, value] of Object.entries(json.color[family].scale)) same(`color.${family}.${step}`, value, light[`--${family}-${step}`]);
}
for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
  for (const [key, value] of Object.entries(json.semantic[theme])) same(`semantic.${theme}.${key}`, value, resolveToken(tokens, kebab(key)));
}
for (const [key, value] of Object.entries(json.radius)) same(`radius.${key}`, value, light[`--radius-${key}`]);
for (const [key, value] of Object.entries(json.space.scale)) same(`space.${key}`, value, light[`--space-${key}`]);
same('size.touchTarget', json.size.touchTarget, light['--size-touch-target']);
same('size.tabBar', json.size.tabBar, light['--size-tab-bar']);
same('size.navBar', json.size.navBar, light['--size-nav-bar']);
for (const key of ['raised', 'chip', 'panel', 'sheet']) {
  same(`elevation.${key}`, json.elevation[key], light[`--elevation-${key}`]);
  if (json.elevation.dark?.[key]) same(`elevation.dark.${key}`, json.elevation.dark[key], dark[`--elevation-${key}`]);
}
for (const [key, value] of Object.entries(json.motion.duration)) same(`motion.duration.${key}`, value, light[`--duration-${key}`]);
same('typography.family.display', json.typography.family.display, light['--font-display']);
same('typography.family.displayWeight', json.typography.family.displayWeight, light['--font-display-weight']);

if (markdown) {
  console.log('| Pair | Theme | Against | Canvas | Raised | Sunken | Needs |\n|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const cells = r.perSurface.length === 3 ? r.perSurface.map(v => v.toFixed(2)) : [r.ratio.toFixed(2), '', ''];
    console.log(`| \`${r.label}\` | ${r.theme} | ${r.bg} | ${cells.join(' | ')} | ${r.min} |`);
  }
} else {
  for (const r of rows) {
    console.log(`${r.ratio >= r.min ? 'ok  ' : 'FAIL'} ${r.theme.padEnd(5)} ${r.label.padEnd(26)} on ${r.bg.padEnd(24)} ${r.ratio.toFixed(2)}:1 (min ${r.min})`);
  }
}
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(failures.length ? `${failures.length} failures` : `PASS: ${rows.length} contrast pairs and the JSON mirror`);
if (failures.length) process.exitCode = 1;
