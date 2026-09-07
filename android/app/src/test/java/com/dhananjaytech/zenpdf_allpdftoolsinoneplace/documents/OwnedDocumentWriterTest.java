package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.security.MessageDigest;
import org.junit.Test;

public final class OwnedDocumentWriterTest {
    private static final byte[] PDF = "%PDF-1.7\nowned writer\n%%EOF"
            .getBytes(StandardCharsets.US_ASCII);

    @Test public void constructorIsIoFreeAndFinishIsIdempotent() throws Exception {
        Path files = Files.createTempDirectory("owned-writer");
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        assertEquals(0, Files.list(files).count());

        OwnedDocumentWriter.BeginResult session = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF);
        assertTrue(session.sessionId.startsWith("w1_"));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> writer.append(
                "s1_abcdefghijklmnopqrstuv", PDF, () -> false));
        assertEquals(OwnedDocumentWriter.MAXIMUM_CHUNK_BYTES, session.maximumChunkBytes);
        assertEquals(PDF.length, writer.append(session.sessionId, PDF, () -> false));
        OwnedDocumentWriter.OwnedDocument first = writer.finish(session.sessionId, () -> false);
        OwnedDocumentWriter.OwnedDocument retry = writer.finish(session.sessionId, () -> false);
        assertEquals(first, retry);
        assertTrue(first.ref.startsWith("d1_"));
        assertEquals(PDF.length, first.sizeBytes);

        OwnedDocumentWriter.DocumentSource source = writer.source(first.ref);
        byte[] read = new byte[PDF.length];
        assertEquals(PDF.length, source.read(0, read));
        assertArrayEquals(PDF, read);
        writer.abort(session.sessionId);
        assertEquals(first, writer.loadOwned(first.ref));
    }

    @Test public void transientOutputCanBeDeliveredButNeverListedAndIsRemovedOnRestart() throws Exception {
        Path files = Files.createTempDirectory("owned-transient");
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = writer.begin("output.pdf", "application/pdf").sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument output = writer.finish(session, true, () -> false);
        assertTrue(writer.listOwned().isEmpty());
        try (OwnedDocumentWriter.DocumentSource source = writer.source(output.ref)) {
            byte[] bytes = new byte[PDF.length];
            assertEquals(PDF.length, source.read(0, bytes));
            assertArrayEquals(PDF, bytes);
        }
        assertEquals(output, writer.finish(session, true, () -> false));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> writer.finish(session, false, () -> false));
        OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
        assertTrue(restarted.listOwned().isEmpty());
        assertFailure("DOCUMENT_NOT_FOUND", () -> restarted.loadOwned(output.ref));
        assertFalse(Files.exists(files.resolve("pdfchef_documents/owned/zyxwvutsrqponmlkjihgfe.bin")));
        assertFalse(Files.exists(files.resolve("pdfchef_documents/operations/" + session + ".transient")));
    }

    @Test public void transientProcessDeathAtEachPublicationBoundaryCannotCreateRecentHistory() throws Exception {
        for (OwnedDocumentWriter.Checkpoint boundary : List.of(
                OwnedDocumentWriter.Checkpoint.AFTER_TRANSIENT_MARKER,
                OwnedDocumentWriter.Checkpoint.AFTER_FINISH_INTENT,
                OwnedDocumentWriter.Checkpoint.AFTER_FINISH_DATA_MOVE,
                OwnedDocumentWriter.Checkpoint.AFTER_OWNED_RECORD_PUBLISH)) {
            Path files = Files.createTempDirectory("owned-transient-interrupted");
            OwnedDocumentWriter ordinary = writer(files, tokens("abcdefghijklmnopqrstuv",
                    "zyxwvutsrqponmlkjihgfe"), ignored -> {});
            String keptSession = ordinary.begin("application/pdf").sessionId;
            ordinary.append(keptSession, PDF, () -> false);
            OwnedDocumentWriter.OwnedDocument kept = ordinary.finish(keptSession, () -> false);
            OwnedDocumentWriter crashing = writer(files, tokens("mnopqrstuvabcdefghijkl",
                    "ponmlkjihgfezyxwvutsrq"), checkpoint -> {
                if (checkpoint == boundary) throw new AssertionError("process death");
            });
            String session = crashing.begin("application/pdf").sessionId;
            crashing.append(session, PDF, () -> false);
            try {
                crashing.finish(session, true, () -> false);
                fail("Expected interruption at " + boundary);
            } catch (AssertionError expected) {
                assertEquals("process death", expected.getMessage());
            }
            OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
            assertEquals(List.of(kept), restarted.listOwned());
            assertFalse(Files.exists(files.resolve("pdfchef_documents/owned/ponmlkjihgfezyxwvutsrq.bin")));
            assertFalse(Files.exists(files.resolve("pdfchef_documents/sessions/" + session + ".part")));
            assertFalse(Files.exists(files.resolve("pdfchef_documents/operations/" + session + ".finish")));
            assertFalse(Files.exists(files.resolve("pdfchef_documents/operations/" + session + ".transient")));
        }
    }

    @Test public void explicitTransientCleanupRemovesRecoveryMarkerImmediately() throws Exception {
        Path files = Files.createTempDirectory("owned-transient-delete");
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = writer.begin("application/pdf").sessionId;
        writer.append(session, PDF, () -> false);
        String ref = writer.finish(session, true, () -> false).ref;
        assertTrue(writer.deleteOwned(ref));
        assertTrue(writer.listOwned().isEmpty());
        assertFalse(Files.exists(files.resolve("pdfchef_documents/operations/" + session + ".transient")));
    }

    @Test public void sourceUsesOneIntegrityPassAndOnePinnedChannelAcrossSequentialReads()
            throws Exception {
        Path files = Files.createTempDirectory("owned-source-session");
        AtomicInteger digests = new AtomicInteger();
        AtomicInteger opens = new AtomicInteger();
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe"), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_TARGET_DIGEST) {
                digests.incrementAndGet();
            }
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_SOURCE_OPEN) {
                opens.incrementAndGet();
            }
        });
        String session = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        digests.set(0);
        opens.set(0);

        OwnedDocumentWriter.DocumentSource source = writer.source(document.ref);
        byte[] first = new byte[5];
        byte[] second = new byte[PDF.length - first.length];
        assertEquals(first.length, source.read(0, first));
        assertEquals(second.length, source.read(first.length, second));
        source.close();
        assertEquals(1, digests.get());
        assertEquals(1, opens.get());
        assertArrayEquals(java.util.Arrays.copyOfRange(PDF, 0, 5), first);
        assertArrayEquals(java.util.Arrays.copyOfRange(PDF, 5, PDF.length), second);
    }

    @Test public void readerSourceNormalizesPinnedOpenAndSequentialReadInterruption()
            throws Exception {
        Path files = Files.createTempDirectory("owned-reader-interruption");
        OwnedDocumentWriter original = writer(files,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = original.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        original.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = original.finish(session, () -> false);

        OwnedDocumentWriter interruptedOpen = writer(files, tokens(), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_SOURCE_OPEN) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted open");
            }
        });
        assertFailure("DOCUMENT_INTERRUPTED", () -> interruptedOpen.readerSource(document.ref));
        assertTrue(Thread.interrupted());

        OwnedDocumentWriter interruptedRead = writer(files, tokens(), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_READER_SOURCE_READ) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted read");
            }
        });
        OwnedDocumentWriter.DocumentSource source = interruptedRead.readerSource(document.ref);
        try {
            assertFailure("DOCUMENT_INTERRUPTED", () -> source.read(0, new byte[PDF.length]));
            assertTrue(Thread.interrupted());
        } finally {
            source.close();
        }
    }

    @Test public void interruptedAppendNeverReplaysOrDuplicatesTail() throws Exception {
        Path files = Files.createTempDirectory("owned-interrupted-append");
        AtomicLong clock = new AtomicLong(10);
        OwnedDocumentWriter interrupted = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, clock::get,
                tokens("abcdefghijklmnopqrstuv"), checkpoint -> {
                    if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_APPEND_DATA_FORCE) {
                        throw new IOException("simulated process loss");
                    }
                });
        String session = interrupted.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        assertFailure("DOCUMENT_UNSAFE_STATE",
                () -> interrupted.append(session, PDF, () -> false));

        OwnedDocumentWriter restarted = writer(files, tokens("zyxwvutsrqponmlkjihgfe"),
                ignored -> {});
        assertFailure("DOCUMENT_INTERRUPTED",
                () -> restarted.append(session, PDF, () -> false));
        Path part = files.resolve("pdfchef_documents/sessions/" + session + ".part");
        assertEquals(0, Files.size(part));
    }

    @Test public void finishRecoveryCompletesMovedDataAndReturnsSameRef() throws Exception {
        Path files = Files.createTempDirectory("owned-finish-recovery");
        ArrayDeque<String> tokenValues = new ArrayDeque<>(List.of(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"));
        OwnedDocumentWriter interrupted = writer(files, tokenValues::removeFirst, checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_FINISH_DATA_MOVE) {
                throw new IOException("simulated process loss");
            }
        });
        String session = interrupted.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        interrupted.append(session, PDF, () -> false);
        assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.finish(session, () -> false));

        OwnedDocumentWriter restarted = writer(files, tokens("unusedtokenabcdefghijk"),
                ignored -> {});
        OwnedDocumentWriter.OwnedDocument recovered = restarted.finish(session, () -> false);
        assertEquals("d1_zyxwvutsrqponmlkjihgfe", recovered.ref);
        assertEquals(recovered, restarted.finish(session, () -> false));
    }

    @Test public void finishRecoveryRejectsCorruptedMovedBytesBeforePublishingRecord()
            throws Exception {
        Path files = Files.createTempDirectory("owned-finish-corrupt-recovery");
        OwnedDocumentWriter interrupted = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_FINISH_DATA_MOVE) {
                throw new IOException("simulated process loss");
            }
        });
        String session = interrupted.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        interrupted.append(session, PDF, () -> false);
        assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.finish(session, () -> false));
        Path moved = files.resolve("pdfchef_documents/owned/zyxwvutsrqponmlkjihgfe.bin");
        byte[] corrupt = PDF.clone();
        corrupt[corrupt.length - 1] ^= 1;
        Files.write(moved, corrupt);

        OwnedDocumentWriter restarted = writer(files, tokens("unusedtokenabcdefghijk"),
                ignored -> {});
        assertFailure("DOCUMENT_CORRUPT", () -> restarted.finish(session, () -> false));
        assertFalse(Files.exists(files.resolve(
                "pdfchef_documents/records/zyxwvutsrqponmlkjihgfe.owned")));
    }

    @Test public void identityReplacementDuringRecoveryIsRejected() throws Exception {
        Path files = Files.createTempDirectory("owned-finish-replaced-recovery");
        OwnedDocumentWriter interrupted = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_FINISH_DATA_MOVE) {
                throw new IOException("simulated process loss");
            }
        });
        String session = interrupted.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        interrupted.append(session, PDF, () -> false);
        assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.finish(session, () -> false));
        Path moved = files.resolve("pdfchef_documents/owned/zyxwvutsrqponmlkjihgfe.bin");
        OwnedDocumentWriter restarted = writer(files, tokens("unusedtokenabcdefghijk"),
                checkpoint -> {
                    if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_OWNED_TARGET_DIGEST) {
                        Path replacement = moved.resolveSibling("replacement.bin");
                        Files.write(replacement, PDF);
                        Files.move(replacement, moved, StandardCopyOption.ATOMIC_MOVE,
                                StandardCopyOption.REPLACE_EXISTING);
                    }
                });
        assertFailure("DOCUMENT_CORRUPT", () -> restarted.finish(session, () -> false));
    }

    @Test public void retainPendingMovesSameOwnedFileAndRemovesOnlyMarker() throws Exception {
        Path files = Files.createTempDirectory("owned-retain");
        String ref = "d1_abcdefghijklmnopqrstuv";
        OwnedPendingImportStore pending = new OwnedPendingImportStore(files,
                required -> required + 1_000_000, () -> 99, ignored -> {});
        pending.stage(ref, pendingItem(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        Path source = files.resolve("pdfchef_pending_imports/data/abcdefghijklmnopqrstuv.bin");
        Object beforeKey = Files.readAttributes(source, BasicFileAttributes.class).fileKey();

        OwnedDocumentWriter writer = writer(files, tokens("zyxwvutsrqponmlkjihgfe"),
                ignored -> {});
        OwnedDocumentWriter.OwnedDocument retained = writer.retainPending(ref, pending, () -> false);
        Path target = files.resolve("pdfchef_documents/owned/abcdefghijklmnopqrstuv.bin");
        assertEquals(ref, retained.ref);
        assertEquals(beforeKey, Files.readAttributes(target, BasicFileAttributes.class).fileKey());
        assertFalse(Files.exists(source));
        assertFalse(Files.exists(files.resolve(
                "pdfchef_pending_imports/records/abcdefghijklmnopqrstuv.pending")));
        assertEquals(retained, writer.retainPending(ref, pending, () -> false));
    }

    @Test public void retainRecoveryAndAlreadyOwnedPathPreserveMarkerOnCorruption()
            throws Exception {
        Path files = Files.createTempDirectory("owned-retain-corrupt");
        String ref = "d1_abcdefghijklmnopqrstuv";
        Path marker = files.resolve(
                "pdfchef_pending_imports/records/abcdefghijklmnopqrstuv.pending");
        OwnedPendingImportStore pending = new OwnedPendingImportStore(files,
                required -> required + 1_000_000, () -> 99, ignored -> {});
        pending.stage(ref, pendingItem(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        OwnedDocumentWriter interrupted = writer(files, tokens("zyxwvutsrqponmlkjihgfe"),
                checkpoint -> {
                    if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_RETAIN_DATA_MOVE) {
                        throw new IOException("simulated retain loss");
                    }
                });
        assertFailure("DOCUMENT_UNSAFE_STATE",
                () -> interrupted.retainPending(ref, pending, () -> false));
        Path owned = files.resolve("pdfchef_documents/owned/abcdefghijklmnopqrstuv.bin");
        byte[] corrupt = PDF.clone();
        corrupt[corrupt.length - 1] ^= 1;
        Files.write(owned, corrupt);
        OwnedDocumentWriter restarted = writer(files, tokens("unusedtokenabcdefghijk"),
                ignored -> {});
        assertFailure("DOCUMENT_CORRUPT",
                () -> restarted.retainPending(ref, pending, () -> false));
        assertTrue(Files.exists(marker));

        Files.write(owned, PDF);
        OwnedDocumentWriter.OwnedDocument recovered = restarted.retainPending(
                ref, pending, () -> false);
        assertEquals(ref, recovered.ref);
        pending.stage(ref, pendingItem(PDF.length), new ByteArrayInputStream(PDF), () -> false);
        Files.write(owned, corrupt);
        assertFailure("DOCUMENT_CORRUPT",
                () -> restarted.retainPending(ref, pending, () -> false));
        assertTrue(Files.exists(marker));
    }

    @Test public void sameSizeOwnedTamperingIsRejectedBeforeDelivery() throws Exception {
        Path files = Files.createTempDirectory("owned-tamper");
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        Path owned = files.resolve("pdfchef_documents/owned/"
                + document.ref.substring(3) + ".bin");
        byte[] tampered = PDF.clone();
        tampered[tampered.length - 1] ^= 1;
        Files.write(owned, tampered);
        assertFailure("DOCUMENT_CORRUPT", () -> writer.source(document.ref));
    }

    @Test public void corruptOwnedPayloadsRemainExplicitlyDeletableAndClearConverges()
            throws Exception {
        Path files = Files.createTempDirectory("owned-corrupt-delete");
        OwnedDocumentWriter writer = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                "mnopqrstuvabcdefghijkl", "ponmlkjihgfedcbazyxwvu"), ignored -> {});
        String firstSession = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(firstSession, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument first = writer.finish(firstSession, () -> false);
        Path firstData = files.resolve("pdfchef_documents/owned/"
                + first.ref.substring(3) + ".bin");
        byte[] corrupt = PDF.clone();
        corrupt[corrupt.length - 1] ^= 1;
        Files.write(firstData, corrupt);
        assertTrue(writer.deleteOwned(first.ref));
        assertFalse(Files.exists(firstData));

        String secondSession = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(secondSession, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument second = writer.finish(secondSession, () -> false);
        Path secondData = files.resolve("pdfchef_documents/owned/"
                + second.ref.substring(3) + ".bin");
        Files.write(secondData, corrupt);
        assertEquals(1, writer.clearOwned());
        assertFalse(Files.exists(secondData));
        assertTrue(writer.listOwned().isEmpty());
    }

    @Test public void clearPayloadsKeepsUnavailableMetadataAndPermanentDeleteStillWorks()
            throws Exception {
        Path files = Files.createTempDirectory("owned-payload-clear");
        OwnedDocumentWriter writer = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = writer.begin("Saved scan.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        String payload = document.ref.substring(3);
        Path data = files.resolve("pdfchef_documents/owned/" + payload + ".bin");
        Path record = files.resolve("pdfchef_documents/records/" + payload + ".owned");

        assertEquals(1, writer.clearOwnedPayloads());
        assertFalse(Files.exists(data));
        assertTrue(Files.exists(record));
        List<OwnedDocumentWriter.OwnedDocument> listed = writer.listOwned();
        assertEquals(1, listed.size());
        assertFalse(listed.get(0).available);
        assertEquals("Saved scan.pdf", listed.get(0).displayName);
        assertEquals(0, writer.clearOwnedPayloads());
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.source(document.ref));
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.readerSource(document.ref));
        assertFailure("DOCUMENT_NOT_FOUND",
                () -> writer.renameOwned(document.ref, "Renamed.pdf"));
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.trashOwned(document.ref));

        assertTrue(writer.deleteOwned(document.ref));
        assertFalse(Files.exists(record));
        assertTrue(writer.listOwned().isEmpty());
    }

    @Test public void everyPayloadClearCheckpointRecoversToUnavailableMetadata()
            throws Exception {
        for (OwnedDocumentWriter.Checkpoint failAt : List.of(
                OwnedDocumentWriter.Checkpoint.AFTER_PAYLOAD_CLEAR_MARKER,
                OwnedDocumentWriter.Checkpoint.AFTER_PAYLOAD_CLEAR_RECORD_PUBLISH,
                OwnedDocumentWriter.Checkpoint.BEFORE_PAYLOAD_CLEAR_DATA_DELETE,
                OwnedDocumentWriter.Checkpoint.BEFORE_PAYLOAD_CLEAR_MARKER_DELETE)) {
            Path files = Files.createTempDirectory("owned-payload-clear-" + failAt.name());
            OwnedDocumentWriter original = writer(files, tokens(
                    "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
            String session = original.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
            original.append(session, PDF, () -> false);
            OwnedDocumentWriter.OwnedDocument document = original.finish(session, () -> false);
            String payload = document.ref.substring(3);
            Path data = files.resolve("pdfchef_documents/owned/" + payload + ".bin");
            Path marker = files.resolve("pdfchef_documents/operations/clear_"
                    + payload + ".payload-clear");
            AtomicBoolean failed = new AtomicBoolean();
            OwnedDocumentWriter interrupted = writer(files, tokens(), checkpoint -> {
                if (checkpoint == failAt && failed.compareAndSet(false, true)) {
                    throw new IOException("simulated payload clear process loss");
                }
            });

            assertFailure("DOCUMENT_UNSAFE_STATE", interrupted::clearOwnedPayloads);
            assertTrue(Files.exists(marker));

            OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
            List<OwnedDocumentWriter.OwnedDocument> listed = restarted.listOwned();
            assertEquals(1, listed.size());
            assertFalse(listed.get(0).available);
            assertFalse(Files.exists(data));
            assertFalse(Files.exists(marker));
            assertEquals(0, restarted.clearOwnedPayloads());
        }
    }

    @Test public void v2OwnedRecordDefaultsAvailableAndUnavailableDataInjectionFailsClosed()
            throws Exception {
        Path files = Files.createTempDirectory("owned-v2-availability");
        Path root = Files.createDirectories(files.resolve("pdfchef_documents"));
        Files.createDirectories(root.resolve("sessions"));
        Path owned = Files.createDirectories(root.resolve("owned"));
        Path records = Files.createDirectories(root.resolve("records"));
        Files.createDirectories(root.resolve("operations"));
        String ref = "d1_abcdefghijklmnopqrstuv";
        String hash = hex(MessageDigest.getInstance("SHA-256").digest(PDF));
        Files.write(owned.resolve("abcdefghijklmnopqrstuv.bin"), PDF);
        Files.write(records.resolve("abcdefghijklmnopqrstuv.owned"),
                v2Owned(ref, "Legacy record.pdf", AndroidDocumentIngressPolicy.MIME_PDF,
                        PDF.length, hash));
        OwnedDocumentWriter writer = writer(files, tokens(), ignored -> {});

        List<OwnedDocumentWriter.OwnedDocument> imported = writer.listOwned();
        assertEquals(1, imported.size());
        assertTrue(imported.get(0).available);
        assertEquals(1, writer.clearOwnedPayloads());
        Files.write(owned.resolve("abcdefghijklmnopqrstuv.bin"), PDF);
        assertFailure("DOCUMENT_UNSAFE_STATE", writer::listOwned);
    }

    @Test public void renameAtomicallyChangesOnlyOwnedMetadataAndIsIdempotent()
            throws Exception {
        Path files = Files.createTempDirectory("owned-rename");
        OwnedDocumentWriter writer = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = writer.begin("Original.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument original = writer.finish(session, () -> false);
        Path payload = files.resolve("pdfchef_documents/owned/"
                + original.ref.substring(3) + ".bin");
        byte[] payloadBefore = Files.readAllBytes(payload);
        Object payloadKey = Files.readAttributes(payload, BasicFileAttributes.class).fileKey();

        OwnedDocumentWriter.OwnedDocument renamed = writer.renameOwned(
                original.ref, "Renamed document.pdf");
        assertEquals(original.ref, renamed.ref);
        assertEquals("Renamed document.pdf", renamed.displayName);
        assertEquals(original.mimeType, renamed.mimeType);
        assertEquals(original.sizeBytes, renamed.sizeBytes);
        assertEquals(original.contentHash, renamed.contentHash);
        assertEquals(original.createdAtMillis, renamed.createdAtMillis);
        assertArrayEquals(payloadBefore, Files.readAllBytes(payload));
        assertEquals(payloadKey,
                Files.readAttributes(payload, BasicFileAttributes.class).fileKey());
        assertEquals(renamed, writer.renameOwned(original.ref, "Renamed document.pdf"));
        assertEquals(renamed, writer.listOwned().get(0));
        assertFalse(Files.exists(files.resolve("pdfchef_documents/records/"
                + original.ref.substring(3) + ".rename.part")));
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> writer.renameOwned("a1_1", "Legacy.pdf"));
        assertFailure("DOCUMENT_INVALID_ARGUMENT",
                () -> writer.renameOwned(original.ref, "bad/name"));
    }

    @Test public void renameFailureKeepsOneCompleteRecordAndCleansExactPart()
            throws Exception {
        Path files = Files.createTempDirectory("owned-rename-recovery");
        OwnedDocumentWriter originalWriter = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = originalWriter.begin("Original.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        originalWriter.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument original = originalWriter.finish(session, () -> false);
        Path part = files.resolve("pdfchef_documents/records/"
                + original.ref.substring(3) + ".rename.part");

        OwnedDocumentWriter beforePublish = writer(files, tokens(), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_RENAME_RECORD_FORCE) {
                throw new IOException("simulated rename loss before publish");
            }
        });
        assertFailure("DOCUMENT_UNSAFE_STATE",
                () -> beforePublish.renameOwned(original.ref, "Before.pdf"));
        assertEquals("Original.pdf", originalWriter.loadOwned(original.ref).displayName);
        assertFalse(Files.exists(part));

        OwnedDocumentWriter afterPublish = writer(files, tokens(), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_RENAME_RECORD_PUBLISH) {
                throw new IOException("simulated rename loss after publish");
            }
        });
        assertFailure("DOCUMENT_UNSAFE_STATE",
                () -> afterPublish.renameOwned(original.ref, "After.pdf"));
        OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
        assertEquals("After.pdf", restarted.loadOwned(original.ref).displayName);
        assertEquals("After.pdf",
                restarted.renameOwned(original.ref, "After.pdf").displayName);
        assertFalse(Files.exists(part));
    }

    @Test public void renameRejectsMissingOrStructurallyCorruptPayloadWithoutChangingName()
            throws Exception {
        Path files = Files.createTempDirectory("owned-rename-corrupt");
        OwnedDocumentWriter writer = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), ignored -> {});
        String session = writer.begin("Original.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument original = writer.finish(session, () -> false);
        Path payload = files.resolve("pdfchef_documents/owned/"
                + original.ref.substring(3) + ".bin");
        Files.write(payload, java.util.Arrays.copyOf(PDF, PDF.length - 1));
        assertFailure("DOCUMENT_CORRUPT",
                () -> writer.renameOwned(original.ref, "Corrupt.pdf"));
        Path record = files.resolve("pdfchef_documents/records/"
                + original.ref.substring(3) + ".owned");
        assertTrue(new String(Files.readAllBytes(record), StandardCharsets.ISO_8859_1)
                .contains("Original.pdf"));
    }

    @Test public void deleteFailureRetainsJournalUntilPayloadAndRecordAreAbsent()
            throws Exception {
        Path files = Files.createTempDirectory("owned-delete-recovery");
        AtomicBoolean failRecordDelete = new AtomicBoolean();
        OwnedDocumentWriter writer = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe"), checkpoint -> {
            if (failRecordDelete.get()
                    && checkpoint == OwnedDocumentWriter.Checkpoint.BEFORE_OWNED_RECORD_DELETE) {
                throw new IOException("simulated unlink failure");
            }
        });
        String session = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        String payload = document.ref.substring(3);
        Path data = files.resolve("pdfchef_documents/owned/" + payload + ".bin");
        Path record = files.resolve("pdfchef_documents/records/" + payload + ".owned");
        Path marker = files.resolve("pdfchef_documents/operations/delete_"
                + payload + ".delete");

        failRecordDelete.set(true);
        assertFailure("DOCUMENT_UNSAFE_STATE", () -> writer.deleteOwned(document.ref));
        assertFalse(Files.exists(data));
        assertTrue(Files.exists(record));
        assertTrue(Files.exists(marker));

        OwnedDocumentWriter restarted = writer(files,
                tokens("mnopqrstuvabcdefghijkl"), ignored -> {});
        assertTrue(restarted.listOwned().isEmpty());
        assertFalse(Files.exists(record));
        assertFalse(Files.exists(marker));
    }

    @Test public void trashAndRestorePreserveExactPayloadAndAreResponseLossIdempotent()
            throws Exception {
        Path files = Files.createTempDirectory("owned-undo-happy");
        AtomicLong clock = new AtomicLong(1_000);
        OwnedDocumentWriter writer = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, clock::get,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                        "mnopqrstuvabcdefghijkl"), ignored -> {});
        String session = writer.begin("Original.pdf",
                AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        Path owned = files.resolve("pdfchef_documents/owned/"
                + document.ref.substring(3) + ".bin");
        Object originalKey = Files.readAttributes(owned, BasicFileAttributes.class).fileKey();

        OwnedDocumentWriter.UndoEntry first = writer.trashOwned(document.ref);
        OwnedDocumentWriter.UndoEntry retry = writer.trashOwned(document.ref);
        assertEquals(first.undoRef, retry.undoRef);
        assertEquals(1_000 + OwnedDocumentWriter.UNDO_EXPIRY_MILLIS, first.expiresAt);
        assertTrue(writer.listOwned().isEmpty());
        Path trashed = files.resolve("pdfchef_documents/trash/data/"
                + first.undoRef.substring(3) + ".bin");
        assertEquals(originalKey,
                Files.readAttributes(trashed, BasicFileAttributes.class).fileKey());
        assertArrayEquals(PDF, Files.readAllBytes(trashed));

        clock.set(first.expiresAt - 1);
        assertTrue(writer.restoreOwned(first.undoRef));
        assertTrue(writer.restoreOwned(first.undoRef));
        assertEquals(originalKey,
                Files.readAttributes(owned, BasicFileAttributes.class).fileKey());
        assertEquals("Original.pdf", writer.loadOwned(document.ref).displayName);

        writer.renameOwned(document.ref, "After restore.pdf");
        assertTrue(writer.restoreOwned(first.undoRef));
        assertEquals("After restore.pdf", writer.loadOwned(document.ref).displayName);
        assertFalse(Files.exists(trashed));
        assertTrue(writer.deleteOwned(document.ref));
        assertTrue(writer.restoreOwned(first.undoRef));
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.loadOwned(document.ref));
        clock.set(first.expiresAt - 1 + OwnedDocumentWriter.COMPLETED_RECORD_EXPIRY_MILLIS);
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.restoreOwned(first.undoRef));
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.loadOwned(document.ref));
    }

    @Test public void everyUndoMoveCheckpointRecoversWithTheSameToken() throws Exception {
        List<OwnedDocumentWriter.Checkpoint> trashCheckpoints = List.of(
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_INTENT,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_RECORD_MOVE,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_DATA_MOVE,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_TRASHED);
        for (OwnedDocumentWriter.Checkpoint failAt : trashCheckpoints) {
            Path files = Files.createTempDirectory("owned-undo-trash-crash");
            OwnedDocumentWriter interrupted = new OwnedDocumentWriter(files,
                    required -> required + 1_000_000, () -> 1_000,
                    tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                            "mnopqrstuvabcdefghijkl"), checkpoint -> {
                        if (checkpoint == failAt) throw new IOException("process loss");
                    });
            String session = interrupted.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
            interrupted.append(session, PDF, () -> false);
            OwnedDocumentWriter.OwnedDocument document = interrupted.finish(session, () -> false);
            assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.trashOwned(document.ref));

            OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
            OwnedDocumentWriter.UndoEntry recovered = restarted.trashOwned(document.ref);
            assertEquals("u1_mnopqrstuvabcdefghijkl", recovered.undoRef);
            assertTrue(restarted.restoreOwned(recovered.undoRef));
            assertArrayEquals(PDF, Files.readAllBytes(files.resolve(
                    "pdfchef_documents/owned/" + document.ref.substring(3) + ".bin")));
        }
    }

    @Test public void everyRestoreMoveCheckpointRecoversWithoutResurrection() throws Exception {
        List<OwnedDocumentWriter.Checkpoint> restoreCheckpoints = List.of(
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_RESTORE_INTENT,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_RESTORE_DATA_MOVE,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_RESTORE_RECORD_MOVE,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_RESTORED);
        for (OwnedDocumentWriter.Checkpoint failAt : restoreCheckpoints) {
            Path files = Files.createTempDirectory("owned-undo-restore-crash");
            OwnedDocumentWriter setup = writer(files, tokens(
                    "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                    "mnopqrstuvabcdefghijkl"), ignored -> {});
            String session = setup.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
            setup.append(session, PDF, () -> false);
            OwnedDocumentWriter.OwnedDocument document = setup.finish(session, () -> false);
            OwnedDocumentWriter.UndoEntry undo = setup.trashOwned(document.ref);

            OwnedDocumentWriter interrupted = writer(files, tokens(), checkpoint -> {
                if (checkpoint == failAt) throw new IOException("process loss");
            });
            assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.restoreOwned(undo.undoRef));
            OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
            assertTrue(restarted.restoreOwned(undo.undoRef));
            restarted.renameOwned(document.ref, "After crash.pdf");
            assertTrue(restarted.restoreOwned(undo.undoRef));
            assertEquals("After crash.pdf", restarted.loadOwned(document.ref).displayName);
        }
    }

    @Test public void undoExpiryBoundaryPurgesExactTrashWithoutChangingDeleteSemantics()
            throws Exception {
        Path files = Files.createTempDirectory("owned-undo-expiry");
        AtomicLong clock = new AtomicLong(1_000);
        OwnedDocumentWriter writer = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, clock::get,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                        "mnopqrstuvabcdefghijkl"), ignored -> {});
        String session = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        OwnedDocumentWriter.UndoEntry undo = writer.trashOwned(document.ref);
        clock.set(undo.expiresAt);
        assertFailure("DOCUMENT_NOT_FOUND", () -> writer.restoreOwned(undo.undoRef));
        String payload = undo.undoRef.substring(3);
        assertFalse(Files.exists(files.resolve("pdfchef_documents/trash/data/"
                + payload + ".bin")));
        assertFalse(Files.exists(files.resolve("pdfchef_documents/trash/records/"
                + payload + ".owned")));
        assertFalse(Files.exists(files.resolve("pdfchef_documents/operations/undo_"
                + payload + ".undo")));
        assertFalse(writer.deleteOwned(document.ref));
    }

    @Test public void everyExpiryPurgeCheckpointConvergesToNotFound() throws Exception {
        for (OwnedDocumentWriter.Checkpoint failAt : List.of(
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_PURGE_INTENT,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_PURGE_DATA_DELETE,
                OwnedDocumentWriter.Checkpoint.AFTER_UNDO_PURGE_RECORD_DELETE)) {
            Path files = Files.createTempDirectory("owned-undo-purge-crash");
            AtomicLong clock = new AtomicLong(1_000);
            OwnedDocumentWriter setup = new OwnedDocumentWriter(files,
                    required -> required + 1_000_000, clock::get,
                    tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                            "mnopqrstuvabcdefghijkl"), ignored -> {});
            String session = setup.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
            setup.append(session, PDF, () -> false);
            OwnedDocumentWriter.OwnedDocument document = setup.finish(session, () -> false);
            OwnedDocumentWriter.UndoEntry undo = setup.trashOwned(document.ref);
            clock.set(undo.expiresAt);

            OwnedDocumentWriter interrupted = new OwnedDocumentWriter(files,
                    required -> required + 1_000_000, clock::get, tokens(), checkpoint -> {
                        if (checkpoint == failAt) throw new IOException("process loss");
                    });
            assertFailure("DOCUMENT_UNSAFE_STATE",
                    () -> interrupted.restoreOwned(undo.undoRef));
            OwnedDocumentWriter restarted = new OwnedDocumentWriter(files,
                    required -> required + 1_000_000, clock::get, tokens(), ignored -> {});
            assertFailure("DOCUMENT_NOT_FOUND", () -> restarted.restoreOwned(undo.undoRef));
            assertTrue(restarted.listOwned().isEmpty());
        }
    }

    @Test public void undoClockRollbackPreservesDataAndUnsafeTimestampCannotCrossBridge()
            throws Exception {
        Path files = Files.createTempDirectory("owned-undo-clock");
        AtomicLong clock = new AtomicLong(1_000);
        OwnedDocumentWriter writer = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, clock::get,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                        "mnopqrstuvabcdefghijkl"), ignored -> {});
        String session = writer.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        writer.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        OwnedDocumentWriter.UndoEntry undo = writer.trashOwned(document.ref);
        clock.set(999);
        assertTrue(writer.restoreOwned(undo.undoRef));
        assertTrue(writer.restoreOwned(undo.undoRef));
        assertArrayEquals(PDF, Files.readAllBytes(files.resolve("pdfchef_documents/owned/"
                + document.ref.substring(3) + ".bin")));

        Path overflowFiles = Files.createTempDirectory("owned-undo-overflow");
        AtomicLong overflowClock = new AtomicLong(
                9_007_199_254_740_991L - OwnedDocumentWriter.UNDO_EXPIRY_MILLIS + 1);
        OwnedDocumentWriter overflow = new OwnedDocumentWriter(overflowFiles,
                required -> required + 1_000_000, overflowClock::get,
                tokens("abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                        "mnopqrstuvabcdefghijkl"), ignored -> {});
        String overflowSession = overflow.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        overflow.append(overflowSession, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument overflowDocument = overflow.finish(
                overflowSession, () -> false);
        assertFailure("DOCUMENT_UNSAFE_STATE",
                () -> overflow.trashOwned(overflowDocument.ref));
    }

    @Test public void journaledTrashIsRecoveredBeforeRenameDeleteOrClearCanMutateIt()
            throws Exception {
        for (String operation : List.of("rename", "delete", "clear")) {
            Path files = Files.createTempDirectory("owned-undo-mutator-guard");
            OwnedDocumentWriter interrupted = writer(files, tokens(
                    "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                    "mnopqrstuvabcdefghijkl"), checkpoint -> {
                if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_UNDO_INTENT) {
                    throw new IOException("process loss");
                }
            });
            String session = interrupted.begin("Original.pdf",
                    AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
            interrupted.append(session, PDF, () -> false);
            OwnedDocumentWriter.OwnedDocument document = interrupted.finish(session, () -> false);
            assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.trashOwned(document.ref));

            OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
            if (operation.equals("rename")) {
                assertFailure("DOCUMENT_UNSAFE_STATE",
                        () -> restarted.renameOwned(document.ref, "Must not publish.pdf"));
            } else if (operation.equals("delete")) {
                assertFalse(restarted.deleteOwned(document.ref));
            } else {
                assertEquals(0, restarted.clearOwned());
            }
            String undoRef = "u1_mnopqrstuvabcdefghijkl";
            assertTrue(restarted.restoreOwned(undoRef));
            assertEquals("Original.pdf", restarted.loadOwned(document.ref).displayName);
        }
    }

    @Test public void restoringRecoveryReservesCapacityBeforePublishingOwnedMetadata()
            throws Exception {
        Path files = Files.createTempDirectory("owned-undo-restore-capacity");
        OwnedDocumentWriter setup = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfe",
                "mnopqrstuvabcdefghijkl"), ignored -> {});
        String session = setup.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        setup.append(session, PDF, () -> false);
        OwnedDocumentWriter.OwnedDocument document = setup.finish(session, () -> false);
        OwnedDocumentWriter.UndoEntry undo = setup.trashOwned(document.ref);
        OwnedDocumentWriter interrupted = writer(files, tokens(), checkpoint -> {
            if (checkpoint == OwnedDocumentWriter.Checkpoint.AFTER_UNDO_RESTORE_INTENT) {
                throw new IOException("process loss");
            }
        });
        assertFailure("DOCUMENT_UNSAFE_STATE", () -> interrupted.restoreOwned(undo.undoRef));

        Path records = files.resolve("pdfchef_documents/records");
        Path owned = files.resolve("pdfchef_documents/owned");
        Path removableRecord = null;
        Path removableData = null;
        for (int index = 0; index < OwnedDocumentWriter.MAXIMUM_OWNED_DOCUMENTS; index++) {
            String token = String.format(java.util.Locale.ROOT, "%022d", index);
            String ref = "d1_" + token;
            Path record = records.resolve(token + ".owned");
            Path data = owned.resolve(token + ".bin");
            Files.write(record, v1Owned(ref, AndroidDocumentIngressPolicy.MIME_PDF,
                    PDF.length, hex(MessageDigest.getInstance("SHA-256").digest(PDF))));
            Files.write(data, PDF);
            if (index == 0) { removableRecord = record; removableData = data; }
        }
        OwnedDocumentWriter restarted = writer(files, tokens(), ignored -> {});
        String fullCapacityRef = "d1_" + String.format(java.util.Locale.ROOT, "%022d", 0);
        assertFailure("DOCUMENT_LIMIT_EXCEEDED",
                () -> restarted.trashOwned(fullCapacityRef));
        assertTrue(Files.exists(records.resolve(fullCapacityRef.substring(3) + ".owned")));
        assertTrue(Files.exists(files.resolve("pdfchef_documents/trash/data/"
                + undo.undoRef.substring(3) + ".bin")));
        assertFailure("DOCUMENT_LIMIT_EXCEEDED", () -> restarted.restoreOwned(undo.undoRef));
        assertFalse(Files.exists(owned.resolve(document.ref.substring(3) + ".bin")));
        assertTrue(Files.exists(files.resolve("pdfchef_documents/trash/data/"
                + undo.undoRef.substring(3) + ".bin")));

        Files.delete(removableRecord);
        Files.delete(removableData);
        assertTrue(restarted.restoreOwned(undo.undoRef));
        assertEquals(OwnedDocumentWriter.MAXIMUM_OWNED_DOCUMENTS,
                Files.list(records).filter(path -> path.toString().endsWith(".owned")).count());
    }

    @Test public void maximumLegalNameRefAndMimeFitTheDedicatedUndoRecordBound()
            throws Exception {
        Path files = Files.createTempDirectory("owned-undo-record-bound");
        String longToken = "A".repeat(64);
        String longName = "界".repeat(180);
        byte[] pptx = new byte[] {0x50, 0x4b, 0x03, 0x04, 1};
        OwnedDocumentWriter writer = writer(files,
                tokens(longToken, "B".repeat(64), "C".repeat(64)), ignored -> {});
        String session = writer.begin(longName, OwnedDocumentWritePolicy.MIME_PPTX).sessionId;
        writer.append(session, pptx, () -> false);
        OwnedDocumentWriter.OwnedDocument document = writer.finish(session, () -> false);
        OwnedDocumentWriter.UndoEntry undo = writer.trashOwned(document.ref);
        Path journal = files.resolve("pdfchef_documents/operations/undo_"
                + undo.undoRef.substring(3) + ".undo");
        assertTrue(Files.size(journal) > 0);
        assertTrue(Files.size(journal) <= 2_048);
        assertTrue(writer.restoreOwned(undo.undoRef));
        assertEquals(longName, writer.loadOwned(document.ref).displayName);
    }

    @Test public void completedIntentCleanupIsAgeAwareBoundedAndNotLexicallyStarved()
            throws Exception {
        Path files = Files.createTempDirectory("owned-finish-cleanup");
        Path root = Files.createDirectories(files.resolve("pdfchef_documents"));
        Files.createDirectories(root.resolve("sessions"));
        Files.createDirectories(root.resolve("owned"));
        Files.createDirectories(root.resolve("records"));
        Path operations = Files.createDirectories(root.resolve("operations"));
        long now = OwnedDocumentWriter.COMPLETED_RECORD_EXPIRY_MILLIS + 10_000;
        String ref = "d1_abcdefghijklmnopqrstuv";
        for (int index = 0; index < 4; index++) {
            String session = "w1_" + "A".repeat(21) + index;
            Files.write(operations.resolve(session + ".finish"), v1FinishAt(
                    session, ref, AndroidDocumentIngressPolicy.MIME_PDF, PDF.length,
                    hex(MessageDigest.getInstance("SHA-256").digest(PDF)), now));
        }
        for (int index = 0; index < 5; index++) {
            String session = "w1_" + "z".repeat(21) + index;
            Files.write(operations.resolve(session + ".finish"), v1FinishAt(
                    session, ref, AndroidDocumentIngressPolicy.MIME_PDF, PDF.length,
                    hex(MessageDigest.getInstance("SHA-256").digest(PDF)), 1));
        }
        Path invalid = operations.resolve("w1_" + "y".repeat(22) + ".finish");
        Files.write(invalid, new byte[] {1, 2, 3});
        Files.setLastModifiedTime(invalid, java.nio.file.attribute.FileTime.fromMillis(1));
        OwnedDocumentWriter writer = new OwnedDocumentWriter(files,
                required -> required + 1_000_000, () -> now,
                tokens("abcdefghijklmnopqrstuv"), ignored -> {});

        writer.listOwned();
        long afterFirst = Files.list(operations)
                .filter(path -> path.getFileName().toString().endsWith(".finish")).count();
        assertEquals(6, afterFirst);
        writer.listOwned();
        assertEquals(4, Files.list(operations)
                .filter(path -> path.getFileName().toString().endsWith(".finish")).count());
        assertFalse(Files.exists(invalid));
    }

    @Test public void frozenChunkSessionAndStorageLimitsFailClosed() throws Exception {
        Path files = Files.createTempDirectory("owned-limits");
        OwnedDocumentWriter writer = writer(files, tokens(
                "abcdefghijklmnopqrstuv", "bcdefghijklmnopqrstuvw",
                "cdefghijklmnopqrstuvwx", "defghijklmnopqrstuvwxy",
                "efghijklmnopqrstuvwxyz"), ignored -> {});
        for (int index = 0; index < OwnedDocumentWriter.MAXIMUM_OPEN_SESSIONS; index++) {
            writer.begin(AndroidDocumentIngressPolicy.MIME_PDF);
        }
        assertFailure("DOCUMENT_LIMIT_EXCEEDED",
                () -> writer.begin(AndroidDocumentIngressPolicy.MIME_PDF));

        Path lowFiles = Files.createTempDirectory("owned-low-storage");
        OwnedDocumentWriter low = new OwnedDocumentWriter(lowFiles, required -> required - 1,
                () -> 1, tokens("abcdefghijklmnopqrstuv"), ignored -> {});
        String session = low.begin(AndroidDocumentIngressPolicy.MIME_PDF).sessionId;
        assertFailure("DOCUMENT_STORAGE_FULL", () -> low.append(session, PDF, () -> false));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> low.append(session,
                new byte[OwnedDocumentWriter.MAXIMUM_CHUNK_BYTES + 1], () -> false));
    }

    @Test public void textWritesValidateUtf8AndNulWithoutAnUnboundedSecondRead() throws Exception {
        Path files = Files.createTempDirectory("owned-text");
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe", "mnopqrstuvabcdefghijkl",
                "ponmlkjihgfedcbazyxwvu"), ignored -> {});
        String valid = writer.begin("note.txt", OwnedDocumentWritePolicy.MIME_TEXT).sessionId;
        writer.append(valid, "hello 😀".getBytes(StandardCharsets.UTF_8), () -> false);
        assertEquals("note.txt", writer.finish(valid, () -> false).displayName);
        String invalidUtf8 = writer.begin(OwnedDocumentWritePolicy.MIME_TEXT).sessionId;
        writer.append(invalidUtf8, new byte[] {(byte) 0xc3, 0x28}, () -> false);
        assertFailure("DOCUMENT_CORRUPT", () -> writer.finish(invalidUtf8, () -> false));
        String nul = writer.begin(OwnedDocumentWritePolicy.MIME_TEXT).sessionId;
        writer.append(nul, new byte[] {'x', 0, 'y'}, () -> false);
        assertFailure("DOCUMENT_CORRUPT", () -> writer.finish(nul, () -> false));
    }

    @Test public void v1SessionAndCommittedFinishDecodeWithNullNameWithoutRewrite() throws Exception {
        Path files = Files.createTempDirectory("owned-v1");
        Path root = Files.createDirectories(files.resolve("pdfchef_documents"));
        Path sessions = Files.createDirectories(root.resolve("sessions"));
        Path owned = Files.createDirectories(root.resolve("owned"));
        Path records = Files.createDirectories(root.resolve("records"));
        Path operations = Files.createDirectories(root.resolve("operations"));
        String session = "w1_abcdefghijklmnopqrstuv";
        String ref = "d1_zyxwvutsrqponmlkjihgfe";
        Files.write(sessions.resolve(session + ".part"), new byte[0]);
        byte[] sessionBytes = v1Session(session, AndroidDocumentIngressPolicy.MIME_PDF);
        Files.write(sessions.resolve(session + ".session"), sessionBytes);
        OwnedDocumentWriter restarted = writer(files, tokens("mnopqrstuvabcdefghijkl"), ignored -> {});
        restarted.begin(AndroidDocumentIngressPolicy.MIME_PDF);
        assertArrayEquals(sessionBytes, Files.readAllBytes(sessions.resolve(session + ".session")));

        Files.write(owned.resolve(ref.substring(3) + ".bin"), PDF);
        String hash = hex(MessageDigest.getInstance("SHA-256").digest(PDF));
        byte[] ownedBytes = v1Owned(ref, AndroidDocumentIngressPolicy.MIME_PDF, PDF.length, hash);
        byte[] finishBytes = v1Finish(session, ref, AndroidDocumentIngressPolicy.MIME_PDF, PDF.length, hash);
        Files.write(records.resolve(ref.substring(3) + ".owned"), ownedBytes);
        Files.write(operations.resolve(session + ".finish"), finishBytes);
        OwnedDocumentWriter.OwnedDocument result = restarted.finish(session, () -> false);
        assertEquals(null, result.displayName);
        assertArrayEquals(ownedBytes, Files.readAllBytes(records.resolve(ref.substring(3) + ".owned")));
        assertArrayEquals(finishBytes, Files.readAllBytes(operations.resolve(session + ".finish")));
    }

    @Test public void textUtf8CarriesAcrossDigestBoundaryAndRejectsTruncatedTail() throws Exception {
        Path files = Files.createTempDirectory("owned-text-boundary");
        OwnedDocumentWriter writer = writer(files, tokens("abcdefghijklmnopqrstuv",
                "zyxwvutsrqponmlkjihgfe", "mnopqrstuvabcdefghijkl",
                "ponmlkjihgfedcbazyxwvu"), ignored -> {});
        byte[] prefix = new byte[65_535]; java.util.Arrays.fill(prefix, (byte) 'a');
        byte[] emoji = "😀".getBytes(StandardCharsets.UTF_8);
        byte[] valid = new byte[prefix.length + emoji.length]; System.arraycopy(prefix, 0, valid, 0, prefix.length); System.arraycopy(emoji, 0, valid, prefix.length, emoji.length);
        String good = writer.begin(OwnedDocumentWritePolicy.MIME_TEXT).sessionId;
        writer.append(good, valid, () -> false);
        assertEquals(valid.length, writer.finish(good, () -> false).sizeBytes);
        String bad = writer.begin(OwnedDocumentWritePolicy.MIME_TEXT).sessionId;
        writer.append(bad, java.util.Arrays.copyOf(valid, 65_536), () -> false);
        assertFailure("DOCUMENT_CORRUPT", () -> writer.finish(bad, () -> false));
    }

    private static byte[] v1Session(String session, String mime) throws Exception { return record(output -> { output.writeInt(0x50445331); output.writeInt(1); ascii(output, session); ascii(output, mime); output.writeLong(0); output.writeLong(1_000); output.writeLong(1_000); output.writeByte(0); }); }
    private static byte[] v1Owned(String ref, String mime, long size, String hash) throws Exception { return record(output -> { output.writeInt(0x50444f31); output.writeInt(1); ascii(output, ref); ascii(output, mime); output.writeLong(size); ascii(output, hash); output.writeLong(1_000); }); }
    private static byte[] v2Owned(String ref, String displayName, String mime, long size,
            String hash) throws Exception {
        return record(output -> {
            output.writeInt(0x50444f31); output.writeInt(2); ascii(output, ref);
            byte[] name = displayName.getBytes(StandardCharsets.UTF_8);
            output.writeShort(name.length); output.write(name); ascii(output, mime);
            output.writeLong(size); ascii(output, hash); output.writeLong(1_000);
        });
    }
    private static byte[] v1Finish(String session, String ref, String mime, long size, String hash) throws Exception { return v1FinishAt(session, ref, mime, size, hash, 1_000); }
    private static byte[] v1FinishAt(String session, String ref, String mime, long size, String hash, long createdAt) throws Exception { return record(output -> { output.writeInt(0x50444631); output.writeInt(1); ascii(output, session); ascii(output, ref); ascii(output, mime); output.writeLong(size); ascii(output, hash); output.writeLong(createdAt); output.writeBoolean(true); }); }
    private static byte[] record(Writer writer) throws Exception { ByteArrayOutputStream bytes = new ByteArrayOutputStream(); try (DataOutputStream output = new DataOutputStream(bytes)) { writer.write(output); } return bytes.toByteArray(); }
    private static void ascii(DataOutputStream output, String value) throws IOException { byte[] bytes = value.getBytes(StandardCharsets.US_ASCII); output.writeByte(bytes.length); output.write(bytes); }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value)); return result.toString(); }

    private static OwnedDocumentWriter writer(Path files,
            OwnedDocumentWriter.TokenSource tokens, OwnedDocumentWriter.FaultInjector faults) {
        return new OwnedDocumentWriter(files, required -> required + 1_000_000,
                () -> 1_000, tokens, faults);
    }

    private static OwnedDocumentWriter.TokenSource tokens(String... values) {
        ArrayDeque<String> queue = new ArrayDeque<>(List.of(values));
        return queue::removeFirst;
    }

    private static AndroidDocumentIngressPolicy.ValidatedItem pendingItem(long size)
            throws Exception {
        return new AndroidDocumentIngressPolicy().validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(new AndroidDocumentIngressPolicy.Candidate("opaque", "content",
                        AndroidDocumentIngressPolicy.MIME_PDF, size, true, true,
                        new byte[] {'%', 'P', 'D', 'F', '-'}))).items().get(0);
    }

    private static void assertFailure(String code, ThrowingRunnable action) {
        try { action.run(); fail("Expected " + code); }
        catch (OwnedDocumentWriter.Failure failure) { assertEquals(code, failure.code()); }
        catch (Exception failure) { throw new AssertionError(failure); }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
    private interface Writer { void write(DataOutputStream output) throws Exception; }
}
