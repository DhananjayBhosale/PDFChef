package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public final class AndroidDocumentExporterTest {
    private static final byte[] PDF = "%PDF-1.7\nexport\n%%EOF".getBytes();

    @Test public void constructorIsIoFreeAndCompletedExportsDoNotBlockNextExport() throws Exception {
        Path files = Files.createTempDirectory("export-success");
        FakeDestination destination = new FakeDestination();
        AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        assertEquals(0, Files.list(files).count());

        assertTrue(exporter.export(source(PDF), "first.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false).completedValue());
        assertTrue(exporter.export(source(PDF), "second.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false).completedValue());
        assertEquals(2, destination.rows.size());
        for (FakeDestination.Row row : destination.rows.values()) {
            assertFalse(row.pending);
            assertArrayEquals(PDF, row.bytes);
            assertTrue(row.displayName.endsWith(".pdf"));
        }
        assertFalse(Files.exists(files.resolve("pdfchef_documents/export/current.export")));
    }

    @Test public void exportReportsStoredNameAndRenamesOnlyItsOwnFreshRow() throws Exception {
        Path files = Files.createTempDirectory("export-rename");
        FakeDestination destination = new FakeDestination();
        AtomicLong clock = new AtomicLong(100);
        AndroidDocumentExporter exporter = exporter(files, destination, clock::get,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        AndroidDocumentExporter.Result first = exporter.export(source(PDF), "Report.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
        AndroidDocumentExporter.Result second = exporter.export(source(PDF), "Report.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
        assertEquals("Report.pdf", first.savedName());
        assertEquals("Report (1).pdf", second.savedName());

        assertEquals("Invoice.pdf", exporter.rename(second.token(), "Invoice.pdf"));
        assertEquals("Invoice (1).pdf", exporter.rename(first.token(), "Invoice.pdf"));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> exporter.rename("content://fake/x", "a.pdf"));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> exporter.rename(first.token(), "a/b.pdf"));
        assertFailure("DOCUMENT_NOT_FOUND",
                () -> exporter.rename("pdfchef-unknownunknownunknown00", "a.pdf"));
        clock.set(100 + AndroidDocumentExporter.COMPLETED_EXPIRY_MILLIS);
        assertFailure("DOCUMENT_NOT_FOUND", () -> exporter.rename(first.token(), "late.pdf"));
    }

    @Test public void generatedZipTextAndWebpOutputsReachDownloadsUnchanged() throws Exception {
        for (String mime : List.of("application/zip", "text/plain", "image/webp")) {
            Path files = Files.createTempDirectory("export-generated");
            FakeDestination destination = new FakeDestination();
            AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                    tokens("abcdefghijklmnopqrstuv"), ignored -> {});
            byte[] bytes = "already-validated-owned-bytes".getBytes();
            assertTrue(exporter.export(source(bytes, mime), "Output", mime, () -> false).completedValue());
            FakeDestination.Row row = destination.rows.values().iterator().next();
            assertEquals(mime, row.mimeType);
            assertEquals(AndroidDocumentExporter.MediaTarget.DOWNLOADS, row.target);
            assertArrayEquals(bytes, row.bytes);
            assertFalse(row.pending);
        }
    }

    @Test public void prepublicationFailureDeletesOnlyExactPendingRow() throws Exception {
        Path files = Files.createTempDirectory("export-rollback");
        FakeDestination destination = new FakeDestination();
        AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                tokens("abcdefghijklmnopqrstuv"), checkpoint -> {
                    if (checkpoint == AndroidDocumentExporter.Checkpoint.AFTER_PENDING_ROW) {
                        throw new IOException("simulated failure");
                    }
                });
        assertFailure("DOCUMENT_FAILED", () -> exporter.export(source(PDF), "safe.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertTrue(destination.rows.isEmpty());
        assertEquals(1, destination.deletedAddresses);
        assertFalse(Files.exists(files.resolve("pdfchef_documents/export/current.export")));
    }

    @Test public void postpublicationFailureNeverDeletesVisibleExport() throws Exception {
        Path files = Files.createTempDirectory("export-published");
        FakeDestination destination = new FakeDestination();
        AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                tokens("abcdefghijklmnopqrstuv"), checkpoint -> {
                    if (checkpoint == AndroidDocumentExporter.Checkpoint.AFTER_PUBLICATION) {
                        throw new IOException("simulated journal loss");
                    }
                });
        assertFailure("DOCUMENT_DURABILITY_UNCERTAIN", () -> exporter.export(source(PDF),
                "visible.pdf", AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertEquals(1, destination.rows.size());
        assertFalse(destination.rows.values().iterator().next().pending);
        assertEquals(0, destination.deletedAddresses);
    }

    @Test public void updateSuccessThenVerificationFailurePreservesJournalAndSnapshot()
            throws Exception {
        Path files = Files.createTempDirectory("export-publish-query-failure");
        FakeDestination destination = new FakeDestination();
        destination.failAfterPublishing = true;
        AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                tokens("abcdefghijklmnopqrstuv"), ignored -> {});
        assertFailure("DOCUMENT_DURABILITY_UNCERTAIN", () -> exporter.export(source(PDF),
                "visible.pdf", AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertFalse(destination.rows.values().iterator().next().pending);
        assertEquals(0, destination.deletedAddresses);
        assertTrue(Files.exists(files.resolve("pdfchef_documents/export/current.export")));
        assertTrue(Files.exists(files.resolve(
                "pdfchef_documents/export/pdfchef-abcdefghijklmnopqrstuv.snapshot")));
    }

    @Test public void indeterminatePublicationProbePreservesPendingRowAndRecoveryState()
            throws Exception {
        Path files = Files.createTempDirectory("export-indeterminate-probe");
        FakeDestination destination = new FakeDestination();
        destination.failBeforePublishing = true;
        destination.unknownProbe = true;
        AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                tokens("abcdefghijklmnopqrstuv"), ignored -> {});
        assertFailure("DOCUMENT_DURABILITY_UNCERTAIN", () -> exporter.export(source(PDF),
                "unknown.pdf", AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertTrue(destination.rows.values().iterator().next().pending);
        assertEquals(0, destination.deletedAddresses);
        assertTrue(Files.exists(files.resolve("pdfchef_documents/export/current.export")));
        assertTrue(Files.exists(files.resolve(
                "pdfchef_documents/export/pdfchef-abcdefghijklmnopqrstuv.snapshot")));
    }

    @Test public void restartDeletesAgedPendingAllocationByPrivateJournal() throws Exception {
        Path files = Files.createTempDirectory("export-recovery");
        FakeDestination destination = new FakeDestination();
        AtomicLong clock = new AtomicLong(100);
        AndroidDocumentExporter crashing = exporter(files, destination, clock::get,
                tokens("abcdefghijklmnopqrstuv"), checkpoint -> {
                    if (checkpoint == AndroidDocumentExporter.Checkpoint.AFTER_PENDING_ROW) {
                        throw new AssertionError("simulated process death");
                    }
                });
        try {
            crashing.export(source(PDF), "lost.pdf", AndroidDocumentIngressPolicy.MIME_PDF,
                    () -> false);
            fail("Expected process death");
        } catch (AssertionError expected) { }
        assertEquals(1, destination.rows.size());
        assertTrue(destination.rows.values().iterator().next().pending);

        clock.set(100 + AndroidDocumentExporter.INCOMPLETE_EXPIRY_MILLIS + 1);
        AndroidDocumentExporter restarted = exporter(files, destination, clock::get,
                tokens("zyxwvutsrqponmlkjihgfe"), ignored -> {});
        assertTrue(restarted.export(source(PDF), "recovered.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false).completedValue());
        assertEquals(1, destination.rows.size());
        assertFalse(destination.rows.values().iterator().next().pending);
        assertEquals(1, destination.deletedAddresses);
    }

    @Test public void invalidNamesMimeAndStorageFailBeforeAllocation() throws Exception {
        Path files = Files.createTempDirectory("export-invalid");
        FakeDestination destination = new FakeDestination();
        AndroidDocumentExporter low = new AndroidDocumentExporter(files, destination, () -> 1,
                tokens("abcdefghijklmnopqrstuv"), required -> required - 1, ignored -> {});
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> low.export(source(PDF), "../raw.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> low.export(source(PDF), "raw.pdf",
                AndroidDocumentIngressPolicy.MIME_PNG, () -> false));
        assertFailure("DOCUMENT_STORAGE_FULL", () -> low.export(source(PDF), "raw.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertTrue(destination.rows.isEmpty());
    }

    @Test public void collectionExportUsesPicturesAlbumAndRollsBackExactCompletedRows()
            throws Exception {
        Path files = Files.createTempDirectory("export-collection");
        LegacyDocumentOpenResolver.CollectionSource collection = imageCollection(files);
        FakeDestination destination = new FakeDestination();
        AndroidDocumentExporter exporter = exporter(files, destination, () -> 100,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        AndroidDocumentExporter.Result result = exporter.exportCollection(
                collection, "Scanned pages", () -> false);
        assertTrue(result.completedValue());
        assertEquals(2, result.itemCount());
        assertEquals(2, destination.rows.size());
        for (FakeDestination.Row row : destination.rows.values()) {
            assertEquals(AndroidDocumentExporter.MediaTarget.PICTURES, row.target);
            assertEquals("Scanned pages", row.containerName);
            assertFalse(row.pending);
        }

        Path rollbackFiles = Files.createTempDirectory("export-collection-rollback");
        LegacyDocumentOpenResolver.CollectionSource rollbackCollection =
                imageCollection(rollbackFiles);
        FakeDestination failing = new FakeDestination();
        failing.failAllocationNumber = 2;
        AndroidDocumentExporter rollbackExporter = exporter(rollbackFiles, failing, () -> 100,
                tokens("mnopqrstuvabcdefghijkl", "ponmlkjihgfezyxwvutsrq"), ignored -> {});
        assertFailure("DOCUMENT_FAILED", () -> rollbackExporter.exportCollection(
                rollbackCollection, "Scanned pages", () -> false));
        assertTrue(failing.rows.isEmpty());
        assertEquals(1, failing.deletedAddresses);
    }

    private static LegacyDocumentOpenResolver.CollectionSource imageCollection(Path files)
            throws Exception {
        Path processed = Files.createDirectory(files.resolve("processed"));
        Path album = Files.createDirectory(processed.resolve("album"));
        byte[] first = new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 1};
        byte[] second = new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 2};
        Files.write(album.resolve("01.jpg"), first);
        Files.write(album.resolve("02.jpg"), second);
        String index = "[{\"id\":7,\"displayName\":\"Scanned pages\","
                + "\"toolName\":\"PDF_TO_IMAGE\",\"sizeBytes\":8,"
                + "\"createdAtMillis\":1,\"storedFileName\":\"album\","
                + "\"mimeType\":\"image/jpeg\",\"isDirectory\":true,\"itemCount\":2}]";
        Files.writeString(files.resolve("processed_index.json"), index);
        return new LegacyDocumentOpenResolver(files.toFile()).openCollection("a1_7");
    }

    private static AndroidDocumentExporter exporter(Path files, FakeDestination destination,
            OwnedDocumentWriter.Clock clock, OwnedDocumentWriter.TokenSource tokens,
            AndroidDocumentExporter.FaultInjector faults) {
        return new AndroidDocumentExporter(files, destination, clock, tokens,
                required -> required + 1_000_000, faults);
    }

    private static OwnedDocumentWriter.DocumentSource source(byte[] bytes) {
        return source(bytes, AndroidDocumentIngressPolicy.MIME_PDF);
    }

    private static OwnedDocumentWriter.DocumentSource source(byte[] bytes, String mimeType) {
        return new OwnedDocumentWriter.DocumentSource() {
            @Override public String mimeType() { return mimeType; }
            @Override public long sizeBytes() { return bytes.length; }
            @Override public int read(long offset, byte[] target) {
                if (offset >= bytes.length) return 0;
                int count = Math.min(target.length, bytes.length - (int) offset);
                System.arraycopy(bytes, (int) offset, target, 0, count);
                return count;
            }
        };
    }

    private static OwnedDocumentWriter.TokenSource tokens(String... values) {
        ArrayDeque<String> queue = new ArrayDeque<>(List.of(values));
        return queue::removeFirst;
    }

    private static void assertFailure(String code, ThrowingRunnable action) {
        try { action.run(); fail("Expected " + code); }
        catch (AndroidDocumentExporter.Failure failure) { assertEquals(code, failure.code()); }
        catch (Exception failure) { throw new AssertionError(failure); }
    }

    private interface ThrowingRunnable { void run() throws Exception; }

    private static final class FakeDestination implements AndroidDocumentExporter.Destination {
        final Map<String, Row> rows = new HashMap<>();
        int deletedAddresses;
        boolean failBeforePublishing;
        boolean failAfterPublishing;
        boolean unknownProbe;
        int allocationCount;
        int failAllocationNumber;
        @Override public String allocate(String token, String mimeType) {
            String address = "content://fake/" + token;
            rows.put(address, new Row(token, mimeType));
            return address;
        }
        @Override public String allocate(String token, String mimeType,
                AndroidDocumentExporter.MediaTarget target, String containerName)
                throws IOException {
            allocationCount++;
            if (allocationCount == failAllocationNumber) throw new IOException("allocate");
            String address = allocate(token, mimeType);
            Row row = rows.get(address); row.target = target; row.containerName = containerName;
            return address;
        }
        @Override public Output open(String address) throws IOException {
            Row row = required(address);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            return new Output() {
                @Override public void write(byte[] source, int offset, int length) {
                    bytes.write(source, offset, length);
                }
                @Override public void force() { row.forced = true; }
                @Override public void close() { row.bytes = bytes.toByteArray(); }
            };
        }
        @Override public String publish(String address, String displayName, String mimeType, long size)
                throws IOException {
            Row row = required(address);
            if (!row.forced || row.bytes.length != size) throw new IOException("not forced");
            if (failBeforePublishing) throw new IOException("publish update failed");
            row.pending = false; row.displayName = storedName(displayName, address);
            row.mimeType = mimeType;
            if (failAfterPublishing) throw new IOException("publication query failed");
            return row.displayName;
        }
        @Override public String rename(String address, String displayName) throws IOException {
            Row row = required(address);
            if (row.pending) throw new IOException("pending");
            row.displayName = storedName(displayName, address);
            return row.displayName;
        }
        /** Like MediaStore, a name another row already uses gets " (1)" before its extension. */
        private String storedName(String displayName, String address) {
            boolean taken = rows.entrySet().stream().anyMatch(entry ->
                    !entry.getKey().equals(address) && displayName.equals(entry.getValue().displayName));
            if (!taken) return displayName;
            int dot = displayName.lastIndexOf('.');
            return dot < 0 ? displayName + " (1)"
                    : displayName.substring(0, dot) + " (1)" + displayName.substring(dot);
        }
        @Override public AndroidDocumentExporter.PublicationState publicationState(String address)
                throws IOException {
            if (unknownProbe) return AndroidDocumentExporter.PublicationState.UNKNOWN;
            return required(address).pending
                    ? AndroidDocumentExporter.PublicationState.PENDING
                    : AndroidDocumentExporter.PublicationState.PUBLISHED;
        }
        @Override public void deleteAddress(String address) {
            if (rows.remove(address) != null) deletedAddresses++;
        }
        @Override public void deletePendingToken(String token) {
            rows.entrySet().removeIf(entry -> entry.getValue().token.equals(token)
                    && entry.getValue().pending);
        }
        private Row required(String address) throws IOException {
            Row row = rows.get(address);
            if (row == null) throw new IOException("missing");
            return row;
        }
        static final class Row {
            final String token; String mimeType; String displayName; boolean pending = true;
            boolean forced; byte[] bytes = new byte[0];
            AndroidDocumentExporter.MediaTarget target;
            String containerName;
            Row(String token, String mimeType) { this.token = token; this.mimeType = mimeType; }
        }
    }
}
