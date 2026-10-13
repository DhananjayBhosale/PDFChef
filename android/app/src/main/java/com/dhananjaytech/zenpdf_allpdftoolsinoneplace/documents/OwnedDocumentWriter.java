package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

/** Inactive owned-document writer. All calls are serialized by DocumentLifecycleCoordinator. */
final class OwnedDocumentWriter {
    static final int MAXIMUM_CHUNK_BYTES = 524_288;
    static final long MAXIMUM_FILE_BYTES = 256L * 1024L * 1024L;
    static final int MAXIMUM_OPEN_SESSIONS = 4;
    static final int MAXIMUM_OWNED_DOCUMENTS = 10_000;
    static final long MAXIMUM_OPEN_BYTES = 256L * 1024L * 1024L;
    static final long INACTIVITY_EXPIRY_MILLIS = 30L * 60L * 1000L;
    static final long ABSOLUTE_EXPIRY_MILLIS = 2L * 60L * 60L * 1000L;
    static final long COMPLETED_RECORD_EXPIRY_MILLIS = 24L * 60L * 60L * 1000L;
    static final long UNDO_EXPIRY_MILLIS = 10L * 60L * 1000L;
    static final long STORAGE_RESERVE_BYTES = 1024L * 1024L;
    private static final long MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L;

    private static final int SESSION_MAGIC = 0x50445331; // PDS1
    private static final int OWNED_MAGIC = 0x50444f31; // PDO1
    private static final int FINISH_MAGIC = 0x50444631; // PDF1
    private static final int UNDO_MAGIC = 0x50445531; // PDU1
    private static final int VERSION = 2;
    private static final int OWNED_VERSION = 3;
    private static final int MAXIMUM_RECORD_BYTES = 1024;
    private static final int MAXIMUM_UNDO_RECORD_BYTES = 2048;
    private static final String ROOT_NAME = "pdfchef_documents";
    private static final Pattern SESSION_REF = Pattern.compile("w1_[A-Za-z0-9_-]{22,64}");
    private static final Pattern UNDO_REF = Pattern.compile("u1_[A-Za-z0-9_-]{22,64}");
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{64}");

    private final Path filesDir;
    private final StorageProbe storageProbe;
    private final Clock clock;
    private final TokenSource tokens;
    private final FaultInjector faults;
    private final java.util.Map<String, String> transientSessions = new java.util.HashMap<>();

    OwnedDocumentWriter(Path filesDir) {
        this(filesDir, ignored -> filesDir.toFile().getUsableSpace(), System::currentTimeMillis,
                secureTokens(), ignored -> {});
    }

    OwnedDocumentWriter(Path filesDir, StorageProbe storageProbe, Clock clock,
            TokenSource tokens, FaultInjector faults) {
        this.filesDir = Objects.requireNonNull(filesDir).toAbsolutePath().normalize();
        this.storageProbe = Objects.requireNonNull(storageProbe);
        this.clock = Objects.requireNonNull(clock);
        this.tokens = Objects.requireNonNull(tokens);
        this.faults = Objects.requireNonNull(faults);
    }

    BeginResult begin(String mimeType) throws Failure { return begin(null, mimeType); }

