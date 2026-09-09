package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class LegacyDocumentOpenResolverTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void validChunksAreBoundedAndEveryCallReparsesCommittedIndex() throws Exception {
        CaseRoot item = fresh("valid-reparse");
        byte[] firstBytes = "first-document".getBytes(StandardCharsets.UTF_8);
        byte[] secondBytes = "replacement-document".getBytes(StandardCharsets.UTF_8);
        Files.write(item.processed.resolve("first.pdf"), firstBytes);
        Files.write(item.processed.resolve("second.pdf"), secondBytes);
        writeIndex(item, "[" + record(7, "First", "VIEW", firstBytes.length, 1,
                "first.pdf", false) + "]");

        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(item.files.toFile());
        BoundedDocumentReader.Chunk first = resolver.readChunk("a1_7", 0, 5);
        assertArrayEquals("first".getBytes(StandardCharsets.UTF_8), first.bytes());
        assertEquals(5, first.nextOffset());
        assertFalse(first.done());

        writeIndex(item, "[" + record(7, "Second", "VIEW", secondBytes.length, 2,
                "second.pdf", false) + "]");
        BoundedDocumentReader.Chunk reparsed = resolver.readChunk("a1_7", 0, 100);
        assertArrayEquals(secondBytes, reparsed.bytes());
        assertEquals(secondBytes.length, reparsed.nextOffset());
        assertTrue(reparsed.done());

        BoundedDocumentReader.Chunk eof = resolver.readChunk(
                "a1_7", secondBytes.length, BoundedDocumentReader.MAXIMUM_CHUNK_BYTES);
        assertEquals(0, eof.bytes().length);
        assertTrue(eof.done());
    }

    @Test public void earlyPdfRecordWithoutNewerOptionalFieldsStillOpens() throws Exception {
        CaseRoot item = fresh("early-compatible");
        byte[] bytes = "%PDF-1.7\nearly".getBytes(StandardCharsets.US_ASCII);
        Files.write(item.processed.resolve("early.pdf"), bytes);
        String early = record(4, "Early.pdf", "Create PDF", bytes.length, 1,
                "early.pdf", false)
                .replace(",\"mimeType\":\"application/pdf\"", "")
                .replace(",\"isDirectory\":false", "");
        writeIndex(item, "[" + early + "]");

        BoundedDocumentReader.Chunk read =
                new LegacyDocumentOpenResolver(item.files.toFile())
                        .readChunk("a1_4", 0, bytes.length);
        assertArrayEquals(bytes, read.bytes());
        assertTrue(read.done());
    }

    @Test public void rawAddressesNoncanonicalRefsAndUnsafeBoundsAreInvalid() throws Exception {
        CaseRoot item = fresh("invalid-authority");
        Files.write(item.processed.resolve("safe.pdf"), new byte[] {1});
        writeIndex(item, "[" + record(1, "Safe", "VIEW", 1, 1,
                "safe.pdf", false) + "]");
        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(item.files.toFile());

        for (String invalid : List.of("", "a1_0", "a1_01", "a1_-1", "A1_1",
                "a1_9007199254740992", "../safe.pdf", "safe.pdf",
                "content://private.provider/safe.pdf", "file:///safe.pdf")) {
            assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver,
                    invalid, 0, 1);
        }
        assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver, "a1_1", -1, 1);
        assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver, "a1_1",
                9_007_199_254_740_992L, 1);
        assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver, "a1_1", 0, 0);
        assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver, "a1_1", 0,
                BoundedDocumentReader.MAXIMUM_CHUNK_BYTES + 1);
        assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver, "a1_1", 2, 1);
    }

    @Test public void malformedDuplicateInvalidAndMissingRecordsUseFixedErrors() throws Exception {
        CaseRoot item = fresh("invalid-index");
        Files.write(item.processed.resolve("safe.pdf"), new byte[] {1});
        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(item.files.toFile());

        writeIndex(item, "{}");
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        String valid = record(1, "Safe", "VIEW", 1, 1, "safe.pdf", false);
        writeIndex(item, "[" + valid + "," + valid + "]");
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        writeIndex(item, "[" + valid.replaceFirst("\\{", "{\"invented\":true,") + "]");
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        writeIndex(item, "[" + valid.replace("\"displayName\":\"Safe\"",
                "\"displayName\":\"content:private\"") + "]");
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        writeIndex(item, "[" + valid.replace("\"storedFileName\":\"safe.pdf\"",
                "\"storedFileName\":\"../safe.pdf\"") + "]");
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        writeIndex(item, "[" + record(2, "Other", "VIEW", 1, 1,
                "safe.pdf", false) + "]");
        assertFailure("LEGACY_DOCUMENT_NOT_FOUND", resolver, "a1_1", 0, 1);

        writeIndex(item, "[" + record(1, "Missing", "VIEW", 1, 1,
                "missing.pdf", false) + "]");
        assertFailure("LEGACY_DOCUMENT_NOT_FOUND", resolver, "a1_1", 0, 1);
    }

    @Test public void collectionsWrongTypesAndSymlinksNeverBecomeFileReads() throws Exception {
        CaseRoot collection = fresh("collection");
        Path album = Files.createDirectory(collection.processed.resolve("album"));
        Files.write(album.resolve("child.pdf"), new byte[] {1});
        writeIndex(collection, "[" + record(1, "Album", "MERGE", 1, 1,
                "album", true) + "]");
        assertFailure("LEGACY_DOCUMENT_COLLECTION_UNSUPPORTED",
                new LegacyDocumentOpenResolver(collection.files.toFile()), "a1_1", 0, 1);

        CaseRoot wrongType = fresh("wrong-type");
        Files.createDirectory(wrongType.processed.resolve("file.pdf"));
        writeIndex(wrongType, "[" + record(1, "File", "VIEW", 1, 1,
                "file.pdf", false) + "]");
        assertFailure("LEGACY_DOCUMENT_UNAVAILABLE",
                new LegacyDocumentOpenResolver(wrongType.files.toFile()), "a1_1", 0, 1);

        CaseRoot link = fresh("link-output");
        Path victim = link.outer.resolve("victim.pdf");
        Files.write(victim, new byte[] {9, 9, 9});
        Files.createSymbolicLink(link.processed.resolve("linked.pdf"), victim);
        writeIndex(link, "[" + record(1, "Linked", "VIEW", 3, 1,
                "linked.pdf", false) + "]");
        assertFailure("LEGACY_DOCUMENT_UNSAFE_STATE",
                new LegacyDocumentOpenResolver(link.files.toFile()), "a1_1", 0, 1);

        CaseRoot rootLink = freshWithoutProcessed("link-root");
        Path victimRoot = Files.createDirectory(rootLink.outer.resolve("victim-root"));
        Files.write(victimRoot.resolve("file.pdf"), new byte[] {7});
        Files.createSymbolicLink(rootLink.files.resolve("processed"), victimRoot);
        writeIndex(rootLink, "[" + record(1, "File", "VIEW", 1, 1,
                "file.pdf", false) + "]");
        assertFailure("LEGACY_DOCUMENT_UNSAFE_STATE",
                new LegacyDocumentOpenResolver(rootLink.files.toFile()), "a1_1", 0, 1);
    }

    @Test public void successfulAndRefusedReadsDoNotMutateLegacyTree() throws Exception {
        CaseRoot item = fresh("read-only");
        Files.write(item.processed.resolve("safe.pdf"), new byte[] {1, 2, 3, 4});
        writeIndex(item, "[" + record(1, "Safe", "VIEW", 4, 1,
                "safe.pdf", false) + "]");
        List<String> before = manifest(item.outer);
        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(item.files.toFile());
        assertArrayEquals(new byte[] {1, 2}, resolver.readChunk("a1_1", 0, 2).bytes());
        assertFailure("LEGACY_DOCUMENT_INVALID_ARGUMENT", resolver, "content://x/y", 0, 1);
        assertEquals(before, manifest(item.outer));
    }

    @Test public void indexByteSourceAndNestingBoundsFailClosed() throws Exception {
        CaseRoot item = fresh("index-bounds");
        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(item.files.toFile());
        byte[] oversized = new byte[4 * 1024 * 1024 + 1];
        java.util.Arrays.fill(oversized, (byte) ' ');
        Files.write(item.files.resolve("processed_index.json"), oversized);
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        StringBuilder source = new StringBuilder("[");
        for (int index = 0; index < 10_001; index++) {
            if (index > 0) source.append(',');
            source.append("null");
        }
        source.append(']');
        writeIndex(item, source.toString());
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);

        String nested = "[".repeat(66) + "]".repeat(66);
        writeIndex(item, nested);
        assertFailure("LEGACY_DOCUMENT_CORRUPT", resolver, "a1_1", 0, 1);
    }

    @Test public void nativeSourceUsesOnePinnedChannelAcrossSequentialWindowsAndCloses()
            throws Exception {
        CaseRoot item = fresh("pinned-source");
        byte[] bytes = new byte[BoundedDocumentReader.MAXIMUM_CHUNK_BYTES + 37];
        java.util.Arrays.fill(bytes, (byte) 'x');
        System.arraycopy("%PDF-1.7\n".getBytes(StandardCharsets.US_ASCII), 0, bytes, 0, 9);
        Files.write(item.processed.resolve("large.pdf"), bytes);
        writeIndex(item, "[" + record(9, "Large", "VIEW", bytes.length, 1,
                "large.pdf", false) + "]");
        AtomicInteger opens = new AtomicInteger();
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger closes = new AtomicInteger();
        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(
                item.files.toFile(), new BoundedDocumentReader(), checkpoint -> {
            if (checkpoint == LegacyDocumentOpenResolver.SourceCheckpoint.OPEN) {
                opens.incrementAndGet();
            } else if (checkpoint == LegacyDocumentOpenResolver.SourceCheckpoint.READ) {
                reads.incrementAndGet();
            } else if (checkpoint == LegacyDocumentOpenResolver.SourceCheckpoint.CLOSE) {
                closes.incrementAndGet();
            }
        });

        OwnedDocumentWriter.DocumentSource source = resolver.openSource(
                "a1_9", AndroidDocumentIngressPolicy.MIME_PDF);
        byte[] first = new byte[BoundedDocumentReader.MAXIMUM_CHUNK_BYTES];
        byte[] second = new byte[37];
        assertEquals(first.length, source.read(0, first));
        assertEquals(second.length, source.read(first.length, second));
        source.close();

        assertEquals(1, opens.get());
        assertEquals(2, reads.get());
        assertEquals(1, closes.get());
        assertArrayEquals(java.util.Arrays.copyOfRange(bytes, 0, first.length), first);
        assertArrayEquals(java.util.Arrays.copyOfRange(bytes, first.length, bytes.length), second);
        try {
            source.read(0, new byte[1]);
            fail("Expected closed source rejection");
        } catch (OwnedDocumentWriter.Failure failure) {
            assertEquals("DOCUMENT_INVALID_ARGUMENT", failure.code());
        }
    }

    @Test public void collectionResolutionIsImmediateBoundedSortedAndIdentityPinned()
            throws Exception {
        CaseRoot item = fresh("collection-valid");
        Path album = Files.createDirectory(item.processed.resolve("album"));
        byte[] first = new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 1};
        byte[] second = new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 2, 3};
        Files.write(album.resolve("02.jpg"), second);
        Files.write(album.resolve("01.jpg"), first);
        writeIndex(item, "[" + collectionRecord(5, "Album", first.length + second.length,
                "album", "image/jpeg", 2) + "]");

        LegacyDocumentOpenResolver.CollectionSource source =
                new LegacyDocumentOpenResolver(item.files.toFile()).openCollection("a1_5");
        assertEquals(2, source.itemCount());
        assertEquals(first.length + second.length, source.totalBytes());
        assertTrue(source.imageCollection());
        assertEquals("01.jpg", source.items().get(0).displayName());
        try (OwnedDocumentWriter.DocumentSource child = source.items().get(0).openSource()) {
            byte[] read = new byte[first.length];
            assertEquals(first.length, child.read(0, read));
            assertArrayEquals(first, read);
        }
        source.validateUnchanged();
        Files.write(album.resolve("01.jpg"), second);
        try { source.validateUnchanged(); fail("Expected identity change rejection"); }
        catch (LegacyDocumentOpenResolver.Failure failure) {
            assertEquals("LEGACY_DOCUMENT_UNSAFE_STATE", failure.code());
        }
        source.close();
    }

    @Test public void collectionRejectsEmptyNestedSymlinkAndItemLimit() throws Exception {
        CaseRoot empty = fresh("collection-empty");
        Files.createDirectory(empty.processed.resolve("album"));
        writeIndex(empty, "[" + collectionRecord(1, "Album", 0, "album",
                "application/pdf", 1) + "]");
        assertCollectionFailure("LEGACY_DOCUMENT_CORRUPT", empty, "a1_1");

        CaseRoot nested = fresh("collection-nested");
        Path nestedAlbum = Files.createDirectory(nested.processed.resolve("album"));
        Files.createDirectory(nestedAlbum.resolve("nested"));
        writeIndex(nested, "[" + collectionRecord(2, "Album", 1, "album",
                "application/pdf", 1) + "]");
        assertCollectionFailure("LEGACY_DOCUMENT_UNAVAILABLE", nested, "a1_2");

        CaseRoot linked = fresh("collection-linked");
        Path linkedAlbum = Files.createDirectory(linked.processed.resolve("album"));
        Path victim = Files.write(linked.outer.resolve("victim.pdf"), new byte[] {1});
        Files.createSymbolicLink(linkedAlbum.resolve("escape.pdf"), victim);
        writeIndex(linked, "[" + collectionRecord(3, "Album", 1, "album",
                "application/pdf", 1) + "]");
        assertCollectionFailure("LEGACY_DOCUMENT_UNAVAILABLE", linked, "a1_3");

        CaseRoot over = fresh("collection-limit");
        Path overAlbum = Files.createDirectory(over.processed.resolve("album"));
        byte[] tinyPdf = "%PDF-1.7".getBytes(StandardCharsets.US_ASCII);
        for (int index = 0; index <= LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_ITEMS; index++) {
            Files.write(overAlbum.resolve(String.format("%03d.pdf", index)), tinyPdf);
        }
        writeIndex(over, "[" + collectionRecord(4, "Album",
                (LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_ITEMS + 1L) * tinyPdf.length,
                "album",
                "application/pdf", LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_ITEMS) + "]");
        assertCollectionFailure("LEGACY_DOCUMENT_LIMIT_EXCEEDED", over, "a1_4");
    }

    @Test public void legacyCollectionWithoutPostReleaseMimeAndCountIsDerivedSafely()
            throws Exception {
        CaseRoot item = fresh("collection-compatible");
        Path album = Files.createDirectory(item.processed.resolve("album"));
        byte[] pdf = "%PDF-1.7\nlegacy".getBytes(StandardCharsets.US_ASCII);
        Files.write(album.resolve("page.pdf"), pdf);
        JsonObject record = new JsonObject();
        record.addProperty("id", 6); record.addProperty("displayName", "Legacy pages");
        record.addProperty("toolName", "SPLIT"); record.addProperty("sizeBytes", pdf.length);
        record.addProperty("createdAtMillis", 1); record.addProperty("storedFileName", "album");
        writeIndex(item, "[" + record + "]");
        List<String> before = manifest(item.outer);
        try (LegacyDocumentOpenResolver.CollectionSource source =
                     new LegacyDocumentOpenResolver(item.files.toFile()).openCollection("a1_6")) {
            assertEquals(1, source.itemCount());
            assertEquals("application/pdf", source.mimeType());
        }
        assertEquals(before, manifest(item.outer));
    }

    private CaseRoot fresh(String name) throws Exception {
        CaseRoot result = freshWithoutProcessed(name);
        Files.createDirectory(result.processed);
        return result;
    }

    private CaseRoot freshWithoutProcessed(String name) throws Exception {
        Path outer = temporary.newFolder(name + "-" + System.nanoTime()).toPath();
        Path files = Files.createDirectory(outer.resolve("files"));
        return new CaseRoot(outer, files, files.resolve("processed"));
    }

    private static void writeIndex(CaseRoot item, String json) throws Exception {
        Files.write(item.files.resolve("processed_index.json"),
                json.getBytes(StandardCharsets.UTF_8));
    }

    private static String record(long id, String display, String tool, long size, long created,
            String stored, boolean collection) {
        JsonObject value = new JsonObject();
        value.addProperty("id", id);
        value.addProperty("displayName", display);
        value.addProperty("toolName", tool);
        value.addProperty("sizeBytes", size);
        value.addProperty("createdAtMillis", created);
        value.addProperty("storedFileName", stored);
        value.addProperty("mimeType", "application/pdf");
        value.addProperty("isDirectory", collection);
        if (collection) value.addProperty("itemCount", 1);
        return value.toString();
    }

    private static String collectionRecord(long id, String display, long size, String stored,
            String mimeType, int itemCount) {
        JsonObject value = new JsonObject();
        value.addProperty("id", id); value.addProperty("displayName", display);
        value.addProperty("toolName", "COLLECTION"); value.addProperty("sizeBytes", size);
        value.addProperty("createdAtMillis", 1); value.addProperty("storedFileName", stored);
        value.addProperty("mimeType", mimeType); value.addProperty("isDirectory", true);
        value.addProperty("itemCount", itemCount); return value.toString();
    }

    private static void assertCollectionFailure(String code, CaseRoot item, String ref)
            throws Exception {
        try {
            new LegacyDocumentOpenResolver(item.files.toFile()).openCollection(ref);
            fail("Expected " + code);
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            assertEquals(code, failure.code());
            assertFalse(failure.getMessage().contains("processed"));
        }
    }

    private static List<String> manifest(Path root) throws Exception {
        ArrayList<String> result = new ArrayList<>();
        try (var paths = Files.walk(root)) {
            paths.sorted().forEach(path -> {
                try {
                    String kind = Files.isSymbolicLink(path) ? "link"
                            : Files.isDirectory(path) ? "dir" : "file";
                    long size = Files.isRegularFile(path) ? Files.size(path) : 0;
                    result.add(root.relativize(path) + "|" + kind + "|" + size);
                } catch (Exception failure) {
                    throw new RuntimeException(failure);
                }
            });
        }
        return result;
    }

    private static void assertFailure(String code, LegacyDocumentOpenResolver resolver,
            String ref, long offset, int length) throws Exception {
        try {
            resolver.readChunk(ref, offset, length);
            fail("Expected " + code);
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            assertEquals(code, failure.code());
            assertFalse(failure.getMessage().contains("content://"));
            assertFalse(failure.getMessage().contains("processed"));
            assertFalse(failure.getMessage().contains(".pdf"));
        }
    }

    private static final class CaseRoot {
        final Path outer;
        final Path files;
        final Path processed;
        CaseRoot(Path outer, Path files, Path processed) {
            this.outer = outer;
            this.files = files;
            this.processed = processed;
        }
    }
}
