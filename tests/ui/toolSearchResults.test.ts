import assert from 'node:assert/strict';
import test from 'node:test';
import { tools } from '../../components/Tools/toolCatalog.ts';
import { matchesToolSearchQuery, toolSearchScore } from '../../services/toolSearch.ts';

const search = (query: string) => tools
  .filter((tool) => matchesToolSearchQuery(tool, query))
  .sort((left, right) => toolSearchScore(right, query) - toolSearchScore(left, query))
  .map((tool) => tool.path);

test('a search lists the tool it names, not tools that merely contain the letters', () => {
  // "rotate" used to list the converters, whose descriptions say "Turn … into".
  assert.deepEqual(search('rotate'), ['/rotate']);
  // "word" used to list Protect and Unlock because "password" contains it.
  assert.ok(!search('word').includes('/protect'));
  assert.ok(!search('word').includes('/unlock'));
  // Typing part of a word still finds it.
  assert.equal(search('merg')[0], '/merge');
});

test('Word to PDF can be found by name', () => {
  // The search once treated these as unsupported and returned nothing at all.
  assert.equal(search('word to pdf')[0], '/word-to-pdf');
  assert.equal(search('docx to pdf')[0], '/word-to-pdf');
});

test('a word that names no tool lists nothing, and two letters match only whole words', () => {
  // "zzzz-no-tool" listed six tools: "no" started "notes", "tool" started "tools".
  assert.deepEqual(search('zzzz-no-tool'), []);
  assert.deepEqual(search('no'), []);
  // The start of a tool's own name still counts at two letters.
  assert.equal(search('ro')[0], '/rotate');
  // A synonym found only in descriptions no longer lists every tool that says "document".
  assert.ok(search('scan').length <= 4);
  assert.equal(search('scan')[0], '/make-pdf');
  // "numbers" means "page" too, but that must not list every page tool.
  assert.deepEqual(search('page numbers'), ['/page-numbers']);
  // A phrase the app knows still finds its tool.
  assert.deepEqual(search('make smaller'), ['/compress']);
  assert.equal(search('remove password')[0], '/unlock');
});
