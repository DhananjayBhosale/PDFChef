import { getLocale } from './i18n/core.ts';
/**
 * Dashboard tool search.
 *
 * A port of the Android app's `ui/app/ToolSearch.kt`: the same scoring weights, the same minimum
 * score, and the same stop words, unsupported phrases, token expansions and phrase expansions, so
 * a query typed on the web returns the same tools in the same order as the same query typed in the
 * app. Keep the two in step when either changes.
 */
import type { ToolCardData } from '../components/Tools/toolCatalog';

const MIN_SEARCH_SCORE = 90;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'into',
  'my',
  'of',
  'on',
  'pdf',
  'the',
  'to',
  'with',
]);

const DOMAIN_STOP_TERMS = new Set(['pdf']);

const UNSUPPORTED_SEARCH_PHRASES = new Set([
  'doc to pdf',
  'docs to pdf',
  'docx to pdf',
  'word to pdf',
  'word document to pdf',
]);

const QUERY_TOKEN_EXPANSIONS: Record<string, string[]> = {
  add: ['insert', 'create', 'make'],
  annotate: ['annotation', 'edit', 'note'],
  annotator: ['annotation', 'edit', 'note'],
  arrange: ['reorder', 'sort', 'organize'],
  blank: ['new', 'create', 'make'],
  big: ['large', 'size', 'compress'],
  bmp: ['image', 'picture', 'photo'],
  camera: ['scan', 'scanner', 'document'],
  comment: ['annotation', 'note', 'edit'],
  comments: ['annotation', 'notes', 'edit'],
  combine: ['merge', 'join'],
  convert: ['export', 'change'],
  converter: ['convert', 'export', 'change'],
  copy: ['duplicate', 'extract'],
  create: ['make', 'new', 'scan'],
  crop: ['image', 'photo', 'picture'],
  decrypt: ['unlock', 'password', 'remove'],
  doc: ['docx', 'word', 'document'],
  docs: ['docx', 'word', 'document'],
  document: ['doc', 'word', 'scan'],
  draw: ['edit', 'annotation', 'sign'],
  draft: ['watermark', 'stamp'],
  duplicate: ['copy', 'extract'],
  encrypt: ['protect', 'lock', 'password'],
  extract: ['pull', 'export', 'separate'],
  fields: ['form', 'flatten'],
  fill: ['form', 'flatten'],
  filesize: ['size', 'compress'],
  fix: ['repair', 'recover'],
  form: ['forms', 'fields', 'flatten'],
  forms: ['form', 'fields', 'flatten'],
  freehand: ['annotation', 'edit', 'draw'],
  gif: ['image', 'picture', 'photo'],
  heic: ['image', 'picture', 'photo'],
  highlight: ['annotation', 'edit', 'note'],
  highlighter: ['annotation', 'edit', 'note'],
  information: ['metadata', 'properties', 'info'],
  join: ['merge', 'combine'],
  jpeg: ['jpg', 'image', 'photo'],
  large: ['big', 'size', 'compress'],
  lock: ['protect', 'password', 'secure'],
  locked: ['protect', 'password', 'secure'],
  make: ['create', 'new'],
  mb: ['size', 'compress'],
  new: ['create', 'make', 'scan', 'document'],
  note: ['annotation', 'comment', 'edit'],
  notes: ['annotation', 'comments', 'edit'],
  number: ['page', 'pages', 'numbering'],
  numbers: ['page', 'pages', 'numbering'],
  ocr: ['text', 'extract', 'read', 'searchable'],
  page: ['pages'],
  pages: ['page'],
  permission: ['unlock', 'password', 'security'],
  permissions: ['unlock', 'password', 'security'],
  order: ['reorder', 'arrange', 'sort'],
  organise: ['organize', 'reorder', 'arrange', 'sort'],
  organize: ['reorder', 'arrange', 'sort'],
  passcode: ['password', 'protect', 'unlock'],
  password: ['protect', 'unlock', 'secure'],
  passwords: ['protect', 'unlock', 'secure'],
  photo: ['image', 'jpg', 'jpeg', 'picture'],
  photos: ['image', 'images', 'jpg', 'jpeg', 'picture'],
  picture: ['image', 'jpg', 'jpeg', 'photo'],
  pictures: ['image', 'images', 'jpg', 'jpeg', 'photo'],
  png: ['image', 'picture', 'photo'],
  properties: ['metadata', 'info', 'author', 'title'],
  protection: ['protect', 'secure', 'password'],
  read: ['text', 'extract', 'searchable'],
  recognise: ['ocr', 'text', 'read'],
  recognition: ['ocr', 'text', 'read'],
  recognize: ['ocr', 'text', 'read'],
  recover: ['repair', 'fix'],
  resize: ['size', 'compress', 'scale'],
  remove: ['delete', 'unlock', 'clear'],
  rotate: ['turn', 'landscape', 'portrait'],
  scan: ['scanner', 'camera', 'document', 'text'],
  scanned: ['scanner', 'camera', 'document', 'text'],
  scanner: ['scan', 'camera', 'document'],
  secure: ['protect', 'lock', 'password'],
  separate: ['split', 'extract'],
  shrink: ['compress', 'reduce', 'smaller', 'size'],
  small: ['compress', 'reduce', 'size'],
  smaller: ['compress', 'reduce', 'size'],
  sort: ['reorder', 'arrange', 'organize'],
  stamp: ['watermark'],
  svg: ['image', 'picture', 'photo'],
  text: ['extract', 'searchable', 'ocr'],
  tif: ['image', 'picture', 'photo'],
  tiff: ['image', 'picture', 'photo'],
  tiny: ['compress', 'reduce', 'size'],
  turn: ['rotate', 'landscape', 'portrait'],
  txt: ['text', 'extract', 'plain'],
  uneditable: ['flatten', 'locked', 'permanent'],
  unified: ['merge', 'combine', 'single'],
  unlock: ['password', 'remove', 'open'],
  webp: ['image', 'picture', 'photo'],
  word: ['doc', 'docx', 'document'],
  write: ['edit', 'annotation', 'note'],
};

