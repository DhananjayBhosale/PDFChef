import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pathOf = name => join(root, name);
const read = name => readFileSync(pathOf(name), 'utf8');
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = name => hashBytes(readFileSync(pathOf(name)));
const requireMatch = (source, pattern, label) => {
  if (!pattern.test(source)) throw new Error(`missing ${label}`);
};
const forbid = (source, pattern, label) => {
  if (pattern.test(source)) throw new Error(`forbidden ${label}`);
};
const occurrenceCount = (source, pattern) => [...source.matchAll(pattern)].length;
const maskJavaCommentsAndLiterals = text => {
  let state = 'code';
  let escaped = false;
  let output = '';
  for (let index = 0; index < text.length; index++) {
    const current = text[index];
    const next = text[index + 1];
    if (state === 'code' && current === '/' && next === '/') {
      output += '  '; index++; state = 'line'; continue;
    }
    if (state === 'code' && current === '/' && next === '*') {
      output += '  '; index++; state = 'block'; continue;
    }
    if (state === 'line') {
      output += current === '\n' ? '\n' : ' ';
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        output += '  '; index++; state = 'code';
      } else output += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'code' && (current === '"' || current === "'")) {
      state = current === '"' ? 'string' : 'char';
      escaped = false;
      output += ' ';
      continue;
    }
    if (state === 'string' || state === 'char') {
      output += current === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
        state = 'code';
      }
      continue;
    }
    output += current;
  }
  return output;
};

const files = Object.freeze({
  gradle: 'android/app/build.gradle',
  activity: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java',
  plugin: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/legacy/AndroidLegacyInspectorPlugin.java',
  history: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/legacy/LegacyHistoryInspector.java',
  settings: 'android/app/src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/legacy/LegacySettingsInspector.java',
  historyTest: 'android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/legacy/LegacyHistoryInspectorTest.java',
  settingsTest: 'android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/legacy/LegacySettingsInspectorTest.java',
  contractTest: 'android/app/src/test/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/legacy/AndroidLegacyInspectorContractTest.java',
  t012: 'services/platform/android/legacyCompatibilityContracts.ts',
  t016: 'services/platform/android/androidLegacyInspector.ts',
});
const source = Object.fromEntries(Object.entries(files).map(([key, name]) => [key, read(name)]));

const frozen = Object.freeze({
  history: '4c664195be8dc66c121187a54dbd979d6fefe5d384d43c3d05d11296f57b3ebd',
  settings: 'bf4acfb0efd1e5199a6b540b43e7b99a55bbbf96b256ae49301998431d304827',
  t012: 'ba6d3576e82a196a4311c2946f540e90bcf730e91560e8f58549fddb37defa96',
  t016: '44af983eebb6b419f64e5890f0025188850370c45dc6e04aa9245e0403674909',
  fixtures: 'f51428fcd0d5a058ef359ec07eef8950888a6b6059d83bc7ef5ec7efbb669ca4',
});
for (const key of ['history', 'settings', 't012', 't016']) {
  const actual = hashFile(files[key]);
  if (actual !== frozen[key]) throw new Error(`${key.toUpperCase()} frozen source drift: ${actual}`);
}

const fixtureFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = join(directory, entry.name);
  if (entry.isDirectory()) return fixtureFiles(absolute);
  if (!entry.isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`unexpected fixture node: ${absolute}`);
  return [absolute];
});
const fixtureManifest = fixtureFiles(pathOf('tests/fixtures/android-legacy'))
  .map(absolute => relative(root, absolute).split(sep).join('/'))
  .sort()
  .map(name => `${hashFile(name)}  ${name}\n`)
  .join('');
const fixtureDigest = hashBytes(fixtureManifest);
if (fixtureDigest !== frozen.fixtures) throw new Error(`fixture-tree drift: ${fixtureDigest}`);

