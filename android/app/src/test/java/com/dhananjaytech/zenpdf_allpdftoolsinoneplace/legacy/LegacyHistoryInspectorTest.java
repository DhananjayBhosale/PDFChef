package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.legacy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class LegacyHistoryInspectorTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void missingBlankWhitespaceCorruptAndMalformedUtf8AreDistinctAndReadOnly()
            throws Exception {
        CaseRoot missing = fresh("history-missing");
        LegacyInspectorTestSupport.assertHistory(inspect(missing), "missing", 0, 0, 0, false);

        for (byte[] blank : List.of(new byte[0], " \t\r\n\u2003".getBytes(StandardCharsets.UTF_8))) {
            CaseRoot item = fresh("history-blank");
            writeIndex(item, blank);
            LegacyInspectorTestSupport.assertHistory(inspect(item), "blank", 0, 0, 0, false);
        }
        for (byte[] corrupt : List.of("{}".getBytes(StandardCharsets.UTF_8),
                "[{".getBytes(StandardCharsets.UTF_8),
                "[] trailing".getBytes(StandardCharsets.UTF_8), new byte[] {(byte) 0xc3, 0x28})) {
            CaseRoot item = fresh("history-corrupt");
            writeIndex(item, corrupt);
            LegacyInspectorTestSupport.assertHistory(inspect(item), "corrupt", 0, 0, 0, false);
        }

        CaseRoot danglingIndex = fresh("history-dangling-index");
        Files.createSymbolicLink(danglingIndex.files.resolve("processed_index.json"),
                danglingIndex.outer.resolve("missing-index-target.json"));
        LegacyInspectorTestSupport.assertHistory(inspect(danglingIndex),
                "corrupt", 0, 0, 0, false);
    }

    @Test public void countLadderZeroOneFiftyThreeHundredAndThreeHundredOneIsExactAndNonDestructive()
            throws Exception {
        for (int count : new int[] {0, 1, 50, 300, 301}) {
            CaseRoot item = fresh("history-count-" + count);
            writeIndex(item, records(count));
            JsonObject result = inspect(item);
            int returned = Math.min(count, 300);
            LegacyInspectorTestSupport.assertHistory(result, "ok", count, 0, returned, count > 300);
            if (returned > 0) {
                assertEquals("a1_" + count, entry(result, 0).get("ref").getAsString());
                assertEquals("a1_" + (count - returned + 1),
                        entry(result, returned - 1).get("ref").getAsString());
            }
        }
    }

    @Test public void invalidRecordsBeforeAndBetweenValidRecordsRemainPartialAndDoNotSkipLaterEntries()
            throws Exception {
        CaseRoot item = fresh("history-local-invalid");
        String json = "[true," + record(1, "one.pdf", "ONE", 10, 10, "one.pdf", false, null, null)
                + ",{" + "\"id\":2" + "},"
                + record(3, "three.pdf", "THREE", 30, 30, "three.pdf", false, null, null)
                + ",null," + record(5, "five.pdf", "FIVE", 50, 50, "five.pdf", false, null, null) + "]";
        writeIndex(item, json);
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "partial_invalid", 6, 3, 3, false);
        assertRefs(result, "a1_5", "a1_3", "a1_1");
    }

    @Test public void duplicateIdsInvalidateEveryAmbiguousRecord() throws Exception {
        CaseRoot item = fresh("history-duplicates");
        String invalidBeforeId = record(7, "first.pdf", "FIRST", 1, 1, "first.pdf", false, null, null)
                .replace("{\"id\":7", "{\"inventedBeforeId\":true,\"id\":7");
        writeIndex(item, "[" + invalidBeforeId
                + "," + record(8, "unique.pdf", "UNIQUE", 1, 2, "unique.pdf", false, null, null)
                + "," + record(7, "second.pdf", "SECOND", 1, 3, "second.pdf", false, null, null) + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "partial_invalid", 3, 2, 1, false);
        assertRefs(result, "a1_8");
    }

    @Test public void exactRawSchemaAndStrictNumericTypesAreEnforced() throws Exception {
        CaseRoot item = fresh("history-schema-numbers");
        List<String> invalid = new ArrayList<>();
        invalid.add(record(1, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"id\":1", "\"id\":\"1\""));
        invalid.add(record(2, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"sizeBytes\":1", "\"sizeBytes\":-1"));
        invalid.add(record(3, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"createdAtMillis\":1", "\"createdAtMillis\":1.5"));
        invalid.add(record(4, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"sizeBytes\":1", "\"sizeBytes\":9007199254740992"));
        invalid.add(record(5, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"isDirectory\":false", "\"isDirectory\":0"));
        invalid.add(record(6, "x", "X", 1, 1, "x", false, null, null)
                .replace("}", ",\"outputExists\":true}"));
        invalid.add(record(7, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"displayName\":\"x\"", "\"displayName\":\"x\",\"displayName\":\"y\""));
        invalid.add(record(8, "x", "X", 1, 1, "x", true, 0, null));
        invalid.add(record(9, "x", "X", 1, 1, "x", true, null, null)
                .replace("\"isDirectory\":true", "\"isDirectory\":true,\"itemCount\":1.1"));
        invalid.add(record(10, "x", "X", 1, 1, "x", false, null, null)
                .replace("\"displayName\":\"x\",", ""));
        String valid = record(20, "valid.pdf", "VALID", 0, 0, "valid.pdf", false, null, null);
        writeIndex(item, "[" + String.join(",", invalid) + "," + valid + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "partial_invalid", 11, 10, 1, false);
        assertRefs(result, "a1_20");

        CaseRoot leadingZero = fresh("history-leading-zero");
        writeIndex(leadingZero, "[" + valid.replace("\"id\":20", "\"id\":020") + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(leadingZero), "corrupt", 0, 0, 0, false);
    }

    @Test public void addressLikeMetadataAndStoredNameEscapesNeverCross() throws Exception {
        CaseRoot item = fresh("history-addresses");
        List<String> records = List.of(
                record(1, "../private", "ONE", 1, 1, "one", false, null, null),
                record(2, "a/b", "TWO", 1, 1, "two", false, null, null),
                record(3, "content:secret", "THREE", 1, 1, "three", false, null, null),
                record(4, "four", "../TOOL", 1, 1, "four", false, null, null),
                record(5, "five", "FIVE", 1, 1, "../five", false, null, null),
                record(6, "six", "SIX", 1, 1, "dir\\six", false, null, null),
                record(7, "safe.pdf", "SAFE", 1, 1, "safe.pdf", false, null, null));
        writeIndex(item, "[" + String.join(",", records) + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "partial_invalid", 7, 6, 1, false);
        assertRefs(result, "a1_7");
    }

    @Test public void availableAndMissingFilesPreserveStoredSizeMimeAndExactWireKeys()
            throws Exception {
        CaseRoot item = fresh("history-file-wire");
        Files.createDirectories(item.files.resolve("processed"));
        Files.write(item.files.resolve("processed/present.pdf"), new byte[] {1, 2, 3});
        writeIndex(item, "[" + record(1, "present.pdf", "MERGE", 999, 2, "present.pdf", false,
                null, "application/pdf") + "," + record(2, "missing.pdf", "SPLIT", 777, 1,
                "missing.pdf", false, null, null) + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "ok", 2, 0, 2, false);
        JsonObject present = entry(result, 0), missing = entry(result, 1);
        for (JsonObject value : List.of(present, missing)) {
            LegacyInspectorTestSupport.assertExactKeys(value, "kind", "ref", "displayName", "toolId",
                    "createdAt", "available", "mimeType", "sizeBytes");
            assertEquals("file", value.get("kind").getAsString());
        }
        assertTrue(present.get("available").getAsBoolean());
        assertEquals(999, present.get("sizeBytes").getAsInt());
        assertEquals("application/pdf", present.get("mimeType").getAsString());
        assertFalse(missing.get("available").getAsBoolean());
        assertEquals(777, missing.get("sizeBytes").getAsInt());
        assertEquals(JsonNull.INSTANCE, missing.get("mimeType"));
    }

    @Test public void earlyFileRecordWithoutNewerOptionalFieldsRemainsVisible() throws Exception {
        CaseRoot item = fresh("history-early-file");
        Files.createDirectories(item.files.resolve("processed"));
        Files.write(item.files.resolve("processed/early.pdf"), new byte[] {1, 2, 3});
        String early = record(7, "early.pdf", "Create PDF", 3, 9,
                "early.pdf", false, null, null)
                .replace(",\"isDirectory\":false", "");
        writeIndex(item, "[" + early + "]");

        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "ok", 1, 0, 1, false);
        JsonObject visible = entry(result, 0);
        assertEquals("file", visible.get("kind").getAsString());
        assertEquals("a1_7", visible.get("ref").getAsString());
        assertEquals("early.pdf", visible.get("displayName").getAsString());
        assertEquals(JsonNull.INSTANCE, visible.get("mimeType"));
    }

    @Test public void earlyCollectionWithoutNewerOptionalFieldsRemainsVisibleAndReadOnly()
            throws Exception {
        CaseRoot item = fresh("history-early-collection");
        Files.createDirectories(item.files.resolve("processed/album"));
        Files.write(item.files.resolve("processed/album/page.pdf"), new byte[] {1, 2, 3});
        String early = record(8, "Album", "PDF to Image", 3, 10,
                "album", true, null, null)
                .replace(",\"isDirectory\":true", "");
        writeIndex(item, "[" + early + "]");

        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "ok", 1, 0, 1, false);
        JsonObject visible = entry(result, 0);
        assertEquals("collection", visible.get("kind").getAsString());
        assertEquals("a1_8", visible.get("ref").getAsString());
        assertEquals(1, visible.get("itemCount").getAsInt());
    }

    @Test public void collectionsUseStoredCountOrBoundedFallbackForPopulatedDirectory()
            throws Exception {
        CaseRoot item = fresh("history-collections-populated");
        Files.createDirectories(item.files.resolve("processed/stored"));
        Files.write(item.files.resolve("processed/stored/ignored.bin"), new byte[] {1});
        Path storedCountVictim = item.outer.resolve("stored-count-victim.bin");
        Files.write(storedCountVictim, new byte[] {9, 8, 7});
        Files.createSymbolicLink(item.files.resolve("processed/stored/unvisited-link.bin"),
                storedCountVictim);
        Files.createDirectories(item.files.resolve("processed/derived/nested"));
        Files.write(item.files.resolve("processed/derived/a.bin"), new byte[] {1});
        Files.write(item.files.resolve("processed/derived/nested/b.bin"), new byte[] {2});
        writeIndex(item, "[" + record(1, "stored", "COLLECT", 0, 2, "stored", true, 77, null)
                + "," + record(2, "derived", "COLLECT", 0, 1, "derived", true, null, null) + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "ok", 2, 0, 2, false);
        assertEquals(77, entry(result, 0).get("itemCount").getAsInt());
        assertEquals(2, entry(result, 1).get("itemCount").getAsInt());
        for (int index = 0; index < 2; index++) {
            LegacyInspectorTestSupport.assertExactKeys(entry(result, index), "kind", "ref", "displayName",
                    "toolId", "createdAt", "available", "itemCount");
            assertEquals("collection", entry(result, index).get("kind").getAsString());
            assertTrue(entry(result, index).get("available").getAsBoolean());
        }
    }

    @Test public void emptyAndMissingCollectionFallbackToOneWhileWrongTypesAreRecordLocalInvalid()
            throws Exception {
        CaseRoot item = fresh("history-collection-fallback");
        Files.createDirectories(item.files.resolve("processed/empty"));
        Files.write(item.files.resolve("processed/wrong-collection"), new byte[] {1});
        Files.createDirectories(item.files.resolve("processed/wrong-file"));
        writeIndex(item, "[" + record(1, "empty", "COLLECT", 0, 4, "empty", true, null, null)
                + "," + record(2, "missing", "COLLECT", 0, 3, "missing", true, null, null)
                + "," + record(3, "wrong collection", "COLLECT", 0, 2, "wrong-collection", true, null, null)
                + "," + record(4, "wrong file", "FILE", 4, 1, "wrong-file", false, null, null) + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "partial_invalid", 4, 2, 2, false);
        assertRefs(result, "a1_1", "a1_2");
        assertEquals(1, entry(result, 0).get("itemCount").getAsInt());
        assertEquals(1, entry(result, 1).get("itemCount").getAsInt());
        assertTrue(entry(result, 0).get("available").getAsBoolean());
        assertFalse(entry(result, 1).get("available").getAsBoolean());
    }

    @Test public void symlinkIndexRootOutputAndDescendantCannotEscapeOrTouchVictims() throws Exception {
        CaseRoot indexLink = fresh("history-link-index");
        Path victimIndex = indexLink.outer.resolve("victim-index.json");
        Files.write(victimIndex, "[]".getBytes(StandardCharsets.UTF_8));
        Files.createSymbolicLink(indexLink.files.resolve("processed_index.json"), victimIndex);
        LegacyInspectorTestSupport.assertHistory(inspect(indexLink), "corrupt", 0, 0, 0, false);

        CaseRoot rootLink = fresh("history-link-root");
        Path victimRoot = Files.createDirectories(rootLink.outer.resolve("victim-root"));
        Files.write(victimRoot.resolve("file.pdf"), new byte[] {9});
        Files.createSymbolicLink(rootLink.files.resolve("processed"), victimRoot);
        writeIndex(rootLink, "[" + record(1, "file", "FILE", 1, 1, "file.pdf", false, null, null) + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(rootLink), "partial_invalid", 1, 1, 0, false);

        CaseRoot outputLink = fresh("history-link-output");
        Files.createDirectories(outputLink.files.resolve("processed"));
        Path victimFile = outputLink.outer.resolve("victim.pdf");
        Files.write(victimFile, new byte[] {8});
        Files.createSymbolicLink(outputLink.files.resolve("processed/out.pdf"), victimFile);
        writeIndex(outputLink, "[" + record(1, "out", "FILE", 1, 1, "out.pdf", false, null, null) + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(outputLink), "partial_invalid", 1, 1, 0, false);

        CaseRoot descendant = fresh("history-link-descendant");
        Files.createDirectories(descendant.files.resolve("processed/album"));
        Path victimChild = descendant.outer.resolve("victim-child.pdf");
        Files.write(victimChild, new byte[] {7});
        Files.createSymbolicLink(descendant.files.resolve("processed/album/link.pdf"), victimChild);
        writeIndex(descendant, "[" + record(1, "album", "COLLECT", 0, 1, "album", true, null, null) + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(descendant), "partial_invalid", 1, 1, 0, false);
    }

    @Test public void filesystemDepthAndGlobalNodeLimitsAreDeterministicAndRecordLocal()
            throws Exception {
        CaseRoot depth = fresh("history-depth-limit");
        Files.createDirectories(depth.files.resolve("processed/deep"));
        Files.write(depth.files.resolve("processed/deep/file"), new byte[] {1});
        writeIndex(depth, "[" + record(1, "deep", "COLLECT", 0, 1, "deep", true, null, null) + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(depth, Long.MAX_VALUE, 10, 10, 1, 10),
                "ok", 1, 0, 1, false);
        LegacyInspectorTestSupport.assertHistory(inspect(depth, Long.MAX_VALUE, 10, 10, 0, 10),
                "partial_invalid", 1, 1, 0, false);

        CaseRoot nodes = fresh("history-node-limit");
        Files.createDirectories(nodes.files.resolve("processed/a"));
        Files.createDirectories(nodes.files.resolve("processed/b"));
        writeIndex(nodes, "[" + record(1, "a", "COLLECT", 0, 2, "a", true, null, null)
                + "," + record(2, "b", "COLLECT", 0, 1, "b", true, null, null) + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(nodes, Long.MAX_VALUE, 10, 10, 1, 2),
                "ok", 2, 0, 2, false);
        JsonObject limited = inspect(nodes, Long.MAX_VALUE, 10, 10, 1, 1);
        LegacyInspectorTestSupport.assertHistory(limited, "partial_invalid", 2, 1, 1, false);
        assertRefs(limited, "a1_1");
    }

    @Test public void committedIndexWinsAndTemporaryIndexIsIgnoredAndUnchanged() throws Exception {
        CaseRoot item = fresh("history-committed");
        writeIndex(item, "[" + record(1, "committed", "ONE", 1, 1, "one", false, null, null) + "]");
        Files.write(item.files.resolve("processed_index.json.tmp"),
                ("[" + record(2, "temporary", "TWO", 2, 2, "two", false, null, null) + "]")
                        .getBytes(StandardCharsets.UTF_8));
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "ok", 1, 0, 1, false);
        assertRefs(result, "a1_1");
    }

    @Test public void equalTimestampsPreserveSourceEncounterOrder() throws Exception {
        CaseRoot item = fresh("history-stable-ties");
        writeIndex(item, "[" + record(1, "first", "ONE", 1, 99, "one", false, null, null)
                + "," + record(2, "second", "TWO", 1, 99, "two", false, null, null)
                + "," + record(3, "newest", "THREE", 1, 100, "three", false, null, null) + "]");
        JsonObject result = inspect(item);
        LegacyInspectorTestSupport.assertHistory(result, "ok", 3, 0, 3, false);
        assertRefs(result, "a1_3", "a1_1", "a1_2");
    }

    @Test public void byteSourceAndJsonNestingLimitsHaveExactBoundaries() throws Exception {
        CaseRoot bytes = fresh("history-byte-limit");
        String one = "[" + record(1, "one", "ONE", 1, 1, "one", false, null, null) + "]";
        writeIndex(bytes, one);
        long length = one.getBytes(StandardCharsets.UTF_8).length;
        LegacyInspectorTestSupport.assertHistory(inspect(bytes, length, 10, 10, 10, 10),
                "ok", 1, 0, 1, false);
        LegacyInspectorTestSupport.assertHistory(inspect(bytes, length - 1, 10, 10, 10, 10),
                "corrupt", 0, 0, 0, false);

        CaseRoot source = fresh("history-source-limit");
        writeIndex(source, "[" + record(1, "one", "ONE", 1, 1, "one", false, null, null)
                + "," + record(2, "two", "TWO", 1, 2, "two", false, null, null) + "]");
        LegacyInspectorTestSupport.assertHistory(inspect(source, Long.MAX_VALUE, 2, 10, 10, 10),
                "ok", 2, 0, 2, false);
        LegacyInspectorTestSupport.assertHistory(inspect(source, Long.MAX_VALUE, 1, 10, 10, 10),
                "corrupt", 0, 0, 0, false);

        CaseRoot nesting = fresh("history-nesting-limit");
        writeIndex(nesting, one);
        LegacyInspectorTestSupport.assertHistory(inspect(nesting, Long.MAX_VALUE, 10, 2, 10, 10),
                "ok", 1, 0, 1, false);
        LegacyInspectorTestSupport.assertHistory(inspect(nesting, Long.MAX_VALUE, 10, 1, 10, 10),
                "corrupt", 0, 0, 0, false);
        CaseRoot deeper = fresh("history-deeper-nesting");
        writeIndex(deeper, "[[[]]]");
        LegacyInspectorTestSupport.assertHistory(inspect(deeper, Long.MAX_VALUE, 10, 2, 10, 10),
                "corrupt", 0, 0, 0, false);
    }

    private CaseRoot fresh(String prefix) throws Exception {
        Path outer = temporary.newFolder(prefix + "-" + System.nanoTime()).toPath();
        Path files = Files.createDirectory(outer.resolve("files"));
        return new CaseRoot(outer, files);
    }

    private static JsonObject inspect(CaseRoot item) throws Exception {
        return LegacyInspectorTestSupport.inspectTwiceUnchanged(item.outer,
                () -> new LegacyHistoryInspector(item.files.toFile()).read());
    }

    private static JsonObject inspect(CaseRoot item, long bytes, int source, int nesting,
            int depth, int nodes) throws Exception {
        return LegacyInspectorTestSupport.inspectTwiceUnchanged(item.outer,
                () -> new LegacyHistoryInspector(item.files.toFile(), bytes, source, nesting,
                        depth, nodes).read());
    }

    private static void writeIndex(CaseRoot item, String json) throws Exception {
        writeIndex(item, json.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeIndex(CaseRoot item, byte[] bytes) throws Exception {
        Files.write(item.files.resolve("processed_index.json"), bytes);
    }

    private static String records(int count) {
        List<String> result = new ArrayList<>();
        for (int index = 1; index <= count; index++) {
            result.add(record(index, "Document " + index, "TOOL", index, index,
                    "missing-" + index + ".pdf", false, null, "application/pdf"));
        }
        return "[" + String.join(",", result) + "]";
    }

    private static String record(long id, String display, String tool, long size, long created,
            String stored, boolean collection, Integer itemCount, String mime) {
        JsonObject value = new JsonObject();
        value.addProperty("id", id);
        value.addProperty("displayName", display);
        value.addProperty("toolName", tool);
        value.addProperty("sizeBytes", size);
        value.addProperty("createdAtMillis", created);
        value.addProperty("storedFileName", stored);
        if (mime != null) value.addProperty("mimeType", mime);
        value.addProperty("isDirectory", collection);
        if (itemCount != null) value.addProperty("itemCount", itemCount);
        return value.toString();
    }

    private static JsonObject entry(JsonObject result, int index) {
        return result.getAsJsonArray("entries").get(index).getAsJsonObject();
    }

    private static void assertRefs(JsonObject result, String... expected) {
        JsonArray entries = result.getAsJsonArray("entries");
        assertEquals(expected.length, entries.size());
        for (int index = 0; index < expected.length; index++) {
            assertEquals(expected[index], entries.get(index).getAsJsonObject().get("ref").getAsString());
        }
    }

    private static final class CaseRoot {
        final Path outer;
        final Path files;
        CaseRoot(Path outer, Path files) { this.outer = outer; this.files = files; }
    }
}