const QUERY_PHRASE_EXPANSIONS: Record<string, string[]> = {
  'add page number': ['page numbers', 'numbering'],
  'add numbers': ['page numbers', 'numbering'],
  'add signature': ['sign pdf', 'signature'],
  'add text': ['edit pdf', 'annotation'],
  'add watermark': ['watermark pdf', 'stamp'],
  'add page numbers to pdf': ['page numbers', 'numbering'],
  'add pdf password': ['protect pdf', 'password protection'],
  'add text boxes': ['edit pdf', 'annotation'],
  'author name': ['metadata', 'document properties'],
  'blank pdf': ['make pdf', 'new pdf', 'create pdf'],
  'change order': ['reorder pages', 'arrange pages'],
  'change pdf document information': ['metadata', 'document properties'],
  'change title': ['metadata', 'document properties'],
  'clear metadata': ['metadata', 'document properties'],
  'combine files': ['merge pdf', 'join pdf'],
  'combine pdf': ['merge pdf', 'join pdf'],
  'compare pdfs': ['compare pdf', 'compare summary'],
  'convert image files to pdf': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'convert pdf to text': ['extract text', 'pdf to text', 'ocr'],
  'convert photos to pdf': ['photo to pdf', 'image to pdf'],
  'convert pictures to pdf': ['picture to pdf', 'image to pdf'],
  'create document': ['make pdf', 'new pdf', 'document scanner'],
  'create file': ['make pdf', 'new pdf', 'create pdf'],
  'create new pdf': ['make pdf', 'new pdf', 'document scanner'],
  'create pdf': ['make pdf', 'new pdf', 'image to pdf', 'document scanner'],
  'create pdf with a camera': ['make pdf', 'document scanner', 'camera to pdf'],
  'create pdf with camera': ['make pdf', 'document scanner', 'camera to pdf'],
  'create pdf from image': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'create pdf from images': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'create pdf from photo': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'create pdf from photos': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'crop photo': ['image to pdf', 'photo to pdf'],
  'crop picture': ['image to pdf', 'photo to pdf'],
  'convert to image': ['pdf to image', 'pdf to jpg'],
  'convert to jpg': ['pdf to image', 'pdf to jpg'],
  'convert to png': ['pdf to image', 'pdf to jpg', 'png'],
  'convert to word': ['pdf to word', 'pdf to doc', 'docx'],
  'delete page': ['delete pages', 'remove pages'],
  'document info': ['metadata', 'properties'],
  'document information': ['metadata', 'properties'],
  'document properties': ['metadata', 'properties'],
  'draw on pdf': ['edit pdf', 'annotation'],
  'edit author': ['metadata', 'author', 'document properties'],
  'edit title': ['metadata', 'title', 'document properties'],
  'export image': ['pdf to image', 'pdf to jpg'],
  'export pages as images': ['pdf to image', 'pdf to jpg'],
  'export text': ['extract text', 'searchable text'],
  'fill and sign': ['sign pdf', 'signature'],
  'fill form': ['flatten pdf', 'form fields'],
  'fix pdf': ['repair pdf'],
  'form fields': ['flatten pdf'],
  'heic to pdf': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'image to pdf': ['jpg to pdf', 'photo to pdf'],
  'image files to pdf': ['jpg to pdf', 'image to pdf', 'photo to pdf'],
  'images to pdf': ['jpg to pdf', 'image to pdf', 'photo to pdf'],
  'insert page numbers': ['page numbers', 'numbering'],
  'join files': ['merge pdf', 'combine pdf'],
  'join pdf': ['merge pdf', 'combine pdf'],
  'lock pdf': ['protect pdf', 'password protection'],
  'make smaller': ['compress pdf', 'reduce file size', 'shrink pdf'],
  'make tiny': ['compress pdf', 'reduce file size', 'shrink pdf'],
  'make pdf from image': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'make pdf from images': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'make pdf from photo': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'make pdf from photos': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'make new pdf': ['make pdf', 'new pdf', 'document scanner'],
  'mobile scanner': ['make pdf', 'document scanner', 'scan to pdf'],
  'move pages': ['reorder pages', 'arrange pages'],
  'new document': ['make pdf', 'new pdf', 'document scanner'],
  'new file': ['make pdf', 'new pdf', 'create pdf'],
  'new pdf': ['make pdf', 'create pdf', 'document scanner'],
  'organise pdf': ['organize pdf', 'reorder pages', 'arrange pages'],
  'organize pdf': ['reorder pages', 'arrange pages'],
  'open password': ['unlock pdf', 'remove password'],
  'password protection': ['protect pdf', 'secure pdf'],
  'pdf creator': ['make pdf', 'new pdf'],
  'pdf scanner': ['make pdf', 'document scanner', 'scan to pdf'],
  'pdf to images': ['pdf to image', 'pdf to jpg'],
  'pdf to text': ['extract text', 'ocr', 'searchable text'],
  'pdf maker': ['make pdf', 'new pdf'],
  'photo to pdf': ['jpg to pdf', 'image to pdf'],
  'photos to pdf': ['jpg to pdf', 'image to pdf', 'photo to pdf'],
  'png to pdf': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
  'pull pages': ['extract pages'],
  'read text': ['extract text', 'searchable text'],
  'reduce file': ['compress pdf', 'reduce file size'],
  'reduce filesize': ['compress pdf', 'reduce file size'],
  'reduce mb': ['compress pdf', 'reduce file size'],
  'reduce pdf size': ['compress pdf', 'reduce file size', 'shrink pdf'],
  'remove encryption': ['unlock pdf', 'remove password'],
  'remove metadata': ['metadata', 'document properties'],
  'remove pdf metadata': ['metadata', 'document properties'],
  'remove pdf password': ['unlock pdf', 'remove known password'],
  'remove password': ['unlock pdf', 'remove known password'],
  'remove pages': ['delete pages'],
  'rearrange pdf pages': ['reorder pages', 'arrange pages'],
  'recognize text': ['ocr', 'extract text', 'searchable text'],
  'rotate document': ['rotate pages', 'turn pages'],
  'save one page': ['extract pages', 'copy pages'],
  'scan paper': ['make pdf', 'document scanner'],
  'scan document': ['make pdf', 'document scanner'],
  'scan documents': ['make pdf', 'document scanner'],
  'scan to pdf': ['make pdf', 'document scanner', 'paper to pdf'],
  'scan text': ['extract text', 'ocr', 'searchable text'],
  'set password': ['protect pdf', 'password protection'],
  'shrink file': ['compress pdf', 'reduce file size'],
  'sign document': ['sign pdf', 'signature'],
  'split file': ['split pdf', 'separate pages'],
  'stamp pdf': ['watermark pdf'],
  'text recognition': ['ocr', 'extract text', 'searchable text'],
  'to docs': ['pdf to word', 'pdf to doc', 'docx'],
  'to word': ['pdf to word', 'pdf to doc', 'docx'],
  'web optimize pdf': ['compress pdf', 'optimize pdf'],
  'webp to pdf': ['image to pdf', 'jpg to pdf', 'photo to pdf'],
};

