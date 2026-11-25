// English first: gives every locale catalog and draft the keys it lacks, with the English text.
//
//   node scripts/sync-locale-fallbacks.mjs            insert missing keys that pending.ts lists
//   node scripts/sync-locale-fallbacks.mjs --prune    also remove keys that en-US.ts no longer has
//   node scripts/sync-locale-fallbacks.mjs --check    change nothing; exit 1 if anything would change
//   node scripts/sync-locale-fallbacks.mjs --mirror-drafts   rewrite each draft as a copy of its locale catalog
//
// A missing key must be listed in services/i18n/pending.ts, and a listed key must still carry the
// English fallback in every locale; a translated key comes off the list. See localization/README.md.
import { resolve } from 'node:path';
import { syncLocaleFallbacks } from './lib/locale-fallbacks.mjs';

const args = process.argv.slice(2);
const root = resolve(args.find(arg => arg.startsWith('--root='))?.slice(7) ?? resolve(import.meta.dirname, '..'));
const check = args.includes('--check');
const result = await syncLocaleFallbacks({ root, prune: args.includes('--prune'), check, mirrorDrafts: args.includes('--mirror-drafts') });

for (const change of result.changes) {
  const parts = [];
  if (change.inserted.length) parts.push(`${check ? 'would add' : 'added'} ${change.inserted.length}`);
  if (change.removed.length) parts.push(`${check ? 'would remove' : 'removed'} ${change.removed.length}`);
  console.log(`${change.label}: ${parts.join(', ')}`);
}
for (const failure of result.failures) console.error(`FAIL ${failure}`);
console.log(`pending keys: ${result.pending}; files ${check ? 'to change' : 'written'}: ${check ? result.changes.length : result.wrote}`);
if (result.failures.length || (check && result.changes.length)) process.exitCode = 1;