if (occurrenceCount(source.gradle, /implementation\s+['"]androidx\.datastore:datastore-preferences-proto:1\.2\.1['"]/g) !== 1) {
  throw new Error('expected exactly one pinned datastore-preferences-proto:1.2.1 dependency');
}
if (occurrenceCount(source.gradle, /implementation\s+['"]com\.google\.code\.gson:gson:2\.13\.2['"]/g) !== 1) {
  throw new Error('expected exactly one pinned gson:2.13.2 dependency');
}
forbid(source.gradle, /(?:datastore-preferences-proto|gson):(?:\+|latest|\[[^\]]+\]|\([^)]*\))/i, 'dynamic inspector dependency');
forbid(source.gradle, /org\.json|json-java|returnDefaultValues/i, 'org.json or masked JVM defaults');

requireMatch(source.plugin, /@CapacitorPlugin\s*\(\s*name\s*=\s*"AndroidLegacyInspector"\s*\)/, 'exact plugin annotation');
if (occurrenceCount(source.plugin, /@PluginMethod\b/g) !== 2) throw new Error('plugin must expose exactly two @PluginMethod methods');
for (const method of ['readHistory', 'readSettings']) {
  requireMatch(source.plugin, new RegExp(`@PluginMethod\\s+public\\s+void\\s+${method}\\s*\\(\\s*PluginCall\\s+call\\s*\\)`), `${method} promise surface`);
}
forbid(source.plugin, /@PluginMethod[\s\S]*?\b(?:write|save|delete|remove|update|mutate|clear|migrate|import|export|copy|move|rename|create|edit)\w*\s*\(/i, 'plugin mutation method');
requireMatch(source.plugin, /call\.reject\s*\(\s*"Legacy history could not be read\."\s*,\s*"LEGACY_HISTORY_READ_FAILED"\s*\)/, 'fixed history rejection');
requireMatch(source.plugin, /call\.reject\s*\(\s*"Legacy settings could not be read\."\s*,\s*"LEGACY_SETTINGS_READ_FAILED"\s*\)/, 'fixed settings rejection');
forbid(source.plugin, /reject\s*\([^)]*(?:getMessage|getCause|toString\s*\(|ignored\s*[,)])/s, 'exception detail leakage');

const activityCode = maskJavaCommentsAndLiterals(source.activity);
const shortRegistration = [...activityCode.matchAll(/\bregisterPlugin\s*\(\s*AndroidLegacyInspectorPlugin\s*\.\s*class\s*\)\s*;/g)];
const qualifiedRegistration = [...activityCode.matchAll(/\bregisterPlugin\s*\(\s*com\s*\.\s*dhananjaytech\s*\.\s*zenpdf_allpdftoolsinoneplace\s*\.\s*legacy\s*\.\s*AndroidLegacyInspectorPlugin\s*\.\s*class\s*\)\s*;/g)];
const registrations = [...shortRegistration, ...qualifiedRegistration];
if (registrations.length !== 1) throw new Error('plugin must use exactly one accepted inspector registration form');
if (shortRegistration.length === 1
    && occurrenceCount(activityCode, /^\s*import com\.dhananjaytech\.zenpdf_allpdftoolsinoneplace\.legacy\.AndroidLegacyInspectorPlugin;\s*$/gm) !== 1) {
  throw new Error('short inspector registration requires the exact inspector import');
}
if (occurrenceCount(activityCode, /\bregisterPlugin\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*AndroidLegacyInspectorPlugin\s*\.\s*class\s*\)/g) !== 1) {
  throw new Error('plugin must be registered exactly once');
}
const registration = registrations[0].index;
const writerRegistration = activityCode.indexOf(
  'registerPlugin(AndroidLegacySettingsWriterPlugin.class)');
const metadataRegistration = activityCode.indexOf(
  'registerPlugin(AndroidAppMetadataPlugin.class)');
const storageRegistration = activityCode.indexOf(
  'registerPlugin(AndroidStorageStatsPlugin.class)');
const documentsRegistration = activityCode.indexOf(
  'registerPlugin(AndroidDocumentsPlugin.class)');
const scannerRegistration = activityCode.indexOf(
  'registerPlugin(AndroidDocumentScannerPlugin.class)');
const superCreate = activityCode.search(/\bsuper\s*\.\s*onCreate\s*\(\s*savedInstanceState\s*\)/);
for (const plugin of ['AndroidLegacySettingsWriterPlugin', 'AndroidAppMetadataPlugin',
  'AndroidStorageStatsPlugin', 'AndroidDocumentsPlugin', 'AndroidDocumentScannerPlugin']) {
  if (occurrenceCount(activityCode,
    new RegExp(`\\bregisterPlugin\\s*\\(\\s*${plugin}\\s*\\.\\s*class\\s*\\)`, 'g')) !== 1) {
    throw new Error(`${plugin} must be registered exactly once`);
  }
}
if (!(registration >= 0 && registration < writerRegistration
    && writerRegistration < metadataRegistration
    && metadataRegistration < storageRegistration
    && storageRegistration < documentsRegistration
    && documentsRegistration < scannerRegistration && scannerRegistration < superCreate)) {
  throw new Error('accepted six-plugin order drifted');
}
if (occurrenceCount(activityCode, /\bregisterPlugin\s*\(/g) !== 6) {
  throw new Error('MainActivity must contain exactly the accepted six registrations');
}

for (const [label, inspector] of [['history', source.history], ['settings', source.settings]]) {
  forbid(inspector, /com\.getcapacitor|org\.json/, `${label} inspector platform/JSON coupling`);
  requireMatch(inspector, /public\s+JsonObject\s+read\s*\(\s*\)/, `${label} pure Gson read result`);
  requireMatch(inspector, /setStrictness\s*\(\s*Strictness\.STRICT\s*\)/, `${label} strict JSON parsing`);
  requireMatch(inspector, /setNestingLimit\s*\(/, `${label} JSON nesting bound`);
  requireMatch(inspector, /readBounded\s*\(/, `${label} bounded input read`);
  requireMatch(inspector, /if\s*\(\s*(?:count|n)\s*>\s*limit\s*\)/, `${label} exact byte ceiling`);
}
requireMatch(source.history, /LegacyHistoryInspector\s*\(\s*File\s+filesDir\s*,\s*long\s+maxBytes\s*,\s*int\s+maxSource\s*,\s*int\s+maxJsonNesting\s*,\s*int\s+maxFilesystemDepth\s*,\s*int\s+maxFilesystemNodes\s*\)/s, 'injectable history limits');
requireMatch(source.history, /sourceCount\+\+;\s*if\s*\(\s*sourceCount\s*>\s*maxSource\s*\)/, 'history source ceiling');
requireMatch(source.history, /depth\s*>\s*maxDepth\s*\|\|\s*\+\+globalNodes\[0\]\s*>\s*maxNodes/, 'history depth/global-node ceilings');
requireMatch(source.history, /LinkOption\.NOFOLLOW_LINKS/, 'history no-follow type checks');
requireMatch(source.history, /isSymlink\s*\(root\)|isSymlink\s*\(output\)|isSymlink\s*\(item\)/, 'history symlink rejection');
requireMatch(source.history, /idFrequency\.get\(record\.id\)\s*>\s*1/, 'all duplicate IDs invalid');
requireMatch(source.history, /reversed\(\)\.thenComparingInt\(record\s*->\s*record\.sourceOrder\)/, 'stable newest-first ordering');
requireMatch(source.history, /String\.format|"a1_"\s*\+\s*id/, 'opaque history refs');

requireMatch(source.settings, /LegacySettingsInspector\s*\(\s*File\s+filesDir\s*,\s*long\s+maxBytes\s*,\s*int\s+maxPreferences\s*,\s*int\s+maxJsonNesting\s*\)/s, 'injectable settings limits');
requireMatch(source.settings, /getPreferencesCount\(\)\s*>\s*maxPreferences/, 'settings preference ceiling');
requireMatch(source.settings, /PreferencesProto\.PreferenceMap\.parseFrom/, 'direct proto parsing');
requireMatch(source.settings, /hasLinkAncestor\s*\(source\)|contained\s*\(store\s*,\s*source\)/, 'settings containment and ancestor-link rejection');
const settingKeys = ['theme_mode', 'app_font_option', 'onboarding_completed', 'tool_usage_memory', 'savings_tally', 'tool_option_memory', 'last_privacy_line_index'];
for (const key of settingKeys) requireMatch(source.settings, new RegExp(`"${key}"`), `known setting key ${key}`);
for (const token of ['VALUECASE', 'BOOLEAN', 'INTEGER', 'STRING']) requireMatch(source.settings.toUpperCase(), new RegExp(token), `proto discriminator ${token}`);
for (const required of ['runs', 'followUps', 'bytesSaved', 'filesReduced']) requireMatch(source.settings, new RegExp(`"${required}"`), `encoded setting field ${required}`);
requireMatch(source.settings, /Pattern\.CASE_INSENSITIVE/, 'case-insensitive forbidden encoded keys');

for (const [label, inspector] of [['history', source.history], ['settings', source.settings]]) {
  const requiredKeys = label === 'history'
    ? ['health', 'sourceCount', 'invalidRecordCount', 'returnedCount', 'truncated', 'entries', 'kind', 'ref', 'displayName', 'toolId', 'createdAt', 'available', 'mimeType', 'sizeBytes', 'itemCount']
    : ['health', 'invalidValueCount', 'values'];
  for (const key of requiredKeys) requireMatch(inspector, new RegExp(`"${key}"`), `${label} output key ${key}`);
}

const stripCommentsAndLiterals = text => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n\r]*/g, ' ')
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");
const productionLegacy = stripCommentsAndLiterals([source.plugin, source.history, source.settings].join('\n'));
const mutationPatterns = [
  /new\s+(?:FileOutputStream|FileWriter|PrintWriter|RandomAccessFile)\b/,
  /Files\s*\.\s*(?:write|writeString|copy|move|delete|deleteIfExists|newOutputStream|createFile|createDirectory|createDirectories|setLastModifiedTime)\s*\(/,
  /FileChannel\s*\.\s*open\s*\(/,
  /\.\s*(?:delete|renameTo|mkdir|mkdirs|createNewFile|setWritable|setReadable|setExecutable|setLastModified)\s*\(/,
  /StandardOpenOption\s*\.\s*(?:WRITE|APPEND|CREATE|CREATE_NEW|TRUNCATE_EXISTING|DELETE_ON_CLOSE)\b/,
  /\bopenFileOutput\s*\(/,
  /\bSharedPreferences\s*\.\s*Editor\b|\b(?:DataStoreFactory|PreferenceDataStoreFactory)\b|\bpreferencesDataStore\b|\.\s*edit\s*\(/,
  /\b(?:Log\s*\.|printStackTrace\s*\(|getMessage\s*\(|getCause\s*\()/,
];
for (const pattern of mutationPatterns) forbid(productionLegacy, pattern, `production mutation/leak API ${pattern}`);

const requiredTests = [
  'missingBlankWhitespaceCorruptAndMalformedUtf8AreDistinctAndReadOnly',
  'countLadderZeroOneFiftyThreeHundredAndThreeHundredOneIsExactAndNonDestructive',
  'invalidRecordsBeforeAndBetweenValidRecordsRemainPartialAndDoNotSkipLaterEntries',
  'duplicateIdsInvalidateEveryAmbiguousRecord',
  'exactRawSchemaAndStrictNumericTypesAreEnforced',
  'addressLikeMetadataAndStoredNameEscapesNeverCross',
  'availableAndMissingFilesPreserveStoredSizeMimeAndExactWireKeys',
  'earlyFileRecordWithoutNewerOptionalFieldsRemainsVisible',
  'earlyCollectionWithoutNewerOptionalFieldsRemainsVisibleAndReadOnly',
  'collectionsUseStoredCountOrBoundedFallbackForPopulatedDirectory',
  'emptyAndMissingCollectionFallbackToOneWhileWrongTypesAreRecordLocalInvalid',
  'symlinkIndexRootOutputAndDescendantCannotEscapeOrTouchVictims',
  'filesystemDepthAndGlobalNodeLimitsAreDeterministicAndRecordLocal',
  'committedIndexWinsAndTemporaryIndexIsIgnoredAndUnchanged',
  'equalTimestampsPreserveSourceEncounterOrder',
  'byteSourceAndJsonNestingLimitsHaveExactBoundaries',
  'missingBlankCorruptAndSymlinkAncestorAreDistinctAndReadOnly',
  'allSevenKnownValuesRoundTripExactlyWithoutDefaultsOrReserialization',
  'absentKnownKeysNeverEmitRepositoryDefaults',
  'everyKnownWrongProtoTypeIsPartialAndPreservesOtherValidKeys',
  'toolUsageSavingsAndOptionsShapesMatchFrozenT012Contract',
  'strictMalformedJsonIsPartialAndKeepsOtherValidSettings',
  'unknownOnlyAndMixedUnknownMapsStayOkAndOmitUnknownKeys',
  'bytePreferenceAndJsonNestingLimitsHaveExactBoundaries',
  'pluginSurfaceIsExactlyTwoPublicPromiseReads',
  'inspectorsExposePureGsonReadResults',
  'registrationExpansionPreservesLegacyFirstAndSecond',
];
const tests = source.historyTest + source.settingsTest + source.contractTest;
for (const name of requiredTests) requireMatch(tests, new RegExp(`@Test\\s+public\\s+void\\s+${name}\\s*\\(`), `test ${name}`);
if (occurrenceCount(tests, /@Test\s+public\s+void\s+\w+\s*\(/g) !== 27) throw new Error('expected exactly 27 focused JUnit4 tests');
for (const marker of ['inspectTwiceUnchanged', 'snapshotTree', 'walkFileTree', 'NOFOLLOW_LINKS', 'readSymbolicLink', 'SHA-256', 'modifiedMillis', 'size', 'sha256', 'symlinkTarget']) {
  requireMatch(tests, new RegExp(marker), `preservation marker ${marker}`);
}
if (occurrenceCount(tests, /inspection\.call\s*\(\s*\)/g) !== 2) throw new Error('preservation oracle must perform exactly two reads');
for (const marker of ['PreferenceMap.newBuilder', 'putPreferences', 'setBoolean', 'setFloat', 'setInteger', 'setLong', 'setString', 'setStringSet', 'setDouble', 'setBytes']) {
  requireMatch(source.settingsTest, new RegExp(marker.replace('.', '\\.')), `real PreferencesProto fixture marker ${marker}`);
}
forbid(tests, /org\.json|JSONObject|returnDefaultValues/, 'org.json or masked test behavior');

const ownedHashes = [files.historyTest, files.settingsTest, files.contractTest, 'scripts/verify-android-legacy-inspector.mjs']
  .map(name => `${hashFile(name)}  ${name}`);
console.log(`PASS: Android legacy inspector static contract (${requiredTests.length} focused tests)`);
console.log(`FROZEN T012=${frozen.t012} T016=${frozen.t016} FIXTURES=${fixtureDigest}`);
for (const line of ownedHashes) console.log(`OWNED ${line}`);
console.log('RUNTIME_DISCOVERY: NOT_CHECKED');
console.log('PRODUCTION_RELEASE_READY: NO');