export const normalizeSearchText = (value: string): string =>
  value
    .toLocaleLowerCase(getLocale())
    .replace(/&/g, ' and ')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const tokenizeSearchText = (value: string): string[] =>
  normalizeSearchText(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));

const levenshteinDistanceAtMost = (left: string, right: string, maxDistance: number): boolean => {
  if (Math.abs(left.length - right.length) > maxDistance) return false;

  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  let current = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    let rowMin = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
      rowMin = Math.min(rowMin, current[rightIndex]);
    }
    if (rowMin > maxDistance) return false;
    const nextPrevious = previous;
    previous = current;
    current = nextPrevious;
  }

  return previous[right.length] <= maxDistance;
};

const fuzzyTokenMatch = (queryToken: string, indexedToken: string): boolean => {
  if (queryToken.length < 4 || indexedToken.length < 4) return false;
  if (indexedToken.startsWith(queryToken) || queryToken.startsWith(indexedToken)) {
    return Math.min(queryToken.length, indexedToken.length) >= 4;
  }
  const maxDistance = queryToken.length >= 7 || indexedToken.length >= 7 ? 2 : 1;
  return levenshteinDistanceAtMost(queryToken, indexedToken, maxDistance);
};

interface ToolSearchProfile {
  title: string;
  subtitle: string;
  terms: Set<string>;
  tokens: Set<string>;
  priorityTerms: Set<string>;
  priorityTokens: Set<string>;
}

