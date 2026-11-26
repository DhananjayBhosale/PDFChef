import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Small wording, direction and state details in single tools.
// Fix round 2 (output/web/ui-redesign/audit/prompts/final-fix-2.md): the contracts behind each item.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('item 10: small fixes from the reports', () => {
  // desktop-r9-04: a rejected range is not also told to press Select.
  assert.match(read('components/UI/PageRangeSelector.tsx'), /const pendingLine = pending && !error;/);
  // desktop-r9-06: a colour code reads left to right in Arabic.
  assert.match(read('components/Tools/BusinessDocumentBuilder.tsx'), /dir="ltr"\n\s+spellCheck=\{false\}\n\s+aria-label=\{t\("business-document-builder\.colour\.code\.3a26d6"\)\}/);
  // fable K11: "Edit PDF Beta", not "Edit PDFBETA".
  assert.match(read('components/Tool/ToolTop.tsx'), /<span className="sr-only">\{` \$\{betaWord\}`\}<\/span>/);
  // fable C9: Compress words a locked file as every other tool does.
  assert.match(read('components/Tools/CompressPDF.tsx'), /\? t\('error\.pdfLocked'\)/);
  // fable C5: Sign keeps a drawing while another tab is looked at.
  assert.match(read('components/Tools/SignPDF.tsx'), /drawnSnapshotRef\.current = canvas\.toDataURL\('image\/png'\)/);
});
