package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import android.net.Uri;
import java.lang.reflect.Modifier;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderDocumentSession;
import org.junit.Test;

public final class DocumentLifecycleCoordinatorTest {
    private static final byte[] PDF = "%PDF-1.7\ncoordinator\n%%EOF"
            .getBytes(StandardCharsets.US_ASCII);

    @Test public void constructionIsIoFreeAndOneCoordinatorOwnsExactlyOneServiceInstance()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-constructor");
        Components components = components(files);
        new DocumentLifecycleCoordinator(files, components.pending, components.picker,
                components.writer,
                components.exporter, components.sharer, components.legacy);
        assertEquals(0, Files.list(files).count());
        for (var field : DocumentLifecycleCoordinator.class.getDeclaredFields()) {
            assertFalse("No static service owner: " + field,
                    Modifier.isStatic(field.getModifiers())
                            && (field.getType().getName().contains("Coordinator")
                            || field.getType().getName().contains("Store")));
        }
    }

    @Test public void ownedWriteExportAndShareStayBehindSingleLock() throws Exception {
        Path files = Files.createTempDirectory("coordinator-owned");
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);
        DocumentLifecycleCoordinator.WriteSession session = coordinator.beginWrite(
                AndroidDocumentIngressPolicy.MIME_PDF);
        coordinator.appendWrite(session.sessionId(), PDF, () -> false);
        DocumentLifecycleCoordinator.DocumentRecord document = coordinator.finishWrite(
                session.sessionId(), () -> false);
        assertTrue(document.ref().startsWith("d1_"));
        assertEquals(PDF.length, document.sizeBytes());
        assertTrue(coordinator.exportDocument(document.ref(), "owned.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertEquals(1, components.destination.rows.size());

        DocumentLifecycleCoordinator.ShareHandle share = coordinator.prepareShare(document.ref(),
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
        Path stage = coordinator.stagedSharePath(share);
        assertTrue(stage.startsWith(files.resolve("pdfchef_documents/share")));
        coordinator.cancelShareBeforeDispatch(share);
        assertFalse(Files.exists(stage));
    }

    @Test public void ownedReadChunkIsBoundedClonedAndHasExactEof() throws Exception {
        Path files = Files.createTempDirectory("coordinator-owned-read");
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);
        DocumentLifecycleCoordinator.WriteSession session = coordinator.beginWrite(
                AndroidDocumentIngressPolicy.MIME_PDF);
        coordinator.appendWrite(session.sessionId(), PDF, () -> false);
        DocumentLifecycleCoordinator.DocumentRecord document = coordinator.finishWrite(
                session.sessionId(), () -> false);

        DocumentLifecycleCoordinator.ReadChunk first = coordinator.readChunk(
                document.ref(), 0, 5);
        assertArrayEquals(java.util.Arrays.copyOf(PDF, 5), first.bytes());
        assertEquals(5, first.nextOffset());
        assertFalse(first.done());
        byte[] mutated = first.bytes();
        mutated[0] = 0;
        assertEquals('%', first.bytes()[0]);
        DocumentLifecycleCoordinator.ReadChunk eof = coordinator.readChunk(
                document.ref(), PDF.length, 1);
        assertEquals(0, eof.bytes().length);
        assertEquals(PDF.length, eof.nextOffset());
        assertTrue(eof.done());
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.readChunk(document.ref(), PDF.length + 1L, 1));
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.readChunk(document.ref(), 0, 524_289));
    }

    @Test public void durableOwnedListingReaderSnapshotAndDeleteSurviveJsDeliveryLoss()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-reader-owned");
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);
        DocumentLifecycleCoordinator.WriteSession write = coordinator.beginWrite(
                "Scanned document.pdf", AndroidDocumentIngressPolicy.MIME_PDF);
        coordinator.appendWrite(write.sessionId(), PDF, () -> false);
        DocumentLifecycleCoordinator.DocumentRecord completed = coordinator.finishWrite(
                write.sessionId(), () -> false);

        List<DocumentLifecycleCoordinator.DocumentRecord> relaunched =
                coordinator.listOwnedDocuments();
        assertEquals(1, relaunched.size());
        assertEquals(completed.ref(), relaunched.get(0).ref());
        PdfReaderDocumentSession reader = coordinator.prepareReader(completed.ref(),
                "Scanned document.pdf");
        assertEquals(PDF.length, reader.sizeBytes());
        reader.close();
        assertTrue(coordinator.deleteOwnedDocument(completed.ref()));
        assertFalse(coordinator.deleteOwnedDocument(completed.ref()));
        assertEquals(0, coordinator.listOwnedDocuments().size());
        assertEquals(0, coordinator.clearOwnedDocuments());
    }

    @Test public void ownedRenamePreservesIdentityAndLegacyRenameIsRefused()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-rename-owned");
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);
        DocumentLifecycleCoordinator.WriteSession session = coordinator.beginWrite(
                "Original.pdf", AndroidDocumentIngressPolicy.MIME_PDF);
        coordinator.appendWrite(session.sessionId(), PDF, () -> false);
        DocumentLifecycleCoordinator.DocumentRecord original = coordinator.finishWrite(
                session.sessionId(), () -> false);
        DocumentLifecycleCoordinator.DocumentRecord renamed = coordinator.renameOwnedDocument(
                original.ref(), "Renamed.pdf");
        assertEquals(original.ref(), renamed.ref());
        assertEquals("Renamed.pdf", renamed.displayName());
        assertEquals(original.mimeType(), renamed.mimeType());
        assertEquals(original.sizeBytes(), renamed.sizeBytes());
        assertEquals(original.contentHash(), renamed.contentHash());
        assertEquals(original.createdAtMillis(), renamed.createdAtMillis());
        assertEquals("Renamed.pdf", coordinator.listOwnedDocuments().get(0).displayName());
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.renameOwnedDocument("a1_1", "Legacy.pdf"));
    }

    @Test public void ownedUndoClosesTheExactReadCursorAndLegacyIsRefused()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-undo-owned");
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);
        DocumentLifecycleCoordinator.WriteSession session = coordinator.beginWrite(
                "Original.pdf", AndroidDocumentIngressPolicy.MIME_PDF);
        coordinator.appendWrite(session.sessionId(), PDF, () -> false);
        DocumentLifecycleCoordinator.DocumentRecord original = coordinator.finishWrite(
                session.sessionId(), () -> false);
        assertEquals(5, coordinator.readChunk(original.ref(), 0, 5).nextOffset());

        DocumentLifecycleCoordinator.UndoReceipt undo = coordinator.trashOwnedDocument(
                original.ref());
        assertTrue(undo.undoRef().startsWith("u1_"));
        assertEquals(10 + OwnedDocumentWriter.UNDO_EXPIRY_MILLIS, undo.expiresAt());
        assertTrue(coordinator.listOwnedDocuments().isEmpty());
        coordinator.restoreOwnedDocument(undo.undoRef());
        coordinator.restoreOwnedDocument(undo.undoRef());
        assertEquals(original.ref(), coordinator.listOwnedDocuments().get(0).ref());
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.trashOwnedDocument("a1_1"));
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.restoreOwnedDocument("u1_short"));
    }

    @Test public void legacyReadChunkUsesOpaqueRefAndRejectsCollection() throws Exception {
        Path files = Files.createTempDirectory("coordinator-legacy-read");
        Path processed = Files.createDirectory(files.resolve("processed"));
        Files.write(processed.resolve("legacy.pdf"), PDF);
        Files.createDirectory(processed.resolve("album"));
        String index = "[{\"id\":7,\"displayName\":\"Legacy\",\"toolName\":\"VIEW\"," 
                + "\"sizeBytes\":" + PDF.length + ",\"createdAtMillis\":1,"
                + "\"storedFileName\":\"legacy.pdf\",\"mimeType\":\"application/pdf\","
                + "\"isDirectory\":false},{\"id\":8,\"displayName\":\"Album\","
                + "\"toolName\":\"MERGE\",\"sizeBytes\":1,\"createdAtMillis\":1,"
                + "\"storedFileName\":\"album\",\"mimeType\":\"application/pdf\","
                + "\"isDirectory\":true,\"itemCount\":1}]";
        Files.write(files.resolve("processed_index.json"), index.getBytes(StandardCharsets.UTF_8));
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, new LegacyDocumentOpenResolver(files.toFile()));
        DocumentLifecycleCoordinator.ReadChunk chunk = coordinator.readChunk("a1_7", 0, 9);
        assertArrayEquals(java.util.Arrays.copyOf(PDF, 9), chunk.bytes());
        assertFailure("DOCUMENT_COLLECTION_UNSUPPORTED",
                () -> coordinator.readChunk("a1_8", 0, 1));
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.readChunk("content://private/legacy.pdf", 0, 1));
    }

    @Test public void rawRefsAreRejectedWhileLegacyCollectionsExportAndShareInternally()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-refs");
        Path processed = Files.createDirectory(files.resolve("processed"));
        Path album = Files.createDirectory(processed.resolve("album"));
        Files.write(album.resolve("page-1.pdf"), PDF);
        String index = "[{\"id\":1,\"displayName\":\"Album\",\"toolName\":\"MERGE\","
                + "\"sizeBytes\":" + PDF.length + ",\"createdAtMillis\":1,\"storedFileName\":\"album\","
                + "\"mimeType\":\"application/pdf\",\"isDirectory\":true,\"itemCount\":1}]";
        Files.write(files.resolve("processed_index.json"),
                index.getBytes(StandardCharsets.UTF_8));
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, new LegacyDocumentOpenResolver(files.toFile()));

        AndroidDocumentsPlugin.DeliveryRequest collectionRequest =
                AndroidDocumentsPlugin.deliveryRequestValues(
                        "a1_1", true, "Album", false, null);
        assertEquals("a1_1", collectionRequest.ref());
        assertEquals("Album", collectionRequest.displayName());
        assertEquals(null, collectionRequest.mimeType());
        assertEquals(null, AndroidDocumentsPlugin.deliveryRequestValues(
                "d1_abcdefghijklmnopqrstuv", true, "Folder", false, null));

        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> coordinator.retainPending("a1_1", () -> false));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> coordinator.exportDocument(
                "content://private/document", "x.pdf", AndroidDocumentIngressPolicy.MIME_PDF,
                () -> false));
        assertTrue(coordinator.exportDocument("a1_1", "Album", null, () -> false));
        assertEquals(1, components.destination.rows.size());
        DocumentLifecycleCoordinator.ShareHandle share = coordinator.prepareShare(
                "a1_1", null, () -> false);
        List<Path> stages = coordinator.stagedSharePaths(share);
        assertEquals(1, stages.size());
        assertArrayEquals(PDF, Files.readAllBytes(stages.get(0)));
        coordinator.cancelShareBeforeDispatch(share);
        assertFalse(Files.exists(stages.get(0)));
        assertFailure("DOCUMENT_COLLECTION_UNSUPPORTED", () -> coordinator.prepareShare(
                "a1_1", AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
    }

    @Test public void pendingPeekAndDuplicatePickerResultAfterAcknowledgementAreRetrySafe()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-pending-bridge");
        Components components = components(files);
        String firstRef = "d1_abcdefghijklmnopqrstuv";
        String secondRef = "d1_zyxwvutsrqponmlkjihgfe";
        AndroidDocumentIngressPolicy.ValidatedItem item = pendingItem(PDF.length);
        components.pending.stage(firstRef, item, new ByteArrayInputStream(PDF), () -> false);
        components.pending.stage(secondRef, item, new ByteArrayInputStream(PDF), () -> false);
        PendingImportBatch batch = components.pending.beginBatch(List.of(secondRef, firstRef));
        components.pending.completeBatch(batch.batchRef(), List.of(secondRef, firstRef));
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);

        DocumentLifecycleCoordinator.PendingImportBatchRecords firstPeek =
                coordinator.takePendingImports(100);
        DocumentLifecycleCoordinator.PendingImportBatchRecords secondPeek =
                coordinator.takePendingImports(100);
        assertEquals(batch.batchRef(), firstPeek.batchRef());
        assertEquals(2, firstPeek.records().size());
        assertEquals(secondRef, firstPeek.records().get(0).ref());
        assertEquals(firstPeek.records().get(0).ref(), secondPeek.records().get(0).ref());
        assertEquals(firstPeek.records().get(1).ref(), secondPeek.records().get(1).ref());
        assertEquals(2, components.pending.listPending().size());

        List<String> refs = firstPeek.records().stream().map(
                DocumentLifecycleCoordinator.DocumentRecord::ref).toList();
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> coordinator.acknowledgePendingImports(
                batch.batchRef(), List.of(firstRef, secondRef), () -> false));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> coordinator.acknowledgePendingImports(
                batch.batchRef(), List.of(secondRef), () -> false));
        assertEquals(2, coordinator.acknowledgePendingImports(batch.batchRef(), refs, () -> false));
        assertEquals(0, components.pending.listPending().size());
        assertEquals(2, coordinator.listOwnedDocuments().size());
        assertEquals(refs, components.pending.loadAcknowledgedBatch(batch.batchRef()).refs());
        try {
            components.pending.loadCompleteBatch(batch.batchRef());
            fail("Expected cleaned live manifest");
        } catch (OwnedPendingImportStore.Failure expected) {
            assertEquals("DOCUMENT_NOT_FOUND", expected.code());
        }
        PendingImportBatch replay = components.pending.beginBatch(refs);
        assertTrue(replay.isAcknowledged());
        assertEquals(batch.batchRef(), replay.batchRef());
        assertEquals(0, components.pending.listPending().size());
        assertEquals(2, coordinator.pendingImportsForBatch(batch.batchRef()).size());
        assertEquals(2, coordinator.listOwnedDocuments().size());
        assertEquals(2, coordinator.acknowledgePendingImports(batch.batchRef(), refs, () -> false));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () ->
                coordinator.acknowledgePendingImports(batch.batchRef(),
                        List.of(firstRef, firstRef), () -> false));
    }

    @Test public void corruptLaterPendingItemDoesNotPartiallyPromoteEarlierItems()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-pending-preflight");
        Components components = components(files);
        String firstRef = "d1_abcdefghijklmnopqrstuv";
        String secondRef = "d1_zyxwvutsrqponmlkjihgfe";
        AndroidDocumentIngressPolicy.ValidatedItem item = pendingItem(PDF.length);
        components.pending.stage(firstRef, item, new ByteArrayInputStream(PDF), () -> false);
        components.pending.stage(secondRef, item, new ByteArrayInputStream(PDF), () -> false);
        PendingImportBatch batch = components.pending.beginBatch(List.of(firstRef, secondRef));
        components.pending.completeBatch(batch.batchRef(), List.of(firstRef, secondRef));
        Path corruptData = files.resolve(
                "pdfchef_pending_imports/data/zyxwvutsrqponmlkjihgfe.bin");
        byte[] corrupt = PDF.clone();
        corrupt[corrupt.length - 1] ^= 1;
        Files.write(corruptData, corrupt);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, components.legacy);

        assertFailure("DOCUMENT_CORRUPT", () -> coordinator.acknowledgePendingImports(
                batch.batchRef(), List.of(firstRef, secondRef), () -> false));

        assertTrue(components.pending.hasPendingMarker(firstRef));
        assertTrue(components.pending.hasPendingMarker(secondRef));
        assertEquals(0, coordinator.listOwnedDocuments().size());
    }

    @Test public void directReaderFailuresKeepTheirOperationalMessages() throws Exception {
        Method fixed = DocumentLifecycleCoordinator.class.getDeclaredMethod(
                "fixedMessage", String.class);
        fixed.setAccessible(true);
        assertEquals("The document operation was interrupted.",
                fixed.invoke(null, "DOCUMENT_INTERRUPTED"));
        assertEquals("There is not enough storage.",
                fixed.invoke(null, "DOCUMENT_STORAGE_FULL"));
        assertEquals("The document limit was exceeded.",
                fixed.invoke(null, "DOCUMENT_LIMIT_EXCEEDED"));
        assertEquals("The document operation was cancelled.",
                fixed.invoke(null, "DOCUMENT_CANCELLED"));
    }

    @Test public void ownedReaderHashesDuringItsSingleSnapshotPassAndStillRejectsCorruption()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-reader-pass");
        byte[] largePdf = new byte[OwnedDocumentWriter.MAXIMUM_CHUNK_BYTES + 37];
        java.util.Arrays.fill(largePdf, (byte) 'x');
        System.arraycopy("%PDF-1.7\n".getBytes(StandardCharsets.US_ASCII), 0, largePdf, 0, 9);
        AtomicInteger fullValidationPasses = new AtomicInteger();
        AtomicInteger readerWindows = new AtomicInteger();
        ArrayDeque<String> tokens = new ArrayDeque<>(List.of(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"));
        OwnedDocumentWriter writer = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, () -> 10, tokens::removeFirst,
                checkpoint -> {
                    if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_TARGET_DIGEST) {
                        fullValidationPasses.incrementAndGet();
                    } else if (checkpoint
                            == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_READER_SOURCE_READ) {
                        readerWindows.incrementAndGet();
                    }
                });
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, writer, components.exporter,
                components.sharer, components.legacy);
        DocumentLifecycleCoordinator.WriteSession write = coordinator.beginWrite(
                "Large.pdf", AndroidDocumentIngressPolicy.MIME_PDF);
        coordinator.appendWrite(write.sessionId(),
                java.util.Arrays.copyOfRange(largePdf, 0,
                        OwnedDocumentWriter.MAXIMUM_CHUNK_BYTES), () -> false);
        coordinator.appendWrite(write.sessionId(),
                java.util.Arrays.copyOfRange(largePdf,
                        OwnedDocumentWriter.MAXIMUM_CHUNK_BYTES, largePdf.length), () -> false);
        DocumentLifecycleCoordinator.DocumentRecord document = coordinator.finishWrite(
                write.sessionId(), () -> false);
        fullValidationPasses.set(0);
        readerWindows.set(0);

        PdfReaderDocumentSession reader = coordinator.prepareReader(document.ref(), "Large.pdf");
        reader.close();
        assertEquals(0, fullValidationPasses.get());
        assertEquals(2, readerWindows.get());

        Path payload = files.resolve("pdfchef_documents/owned")
                .resolve(document.ref().substring(3) + ".bin");
        byte[] corrupt = Files.readAllBytes(payload);
        corrupt[corrupt.length - 1] ^= 1;
        Files.write(payload, corrupt);
        assertFailure("DOCUMENT_CORRUPT",
                () -> coordinator.prepareReader(document.ref(), "Large.pdf"));
    }

    @Test public void readerCopyDoesNotHoldTheCoordinatorLockAndAlwaysClosesLegacySource()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-reader-lock");
        Path processed = Files.createDirectory(files.resolve("processed"));
        Files.write(processed.resolve("legacy.pdf"), PDF);
        String index = "[{\"id\":7,\"displayName\":\"Legacy\",\"toolName\":\"VIEW\","
                + "\"sizeBytes\":" + PDF.length + ",\"createdAtMillis\":1,"
                + "\"storedFileName\":\"legacy.pdf\",\"mimeType\":\"application/pdf\","
                + "\"isDirectory\":false}]";
        Files.write(files.resolve("processed_index.json"),
                index.getBytes(StandardCharsets.UTF_8));
        CountDownLatch copyEntered = new CountDownLatch(1);
        CountDownLatch allowCopy = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        LegacyDocumentOpenResolver resolver = new LegacyDocumentOpenResolver(files.toFile(),
                new BoundedDocumentReader(), checkpoint -> {
            if (checkpoint == LegacyDocumentOpenResolver.SourceCheckpoint.READ) {
                copyEntered.countDown();
                try {
                    if (!allowCopy.await(5, TimeUnit.SECONDS)) throw new IOException("timeout");
                } catch (InterruptedException failure) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted", failure);
                }
            } else if (checkpoint == LegacyDocumentOpenResolver.SourceCheckpoint.CLOSE) {
                closes.incrementAndGet();
            }
        });
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, resolver);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<PdfReaderDocumentSession> preparing = executor.submit(
                    () -> coordinator.prepareReader("a1_7", "Legacy.pdf"));
            assertTrue(copyEntered.await(5, TimeUnit.SECONDS));
            Future<List<DocumentLifecycleCoordinator.DocumentRecord>> listing =
                    executor.submit(coordinator::listOwnedDocuments);
            assertEquals(0, listing.get(2, TimeUnit.SECONDS).size());
            allowCopy.countDown();
            PdfReaderDocumentSession session = preparing.get(5, TimeUnit.SECONDS);
            session.close();
            assertEquals(1, closes.get());
        } finally {
            allowCopy.countDown();
            executor.shutdownNow();
        }
    }

    @Test public void legacyExportUsesVerifiedFixedSnapshotAndRemovesPriorOrphan()
            throws Exception {
        Path files = Files.createTempDirectory("coordinator-legacy-snapshot");
        Path processed = Files.createDirectory(files.resolve("processed"));
        Files.write(processed.resolve("legacy.pdf"), PDF);
        String index = "[{\"id\":7,\"displayName\":\"Legacy\",\"toolName\":\"VIEW\","
                + "\"sizeBytes\":" + PDF.length + ",\"createdAtMillis\":1,"
                + "\"storedFileName\":\"legacy.pdf\",\"mimeType\":\"application/pdf\","
                + "\"isDirectory\":false}]";
        Files.write(files.resolve("processed_index.json"), index.getBytes(StandardCharsets.UTF_8));
        Path snapshots = Files.createDirectories(
                files.resolve("pdfchef_documents/legacy_snapshots"));
        Files.write(snapshots.resolve("current.snapshot"), new byte[] {1, 2, 3});
        byte[] before = Files.readAllBytes(processed.resolve("legacy.pdf"));
        Components components = components(files);
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(files,
                components.pending, components.picker, components.writer, components.exporter,
                components.sharer, new LegacyDocumentOpenResolver(files.toFile()));
        assertTrue(coordinator.exportDocument("a1_7", "legacy.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false));
        assertEquals(1, components.destination.rows.size());
        assertFalse(Files.exists(snapshots.resolve("current.snapshot")));
        assertFalse(Files.exists(snapshots.resolve("current.part")));
        assertTrue(java.util.Arrays.equals(before,
                Files.readAllBytes(processed.resolve("legacy.pdf"))));
    }

    private static Components components(Path files) {
        ArrayDeque<String> writerTokens = new ArrayDeque<>(List.of(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                "mnopqrstuvabcdefghijkl"));
        OwnedPendingImportStore pending = new OwnedPendingImportStore(files,
                required -> required + 1_000_000, () -> 10, ignored -> {});
        AndroidDocumentPickerController picker = new AndroidDocumentPickerController(
                new UnavailableResolver(), pending, new PickerRequestPolicy(() ->
                        "abcdefghijklmnopqrstuv"), new AndroidDocumentIngressPolicy());
        OwnedDocumentWriter writer = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, () -> 10, writerTokens::removeFirst,
                ignored -> {});
        FakeDestination destination = new FakeDestination();
        AndroidDocumentExporter exporter = new AndroidDocumentExporter(files, destination,
                () -> 10, () -> "abcdefghijklmnopqrstuv",
                required -> required + 1_000_000, ignored -> {});
        AndroidDocumentSharer sharer = new AndroidDocumentSharer(files,
                "com.dhananjaytech.pdfchef.debug.fileprovider", () -> 10,
                () -> "abcdefghijklmnopqrstuv", required -> required + 1_000_000,
                ignored -> {});
        return new Components(pending, picker, writer, exporter, sharer,
                new LegacyDocumentOpenResolver(files.toFile()), destination);
    }

    private static AndroidDocumentIngressPolicy.ValidatedItem pendingItem(long size)
            throws Exception {
        return new AndroidDocumentIngressPolicy().validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW,
                false,
                List.of(new AndroidDocumentIngressPolicy.Candidate(
                        "content://test/document",
                        "content",
                        AndroidDocumentIngressPolicy.MIME_PDF,
                        size,
                        true,
                        true,
                        PDF))).items().get(0);
    }

    private static void assertFailure(String code, ThrowingRunnable action) {
        try { action.run(); fail("Expected " + code); }
        catch (DocumentLifecycleCoordinator.Failure failure) { assertEquals(code, failure.code()); }
        catch (Exception failure) { throw new AssertionError(failure); }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
    private record Components(OwnedPendingImportStore pending, AndroidDocumentPickerController picker,
            OwnedDocumentWriter writer,
            AndroidDocumentExporter exporter, AndroidDocumentSharer sharer,
            LegacyDocumentOpenResolver legacy, FakeDestination destination) { }

    private static final class UnavailableResolver
            implements AndroidDocumentPickerController.Resolver {
        @Override public String mimeType(Uri uri) { return null; }
        @Override public long sizeBytes(Uri uri) throws IOException { throw new IOException(); }
        @Override public InputStream open(Uri uri) throws IOException { throw new IOException(); }
        @Override public void takePersistableReadPermission(Uri uri) { }
    }

    private static final class FakeDestination implements AndroidDocumentExporter.Destination {
        final Map<String, Row> rows = new HashMap<>();
        @Override public String allocate(String token, String mimeType) {
            String address = "content://fake/" + token;
            rows.put(address, new Row()); return address;
        }
        @Override public Output open(String address) {
            Row row = rows.get(address); ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            return new Output() {
                @Override public void write(byte[] source, int offset, int length) {
                    bytes.write(source, offset, length);
                }
                @Override public void force() { row.forced = true; }
                @Override public void close() { row.bytes = bytes.toByteArray(); }
            };
        }
        @Override public String publish(String address, String name, String mime, long size)
                throws IOException {
            Row row = rows.get(address);
            if (!row.forced || row.bytes.length != size) throw new IOException("bad row");
            row.pending = false; row.name = name;
            return name;
        }
        @Override public String rename(String address, String name) {
            rows.get(address).name = name; return name;
        }
        @Override public AndroidDocumentExporter.PublicationState publicationState(String address) {
            return rows.get(address).pending ? AndroidDocumentExporter.PublicationState.PENDING
                    : AndroidDocumentExporter.PublicationState.PUBLISHED;
        }
        @Override public void deleteAddress(String address) { rows.remove(address); }
        @Override public void deletePendingToken(String token) {
            rows.remove("content://fake/" + token);
        }
        private static final class Row {
            boolean pending = true; boolean forced; byte[] bytes = new byte[0]; String name;
        }
    }
}