const profileCache = new WeakMap<ToolCardData, { locale: string; profile: ToolSearchProfile }>();

const searchProfileFor = (tool: ToolCardData): ToolSearchProfile => {
  const cached = profileCache.get(tool);
  if (cached?.locale === getLocale()) return cached.profile;

  const title = normalizeSearchText(tool.name);
  const subtitle = normalizeSearchText(tool.description);
  const aliases = (tool.keywords ?? []).map(normalizeSearchText);

  // The Android profile also indexes the tool's storage slug; the route path is its web analogue.
  // `androidSubtitle` is included so a phrase from the app's own copy still finds the tool here
  // even where the browser build describes itself differently.
  const baseTerms = new Set<string>([
    title,
    subtitle,
    normalizeSearchText(tool.androidSubtitle ?? ''),
    normalizeSearchText(tool.category),
    normalizeSearchText(tool.path),
    ...aliases,
  ]);
  const terms = new Set(
    [...baseTerms].filter((term) => term.length > 0 && !DOMAIN_STOP_TERMS.has(term)),
  );
  const tokens = new Set([...terms].flatMap(tokenizeSearchText));
  const priorityTerms = new Set([...aliases, title]);
  const priorityTokens = new Set([...priorityTerms].flatMap(tokenizeSearchText));

  const profile: ToolSearchProfile = { title, subtitle, terms, tokens, priorityTerms, priorityTokens };
  profileCache.set(tool, { locale: getLocale(), profile });
  return profile;
};

