package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;

public final class OwnedPendingImportStoreTest {
    private static final String REF = "d1_abcdefghijklmnopqrstuv";
    private static final byte[] PDF = "%PDF-1.7\nowned bytes\n%%EOF".getBytes(StandardCharsets.US_ASCII);

    @Test public void stagesCompleteFileBeforePublishingOpaqueRecord() throws Exception {
        Path files = Files.createTempDirectory("pending-import-test");
        OwnedPendingImportStore store = store(files);

        PendingImportRecord record = store.stage(
                REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);

        assertEquals(REF, record.ref());
        assertEquals(AndroidDocumentIngressPolicy.MIME_PDF, record.mimeType());
        assertEquals(PDF.length, record.sizeBytes());
        assertEquals(64, record.contentHash().length());
        assertEquals(1234L, record.createdAtMillis());
        assertEquals(record, store.load(REF));
        assertEquals(List.of(record), store.listPending());
        assertArrayEquals(PDF, Files.readAllBytes(dataFile(files)));
        assertTrue(Files.isRegularFile(recordFile(files)));
        assertNoTemporaryFiles(files);
    }

    @Test public void restartReturnsSameDurableRecordWithoutReadingSourceAgain() throws Exception {
        Path files = Files.createTempDirectory("pending-import-restart");
        PendingImportRecord first = store(files).stage(
                REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);

        PendingImportRecord restarted = store(files).stage(
                REF, item(PDF.length), new FailingInputStream(0), () -> false);
        assertEquals(first, restarted);
        assertEquals(1, store(files).listPending().size());
    }

    @Test public void crashAfterDataPublicationRecoversIdempotentlyOnRestart() throws Exception {
        Path files = Files.createTempDirectory("pending-import-atomic");
        OwnedPendingImportStore interrupted = new OwnedPendingImportStore(
                files, required -> required + 1_000_000, () -> 1234L,
                checkpoint -> {
                    if (checkpoint == OwnedPendingImportStore.Checkpoint.BEFORE_RECORD_PUBLISH) {
                        throw new IOException("simulated process loss");
                    }
                });

        assertStoreFailure("DOCUMENT_FAILED", () -> interrupted.stage(
                REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false));
        assertTrue(Files.isRegularFile(dataFile(files)));
        assertFalse(Files.exists(recordFile(files)));

        PendingImportRecord recovered = store(files).stage(
                REF, item(PDF.length), new FailingInputStream(0), () -> false);
        assertEquals(REF, recovered.ref());
        assertTrue(Files.isRegularFile(recordFile(files)));
        assertEquals(1, store(files).listPending().size());
    }

    @Test public void partialCopyNeverPublishesDataOrRecord() throws Exception {
        Path files = Files.createTempDirectory("pending-import-partial");
        assertStoreFailure("DOCUMENT_FAILED", () -> store(files).stage(
                REF, item(PDF.length), new FailingInputStream(8), () -> false));
        assertFalse(Files.exists(dataFile(files)));
        assertFalse(Files.exists(recordFile(files)));
        assertNoTemporaryFiles(files);
    }

    @Test public void cancellationNeverPublishesAndPreservesInterruptMeaning() throws Exception {
        Path files = Files.createTempDirectory("pending-import-cancel");
        AtomicInteger checks = new AtomicInteger();
        assertStoreFailure("DOCUMENT_CANCELLED", () -> store(files).stage(
                REF, item(PDF.length), new ByteArrayInputStream(PDF),
                () -> checks.incrementAndGet() >= 4));
        assertFalse(Files.exists(dataFile(files)));
        assertFalse(Files.exists(recordFile(files)));
        assertNoTemporaryFiles(files);
    }

    @Test public void lowStorageRefusesBeforeOpeningCopy() throws Exception {
        Path files = Files.createTempDirectory("pending-import-space");
        OwnedPendingImportStore store = new OwnedPendingImportStore(
                files, required -> required - 1, () -> 1234L, checkpoint -> {});
        FailingInputStream source = new FailingInputStream(0);
        assertStoreFailure("DOCUMENT_STORAGE_FULL", () -> store.stage(
                REF, item(PDF.length), source, () -> false));
        assertEquals(0, source.readCalls);
        assertFalse(Files.exists(recordFile(files)));
    }