    BeginResult begin(String displayName, String mimeType) throws Failure {
        requireMime(mimeType);
        if (!OwnedDocumentWritePolicy.isValidDisplayName(displayName)) throw invalid();
        Layout layout = prepareAndRecover();
        List<SessionRecord> sessions = readSessions(layout);
        if (sessions.size() >= MAXIMUM_OPEN_SESSIONS) throw limit();
        long aggregate = aggregateBytes(sessions);
        if (aggregate > MAXIMUM_OPEN_BYTES) throw unsafe();
        String sessionId = nextRef("w1_");
        Path part = null;
        Path record = null;
        try {
            part = layout.sessionPart(sessionId);
            record = layout.sessionRecord(sessionId);
            requireAbsent(part);
            try (FileChannel channel = FileChannel.open(part,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            fsyncDirectory(layout.sessions);
            long now = now();
            publishReplace(record, encodeSession(new SessionRecord(
                    sessionId, displayName, mimeType, 0, now, now, State.OPEN)));
            fsyncDirectory(layout.sessions);
            return new BeginResult(sessionId, MAXIMUM_CHUNK_BYTES);
        } catch (Failure failure) {
            deleteExact(part);
            deleteExact(record);
            throw failure;
        } catch (IOException | RuntimeException failure) {
            deleteExact(part);
            deleteExact(record);
            throw failed();
        }
    }

    int append(String sessionId, byte[] bytes,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (!isSessionRef(sessionId) || bytes == null || bytes.length == 0
                || bytes.length > MAXIMUM_CHUNK_BYTES || cancellation == null) throw invalid();
        checkCancelled(cancellation);
        Layout layout = prepareAndRecover();
        SessionRecord session = loadSession(layout, sessionId);
        if (session.state != State.OPEN) throw interrupted();
        if (session.committedBytes > MAXIMUM_FILE_BYTES - bytes.length) throw limit();
        List<SessionRecord> sessions = readSessions(layout);
        long aggregate = aggregateBytes(sessions);
        if (aggregate > MAXIMUM_OPEN_BYTES - bytes.length) throw limit();
        long required = bytes.length + STORAGE_RESERVE_BYTES;
        try {
            if (storageProbe.availableBytes(required) < required) throw storageFull();
            Path part = layout.sessionPart(sessionId);
            requireRegular(part, session.committedBytes);
            try (FileChannel channel = FileChannel.open(part,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                channel.position(session.committedBytes);
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
            faults.checkpoint(Checkpoint.AFTER_APPEND_DATA_FORCE);
            checkCancelled(cancellation);
            long updatedBytes = session.committedBytes + bytes.length;
            SessionRecord updated = new SessionRecord(session.sessionId, session.displayName, session.mimeType,
                    updatedBytes, session.createdAt, now(), State.OPEN);
            publishReplace(layout.sessionRecord(sessionId), encodeSession(updated));
            fsyncDirectory(layout.sessions);
            faults.checkpoint(Checkpoint.AFTER_APPEND_JOURNAL_PUBLISH);
            return bytes.length;
        } catch (Failure failure) {
            markInterrupted(layout, session);
            throw failure;
        } catch (IOException | RuntimeException failure) {
            markInterrupted(layout, session);
            throw unsafe();
        }
    }

    OwnedDocument finish(String sessionId,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        return finish(sessionId, false, cancellation);
    }

    OwnedDocument finish(String sessionId, boolean transientOutput,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (!isSessionRef(sessionId) || cancellation == null) throw invalid();
        checkCancelled(cancellation);
        Layout layout = prepareAndRecover();
        if (transientSessions.containsKey(sessionId) && !transientOutput) throw invalid();
        FinishRecord prior = loadFinishIfPresent(layout, sessionId);
        if (prior != null && transientOutput != transientSessions.containsKey(sessionId)) throw invalid();
        if (prior != null && prior.committed) return loadOwned(layout, prior.ref);
        SessionRecord session = loadSession(layout, sessionId);
        if (session.state != State.OPEN) throw interrupted();
        if (session.committedBytes <= 0 || session.committedBytes > MAXIMUM_FILE_BYTES) throw invalid();
        try {
            Path part = layout.sessionPart(sessionId);
            requireRegular(part, session.committedBytes);
            FileDigest digest = digest(part, session.committedBytes, cancellation, session.mimeType);
            validateMagic(session.mimeType, digest.prefix);
            String ref = prior == null
                    ? transientSessions.getOrDefault(sessionId, null) : prior.ref;
            if (ref == null) ref = nextRef("d1_");
            requireNewOwnedCapacity(layout, ref);
            if (transientOutput && !transientSessions.containsKey(sessionId)) {
                // Persist before any finish intent can publish this ref as owned.
                publishReplace(layout.transientMarker(sessionId),
                        ref.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                fsyncDirectory(layout.operations);
                transientSessions.put(sessionId, ref);
                faults.checkpoint(Checkpoint.AFTER_TRANSIENT_MARKER);
            }
            FinishRecord intent = prior == null
                    ? new FinishRecord(sessionId, ref, session.displayName, session.mimeType, digest.size,
                            digest.hash, now(), false)
                    : prior;
            if (prior == null) {
                publishReplace(layout.finishRecord(sessionId), encodeFinish(intent));
                fsyncDirectory(layout.operations);
                faults.checkpoint(Checkpoint.AFTER_FINISH_INTENT);
            }
            Path target = layout.ownedData(ref);
            if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                atomicMoveNew(part, target);
                fsyncDirectory(layout.owned);
                fsyncDirectory(layout.sessions);
            }
            faults.checkpoint(Checkpoint.AFTER_FINISH_DATA_MOVE);
            OwnedDocument document = new OwnedDocument(
                    ref, intent.displayName, intent.mimeType, intent.size, intent.hash,
                    intent.createdAt, true);
            validateOwnedTarget(target, document, cancellation);
            publishOwnedIfAbsent(layout, document);
            fsyncDirectory(layout.records);
            faults.checkpoint(Checkpoint.AFTER_OWNED_RECORD_PUBLISH);
            publishReplace(layout.finishRecord(sessionId), encodeFinish(intent.asCommitted()));
            fsyncDirectory(layout.operations);
            deleteExact(layout.sessionRecord(sessionId));
            fsyncDirectory(layout.sessions);
            return document;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    OwnedDocument retainPending(String ref, OwnedPendingImportStore pendingStore,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (!PendingImportRecord.isValidRef(ref) || pendingStore == null || cancellation == null) {
            throw invalid();
        }
        checkCancelled(cancellation);
        Layout layout = prepareAndRecover();
        try {
            if (Files.exists(layout.ownedRecord(ref), LinkOption.NOFOLLOW_LINKS)) {
                OwnedDocument existing = loadOwned(layout, ref);
                removeExactPendingMarker(ref);
                return existing;
            }
            Path operation = layout.retainRecord(ref);
            if (Files.exists(operation, LinkOption.NOFOLLOW_LINKS)) {
                FinishRecord intent = decodeFinish(readRecord(operation));
                Path moved = layout.ownedData(ref);
                if (!intent.operationId.equals("retain_" + ref) || !intent.ref.equals(ref)) {
                    throw corrupt();
                }
                if (Files.exists(moved, LinkOption.NOFOLLOW_LINKS)) {
                    requireNewOwnedCapacity(layout, ref);
                    OwnedDocument recovered = new OwnedDocument(ref, intent.displayName,
                            intent.mimeType, intent.size, intent.hash, intent.createdAt, true);
                    validateOwnedTarget(moved, recovered, cancellation);
                    publishOwnedIfAbsent(layout, recovered);
                    publishReplace(operation, encodeFinish(intent.asCommitted()));
                    fsyncDirectory(layout.operations);
                    removeExactPendingMarker(ref);
                    return recovered;
                }
            }
        } catch (IOException failure) { throw unsafe(); }
        PendingImportRecord pending;
        try {
            pending = pendingStore.loadMetadataForImmediateValidation(ref);
        } catch (OwnedPendingImportStore.Failure failure) {
            throw new Failure(failure.code(), failure.getMessage());
        }
        Path source;
        try { source = pendingData(ref); }
        catch (IOException failure) { throw unsafe(); }
        try {
            requireRegular(source, pending.sizeBytes());
            BasicFileAttributes identityBeforeDigest = attributes(source);
            FileDigest digest = digest(source, pending.sizeBytes(), cancellation, pending.mimeType());
            BasicFileAttributes verifiedIdentity = attributes(source);
            if (!sameIdentity(identityBeforeDigest, verifiedIdentity)) throw corrupt();
            if (!digest.hash.equals(pending.contentHash())) throw corrupt();
            validateMagic(pending.mimeType(), digest.prefix);
            FinishRecord intent = new FinishRecord("retain_" + ref, ref, null, pending.mimeType(),
                    pending.sizeBytes(), pending.contentHash(), pending.createdAtMillis(), false);
            requireNewOwnedCapacity(layout, ref);
            Path operation = layout.retainRecord(ref);
            publishReplace(operation, encodeFinish(intent));
            fsyncDirectory(layout.operations);
            Path target = layout.ownedData(ref);
            boolean movedNow = false;
            if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                atomicMoveNew(source, target);
                movedNow = true;
                fsyncDirectory(layout.owned);
                fsyncDirectory(source.getParent());
            }
            faults.checkpoint(Checkpoint.AFTER_RETAIN_DATA_MOVE);
            OwnedDocument document = new OwnedDocument(ref, null, pending.mimeType(),
                    pending.sizeBytes(), pending.contentHash(), pending.createdAtMillis(), true);
            if (movedNow) {
                BasicFileAttributes movedIdentity = attributes(target);
                if (!sameIdentity(verifiedIdentity, movedIdentity)
                        || !movedIdentity.isRegularFile() || Files.isSymbolicLink(target)
                        || movedIdentity.size() != document.sizeBytes) throw corrupt();
            } else {
                // A retry that did not perform this process's verified move must
                // still validate the previously published target byte-for-byte.
                validateOwnedTarget(target, document, cancellation);
            }
            publishOwnedIfAbsent(layout, document);
            fsyncDirectory(layout.records);
            publishReplace(operation, encodeFinish(intent.asCommitted()));
            fsyncDirectory(layout.operations);
            removeExactPendingMarker(ref);
            return document;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    boolean abort(String sessionId) throws Failure {
        if (!isSessionRef(sessionId)) throw invalid();
        Layout layout = prepareAndRecover();
        String transientRef = transientSessions.get(sessionId);
        if (transientRef != null) {
            try {
                completeTransientDelete(layout, sessionId, transientRef, layout.transientMarker(sessionId));
                return true;
            } catch (IOException failure) { throw unsafe(); }
        }
        FinishRecord finish = loadFinishIfPresent(layout, sessionId);
        if (finish != null && finish.committed) return false;
        try {
            boolean present = Files.exists(layout.sessionPart(sessionId), LinkOption.NOFOLLOW_LINKS)
                    || Files.exists(layout.sessionRecord(sessionId), LinkOption.NOFOLLOW_LINKS);
            deleteExact(layout.sessionPart(sessionId));
            deleteExact(layout.sessionRecord(sessionId));
            fsyncDirectory(layout.sessions);
            return present;
        } catch (IOException failure) {
            throw unsafe();
        }
    }

    OwnedDocument loadOwned(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        return loadOwned(prepareAndRecover(), ref);
    }

    DocumentSource source(String ref) throws Failure {
        Layout layout = prepareAndRecover();
        try {
            ValidatedOwned validated = loadValidatedOwned(layout, ref);
            OwnedDocument document = validated.document;
            Path path = layout.ownedData(ref);
            OwnedSource source = new OwnedSource(path, validated.identity, document);
            try { faults.checkpoint(Checkpoint.AFTER_OWNED_SOURCE_OPEN); }
            catch (IOException failure) { source.close(); throw failure; }
            return source;
        } catch (Failure failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw failure;
        } catch (IOException failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw unavailable();
        }
    }

    /**
     * Reader-only source that validates the recorded digest during the one snapshot-copy pass.
     * The caller must consume it sequentially from offset zero.
     */
    DocumentSource readerSource(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        if (Thread.currentThread().isInterrupted()) throw interrupted();
        try {
            Layout layout = prepareAndRecover();
            Path recordPath = layout.ownedRecord(ref);
            if (!Files.exists(recordPath, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            OwnedDocument document = decodeOwned(readRecord(recordPath));
            if (!document.ref.equals(ref) || !recordPath.equals(layout.ownedRecord(document.ref))) {
                throw corrupt();
            }
            if (!document.available) throw notFound();
            Path path = layout.ownedData(ref);
            BasicFileAttributes identity = attributes(path);
            if (!identity.isRegularFile() || Files.isSymbolicLink(path)
                    || identity.size() != document.sizeBytes) throw corrupt();
            OwnedReaderSource source = new OwnedReaderSource(path, identity, document);
            try { faults.checkpoint(Checkpoint.AFTER_OWNED_SOURCE_OPEN); }
            catch (IOException failure) { source.close(); throw failure; }
            return source;
        } catch (Failure failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw failure;
        } catch (IOException | RuntimeException failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw corrupt();
        }
    }

    List<OwnedDocument> listOwned() throws Failure {
        Layout layout = prepareAndRecover();
        try {
            List<Path> records = listBounded(layout.records, ".owned",
                    MAXIMUM_OWNED_DOCUMENTS);
            ArrayList<OwnedDocument> result = new ArrayList<>(records.size());
            for (Path path : records) {
                requireRegular(path, -1);
                OwnedDocument document = decodeOwned(readRecord(path));
                if (!path.equals(layout.ownedRecord(document.ref))) throw corrupt();
                Path data = layout.ownedData(document.ref);
                if (document.available) {
                    requireRegular(data, document.sizeBytes);
                } else if (Files.exists(data, LinkOption.NOFOLLOW_LINKS)) {
                    throw unsafe();
                }
                if (!transientSessions.containsValue(document.ref)) result.add(document);
            }
            result.sort(Comparator.comparingLong((OwnedDocument value) -> value.createdAtMillis)
                    .reversed().thenComparing(value -> value.ref));
            return List.copyOf(result);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    OwnedDocument renameOwned(String ref, String displayName) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)
                || displayName == null
                || !OwnedDocumentWritePolicy.isValidDisplayName(displayName)) throw invalid();
        if (Thread.currentThread().isInterrupted()) throw interrupted();
        Layout layout = prepareAndRecover();
        Path part = null;
        try {
            recoverRestoringUndoForRef(layout, ref);
            Path recordPath = layout.ownedRecord(ref);
            requireRegular(recordPath, -1);
            BasicFileAttributes recordIdentity = attributes(recordPath);
            OwnedDocument current = decodeOwned(readRecord(recordPath));
            if (!current.ref.equals(ref) || !recordPath.equals(layout.ownedRecord(current.ref))) {
                throw corrupt();
            }
            if (!current.available) throw notFound();
            Path dataPath = layout.ownedData(ref);
            BasicFileAttributes dataIdentity = attributes(dataPath);
            if (!dataIdentity.isRegularFile() || Files.isSymbolicLink(dataPath)
                    || dataIdentity.size() != current.sizeBytes) throw corrupt();
            if (displayName.equals(current.displayName)) return current;

            OwnedDocument updated = new OwnedDocument(current.ref, displayName,
                    current.mimeType, current.sizeBytes, current.contentHash,
                    current.createdAtMillis, true);
            part = layout.renamePart(ref);
            cleanupRenamePart(layout, part);
            writeForced(part, encodeOwned(updated));
            fsyncDirectory(layout.records);
            faults.checkpoint(Checkpoint.AFTER_RENAME_RECORD_FORCE);
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            if (!sameIdentity(recordIdentity, attributes(recordPath))
                    || !sameIdentity(dataIdentity, attributes(dataPath))) throw unsafe();
            Files.move(part, recordPath, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
            fsyncDirectory(layout.records);
            faults.checkpoint(Checkpoint.AFTER_RENAME_RECORD_PUBLISH);
            if (!sameIdentity(dataIdentity, attributes(dataPath))) throw unsafe();
            OwnedDocument published = decodeOwned(readRecord(recordPath));
            if (!updated.equals(published)) throw unsafe();
            return published;
        } catch (Failure failure) {
            cleanupRenamePartOrUnsafe(layout, part);
            throw failure;
        } catch (IOException | RuntimeException failure) {
            cleanupRenamePartOrUnsafe(layout, part);
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw unsafe();
        }
    }

    UndoEntry trashOwned(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        if (Thread.currentThread().isInterrupted()) throw interrupted();
        Layout layout = prepareAndRecover();
        try {
            UndoRecord existing = recoverUndoTransactions(layout, ref);
            if (existing != null) return undoEntry(existing);

            OwnedDocument document = loadValidatedOwned(layout, ref).document;
            TrashLayout trash = TrashLayout.prepare(layout);
            String undoRef = nextUndoRef(layout, trash);
            long createdAt = undoNow();
            if (createdAt > MAXIMUM_SAFE_INTEGER - UNDO_EXPIRY_MILLIS) throw unsafe();
            UndoRecord intent = new UndoRecord(undoRef, document.ref,
                    document.displayName, document.mimeType, document.sizeBytes,
                    document.contentHash, document.createdAtMillis, createdAt,
                    createdAt + UNDO_EXPIRY_MILLIS, -1, UndoState.PREPARED);
            publishNew(layout.undoRecord(undoRef), encodeUndo(intent));
            fsyncDirectory(layout.operations);
            faults.checkpoint(Checkpoint.AFTER_UNDO_INTENT);
            return undoEntry(completeTrash(layout, trash, intent));
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw unsafe();
        }
    }

    boolean restoreOwned(String undoRef) throws Failure {
        if (!isUndoRef(undoRef)) throw invalid();
        if (Thread.currentThread().isInterrupted()) throw interrupted();
        Layout layout = prepareAndRecover();
        try {
            Path journal = layout.undoRecord(undoRef);
            if (!Files.exists(journal, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            TrashLayout trash = TrashLayout.prepare(layout);
            UndoRecord decoded = decodeUndo(readUndoRecord(journal));
            if (!decoded.undoRef.equals(undoRef)
                    || !journal.equals(layout.undoRecord(decoded.undoRef))) throw corrupt();
            if (decoded.state == UndoState.RESTORING) {
                requireRestoreCapacity(layout, decoded);
            }
            UndoRecord record = recoverUndo(layout, trash, decoded);
            if (record == null) throw notFound();
            if (record.state == UndoState.RESTORED) {
                long current = undoNow();
                if (current >= record.restoredAt
                        && current - record.restoredAt >= COMPLETED_RECORD_EXPIRY_MILLIS) {
                    removeRestoredReceipt(layout, trash, record);
                    throw notFound();
                }
                return true;
            }
            if (record.state == UndoState.PURGING || undoNow() >= record.expiresAt) {
                completePurge(layout, trash, record.asState(UndoState.PURGING));
                throw notFound();
            }
            if (record.state != UndoState.TRASHED) throw unsafe();
            if (listBounded(layout.records, ".owned", MAXIMUM_OWNED_DOCUMENTS).size()
                    >= MAXIMUM_OWNED_DOCUMENTS) throw limit();
            UndoRecord restoring = record.asState(UndoState.RESTORING);
            publishReplace(journal, encodeUndo(restoring));
            fsyncDirectory(layout.operations);
            faults.checkpoint(Checkpoint.AFTER_UNDO_RESTORE_INTENT);
            completeRestore(layout, trash, restoring);
            return true;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw unsafe();
        }
    }

    String undoTargetRef(String undoRef) throws Failure {
        if (!isUndoRef(undoRef)) throw invalid();
        Layout layout = prepareAndRecover();
        try {
            Path journal = layout.undoRecord(undoRef);
            if (!Files.exists(journal, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            UndoRecord record = decodeUndo(readUndoRecord(journal));
            if (!record.undoRef.equals(undoRef)
                    || !journal.equals(layout.undoRecord(record.undoRef))) throw corrupt();
            return record.ref;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    private UndoRecord recoverUndoTransactions(Layout layout, String targetRef)
            throws IOException, Failure {
        List<UndoRecord> records = readUndoRecords(layout);
        if (records.isEmpty()) return null;
        TrashLayout trash = TrashLayout.prepare(layout);
        long current = undoNow();
        int cleanupCount = 0;
        UndoRecord target = null;
        for (UndoRecord candidate : records) {
            boolean isTarget = candidate.ref.equals(targetRef)
                    && candidate.state != UndoState.RESTORED;
            boolean requiresRecovery = candidate.state == UndoState.PREPARED
                    || candidate.state == UndoState.RESTORING
                    || candidate.state == UndoState.PURGING;
            boolean requiresCleanup = (candidate.state == UndoState.TRASHED
                    && current >= candidate.expiresAt)
                    || (candidate.state == UndoState.RESTORED
                    && candidate.restoredAt >= 0
                    && current >= candidate.restoredAt
                    && current - candidate.restoredAt >= COMPLETED_RECORD_EXPIRY_MILLIS);
            if (!isTarget && !requiresRecovery && !requiresCleanup) continue;
            if (!isTarget && cleanupCount >= 4) continue;

            UndoRecord recovered = recoverUndo(layout, trash, candidate);
            if (!isTarget) cleanupCount++;
            if (recovered == null) continue;
            if (recovered.state == UndoState.TRASHED
                    && current >= recovered.expiresAt) {
                if (isTarget || cleanupCount < 4) {
                    completePurge(layout, trash, recovered.asState(UndoState.PURGING));
                    if (!isTarget) cleanupCount++;
                }
                continue;
            }
            if (recovered.state == UndoState.RESTORED) {
                if (recovered.restoredAt >= 0
                        && current >= recovered.restoredAt
                        && current - recovered.restoredAt >= COMPLETED_RECORD_EXPIRY_MILLIS
                        && (isTarget || cleanupCount < 4)) {
                    removeRestoredReceipt(layout, trash, recovered);
                    if (!isTarget) cleanupCount++;
                }
                continue;
            }
            if (recovered.state != UndoState.TRASHED) throw unsafe();
            if (isTarget) {
                if (target != null) throw unsafe();
                target = recovered;
            }
        }
        return target;
    }

    private static List<UndoRecord> readUndoRecords(Layout layout)
            throws IOException, Failure {
        List<Path> journals = listBounded(layout.operations, ".undo",
                MAXIMUM_OWNED_DOCUMENTS);
        ArrayList<UndoRecord> result = new ArrayList<>(journals.size());
        for (Path journal : journals) {
            UndoRecord record = decodeUndo(readUndoRecord(journal));
            if (!journal.equals(layout.undoRecord(record.undoRef))) throw corrupt();
            result.add(record);
        }
        return result;
    }

    private UndoRecord recoverUndo(Layout layout, TrashLayout trash, UndoRecord record)
            throws IOException, Failure {
        if (record.state == UndoState.PREPARED || record.state == UndoState.TRASHED) {
            return completeTrash(layout, trash, record);
        }
        if (record.state == UndoState.RESTORING) {
            requireRestoreCapacity(layout, record);
            return completeRestore(layout, trash, record);
        }
        if (record.state == UndoState.PURGING) {
            completePurge(layout, trash, record);
            return null;
        }
        if (record.state == UndoState.RESTORED) {
            return record;
        }
        throw unsafe();
    }

    private void recoverNonRestoringUndos(Layout layout) throws IOException, Failure {
        TrashLayout trash = null;
        for (UndoRecord record : readUndoRecords(layout)) {
            if (record.state != UndoState.PREPARED && record.state != UndoState.PURGING) continue;
            if (trash == null) trash = TrashLayout.prepare(layout);
            recoverUndo(layout, trash, record);
        }
    }

    private void recoverRestoringUndoForRef(Layout layout, String ref)
            throws IOException, Failure {
        UndoRecord restoring = null;
        for (UndoRecord record : readUndoRecords(layout)) {
            if (!record.ref.equals(ref) || record.state != UndoState.RESTORING) continue;
            if (restoring != null) throw unsafe();
            restoring = record;
        }
        if (restoring == null) return;
        requireRestoreCapacity(layout, restoring);
        recoverUndo(layout, TrashLayout.prepare(layout), restoring);
    }

    private static void requireRestoreCapacity(Layout layout, UndoRecord record)
            throws IOException, Failure {
        if (Files.exists(layout.ownedRecord(record.ref), LinkOption.NOFOLLOW_LINKS)) return;
        if (listBounded(layout.records, ".owned", MAXIMUM_OWNED_DOCUMENTS).size()
                >= MAXIMUM_OWNED_DOCUMENTS) throw limit();
    }

    private static void requireNewOwnedCapacity(Layout layout, String ref)
            throws IOException, Failure {
        if (Files.exists(layout.ownedRecord(ref), LinkOption.NOFOLLOW_LINKS)) return;
        int active = listBounded(layout.records, ".owned", MAXIMUM_OWNED_DOCUMENTS).size();
        int reserved = 0;
        HashSet<String> reservedRefs = new HashSet<>();
        for (UndoRecord record : readUndoRecords(layout)) {
            if (record.state != UndoState.RESTORING
                    || Files.exists(layout.ownedRecord(record.ref), LinkOption.NOFOLLOW_LINKS)) {
                continue;
            }
            if (!reservedRefs.add(record.ref)) throw unsafe();
            reserved++;
        }
        if (active >= MAXIMUM_OWNED_DOCUMENTS - reserved) throw limit();
    }


    private UndoRecord completeTrash(Layout layout, TrashLayout trash, UndoRecord record)
            throws IOException, Failure {
        Path ownedData = layout.ownedData(record.ref);
        Path ownedRecord = layout.ownedRecord(record.ref);
        Path trashData = trash.data(record.undoRef);
        Path trashRecord = trash.record(record.undoRef);
        boolean dataOwned = Files.exists(ownedData, LinkOption.NOFOLLOW_LINKS);
        boolean dataTrashed = Files.exists(trashData, LinkOption.NOFOLLOW_LINKS);
        boolean recordOwned = Files.exists(ownedRecord, LinkOption.NOFOLLOW_LINKS);
        boolean recordTrashed = Files.exists(trashRecord, LinkOption.NOFOLLOW_LINKS);
        if (record.state == UndoState.TRASHED) {
            if (dataOwned || recordOwned || !dataTrashed || !recordTrashed) throw unsafe();
            requireTrashMatches(trash, record);
            return record;
        }
        if (record.state != UndoState.PREPARED) throw unsafe();
        if (dataOwned == dataTrashed || recordOwned == recordTrashed
                || (dataTrashed && recordOwned)) throw unsafe();

        if (recordOwned) {
            OwnedDocument current = decodeOwned(readRecord(ownedRecord));
            if (!current.equals(record.document())) throw corrupt();
            moveAtomicPreserving(ownedRecord, trashRecord, -1);
            fsyncDirectory(layout.records);
            fsyncDirectory(trash.records);
            faults.checkpoint(Checkpoint.AFTER_UNDO_RECORD_MOVE);
        }
        if (dataOwned) {
            moveAtomicPreserving(ownedData, trashData, record.size);
            fsyncDirectory(layout.owned);
            fsyncDirectory(trash.data);
            faults.checkpoint(Checkpoint.AFTER_UNDO_DATA_MOVE);
        }
        requireTrashMatches(trash, record);
        if (Files.exists(ownedData, LinkOption.NOFOLLOW_LINKS)
                || Files.exists(ownedRecord, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
        UndoRecord trashed = record.asState(UndoState.TRASHED);
        publishReplace(layout.undoRecord(record.undoRef), encodeUndo(trashed));
        fsyncDirectory(layout.operations);
        faults.checkpoint(Checkpoint.AFTER_UNDO_TRASHED);
        return trashed;
    }

    private UndoRecord completeRestore(Layout layout, TrashLayout trash, UndoRecord record)
            throws IOException, Failure {
        Path ownedData = layout.ownedData(record.ref);
        Path ownedRecord = layout.ownedRecord(record.ref);
        Path trashData = trash.data(record.undoRef);
        Path trashRecord = trash.record(record.undoRef);
        boolean dataOwned = Files.exists(ownedData, LinkOption.NOFOLLOW_LINKS);
        boolean dataTrashed = Files.exists(trashData, LinkOption.NOFOLLOW_LINKS);
        boolean recordOwned = Files.exists(ownedRecord, LinkOption.NOFOLLOW_LINKS);
        boolean recordTrashed = Files.exists(trashRecord, LinkOption.NOFOLLOW_LINKS);
        if (dataOwned == dataTrashed || recordOwned == recordTrashed
                || (dataTrashed && recordOwned)) throw unsafe();

        if (dataTrashed) {
            moveAtomicPreserving(trashData, ownedData, record.size);
            fsyncDirectory(trash.data);
            fsyncDirectory(layout.owned);
            faults.checkpoint(Checkpoint.AFTER_UNDO_RESTORE_DATA_MOVE);
        }
        if (recordTrashed) {
            OwnedDocument current = decodeOwned(readRecord(trashRecord));
            if (!current.equals(record.document())) throw corrupt();
            moveAtomicPreserving(trashRecord, ownedRecord, -1);
            fsyncDirectory(trash.records);
            fsyncDirectory(layout.records);
            faults.checkpoint(Checkpoint.AFTER_UNDO_RESTORE_RECORD_MOVE);
        }
        requireOwnedMatches(layout, record.document());
        if (Files.exists(trashData, LinkOption.NOFOLLOW_LINKS)
                || Files.exists(trashRecord, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
        long restoredAt = undoNow();
        if (restoredAt < record.createdAt) restoredAt = record.createdAt;
        UndoRecord restored = record.asRestored(restoredAt);
        publishReplace(layout.undoRecord(record.undoRef), encodeUndo(restored));
        fsyncDirectory(layout.operations);
        faults.checkpoint(Checkpoint.AFTER_UNDO_RESTORED);
        return restored;
    }

    private void completePurge(Layout layout, TrashLayout trash, UndoRecord record)
            throws IOException, Failure {
        if (Files.exists(layout.ownedData(record.ref), LinkOption.NOFOLLOW_LINKS)
                || Files.exists(layout.ownedRecord(record.ref), LinkOption.NOFOLLOW_LINKS)) {
            throw unsafe();
        }
        UndoRecord purging = record.state == UndoState.PURGING
                ? record : record.asState(UndoState.PURGING);
        publishReplace(layout.undoRecord(record.undoRef), encodeUndo(purging));
        fsyncDirectory(layout.operations);
        faults.checkpoint(Checkpoint.AFTER_UNDO_PURGE_INTENT);
        deleteVerified(trash.data(record.undoRef));
        fsyncDirectory(trash.data);
        faults.checkpoint(Checkpoint.AFTER_UNDO_PURGE_DATA_DELETE);
        deleteVerified(trash.record(record.undoRef));
        fsyncDirectory(trash.records);
        faults.checkpoint(Checkpoint.AFTER_UNDO_PURGE_RECORD_DELETE);
        deleteVerified(layout.undoRecord(record.undoRef));
        fsyncDirectory(layout.operations);
    }

    private void removeRestoredReceipt(Layout layout, TrashLayout trash, UndoRecord record)
            throws IOException, Failure {
        if (Files.exists(trash.data(record.undoRef), LinkOption.NOFOLLOW_LINKS)
                || Files.exists(trash.record(record.undoRef), LinkOption.NOFOLLOW_LINKS)) {
            throw unsafe();
        }
        deleteVerified(layout.undoRecord(record.undoRef));
        fsyncDirectory(layout.operations);
    }

    private static void moveAtomicPreserving(Path source, Path target, long expected)
            throws IOException, Failure {
        requireAbsent(target);
        requireRegular(source, expected);
        BasicFileAttributes before = attributes(source);
        atomicMoveNew(source, target);
        BasicFileAttributes after = attributes(target);
        if (!sameIdentity(before, after)) throw unsafe();
    }

    private void requireTrashMatches(TrashLayout trash, UndoRecord record)
            throws IOException, Failure {
        requireRegular(trash.data(record.undoRef), record.size);
        OwnedDocument metadata = decodeOwned(readRecord(trash.record(record.undoRef)));
        if (!metadata.equals(record.document())) throw corrupt();
        validateOwnedTarget(trash.data(record.undoRef), metadata, () -> false);
    }

    private void requireOwnedMatches(Layout layout, OwnedDocument document)
            throws IOException, Failure {
        requireRegular(layout.ownedData(document.ref), document.sizeBytes);
        OwnedDocument metadata = decodeOwned(readRecord(layout.ownedRecord(document.ref)));
        if (!metadata.equals(document)) throw corrupt();
        validateOwnedTarget(layout.ownedData(document.ref), metadata, () -> false);
    }

    private OwnedDocument loadStructuralOwned(Layout layout, String ref) throws Failure {
        try {
            Path recordPath = layout.ownedRecord(ref);
            if (!Files.exists(recordPath, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            OwnedDocument record = decodeOwned(readRecord(recordPath));
            if (!record.ref.equals(ref) || !recordPath.equals(layout.ownedRecord(record.ref))) {
                throw corrupt();
            }
            if (!record.available) throw notFound();
            requireRegular(layout.ownedData(ref), record.sizeBytes);
            return record;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    private String nextUndoRef(Layout layout, TrashLayout trash) throws Failure {
        for (int attempt = 0; attempt < 4; attempt++) {
            String undoRef = nextRef("u1_");
            try {
                if (!Files.exists(layout.undoRecord(undoRef), LinkOption.NOFOLLOW_LINKS)
                        && !Files.exists(trash.data(undoRef), LinkOption.NOFOLLOW_LINKS)
                        && !Files.exists(trash.record(undoRef), LinkOption.NOFOLLOW_LINKS)) {
                    return undoRef;
                }
            } catch (IOException failure) {
                throw unsafe();
            }
        }
        throw unsafe();
    }

    private static UndoEntry undoEntry(UndoRecord record) {
        return new UndoEntry(record.undoRef, record.ref, record.expiresAt);
    }

    boolean deleteOwned(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        Layout layout = prepareAndRecover();
        try {
            String transientSession = null;
            for (var entry : transientSessions.entrySet()) {
                if (entry.getValue().equals(ref)) { transientSession = entry.getKey(); break; }
            }
            if (transientSession != null) {
                completeTransientDelete(layout, transientSession, ref, layout.transientMarker(transientSession));
                return true;
            }
            recoverRestoringUndoForRef(layout, ref);
            Path data = layout.ownedData(ref);
            Path record = layout.ownedRecord(ref);
            boolean dataPresent = Files.exists(data, LinkOption.NOFOLLOW_LINKS);
            boolean recordPresent = Files.exists(record, LinkOption.NOFOLLOW_LINKS);
            if (!dataPresent && !recordPresent) return false;
            requireDeletableIfPresent(data);
            if (recordPresent) {
                requireDeletableIfPresent(record);
                OwnedDocument metadata = decodeOwned(readRecord(record));
                if (!metadata.ref.equals(ref) || !record.equals(layout.ownedRecord(metadata.ref))) {
                    throw corrupt();
                }
            }
            Path marker = layout.deleteMarker(ref);
            try (FileChannel channel = FileChannel.open(marker,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            fsyncDirectory(layout.operations);
            completeDelete(layout, ref, marker);
            return true;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    int clearOwned() throws Failure {
        List<OwnedDocument> documents = listOwned();
        int removed = 0;
        for (OwnedDocument document : documents) {
            if (deleteOwned(document.ref)) removed++;
        }
        return removed;
    }

    int clearOwnedPayloads() throws Failure {
        List<OwnedDocument> documents = listOwned();
        int removed = 0;
        for (OwnedDocument document : documents) {
            if (clearOwnedPayload(document.ref)) removed++;
        }
        return removed;
    }

    private boolean clearOwnedPayload(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        Layout layout = prepareAndRecover();
        try {
            Path recordPath = layout.ownedRecord(ref);
            requireRegular(recordPath, -1);
            OwnedDocument document = decodeOwned(readRecord(recordPath));
            if (!document.ref.equals(ref) || !recordPath.equals(layout.ownedRecord(document.ref))) {
                throw corrupt();
            }
            Path data = layout.ownedData(ref);
            if (!document.available) {
                if (Files.exists(data, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
                return false;
            }
            requireRegular(data, document.sizeBytes);
            Path marker = layout.payloadClearMarker(ref);
            try (FileChannel channel = FileChannel.open(marker,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            fsyncDirectory(layout.operations);
            faults.checkpoint(Checkpoint.AFTER_PAYLOAD_CLEAR_MARKER);
            completePayloadClear(layout, ref, marker);
            return true;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    private Layout prepareAndRecover() throws Failure {
        try {
            Layout layout = Layout.prepare(filesDir);
            recoverTransientOutputs(layout);
            recoverNonRestoringUndos(layout);
            recoverPayloadClears(layout);
            recoverDeletes(layout);
            recoverSessions(layout);
            cleanupCompleted(layout);
            return layout;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    private void recoverTransientOutputs(Layout layout) throws IOException, Failure {
        for (Path marker : listBounded(layout.operations, ".transient", MAXIMUM_OWNED_DOCUMENTS)) {
            String filename = marker.getFileName().toString();
            String sessionId = filename.substring(0, filename.length() - ".transient".length());
            requireRegular(marker, -1);
            String ref = new String(readRecord(marker), java.nio.charset.StandardCharsets.US_ASCII);
            if (!isSessionRef(sessionId) || !PendingImportRecord.isValidRef(ref)
                    || !marker.equals(layout.transientMarker(sessionId))) throw unsafe();
            if (ref.equals(transientSessions.get(sessionId))) continue;
            completeTransientDelete(layout, sessionId, ref, marker);
        }
    }

    private void completeTransientDelete(Layout layout, String sessionId, String ref, Path marker)
            throws IOException, Failure {
        // Remove replay instructions first. A restart during cleanup must never
        // recreate the private document from a finish intent or session payload.
        deleteVerified(layout.finishRecord(sessionId));
        fsyncDirectory(layout.operations);
        deleteVerified(layout.sessionPart(sessionId));
        deleteVerified(layout.sessionRecord(sessionId));
        fsyncDirectory(layout.sessions);
        completeDelete(layout, ref, marker);
        transientSessions.remove(sessionId);
    }

    private void recoverPayloadClears(Layout layout) throws IOException, Failure {
        List<Path> markers = listBounded(layout.operations, ".payload-clear",
                MAXIMUM_OWNED_DOCUMENTS);
        for (Path marker : markers) {
            requireRegular(marker, 0);
            String name = marker.getFileName().toString();
            if (!name.startsWith("clear_") || !name.endsWith(".payload-clear")) {
                throw corrupt();
            }
            String payload = name.substring("clear_".length(),
                    name.length() - ".payload-clear".length());
            String ref = "d1_" + payload;
            if (!PendingImportRecord.isValidRef(ref)
                    || !marker.equals(layout.payloadClearMarker(ref))) throw corrupt();
            completePayloadClear(layout, ref, marker);
        }
    }

    private void completePayloadClear(Layout layout, String ref, Path marker)
            throws IOException, Failure {
        requireRegular(marker, 0);
        Path recordPath = layout.ownedRecord(ref);
        requireRegular(recordPath, -1);
        OwnedDocument current = decodeOwned(readRecord(recordPath));
        if (!current.ref.equals(ref) || !recordPath.equals(layout.ownedRecord(current.ref))) {
            throw corrupt();
        }
        Path data = layout.ownedData(ref);
        if (current.available) {
            requireRegular(data, current.sizeBytes);
            OwnedDocument unavailableRecord = new OwnedDocument(current.ref,
                    current.displayName, current.mimeType, current.sizeBytes,
                    current.contentHash, current.createdAtMillis, false);
            publishReplace(recordPath, encodeOwned(unavailableRecord));
            fsyncDirectory(layout.records);
            faults.checkpoint(Checkpoint.AFTER_PAYLOAD_CLEAR_RECORD_PUBLISH);
        } else if (Files.exists(data, LinkOption.NOFOLLOW_LINKS)) {
            requireRegular(data, current.sizeBytes);
        }
        faults.checkpoint(Checkpoint.BEFORE_PAYLOAD_CLEAR_DATA_DELETE);
        deleteVerified(data);
        fsyncDirectory(layout.owned);
        faults.checkpoint(Checkpoint.BEFORE_PAYLOAD_CLEAR_MARKER_DELETE);
        deleteVerified(marker);
        fsyncDirectory(layout.operations);
    }

    private void recoverDeletes(Layout layout) throws IOException, Failure {
        List<Path> markers = listBounded(layout.operations, ".delete",
                MAXIMUM_OWNED_DOCUMENTS);
        for (Path marker : markers) {
            requireRegular(marker, 0);
            String name = marker.getFileName().toString();
            if (!name.startsWith("delete_") || !name.endsWith(".delete")) throw corrupt();
            String payload = name.substring("delete_".length(),
                    name.length() - ".delete".length());
            String ref = "d1_" + payload;
            if (!PendingImportRecord.isValidRef(ref) || !marker.equals(layout.deleteMarker(ref))) {
                throw corrupt();
            }
            recoverRestoringUndoForRef(layout, ref);
            completeDelete(layout, ref, marker);
        }
    }

    private void completeDelete(Layout layout, String ref, Path marker)
            throws IOException, Failure {
        Path data = layout.ownedData(ref);
        Path record = layout.ownedRecord(ref);
        requireDeletableIfPresent(data);
        requireDeletableIfPresent(record);
        faults.checkpoint(Checkpoint.BEFORE_OWNED_DATA_DELETE);
        deleteVerified(data);
        fsyncDirectory(layout.owned);
        faults.checkpoint(Checkpoint.BEFORE_OWNED_RECORD_DELETE);
        deleteVerified(record);
        fsyncDirectory(layout.records);
        faults.checkpoint(Checkpoint.BEFORE_DELETE_MARKER_DELETE);
        deleteVerified(marker);
        fsyncDirectory(layout.operations);
    }

    private static void requireDeletableIfPresent(Path path) throws IOException, Failure {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
    }

    private void recoverSessions(Layout layout) throws IOException, Failure {
        List<Path> records = listBounded(layout.sessions, ".session", MAXIMUM_OPEN_SESSIONS);
        long current = now();
        for (Path path : records) {
            SessionRecord session = decodeSession(readRecord(path));
            Path part = layout.sessionPart(session.sessionId);
            if (!Files.exists(part, LinkOption.NOFOLLOW_LINKS)) {
                FinishRecord finish = loadFinishIfPresent(layout, session.sessionId);
                if (finish != null && finish.committed) {
                    deleteExact(path);
                    continue;
                }
                markInterrupted(layout, session);
                continue;
            }
            requireRegular(part, -1);
            long actual = Files.size(part);
            boolean expired = current - session.lastActivity >= INACTIVITY_EXPIRY_MILLIS
                    || current - session.createdAt >= ABSOLUTE_EXPIRY_MILLIS;
            if (expired) {
                deleteExact(part);
                deleteExact(path);
                continue;
            }
            if (actual < session.committedBytes) {
                markInterrupted(layout, session);
            } else if (actual > session.committedBytes) {
                try (FileChannel channel = FileChannel.open(part, StandardOpenOption.WRITE,
                        LinkOption.NOFOLLOW_LINKS)) {
                    channel.truncate(session.committedBytes);
                    channel.force(true);
                }
                markInterrupted(layout, session);
            }
        }
    }

    private void cleanupCompleted(Layout layout) throws IOException, Failure {
        long current = now();
        ArrayList<CleanupCandidate> expired = new ArrayList<>(5);
        int seen = 0;
        try (var stream = Files.newDirectoryStream(layout.operations, "*.finish")) {
            for (Path path : stream) {
                if (++seen > MAXIMUM_OWNED_DOCUMENTS + MAXIMUM_OPEN_SESSIONS) throw limit();
                requireRegular(path, -1);
                long createdAt;
                boolean eligible;
                try {
                    FinishRecord record = decodeFinish(readRecord(path));
                    createdAt = record.createdAt;
                    eligible = record.committed;
                } catch (IOException invalidRecord) {
                    createdAt = attributes(path).lastModifiedTime().toMillis();
                    eligible = true;
                }
                long age = current - createdAt;
                if (age < 0) continue;
                if (!eligible || age < COMPLETED_RECORD_EXPIRY_MILLIS) continue;
                expired.add(new CleanupCandidate(path, createdAt));
                expired.sort(Comparator.comparingLong(CleanupCandidate::createdAt)
                        .thenComparing(value -> value.path.getFileName().toString()));
                if (expired.size() > 4) expired.remove(expired.size() - 1);
            }
        }
        boolean changed = false;
        for (CleanupCandidate candidate : expired) {
            deleteVerified(candidate.path);
            changed = true;
        }
        if (changed) fsyncDirectory(layout.operations);
    }

    private List<SessionRecord> readSessions(Layout layout) throws Failure {
        try {
            List<Path> paths = listBounded(layout.sessions, ".session", MAXIMUM_OPEN_SESSIONS);
            ArrayList<SessionRecord> result = new ArrayList<>();
            for (Path path : paths) result.add(decodeSession(readRecord(path)));
            return result;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException failure) {
            throw unsafe();
        }
    }

    private SessionRecord loadSession(Layout layout, String id) throws Failure {
        try {
            Path path = layout.sessionRecord(id);
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            SessionRecord record = decodeSession(readRecord(path));
            if (!record.sessionId.equals(id)) throw corrupt();
            return record;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException failure) {
            throw corrupt();
        }
    }

    private FinishRecord loadFinishIfPresent(Layout layout, String sessionId) throws Failure {
        try {
            Path path = layout.finishRecord(sessionId);
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return null;
            FinishRecord record = decodeFinish(readRecord(path));
            if (!record.operationId.equals(sessionId)) throw corrupt();
            if (!record.committed && Files.exists(layout.ownedData(record.ref), LinkOption.NOFOLLOW_LINKS)) {
                OwnedDocument recovered = new OwnedDocument(record.ref, record.displayName,
                        record.mimeType, record.size, record.hash, record.createdAt, true);
                validateOwnedTarget(layout.ownedData(record.ref), recovered, () -> false);
                publishOwnedIfAbsent(layout, recovered);
                publishReplace(path, encodeFinish(record.asCommitted()));
                fsyncDirectory(layout.operations);
                return record.asCommitted();
            }
            return record;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException failure) {
            throw unsafe();
        }
    }

    private OwnedDocument loadOwned(Layout layout, String ref) throws Failure {
        return loadValidatedOwned(layout, ref).document;
    }

    private ValidatedOwned loadValidatedOwned(Layout layout, String ref) throws Failure {
        try {
            Path recordPath = layout.ownedRecord(ref);
            if (!Files.exists(recordPath, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            OwnedDocument record = decodeOwned(readRecord(recordPath));
            if (!record.ref.equals(ref)) throw corrupt();
            if (!record.available) throw notFound();
            Path data = layout.ownedData(ref);
            BasicFileAttributes identity = validateOwnedTarget(data, record, () -> false);
            return new ValidatedOwned(record, identity);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException failure) {
            throw corrupt();
        }
    }

    private static void publishOwnedIfAbsent(Layout layout, OwnedDocument record)
            throws IOException, Failure {
        Path target = layout.ownedRecord(record.ref);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            OwnedDocument existing = decodeOwned(readRecord(target));
            if (!existing.equals(record)) throw corrupt();
            return;
        }
        publishNew(target, encodeOwned(record));
    }

    private BasicFileAttributes validateOwnedTarget(Path path, OwnedDocument expected,
            OwnedPendingImportStore.CancellationSignal cancellation)
            throws IOException, Failure {
        BasicFileAttributes before = attributes(path);
        if (!before.isRegularFile() || Files.isSymbolicLink(path)
                || before.size() != expected.sizeBytes) throw corrupt();
        FileDigest actual = digest(path, expected.sizeBytes, cancellation, expected.mimeType);
        faults.checkpoint(Checkpoint.AFTER_OWNED_TARGET_DIGEST);
        BasicFileAttributes after = attributes(path);
        if (!sameIdentity(before, after) || actual.size != expected.sizeBytes
                || !actual.hash.equals(expected.contentHash)) throw corrupt();
        validateMagic(expected.mimeType, actual.prefix);
        return after;
    }

    private void markInterrupted(Layout layout, SessionRecord session) {
        try {
            SessionRecord interrupted = new SessionRecord(session.sessionId, session.displayName, session.mimeType,
                    session.committedBytes, session.createdAt, session.lastActivity, State.INTERRUPTED);
            publishReplace(layout.sessionRecord(session.sessionId), encodeSession(interrupted));
            fsyncDirectory(layout.sessions);
        } catch (IOException ignored) {
            // The caller returns unsafe; recovery will refuse a size/journal mismatch again.
        }
    }

    private Path pendingData(String ref) throws IOException {
        String payload = PendingImportRecord.refPayload(ref);
        return direct(filesDir.resolve("pdfchef_pending_imports").resolve("data"), payload + ".bin");
    }

    private void removeExactPendingMarker(String ref) throws IOException {
        String payload = PendingImportRecord.refPayload(ref);
        Path records = filesDir.resolve("pdfchef_pending_imports").resolve("records");
        Path marker = direct(records, payload + ".pending");
        deleteExact(marker);
        if (Files.isDirectory(records, LinkOption.NOFOLLOW_LINKS)) fsyncDirectory(records);
    }

    private String nextRef(String prefix) throws Failure {
        for (int attempt = 0; attempt < 4; attempt++) {
            String token = tokens.next();
            String ref = prefix + token;
            if ((prefix.equals("d1_") && PendingImportRecord.isValidRef(ref))
                    || (prefix.equals("w1_") && isSessionRef(ref))
                    || (prefix.equals("u1_") && isUndoRef(ref))) return ref;
        }
        throw unsafe();
    }

    private long now() throws Failure {
        long value = clock.nowMillis();
        if (value < 0) throw unsafe();
        return value;
    }

    private long undoNow() throws Failure {
        long value = now();
        if (value > MAXIMUM_SAFE_INTEGER) throw unsafe();
        return value;
    }

    private static long aggregateBytes(List<SessionRecord> sessions) throws Failure {
        long result = 0;
        for (SessionRecord session : sessions) {
            if (session.committedBytes < 0 || result > MAXIMUM_OPEN_BYTES - session.committedBytes) {
                throw unsafe();
            }
            result += session.committedBytes;
        }
        return result;
    }

    private static void requireMime(String mimeType) throws Failure {
        if (!OwnedDocumentWritePolicy.isSupportedMimeType(mimeType)) throw invalid();
    }

    private static boolean isSessionRef(String ref) {
        return ref != null && SESSION_REF.matcher(ref).matches();
    }

    private static boolean isUndoRef(String ref) {
        return ref != null && UNDO_REF.matcher(ref).matches();
    }

    private static String undoPayload(String undoRef) throws IOException {
        if (!isUndoRef(undoRef)) throw new IOException("undo");
        return undoRef.substring("u1_".length());
    }

    private static FileDigest digest(Path path, long expected,
            OwnedPendingImportStore.CancellationSignal cancellation, String mimeType) throws IOException, Failure {
        requireRegular(path, expected);
        MessageDigest digest = sha256();
        ByteArrayOutputStream prefix = new ByteArrayOutputStream(16);
        ByteBuffer buffer = ByteBuffer.allocate(64 * 1024);
        long total = 0;
        TextValidator text = OwnedDocumentWritePolicy.MIME_TEXT.equals(mimeType) ? new TextValidator() : null;
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            while (true) {
                checkCancelled(cancellation);
                int read = channel.read(buffer);
                if (read < 0) break;
                if (read == 0) continue;
                total += read;
                if (total > expected || total > MAXIMUM_FILE_BYTES) throw corrupt();
                buffer.flip();
                if (prefix.size() < 16) {
                    ByteBuffer copy = buffer.asReadOnlyBuffer();
                    int wanted = Math.min(copy.remaining(), 16 - prefix.size());
                    byte[] first = new byte[wanted];
                    copy.get(first);
                    prefix.write(first);
                }
                if (text != null) text.accept(buffer.asReadOnlyBuffer());
                digest.update(buffer);
                buffer.clear();
            }
        }
        if (total != expected) throw corrupt();
        if (text != null) text.finish();
        return new FileDigest(total, hex(digest.digest()), prefix.toByteArray());
    }

    private static byte[] encodeSession(SessionRecord value) throws IOException {
        return encode(output -> {
            output.writeInt(SESSION_MAGIC); output.writeInt(VERSION);
            writeAscii(output, value.sessionId); writeNullableUtf8(output, value.displayName); writeAscii(output, value.mimeType);
            output.writeLong(value.committedBytes); output.writeLong(value.createdAt);
            output.writeLong(value.lastActivity); output.writeByte(value.state.ordinal());
        });
    }

    private static SessionRecord decodeSession(byte[] bytes) throws IOException {
        return decode(bytes, input -> {
            int version = requireHeader(input, SESSION_MAGIC);
            String sessionId = readAscii(input, 67);
            String displayName = version == 1 ? null : readNullableUtf8(input);
            SessionRecord result = new SessionRecord(sessionId, displayName, readAscii(input, 128),
                    input.readLong(), input.readLong(), input.readLong(),
                    State.from(input.readUnsignedByte()));
            requireEof(input);
            if (!isSessionRef(result.sessionId)
                    || !OwnedDocumentWritePolicy.isSupportedMimeType(result.mimeType)
                    || !OwnedDocumentWritePolicy.isValidDisplayName(result.displayName)
                    || result.committedBytes < 0 || result.committedBytes > MAXIMUM_FILE_BYTES
                    || result.createdAt < 0 || result.lastActivity < result.createdAt) {
                throw new IOException("record");
            }
            return result;
        });
    }

    private static byte[] encodeOwned(OwnedDocument value) throws IOException {
        return encode(output -> {
            output.writeInt(OWNED_MAGIC); output.writeInt(OWNED_VERSION);
            writeAscii(output, value.ref); writeNullableUtf8(output, value.displayName); writeAscii(output, value.mimeType);
            output.writeLong(value.sizeBytes); writeAscii(output, value.contentHash);
            output.writeLong(value.createdAtMillis); output.writeBoolean(value.available);
        });
    }

    private static OwnedDocument decodeOwned(byte[] bytes) throws IOException {
        return decode(bytes, input -> {
            int version = requireOwnedHeader(input);
            String ref = readAscii(input, 67);
            String displayName = version == 1 ? null : readNullableUtf8(input);
            OwnedDocument result = new OwnedDocument(ref, displayName, readAscii(input, 128),
                    input.readLong(), readAscii(input, 64), input.readLong(),
                    version >= OWNED_VERSION ? input.readBoolean() : true);
            requireEof(input); return result;
        });
    }

    private static byte[] encodeFinish(FinishRecord value) throws IOException {
        return encode(output -> {
            output.writeInt(FINISH_MAGIC); output.writeInt(VERSION);
            writeAscii(output, value.operationId); writeAscii(output, value.ref); writeNullableUtf8(output, value.displayName);
            writeAscii(output, value.mimeType); output.writeLong(value.size);
            writeAscii(output, value.hash); output.writeLong(value.createdAt);
            output.writeBoolean(value.committed);
        });
    }

    private static FinishRecord decodeFinish(byte[] bytes) throws IOException {
        return decode(bytes, input -> {
            int version = requireHeader(input, FINISH_MAGIC);
            String operationId = readAscii(input, 80); String ref = readAscii(input, 67);
            String displayName = version == 1 ? null : readNullableUtf8(input);
            FinishRecord result = new FinishRecord(operationId, ref, displayName,
                    readAscii(input, 128), input.readLong(), readAscii(input, 64),
                    input.readLong(), input.readBoolean());
            requireEof(input);
            if (!PendingImportRecord.isValidRef(result.ref)
                    || !(isSessionRef(result.operationId)
                    || result.operationId.equals("retain_" + result.ref))
                    || !OwnedDocumentWritePolicy.isSupportedMimeType(result.mimeType)
                    || !OwnedDocumentWritePolicy.isValidDisplayName(result.displayName)
                    || result.size <= 0 || result.size > MAXIMUM_FILE_BYTES
                    || !HASH.matcher(result.hash).matches() || result.createdAt < 0) {
                throw new IOException("record");
            }
            return result;
        });
    }

    private static byte[] encodeUndo(UndoRecord value) throws IOException {
        return encode(MAXIMUM_UNDO_RECORD_BYTES, output -> {
            output.writeInt(UNDO_MAGIC); output.writeInt(VERSION);
            writeAscii(output, value.undoRef); writeAscii(output, value.ref);
            writeNullableUtf8(output, value.displayName); writeAscii(output, value.mimeType);
            output.writeLong(value.size); writeAscii(output, value.hash);
            output.writeLong(value.documentCreatedAt); output.writeLong(value.createdAt);
            output.writeLong(value.expiresAt); output.writeLong(value.restoredAt);
            output.writeByte(value.state.ordinal());
        });
    }

    private static UndoRecord decodeUndo(byte[] bytes) throws IOException {
        return decode(bytes, MAXIMUM_UNDO_RECORD_BYTES, input -> {
            requireHeader(input, UNDO_MAGIC);
            UndoRecord result = new UndoRecord(readAscii(input, 67), readAscii(input, 67),
                    readNullableUtf8(input), readAscii(input, 128), input.readLong(),
                    readAscii(input, 64), input.readLong(), input.readLong(),
                    input.readLong(), input.readLong(), UndoState.from(input.readUnsignedByte()));
            requireEof(input);
            if (!isUndoRef(result.undoRef)
                    || !PendingImportRecord.isValidRef(result.ref)
                    || !OwnedDocumentWritePolicy.isSupportedMimeType(result.mimeType)
                    || !OwnedDocumentWritePolicy.isValidDisplayName(result.displayName)
                    || result.size <= 0 || result.size > MAXIMUM_FILE_BYTES
                    || !HASH.matcher(result.hash).matches()
                    || result.documentCreatedAt < 0 || result.createdAt < 0
                    || result.expiresAt < result.createdAt
                    || result.expiresAt > MAXIMUM_SAFE_INTEGER
                    || result.expiresAt - result.createdAt != UNDO_EXPIRY_MILLIS
                    || (result.state == UndoState.RESTORED) != (result.restoredAt >= 0)
                    || result.restoredAt > MAXIMUM_SAFE_INTEGER
                    || (result.restoredAt >= 0 && result.restoredAt < result.createdAt)) {
                throw new IOException("record");
            }
            result.document();
            return result;
        });
    }

    private static byte[] encode(Encoder encoder) throws IOException {
        return encode(MAXIMUM_RECORD_BYTES, encoder);
    }

    private static byte[] encode(int maximum, Encoder encoder) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) { encoder.write(output); }
        byte[] result = bytes.toByteArray();
        if (result.length == 0 || result.length > maximum) throw new IOException("record");
        return result;
    }

    private static <T> T decode(byte[] bytes, Decoder<T> decoder) throws IOException {
        return decode(bytes, MAXIMUM_RECORD_BYTES, decoder);
    }

    private static <T> T decode(byte[] bytes, int maximum, Decoder<T> decoder)
            throws IOException {
        if (bytes == null || bytes.length == 0 || bytes.length > maximum) {
            throw new IOException("record");
        }
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            return decoder.read(input);
        } catch (EOFException failure) {
            throw new IOException("record", failure);
        }
    }

    private static int requireHeader(DataInputStream input, int magic) throws IOException {
        if (input.readInt() != magic) throw new IOException("record");
        int version = input.readInt();
        if (version != 1 && version != VERSION) throw new IOException("record");
        return version;
    }

    private static int requireOwnedHeader(DataInputStream input) throws IOException {
        if (input.readInt() != OWNED_MAGIC) throw new IOException("record");
        int version = input.readInt();
        if (version != 1 && version != VERSION && version != OWNED_VERSION) {
            throw new IOException("record");
        }
        return version;
    }

    private static void requireEof(DataInputStream input) throws IOException {
        if (input.read() != -1) throw new IOException("record");
    }

    private static void writeAscii(DataOutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        if (!value.equals(new String(bytes, java.nio.charset.StandardCharsets.US_ASCII))
                || bytes.length > 255) throw new IOException("field");
        output.writeByte(bytes.length); output.write(bytes);
    }

    private static String readAscii(DataInputStream input, int maximum) throws IOException {
        int length = input.readUnsignedByte();
        if (length > maximum) throw new IOException("field");
        byte[] bytes = new byte[length];
        input.readFully(bytes);
        String value = new String(bytes, java.nio.charset.StandardCharsets.US_ASCII);
        if (value.length() != length) throw new IOException("field");
        return value;
    }

    private static void writeNullableUtf8(DataOutputStream output, String value) throws IOException {
        if (value == null) { output.writeShort(-1); return; }
        byte[] bytes = OwnedDocumentWritePolicy.utf8Bytes(value);
        if (bytes == null || !OwnedDocumentWritePolicy.isValidDisplayName(value) || bytes.length > 720) throw new IOException("field");
        output.writeShort(bytes.length); output.write(bytes);
    }

    private static String readNullableUtf8(DataInputStream input) throws IOException {
        int length = input.readShort();
        if (length == -1) return null;
        if (length < 0 || length > 720) throw new IOException("field");
        byte[] bytes = new byte[length]; input.readFully(bytes);
        java.nio.charset.CharsetDecoder decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
        try {
            String value = decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString();
            if (!OwnedDocumentWritePolicy.isValidDisplayName(value)) throw new IOException("field");
            return value;
        } catch (java.nio.charset.CharacterCodingException failure) { throw new IOException("field", failure); }
    }

    private static byte[] readRecord(Path path) throws IOException {
        requireRegular(path, -1);
        long size = Files.size(path);
        if (size <= 0 || size > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        return Files.readAllBytes(path);
    }

    private static byte[] readUndoRecord(Path path) throws IOException {
        requireRegular(path, -1);
        long size = Files.size(path);
        if (size <= 0 || size > MAXIMUM_UNDO_RECORD_BYTES) throw new IOException("record");
        return Files.readAllBytes(path);
    }

    private static void publishReplace(Path target, byte[] bytes) throws IOException {
        Path temp = direct(target.getParent(), target.getFileName() + ".tmp");
        deleteExact(temp);
        writeForced(temp, bytes);
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException failure) {
            deleteExact(temp); throw failure;
        }
    }

    private static void publishNew(Path target, byte[] bytes) throws IOException {
        Path temp = direct(target.getParent(), target.getFileName() + ".tmp");
        requireAbsent(target); deleteExact(temp); writeForced(temp, bytes);
        try { atomicMoveNew(temp, target); }
        finally { deleteExact(temp); }
    }

    private static void writeForced(Path path, byte[] bytes) throws IOException {
        try (FileChannel channel = FileChannel.open(path,
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer);
            channel.force(true);
        }
    }

    private static void atomicMoveNew(Path source, Path target) throws IOException {
        Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
    }

    private static void requireAbsent(Path path) throws IOException {
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("exists");
    }

    private static void requireRegular(Path path, long expected) throws IOException {
        BasicFileAttributes attributes = attributes(path);
        if (!attributes.isRegularFile() || Files.isSymbolicLink(path)
                || (expected >= 0 && attributes.size() != expected)) throw new IOException("unsafe");
    }

    private static boolean sameIdentity(BasicFileAttributes first, BasicFileAttributes second) {
        return first.isRegularFile() && second.isRegularFile()
                && Objects.equals(first.fileKey(), second.fileKey())
                && first.size() == second.size()
                && first.lastModifiedTime().equals(second.lastModifiedTime());
    }

    private static void validateMagic(String mimeType, byte[] prefix) throws Failure {
        if (!OwnedDocumentWritePolicy.hasValidMagic(mimeType, prefix)) throw corrupt();
    }

    private static final class TextValidator {
        private final java.nio.charset.CharsetDecoder decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
        private final ByteBuffer carry = ByteBuffer.allocate(4);
        private final java.nio.CharBuffer chars = java.nio.CharBuffer.allocate(64 * 1024);
        void accept(ByteBuffer source) throws Failure {
            ByteBuffer input = ByteBuffer.allocate(carry.position() + source.remaining());
            carry.flip(); input.put(carry); carry.clear();
            while (source.hasRemaining()) { byte value = source.get(); if (value == 0) throw corrupt(); input.put(value); }
            input.flip(); decode(input, false);
            if (input.remaining() > 3) throw corrupt();
            carry.put(input);
        }
        void finish() throws Failure { carry.flip(); decode(carry, true); if (carry.hasRemaining()) throw corrupt(); try { java.nio.charset.CoderResult result = decoder.flush(chars); if (result.isError()) result.throwException(); } catch (java.nio.charset.CharacterCodingException failure) { throw corrupt(); } }
        private void decode(ByteBuffer input, boolean end) throws Failure { try { while (true) { java.nio.charset.CoderResult result = decoder.decode(input, chars, end); chars.clear(); if (result.isError()) result.throwException(); if (!result.isOverflow()) return; } } catch (java.nio.charset.CharacterCodingException failure) { throw corrupt(); } }
    }


    private static BasicFileAttributes attributes(Path path) throws IOException {
        return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }

    private static Path direct(Path parent, String name) throws IOException {
        Path normalizedParent = parent.toAbsolutePath().normalize();
        Path child = normalizedParent.resolve(name).normalize();
        if (!normalizedParent.equals(child.getParent())) throw new IOException("unsafe");
        return child;
    }

    private static List<Path> listBounded(Path directory, String suffix, int maximum)
            throws IOException, Failure {
        List<Path> result = listFirst(directory, suffix, maximum + 1);
        if (result.size() > maximum) throw limit();
        return result;
    }

    private static List<Path> listFirst(Path directory, String suffix, int maximum)
            throws IOException {
        ArrayList<Path> result = new ArrayList<>();
        try (var stream = Files.list(directory)) {
            stream.filter(path -> path.getFileName().toString().endsWith(suffix))
                    .limit(maximum).forEach(result::add);
        }
        result.sort(Comparator.comparing(path -> path.getFileName().toString()));
        return result;
    }

    private static void fsyncDirectory(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        }
    }

    private static void deleteExact(Path path) {
        if (path == null) return;
        try {
            if (!Files.isSymbolicLink(path)
                    && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) Files.deleteIfExists(path);
        } catch (IOException | SecurityException ignored) { }
    }

    private static void deleteVerified(Path path) throws IOException, Failure {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
        Files.delete(path);
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("present");
    }

    private static void cleanupRenamePart(Layout layout, Path part)
            throws IOException, Failure {
        if (part == null || !Files.exists(part, LinkOption.NOFOLLOW_LINKS)) return;
        deleteVerified(part);
        fsyncDirectory(layout.records);
    }

    private static void cleanupRenamePartOrUnsafe(Layout layout, Path part) throws Failure {
        try { cleanupRenamePart(layout, part); }
        catch (IOException | RuntimeException failure) { throw unsafe(); }
    }

    private static MessageDigest sha256() throws IOException {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private static void checkCancelled(OwnedPendingImportStore.CancellationSignal signal)
            throws Failure {
        if (Thread.currentThread().isInterrupted() || signal.isCancelled()) throw cancelled();
    }

    private static TokenSource secureTokens() {
        SecureRandom random = new SecureRandom();
        return () -> {
            byte[] bytes = new byte[18]; random.nextBytes(bytes);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        };
    }

    static final class BeginResult {
        final String sessionId; final int maximumChunkBytes;
        BeginResult(String sessionId, int maximumChunkBytes) {
            this.sessionId = sessionId; this.maximumChunkBytes = maximumChunkBytes;
        }
    }

    static final class OwnedDocument {
        final String ref; final String displayName; final String mimeType; final long sizeBytes;
        final String contentHash; final long createdAtMillis; final boolean available;
        OwnedDocument(String ref, String displayName, String mimeType, long sizeBytes,
                String contentHash, long createdAtMillis, boolean available) throws IOException {
            if (!PendingImportRecord.isValidRef(ref)
                    || !OwnedDocumentWritePolicy.isSupportedMimeType(mimeType)
                    || !OwnedDocumentWritePolicy.isValidDisplayName(displayName)
                    || sizeBytes <= 0 || sizeBytes > MAXIMUM_FILE_BYTES
                    || contentHash == null || !HASH.matcher(contentHash).matches()
                    || createdAtMillis < 0) throw new IOException("owned");
            this.ref = ref; this.displayName = displayName; this.mimeType = mimeType; this.sizeBytes = sizeBytes;
            this.contentHash = contentHash; this.createdAtMillis = createdAtMillis;
            this.available = available;
        }
        @Override public boolean equals(Object other) {
            if (!(other instanceof OwnedDocument value)) return false;
            return ref.equals(value.ref) && Objects.equals(displayName, value.displayName) && mimeType.equals(value.mimeType)
                    && sizeBytes == value.sizeBytes && contentHash.equals(value.contentHash)
                    && createdAtMillis == value.createdAtMillis && available == value.available;
        }
        @Override public int hashCode() { return Objects.hash(ref, displayName, mimeType, sizeBytes,
                contentHash, createdAtMillis, available); }
    }

    interface DocumentSource extends AutoCloseable {
        String mimeType();
        long sizeBytes();
        int read(long offset, byte[] target) throws Failure;
        @Override default void close() { }
    }

    private static final class OwnedSource implements DocumentSource {
        private final Path path; private final BasicFileAttributes identity;
        private final OwnedDocument document;
        private final FileChannel channel;
        private boolean closed;
        OwnedSource(Path path, BasicFileAttributes identity, OwnedDocument document)
                throws IOException, Failure {
            this.path = path; this.identity = identity; this.document = document;
            this.channel = FileChannel.open(path, StandardOpenOption.READ,
                    LinkOption.NOFOLLOW_LINKS);
            BasicFileAttributes afterOpen = attributes(path);
            if (!same(identity, afterOpen) || channel.size() != document.sizeBytes) {
                channel.close();
                throw unsafe();
            }
        }
        @Override public String mimeType() { return document.mimeType; }
        @Override public long sizeBytes() { return document.sizeBytes; }
        @Override public int read(long offset, byte[] target) throws Failure {
            if (offset < 0 || target == null || target.length == 0
                    || target.length > MAXIMUM_CHUNK_BYTES || closed) throw invalid();
            try {
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                BasicFileAttributes before = attributes(path);
                if (!same(identity, before) || before.size() != document.sizeBytes) throw unsafe();
                channel.position(offset);
                int read = channel.read(ByteBuffer.wrap(target));
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                if (!same(before, attributes(path))) throw unsafe();
                return Math.max(read, 0);
            } catch (Failure failure) {
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                throw failure;
            } catch (IOException failure) {
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                throw unavailable();
            }
        }
        @Override public void close() {
            if (closed) return;
            closed = true;
            try { channel.close(); } catch (IOException ignored) { }
        }
        private static boolean same(BasicFileAttributes a, BasicFileAttributes b) {
            return Objects.equals(a.fileKey(), b.fileKey()) && a.size() == b.size()
                    && a.lastModifiedTime().equals(b.lastModifiedTime());
        }
    }

    private final class OwnedReaderSource implements DocumentSource {
        private final Path path;
        private final BasicFileAttributes identity;
        private final OwnedDocument document;
        private final FileChannel channel;
        private final MessageDigest digest;
        private final ByteArrayOutputStream prefix = new ByteArrayOutputStream(16);
        private long consumed;
        private boolean closed;

        OwnedReaderSource(Path path, BasicFileAttributes identity, OwnedDocument document)
                throws IOException, Failure {
            this.path = path;
            this.identity = identity;
            this.document = document;
            this.digest = sha256();
            this.channel = FileChannel.open(path, StandardOpenOption.READ,
                    LinkOption.NOFOLLOW_LINKS);
            BasicFileAttributes afterOpen = attributes(path);
            if (!sameIdentity(identity, afterOpen) || channel.size() != document.sizeBytes) {
                channel.close();
                throw unsafe();
            }
        }

        @Override public String mimeType() { return document.mimeType; }
        @Override public long sizeBytes() { return document.sizeBytes; }

        @Override public synchronized int read(long offset, byte[] target) throws Failure {
            if (closed || offset != consumed || target == null || target.length == 0
                    || target.length > MAXIMUM_CHUNK_BYTES) throw invalid();
            if (consumed == document.sizeBytes) return 0;
            try {
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                BasicFileAttributes before = attributes(path);
                if (!sameIdentity(identity, before) || channel.size() != document.sizeBytes) {
                    throw unsafe();
                }
                int requested = (int) Math.min((long) target.length,
                        document.sizeBytes - consumed);
                ByteBuffer buffer = ByteBuffer.wrap(target, 0, requested);
                int total = 0;
                int emptyReads = 0;
                while (buffer.hasRemaining()) {
                    if (Thread.currentThread().isInterrupted()) throw interrupted();
                    int read = channel.read(buffer);
                    if (read < 0) throw corrupt();
                    if (read == 0) {
                        if (++emptyReads > 8) throw unsafe();
                        continue;
                    }
                    emptyReads = 0;
                    total += read;
                }
                digest.update(target, 0, total);
                if (prefix.size() < 16) {
                    int wanted = Math.min(total, 16 - prefix.size());
                    prefix.write(target, 0, wanted);
                }
                consumed += total;
                faults.checkpoint(Checkpoint.AFTER_OWNED_READER_SOURCE_READ);
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                if (!sameIdentity(identity, attributes(path))
                        || channel.size() != document.sizeBytes) throw unsafe();
                if (consumed == document.sizeBytes) {
                    if (!hex(digest.digest()).equals(document.contentHash)) throw corrupt();
                    validateMagic(document.mimeType, prefix.toByteArray());
                }
                return total;
            } catch (Failure failure) {
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                throw failure;
            } catch (IOException | RuntimeException failure) {
                if (Thread.currentThread().isInterrupted()) throw interrupted();
                throw unavailable();
            }
        }

        @Override public synchronized void close() {
            if (closed) return;
            closed = true;
            try { channel.close(); } catch (IOException ignored) { }
        }
    }

    static final class Failure extends Exception {
        private final String code;
        Failure(String code, String message) { super(message); this.code = code; }
        String code() { return code; }
    }

    @FunctionalInterface interface StorageProbe { long availableBytes(long required) throws IOException; }
    @FunctionalInterface interface Clock { long nowMillis(); }
    @FunctionalInterface interface TokenSource { String next(); }
    @FunctionalInterface interface FaultInjector { void checkpoint(Checkpoint checkpoint) throws IOException; }
    enum Checkpoint { AFTER_TRANSIENT_MARKER, AFTER_APPEND_DATA_FORCE, AFTER_APPEND_JOURNAL_PUBLISH,
        AFTER_FINISH_INTENT, AFTER_FINISH_DATA_MOVE, AFTER_RETAIN_DATA_MOVE,
        AFTER_OWNED_TARGET_DIGEST, AFTER_OWNED_RECORD_PUBLISH, AFTER_OWNED_SOURCE_OPEN,
        AFTER_OWNED_READER_SOURCE_READ, AFTER_RENAME_RECORD_FORCE,
        AFTER_RENAME_RECORD_PUBLISH,
        AFTER_UNDO_INTENT, AFTER_UNDO_RECORD_MOVE, AFTER_UNDO_DATA_MOVE,
        AFTER_UNDO_TRASHED, AFTER_UNDO_RESTORE_INTENT,
        AFTER_UNDO_RESTORE_DATA_MOVE, AFTER_UNDO_RESTORE_RECORD_MOVE,
        AFTER_UNDO_RESTORED, AFTER_UNDO_PURGE_INTENT,
        AFTER_UNDO_PURGE_DATA_DELETE, AFTER_UNDO_PURGE_RECORD_DELETE,
        AFTER_PAYLOAD_CLEAR_MARKER, AFTER_PAYLOAD_CLEAR_RECORD_PUBLISH,
        BEFORE_PAYLOAD_CLEAR_DATA_DELETE, BEFORE_PAYLOAD_CLEAR_MARKER_DELETE,
        BEFORE_OWNED_DATA_DELETE, BEFORE_OWNED_RECORD_DELETE, BEFORE_DELETE_MARKER_DELETE }
    private enum State { OPEN, INTERRUPTED;
        static State from(int value) throws IOException {
            if (value < 0 || value >= values().length) throw new IOException("state");
            return values()[value];
        }
    }
    private record SessionRecord(String sessionId, String displayName, String mimeType, long committedBytes,
            long createdAt, long lastActivity, State state) { }
    private record FinishRecord(String operationId, String ref, String displayName, String mimeType, long size,
            String hash, long createdAt, boolean committed) {
        FinishRecord asCommitted() { return new FinishRecord(operationId, ref, displayName, mimeType, size,
                hash, createdAt, true); }
    }
    static final class UndoEntry {
        final String undoRef;
        final String ref;
        final long expiresAt;
        UndoEntry(String undoRef, String ref, long expiresAt) {
            this.undoRef = undoRef;
            this.ref = ref;
            this.expiresAt = expiresAt;
        }
    }
    private enum UndoState { PREPARED, TRASHED, RESTORING, RESTORED, PURGING;
        static UndoState from(int value) throws IOException {
            if (value < 0 || value >= values().length) throw new IOException("state");
            return values()[value];
        }
    }
    private record UndoRecord(String undoRef, String ref, String displayName, String mimeType,
            long size, String hash, long documentCreatedAt, long createdAt, long expiresAt,
            long restoredAt, UndoState state) {
        OwnedDocument document() throws IOException {
            return new OwnedDocument(ref, displayName, mimeType, size, hash,
                    documentCreatedAt, true);
        }
        UndoRecord asState(UndoState next) {
            return new UndoRecord(undoRef, ref, displayName, mimeType, size, hash,
                    documentCreatedAt, createdAt, expiresAt,
                    next == UndoState.RESTORED ? restoredAt : -1, next);
        }
        UndoRecord asRestored(long at) {
            return new UndoRecord(undoRef, ref, displayName, mimeType, size, hash,
                    documentCreatedAt, createdAt, expiresAt, at, UndoState.RESTORED);
        }
    }
    private record CleanupCandidate(Path path, long createdAt) { }
    private record FileDigest(long size, String hash, byte[] prefix) { }
    private record ValidatedOwned(OwnedDocument document, BasicFileAttributes identity) { }
    @FunctionalInterface private interface Encoder { void write(DataOutputStream output) throws IOException; }
    @FunctionalInterface private interface Decoder<T> { T read(DataInputStream input) throws IOException; }

    private static final class Layout {
        final Path root, sessions, owned, records, operations;
        Layout(Path root, Path sessions, Path owned, Path records, Path operations) {
            this.root = root; this.sessions = sessions; this.owned = owned;
            this.records = records; this.operations = operations;
        }
        static Layout prepare(Path filesDir) throws IOException {
            Path files = existingDirectory(filesDir);
            Path root = ensureDirectory(files, ROOT_NAME);
            return new Layout(root, ensureDirectory(root, "sessions"),
                    ensureDirectory(root, "owned"), ensureDirectory(root, "records"),
                    ensureDirectory(root, "operations"));
        }
        Path sessionPart(String id) throws IOException { return direct(sessions, id + ".part"); }
        Path sessionRecord(String id) throws IOException { return direct(sessions, id + ".session"); }
        Path transientMarker(String id) throws IOException { return direct(operations, id + ".transient"); }
        Path finishRecord(String id) throws IOException { return direct(operations, id + ".finish"); }
        Path retainRecord(String ref) throws IOException { return direct(operations, "retain_" + ref + ".finish"); }
        Path deleteMarker(String ref) throws IOException {
            return direct(operations, "delete_" + PendingImportRecord.refPayload(ref) + ".delete");
        }
        Path payloadClearMarker(String ref) throws IOException {
            return direct(operations,
                    "clear_" + PendingImportRecord.refPayload(ref) + ".payload-clear");
        }
        Path undoRecord(String undoRef) throws IOException {
            return direct(operations, "undo_" + undoPayload(undoRef) + ".undo");
        }
        Path ownedData(String ref) throws IOException { return direct(owned, PendingImportRecord.refPayload(ref) + ".bin"); }
        Path ownedRecord(String ref) throws IOException { return direct(records, PendingImportRecord.refPayload(ref) + ".owned"); }
        Path renamePart(String ref) throws IOException {
            return direct(records, PendingImportRecord.refPayload(ref) + ".rename.part");
        }
        private static Path existingDirectory(Path path) throws IOException {
            if (Files.isSymbolicLink(path) || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("unsafe");
            }
            return path.toRealPath(LinkOption.NOFOLLOW_LINKS);
        }
        private static Path ensureDirectory(Path parent, String name) throws IOException {
            Path child = direct(parent, name);
            if (!Files.exists(child, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(child); fsyncDirectory(parent);
            }
            return existingDirectory(child);
        }
    }

    private static final class TrashLayout {
        final Path root, data, records;
        TrashLayout(Path root, Path data, Path records) {
            this.root = root;
            this.data = data;
            this.records = records;
        }
        static TrashLayout prepare(Layout layout) throws IOException {
            Path root = Layout.ensureDirectory(layout.root, "trash");
            return new TrashLayout(root, Layout.ensureDirectory(root, "data"),
                    Layout.ensureDirectory(root, "records"));
        }
        Path data(String undoRef) throws IOException {
            return direct(data, undoPayload(undoRef) + ".bin");
        }
        Path record(String undoRef) throws IOException {
            return direct(records, undoPayload(undoRef) + ".owned");
        }
    }

    private static Failure invalid() { return new Failure("DOCUMENT_INVALID_ARGUMENT", "The document request is invalid."); }
    private static Failure notFound() { return new Failure("DOCUMENT_NOT_FOUND", "The document is unavailable."); }
    private static Failure unavailable() { return new Failure("DOCUMENT_UNAVAILABLE", "The document is unavailable."); }
    private static Failure storageFull() { return new Failure("DOCUMENT_STORAGE_FULL", "There is not enough storage."); }
    private static Failure limit() { return new Failure("DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded."); }
    private static Failure interrupted() { return new Failure("DOCUMENT_INTERRUPTED", "The document operation was interrupted."); }
    private static Failure cancelled() { return new Failure("DOCUMENT_CANCELLED", "The document operation was cancelled."); }
    private static Failure corrupt() { return new Failure("DOCUMENT_CORRUPT", "The document could not be validated."); }
    private static Failure unsafe() { return new Failure("DOCUMENT_UNSAFE_STATE", "The document state is unavailable."); }
    private static Failure failed() { return new Failure("DOCUMENT_FAILED", "The document operation failed."); }
}