const expandQueryTokens = (tokens: string[]): Set<string> => {
  const expanded = new Set<string>();
  tokens.forEach((token) => {
    expanded.add(token);
    QUERY_TOKEN_EXPANSIONS[token]?.forEach((value) => expanded.add(value));
  });
  return expanded;
};

const expandQueryPhrases = (normalizedQuery: string, tokens: string[]): Set<string> => {
  const expanded = new Set<string>([normalizedQuery]);
  Object.entries(QUERY_PHRASE_EXPANSIONS).forEach(([trigger, expansions]) => {
    if (normalizedQuery.includes(trigger)) expansions.forEach((value) => expanded.add(value));
  });
  tokens.forEach((token) => {
    QUERY_TOKEN_EXPANSIONS[token]?.forEach((value) => expanded.add(value));
  });
  return new Set([...expanded].map(normalizeSearchText).filter((value) => value.length > 0));
};

export const toolSearchScore = (tool: ToolCardData, query: string): number => {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return 1;
  if (UNSUPPORTED_SEARCH_PHRASES.has(normalizedQuery)) return 0;

  const queryTokens = tokenizeSearchText(normalizedQuery);
  if (queryTokens.length === 0) return 0;

  const profile = searchProfileFor(tool);
  const expandedTokens = expandQueryTokens(queryTokens);
  const expandedPhrases = expandQueryPhrases(normalizedQuery, queryTokens);
  const terms = [...profile.terms];

  let score = 0;

  if (profile.title === normalizedQuery) score += 900;
  if (profile.title.startsWith(normalizedQuery)) score += 650;
  if (profile.title.includes(normalizedQuery)) score += 500;
  if (profile.subtitle.includes(normalizedQuery)) score += 300;

  if (terms.some((term) => term === normalizedQuery)) score += 620;
  if (terms.some((term) => term.startsWith(normalizedQuery))) score += 480;
  if (terms.some((term) => term.includes(normalizedQuery))) score += 360;

  let phraseHits = 0;
  expandedPhrases.forEach((phrase) => {
    if (terms.some((term) => term === phrase || term.includes(phrase))) phraseHits += 1;
  });
  score += phraseHits * 420;

  const exactOriginalTokenHits = queryTokens.filter(
    (token) => profile.tokens.has(token) || terms.some((term) => term.includes(token)),
  ).length;
  const fuzzyOriginalTokenHits = queryTokens.filter(
    (token) => !profile.tokens.has(token) && [...profile.tokens].some((indexed) => fuzzyTokenMatch(token, indexed)),
  ).length;
  const expandedTokenHits = [...expandedTokens]
    .filter((token) => !queryTokens.includes(token))
    .filter((token) => profile.tokens.has(token) || terms.some((term) => term.includes(token))).length;

  score += exactOriginalTokenHits * 130;
  score += fuzzyOriginalTokenHits * 95;
  score += expandedTokenHits * 70;

  if (queryTokens.length > 0 && exactOriginalTokenHits === queryTokens.length) score += 180;
  if ([...expandedPhrases].some((phrase) => profile.priorityTerms.has(phrase))) score += 260;
  if ([...expandedTokens].some((token) => profile.priorityTokens.has(token))) score += 160;

  return score;
};

export const matchesToolSearchQuery = (tool: ToolCardData, query: string): boolean => {
  if (query.trim().length === 0) return true;
  return toolSearchScore(tool, query) >= MIN_SEARCH_SCORE;
};