    @Test public void declaredAndActualSizeMustMatchAndRemainBounded() throws Exception {
        Path files = Files.createTempDirectory("pending-import-size");
        assertStoreFailure("DOCUMENT_CORRUPT", () -> store(files).stage(
                REF, item(PDF.length - 1), new ByteArrayInputStream(PDF), () -> false));
        assertFalse(Files.exists(recordFile(files)));
    }

    @Test public void magicIsRecheckedDuringOwnedCopy() throws Exception {
        Path files = Files.createTempDirectory("pending-import-magic");
        byte[] zip = "PK\003\004not a pdf".getBytes(StandardCharsets.ISO_8859_1);
        assertStoreFailure("DOCUMENT_CORRUPT", () -> store(files).stage(
                REF, item(zip.length), new ByteArrayInputStream(zip), () -> false));
        assertFalse(Files.exists(recordFile(files)));
    }

    @Test public void recordAndErrorsContainNoSourceMetadata() throws Exception {
        Path files = Files.createTempDirectory("pending-import-redaction");
        store(files).stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        String tree = treeText(files);
        assertFalse(tree.contains("content://"));
        assertFalse(tree.contains("provider"));
        assertFalse(tree.contains("statement.pdf"));

        try {
            store(files).load("content://private.provider/statement.pdf");
            fail("Expected invalid ref");
        } catch (OwnedPendingImportStore.Failure failure) {
            assertEquals("DOCUMENT_INVALID_ARGUMENT", failure.code());
            assertEquals("The document request is invalid.", failure.getMessage());
            assertFalse(failure.getMessage().contains("content://"));
        }
    }

    @Test public void malformedOrMissingDurableStateFailsClosed() throws Exception {
        Path files = Files.createTempDirectory("pending-import-corrupt");
        store(files).stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        Files.write(recordFile(files), new byte[] {1, 2, 3});
        assertStoreFailure("DOCUMENT_CORRUPT", () -> store(files).load(REF));

        Files.deleteIfExists(recordFile(files));
        Files.deleteIfExists(dataFile(files));
        assertStoreFailure("DOCUMENT_NOT_FOUND", () -> store(files).load(REF));
    }

    @Test public void metadataOnlyRetainReadLeavesContentValidationToTheImmediateCaller()
            throws Exception {
        Path files = Files.createTempDirectory("pending-import-metadata");
        OwnedPendingImportStore store = store(files);
        store.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        byte[] corrupt = PDF.clone();
        corrupt[corrupt.length - 1] ^= 1;
        Files.write(dataFile(files), corrupt);

        assertEquals(REF, store.loadMetadataForImmediateValidation(REF).ref());
        assertStoreFailure("DOCUMENT_CORRUPT", () -> store.load(REF));
    }

    @Test public void incompleteBatchIsNeverDeliverableAndRestartPreservesExactOrder() throws Exception {
        Path files = Files.createTempDirectory("pending-import-batch-restart");
        String second = "d1_zyxwvutsrqponmlkjihgfe";
        List<String> ordered = List.of(second, REF);
        OwnedPendingImportStore firstProcess = store(files);
        PendingImportBatch incomplete = firstProcess.beginBatch(ordered);
        firstProcess.stage(second, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        assertEquals(null, firstProcess.takeCompleteBatch(100));

        OwnedPendingImportStore restarted = store(files);
        PendingImportBatch recovered = restarted.beginBatch(ordered);
        assertEquals(incomplete.batchRef(), recovered.batchRef());
        restarted.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        PendingImportBatch complete = restarted.completeBatch(recovered.batchRef(), ordered);
        PendingImportBatch delivered = restarted.takeCompleteBatch(100);
        assertEquals(complete.batchRef(), delivered.batchRef());
        assertEquals(ordered, delivered.refs());
    }

    @Test public void midBatchStagingFailureLeavesNoDeliverableBatchAndCanResumeExactly()
            throws Exception {
        Path files = Files.createTempDirectory("pending-import-batch-failure");
        String second = "d1_zyxwvutsrqponmlkjihgfe";
        List<String> ordered = List.of(REF, second);
        OwnedPendingImportStore firstProcess = store(files);
        PendingImportBatch batch = firstProcess.beginBatch(ordered);
        firstProcess.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        assertStoreFailure("DOCUMENT_FAILED", () -> firstProcess.stage(second, item(PDF.length),
                new FailingInputStream(0), () -> false));
        assertEquals(null, firstProcess.takeCompleteBatch(100));

        OwnedPendingImportStore restarted = store(files);
        restarted.stage(second, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        restarted.completeBatch(batch.batchRef(), ordered);
        assertEquals(ordered, restarted.takeCompleteBatch(100).refs());
    }

    @Test public void restartCleansOnlyCanonicalBatchTempBeforeFirstManifestPublish()
            throws Exception {
        Path files = Files.createTempDirectory("pending-import-batch-temp-publish");
        OwnedPendingImportStore firstProcess = store(files);
        firstProcess.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        PendingImportBatch expected = PendingImportBatch.begin(List.of(REF), 1234L);
        Path temp = batchFile(files, expected.batchRef(), ".tmp");
        Files.write(temp, expected.encode());

        PendingImportBatch recovered = store(files).beginBatch(List.of(REF));
        assertEquals(expected.batchRef(), recovered.batchRef());
        assertTrue(Files.isRegularFile(batchFile(files, expected.batchRef(), ".batch")));
        assertFalse(Files.exists(temp));
        assertArrayEquals(PDF, Files.readAllBytes(dataFile(files)));
        assertEquals(REF, store(files).load(REF).ref());
    }

    @Test public void restartCleansReplaceAndReceiptTempsWithoutDeletingLiveState()
            throws Exception {
        Path files = Files.createTempDirectory("pending-import-batch-temp-replace");
        OwnedPendingImportStore firstProcess = store(files);
        firstProcess.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        PendingImportBatch incomplete = firstProcess.beginBatch(List.of(REF));
        PendingImportBatch complete = firstProcess.completeBatch(incomplete.batchRef(), List.of(REF));
        PendingImportBatch receipt = complete.acknowledge(1234L);
        Path liveBatch = batchFile(files, complete.batchRef(), ".batch");
        Path liveReceipt = acknowledgementFile(files, receipt.batchRef(), ".ack");
        Files.write(liveReceipt, receipt.encode());
        Path batchTemp = batchFile(files, complete.batchRef(), ".tmp");
        Path receiptTemp = acknowledgementFile(files, receipt.batchRef(), ".tmp");
        Files.write(batchTemp, complete.encode());
        Files.write(receiptTemp, receipt.encode());

        OwnedPendingImportStore restarted = store(files);
        assertEquals(List.of(REF), restarted.takeCompleteBatch(100).refs());
        assertEquals(List.of(REF), restarted.loadAcknowledgedBatch(receipt.batchRef()).refs());
        assertTrue(Files.isRegularFile(liveBatch));
        assertTrue(Files.isRegularFile(liveReceipt));
        assertFalse(Files.exists(batchTemp));
        assertFalse(Files.exists(receiptTemp));
        assertTrue(Files.isRegularFile(recordFile(files)));
        assertArrayEquals(PDF, Files.readAllBytes(dataFile(files)));
    }

    @Test public void batchStateTimestampClampsWhenClockMovesBackward() throws Exception {
        PendingImportBatch incomplete = PendingImportBatch.begin(List.of(REF), 100L);
        PendingImportBatch complete = incomplete.complete(10L);
        PendingImportBatch receipt = complete.acknowledge(1L);
        assertEquals(100L, complete.stateAtMillis());
        assertEquals(100L, receipt.stateAtMillis());
    }

    @Test public void finalizationRejectsOrphanPendingPayloadWithoutPublishingReceipt()
            throws Exception {
        Path files = Files.createTempDirectory("pending-import-batch-orphan");
        OwnedPendingImportStore store = store(files);
        store.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        PendingImportBatch incomplete = store.beginBatch(List.of(REF));
        PendingImportBatch complete = store.completeBatch(incomplete.batchRef(), List.of(REF));
        Files.delete(recordFile(files));

        assertStoreFailure("DOCUMENT_UNSAFE_STATE", () -> store.finalizeAcknowledgedBatch(complete));
        assertTrue(Files.isRegularFile(dataFile(files)));
        assertTrue(Files.isRegularFile(batchFile(files, complete.batchRef(), ".batch")));
        assertFalse(Files.exists(acknowledgementFile(files, complete.batchRef(), ".ack")));
    }

    @Test public void cancelledPublishedPayloadRollsBackEvenWithInterruptedWorker() throws Exception {
        Path files = Files.createTempDirectory("pending-import-cancel-published");
        AtomicBoolean cancelled = new AtomicBoolean();
        OwnedPendingImportStore store = new OwnedPendingImportStore(files,
                required -> required + 1_000_000, () -> 1234L, checkpoint -> {
                    if (checkpoint == OwnedPendingImportStore.Checkpoint.AFTER_DATA_PUBLISH) {
                        cancelled.set(true);
                    }
                });
        PendingImportBatch batch = store.beginBatch(List.of(REF));
        assertStoreFailure("DOCUMENT_CANCELLED", () -> store.stage(
                REF, item(PDF.length), new ByteArrayInputStream(PDF), cancelled::get));
        assertTrue(Files.exists(dataFile(files)));
        Thread.currentThread().interrupt();
        try {
            store.abortIncompleteBatch(batch.batchRef());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
        assertFalse(Files.exists(dataFile(files)));
        assertFalse(Files.exists(recordFile(files)));
        assertFalse(Files.exists(batchFile(files, batch.batchRef(), ".batch")));
        store.abortIncompleteBatch(batch.batchRef()); // response-loss retry
    }

    @Test public void failedBatchRollbackRemovesEarlierItemsButPreservesCompletedDelivery() throws Exception {
        Path files = Files.createTempDirectory("pending-import-failed-batch-rollback");
        String second = "d1_zyxwvutsrqponmlkjihgfe";
        String completedRef = "d1_mnopqrstuvabcdefghijkl";
        OwnedPendingImportStore store = store(files);
        PendingImportBatch complete = store.beginBatch(List.of(completedRef));
        store.stage(completedRef, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        store.completeBatch(complete.batchRef(), complete.refs());
        PendingImportBatch failed = store.beginBatch(List.of(REF, second));
        store.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        assertStoreFailure("DOCUMENT_FAILED", () -> store.stage(
                second, item(PDF.length), new FailingInputStream(0), () -> false));
        store.abortIncompleteBatch(failed.batchRef());
        store.abortIncompleteBatch(complete.batchRef());
        assertFalse(Files.exists(dataFile(files)));
        assertFalse(Files.exists(recordFile(files)));
        assertFalse(Files.exists(batchFile(files, failed.batchRef(), ".batch")));
        assertEquals(List.of(completedRef), store.takeCompleteBatch(100).refs());
        assertEquals(completedRef, store.load(completedRef).ref());
    }

    @Test public void restartExpiresAbandonedIncompleteBytesButKeepsCompletedBatch() throws Exception {
        Path files = Files.createTempDirectory("pending-import-abandoned-recovery");
        AtomicLong clock = new AtomicLong(1234);
        String completedRef = "d1_zyxwvutsrqponmlkjihgfe";
        OwnedPendingImportStore store = new OwnedPendingImportStore(files,
                required -> required + 1_000_000, clock::get, checkpoint -> {});
        PendingImportBatch abandoned = store.beginBatch(List.of(REF));
        store.stage(REF, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        Files.delete(recordFile(files)); // process death before the metadata publish
        PendingImportBatch complete = store.beginBatch(List.of(completedRef));
        store.stage(completedRef, item(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        store.completeBatch(complete.batchRef(), complete.refs());
        clock.addAndGet(OwnedPendingImportStore.INCOMPLETE_BATCH_MAX_AGE_MILLIS);
        OwnedPendingImportStore restarted = new OwnedPendingImportStore(files,
                required -> required + 1_000_000, clock::get, checkpoint -> {});
        assertEquals(complete.batchRef(), restarted.takeCompleteBatch(100).batchRef());
        assertFalse(Files.exists(dataFile(files)));
        assertFalse(Files.exists(batchFile(files, abandoned.batchRef(), ".batch")));
        assertEquals(completedRef, restarted.load(completedRef).ref());
    }

    @Test public void rollbackRefusesLinksBeforeDeletingAnyBatchChild() throws Exception {
        Path files = Files.createTempDirectory("pending-import-rollback-link");
        OwnedPendingImportStore store = store(files);
        PendingImportBatch batch = store.beginBatch(List.of(REF));
        Path outside = files.resolve("unrelated.pdf");
        Files.write(outside, PDF);
        Files.createSymbolicLink(dataFile(files), outside);
        assertStoreFailure("DOCUMENT_UNSAFE_STATE", () -> store.abortIncompleteBatch(batch.batchRef()));
        assertArrayEquals(PDF, Files.readAllBytes(outside));
        assertTrue(Files.isSymbolicLink(dataFile(files)));
        assertTrue(Files.exists(batchFile(files, batch.batchRef(), ".batch")));
    }


    private static OwnedPendingImportStore store(Path files) {
        return new OwnedPendingImportStore(
                files, required -> required + 1_000_000, () -> 1234L, checkpoint -> {});
    }

    private static AndroidDocumentIngressPolicy.ValidatedItem item(long size) throws Exception {
        AndroidDocumentIngressPolicy policy = new AndroidDocumentIngressPolicy();
        return policy.validate(AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(new AndroidDocumentIngressPolicy.Candidate(
                        "transient-source", "content", AndroidDocumentIngressPolicy.MIME_PDF,
                        size, true, true,
                        new byte[] {0x25, 0x50, 0x44, 0x46, 0x2d})))
                .items().get(0);
    }

    private static Path root(Path files) {
        return files.resolve("pdfchef_pending_imports");
    }

    private static Path dataFile(Path files) {
        return root(files).resolve("data").resolve("abcdefghijklmnopqrstuv.bin");
    }

    private static Path recordFile(Path files) {
        return root(files).resolve("records").resolve("abcdefghijklmnopqrstuv.pending");
    }

    private static Path batchFile(Path files, String batchRef, String suffix) {
        return root(files).resolve("batches").resolve(batchRef.substring(3) + suffix);
    }

    private static Path acknowledgementFile(Path files, String batchRef, String suffix) {
        return root(files).resolve("acknowledged").resolve(batchRef.substring(3) + suffix);
    }

    private static void assertNoTemporaryFiles(Path files) throws IOException {
        if (!Files.exists(root(files))) return;
        try (var paths = Files.walk(root(files))) {
            assertFalse(paths.anyMatch(path -> path.getFileName().toString().endsWith(".tmp")));
        }
    }

    private static String treeText(Path files) throws IOException {
        StringBuilder result = new StringBuilder();
        try (var paths = Files.walk(files)) {
            for (Path path : paths.toList()) {
                result.append(path.getFileName()).append('\n');
                if (Files.isRegularFile(path)) {
                    result.append(new String(Files.readAllBytes(path), StandardCharsets.ISO_8859_1));
                }
            }
        }
        return result.toString();
    }

    private static void assertStoreFailure(String code, ThrowingRunnable runnable) {
        try {
            runnable.run();
            fail("Expected " + code);
        } catch (OwnedPendingImportStore.Failure failure) {
            assertEquals(code, failure.code());
            assertNotNull(failure.getMessage());
        } catch (Exception unexpected) {
            throw new AssertionError(unexpected);
        }
    }

    private static final class FailingInputStream extends InputStream {
        private final int bytesBeforeFailure;
        private int emitted;
        int readCalls;

        FailingInputStream(int bytesBeforeFailure) {
            this.bytesBeforeFailure = bytesBeforeFailure;
        }

        @Override public int read() throws IOException {
            readCalls++;
            if (emitted >= bytesBeforeFailure) throw new IOException("sensitive provider failure");
            emitted++;
            return PDF[emitted - 1] & 0xff;
        }

        @Override public int read(byte[] target, int offset, int length) throws IOException {
            readCalls++;
            if (emitted >= bytesBeforeFailure) throw new IOException("sensitive provider failure");
            int count = Math.min(length, bytesBeforeFailure - emitted);
            System.arraycopy(PDF, emitted, target, offset, count);
            emitted += count;
            return count;
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
