package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderDocumentSession;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderLaunchContract;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Objects;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Sole inactive lock and composition root for T036-T039 document services.
 * Construction is I/O-free. Application installation and plugin/provider registration are T040.
 */
public final class DocumentLifecycleCoordinator {
    private final Context application;
    private Graph graph;
    private final LinkedHashMap<String, OwnedReadCursor> ownedReadCursors =
            new LinkedHashMap<>(4, 0.75f, true);

    public DocumentLifecycleCoordinator(Context context) {
        Context supplied = Objects.requireNonNull(context);
        Context retained = supplied instanceof Application
                ? supplied : supplied.getApplicationContext();
        this.application = Objects.requireNonNull(retained);
    }

    DocumentLifecycleCoordinator(Path filesDir, OwnedPendingImportStore pendingStore,
            AndroidDocumentPickerController picker, OwnedDocumentWriter writer,
            AndroidDocumentExporter exporter,
            AndroidDocumentSharer sharer, LegacyDocumentOpenResolver legacyResolver) {
        this.application = null;
        this.graph = new Graph(filesDir, pendingStore, picker, writer, exporter, sharer,
                legacyResolver);
    }

    public synchronized WriteSession beginWrite(String mimeType) throws Failure {
        return beginWrite(null, mimeType);
    }

    public synchronized WriteSession beginWrite(String displayName, String mimeType) throws Failure {
        try {
            OwnedDocumentWriter.BeginResult result = graph().writer.begin(displayName, mimeType);
            return new WriteSession(result.sessionId, result.maximumChunkBytes);
        } catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized int appendWrite(String sessionId, byte[] bytes,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        try { return graph().writer.append(sessionId, bytes, cancellation); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized DocumentRecord finishWrite(String sessionId,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        return finishWrite(sessionId, false, cancellation);
    }

    public synchronized DocumentRecord finishWrite(String sessionId, boolean transientOutput,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        try { return record(graph().writer.finish(sessionId, transientOutput, cancellation)); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized boolean abortWrite(String sessionId) throws Failure {
        try { return graph().writer.abort(sessionId); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized List<DocumentRecord> listOwnedDocuments() throws Failure {
        try {
            ArrayList<DocumentRecord> records = new ArrayList<>();
            for (OwnedDocumentWriter.OwnedDocument value : graph().writer.listOwned()) {
                records.add(record(value));
            }
            return List.copyOf(records);
        } catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized DocumentRecord renameOwnedDocument(String ref, String displayName)
            throws Failure {
        if (!isOwned(ref) || displayName == null
                || !OwnedDocumentWritePolicy.isValidDisplayName(displayName)) throw invalid();
        try { return record(graph().writer.renameOwned(ref, displayName)); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized UndoReceipt trashOwnedDocument(String ref) throws Failure {
        if (!isOwned(ref)) throw invalid();
        closeOwnedCursor(ref);
        try {
            OwnedDocumentWriter.UndoEntry entry = graph().writer.trashOwned(ref);
            return new UndoReceipt(entry.undoRef, entry.expiresAt);
        } catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized void restoreOwnedDocument(String undoRef) throws Failure {
        try {
            String ref = graph().writer.undoTargetRef(undoRef);
            closeOwnedCursor(ref);
            graph().writer.restoreOwned(undoRef);
        } catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized boolean deleteOwnedDocument(String ref) throws Failure {
        closeOwnedCursor(ref);
        try { return graph().writer.deleteOwned(ref); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized int clearOwnedDocuments() throws Failure {
        closeAllOwnedCursors();
        try { return graph().writer.clearOwned(); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public synchronized int clearOwnedDocumentPayloads() throws Failure {
        closeAllOwnedCursors();
        try { return graph().writer.clearOwnedPayloads(); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    public PdfReaderDocumentSession prepareReader(String ref, String displayName)
            throws Failure {
        if (!PdfReaderLaunchContract.isCanonicalRef(ref)
                || !PdfReaderLaunchContract.isSafeDisplayName(displayName)) throw invalid();
        OwnedDocumentWriter.DocumentSource source = null;
        try {
            Path filesDir;
            synchronized (this) {
                Graph graph = graph();
                if (isOwned(ref)) {
                    source = graph.writer.readerSource(ref);
                } else if (isLegacy(ref)) {
                    source = graph.legacyResolver.openSource(ref,
                            AndroidDocumentIngressPolicy.MIME_PDF);
                } else {
                    throw invalid();
                }
                filesDir = graph.filesDir;
            }
            OwnedDocumentWriter.DocumentSource retained = source;
            return PdfReaderDocumentSession.prepareForCoordinator(filesDir, ref,
                    displayName, new PdfReaderDocumentSession.Source() {
                        @Override public String mimeType() { return retained.mimeType(); }
                        @Override public long sizeBytes() { return retained.sizeBytes(); }
                        @Override public int read(long offset, byte[] target) throws Exception {
                            try { return retained.read(offset, target); }
                            catch (OwnedDocumentWriter.Failure failure) {
                                throw new PdfReaderDocumentSession.Failure(failure.code(),
                                        fixedMessage(failure.code()));
                            }
                        }
                    });
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            String code = failure.code().startsWith("LEGACY_")
                    ? failure.code().substring("LEGACY_".length()) : failure.code();
            throw new Failure(code, fixedMessage(code));
        } catch (OwnedDocumentWriter.Failure failure) {
            throw wrap(failure);
        } catch (PdfReaderDocumentSession.Failure failure) {
            throw new Failure(failure.code(), fixedMessage(failure.code()));
        } finally {
            if (source != null) source.close();
        }
    }

    public synchronized DocumentRecord retainPending(String ref,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (ref != null && ref.startsWith("a1_")) throw invalid();
        try { return record(graph().writer.retainPending(ref, graph().pendingStore, cancellation)); }
        catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
    }

    synchronized List<DocumentRecord> pendingImportsForBatch(String batchRef) throws Failure {
        if (!PendingImportBatch.isValidBatchRef(batchRef)) throw invalid();
        try {
            return recordsForBatch(graph().pendingStore.loadCompleteBatch(batchRef));
        } catch (OwnedPendingImportStore.Failure missing) {
            if (!"DOCUMENT_NOT_FOUND".equals(missing.code())) {
                throw new Failure(missing.code(), fixedMessage(missing.code()));
            }
            try { return recordsForBatch(graph().pendingStore.loadAcknowledgedBatch(batchRef)); }
            catch (OwnedPendingImportStore.Failure failure) {
                throw new Failure(failure.code(), fixedMessage(failure.code()));
            }
        }
    }

    synchronized PendingImportBatchRecords takePendingImports(int maximumItems) throws Failure {
        if (maximumItems < 1 || maximumItems > AndroidDocumentIngressPolicy.MAX_ITEMS) {
            throw invalid();
        }
        try {
            PendingImportBatch batch = graph().pendingStore.takeCompleteBatch(maximumItems);
            return batch == null ? PendingImportBatchRecords.empty() : new PendingImportBatchRecords(
                    batch.batchRef(), recordsForBatch(batch));
        } catch (OwnedPendingImportStore.Failure failure) {
            throw new Failure(failure.code(), fixedMessage(failure.code()));
        }
    }

    synchronized int acknowledgePendingImports(String batchRef, List<String> refs,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        List<String> checked = checkedPendingRefs(refs);
        if (!PendingImportBatch.isValidBatchRef(batchRef) || cancellation == null) throw invalid();

        PendingImportBatch batch;
        try {
            batch = graph().pendingStore.loadCompleteBatch(batchRef);
        } catch (OwnedPendingImportStore.Failure missing) {
            if (!"DOCUMENT_NOT_FOUND".equals(missing.code())) {
                throw new Failure(missing.code(), fixedMessage(missing.code()));
            }
            try {
                PendingImportBatch receipt = graph().pendingStore.loadAcknowledgedBatch(batchRef);
                if (!receipt.refs().equals(checked)) throw invalid();
                return receipt.refs().size();
            } catch (OwnedPendingImportStore.Failure failure) {
                throw new Failure(failure.code(), fixedMessage(failure.code()));
            }
        }
        if (!batch.refs().equals(checked)) throw invalid();

        // Validate the complete request before the first mutation. A retry may contain refs
        // already promoted by an interrupted prior acknowledgement; those remain idempotent.
        Map<String, DocumentRecord> owned = new java.util.HashMap<>();
        for (DocumentRecord record : listOwnedDocuments()) owned.put(record.ref(), record);
        for (String ref : checked) {
            try {
                graph().pendingStore.load(ref);
            } catch (OwnedPendingImportStore.Failure failure) {
                if (!"DOCUMENT_NOT_FOUND".equals(failure.code()) || !owned.containsKey(ref)) {
                    throw new Failure(failure.code(), fixedMessage(failure.code()));
                }
            }
        }

        int acknowledged = 0;
        for (String ref : batch.refs()) {
            try {
                graph().writer.retainPending(ref, graph().pendingStore, cancellation);
                acknowledged++;
            } catch (OwnedDocumentWriter.Failure failure) {
                throw wrap(failure);
            }
        }
        Map<String, DocumentRecord> confirmedOwned = new java.util.HashMap<>();
        for (DocumentRecord record : listOwnedDocuments()) confirmedOwned.put(record.ref(), record);
        for (String ref : batch.refs()) {
            if (!confirmedOwned.containsKey(ref)) throw unsafe();
            try {
                if (graph().pendingStore.hasPendingMarker(ref)) throw unsafe();
            } catch (OwnedPendingImportStore.Failure failure) {
                throw new Failure(failure.code(), fixedMessage(failure.code()));
            }
        }
        try { graph().pendingStore.finalizeAcknowledgedBatch(batch); }
        catch (OwnedPendingImportStore.Failure failure) {
            throw new Failure(failure.code(), fixedMessage(failure.code()));
        }
        return acknowledged;
    }

    private List<DocumentRecord> recordsForBatch(PendingImportBatch batch) throws Failure {
        Map<String, DocumentRecord> owned = new java.util.HashMap<>();
        for (DocumentRecord record : listOwnedDocuments()) owned.put(record.ref(), record);
        ArrayList<DocumentRecord> records = new ArrayList<>(batch.refs().size());
        for (String ref : batch.refs()) {
            try {
                records.add(record(graph().pendingStore.load(ref)));
            } catch (OwnedPendingImportStore.Failure failure) {
                if (!"DOCUMENT_NOT_FOUND".equals(failure.code()) || !owned.containsKey(ref)) {
                    throw new Failure(failure.code(), fixedMessage(failure.code()));
                }
                records.add(owned.get(ref));
            }
        }
        return List.copyOf(records);
    }

    private static List<String> checkedPendingRefs(List<String> refs) throws Failure {
        if (refs == null || refs.isEmpty()
                || refs.size() > AndroidDocumentIngressPolicy.MAX_ITEMS) throw invalid();
        ArrayList<String> checked = new ArrayList<>(refs.size());
        Set<String> unique = new HashSet<>();
        for (String ref : refs) {
            if (!PendingImportRecord.isValidRef(ref) || !unique.add(ref)) throw invalid();
            checked.add(ref);
        }
        return List.copyOf(checked);
    }

    public synchronized boolean exportDocument(String ref, String displayName, String mimeType,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        Snapshot snapshot = null;
        OwnedDocumentWriter.DocumentSource source = null;
        LegacyDocumentOpenResolver.CollectionSource collection = null;
        try {
            if (isOwned(ref)) {
                if (mimeType == null) throw invalid();
                source = graph().writer.source(ref);
            } else if (isLegacy(ref)) {
                if (mimeType == null) {
                    collection = graph().legacyResolver.openCollection(ref);
                    return graph().exporter.exportCollection(
                            collection, displayName, cancellation).completedValue();
                } else {
                    snapshot = snapshotLegacy(ref, mimeType, cancellation);
                    source = snapshot;
                }
            } else {
                throw invalid();
            }
            return graph().exporter.export(source, displayName, mimeType, cancellation)
                    .completedValue();
        } catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
        catch (LegacyDocumentOpenResolver.Failure failure) {
            throw wrapLegacy(failure);
        }
        catch (AndroidDocumentExporter.Failure failure) { throw wrap(failure); }
        finally {
            if (source != null) source.close();
            else if (snapshot != null) snapshot.close();
            if (collection != null) collection.close();
        }
    }

    public synchronized ShareHandle prepareShare(String ref, String mimeType,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        Snapshot snapshot = null;
        OwnedDocumentWriter.DocumentSource source = null;
        LegacyDocumentOpenResolver.CollectionSource collection = null;
        try {
            if (isOwned(ref)) {
                if (mimeType == null) throw invalid();
                source = graph().writer.source(ref);
            } else if (isLegacy(ref)) {
                if (mimeType == null) {
                    collection = graph().legacyResolver.openCollection(ref);
                    return new ShareHandle(graph().sharer.prepareCollection(
                            collection, cancellation));
                } else {
                    snapshot = snapshotLegacy(ref, mimeType, cancellation);
                    source = snapshot;
                }
            } else {
                throw invalid();
            }
            if (!mimeType.equals(source.mimeType())) throw invalid();
            return new ShareHandle(graph().sharer.prepare(source, cancellation));
        } catch (OwnedDocumentWriter.Failure failure) { throw wrap(failure); }
        catch (LegacyDocumentOpenResolver.Failure failure) {
            throw wrapLegacy(failure);
        }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
        finally {
            if (source != null) source.close();
            else if (snapshot != null) snapshot.close();
            if (collection != null) collection.close();
        }
    }

    public synchronized Intent createShareIntent(ShareHandle handle, Uri contentUri)
            throws Failure {
        if (handle == null) throw invalid();
        try { return graph().sharer.createReadOnlyIntent(handle.stage, contentUri); }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
    }

    public synchronized Intent createShareIntent(ShareHandle handle, List<Uri> contentUris)
            throws Failure {
        if (handle == null) throw invalid();
        try { return graph().sharer.createReadOnlyIntent(handle.stage, contentUris); }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
    }

    public synchronized Uri createShareContentUri(ShareHandle handle) throws Failure {
        if (application == null || handle == null) throw invalid();
        try {
            return FileProvider.getUriForFile(application,
                    application.getPackageName() + ".fileprovider",
                    stagedSharePath(handle).toFile());
        } catch (IllegalArgumentException | SecurityException failure) {
            throw unsafe();
        }
    }

    public synchronized List<Uri> createShareContentUris(ShareHandle handle) throws Failure {
        if (application == null || handle == null) throw invalid();
        try {
            List<Path> paths = graph().sharer.stagedPathsForProvider(handle.stage);
            List<String> names = graph().sharer.stagedDisplayNames(handle.stage);
            if (paths.size() != names.size()) throw unsafe();
            ArrayList<Uri> uris = new ArrayList<>(paths.size());
            for (int index = 0; index < paths.size(); index++) {
                Uri uri = FileProvider.getUriForFile(application,
                        application.getPackageName() + ".fileprovider", paths.get(index).toFile());
                if (names.get(index) != null) {
                    uri = uri.buildUpon().appendQueryParameter("displayName", names.get(index))
                            .build();
                }
                uris.add(uri);
            }
            return List.copyOf(uris);
        } catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
        catch (IllegalArgumentException | SecurityException failure) { throw unsafe(); }
    }

    public synchronized void markShareDispatched(ShareHandle handle) throws Failure {
        if (handle == null) throw invalid();
        try { graph().sharer.markDispatched(handle.stage); }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
    }

    public synchronized void cancelShareBeforeDispatch(ShareHandle handle) throws Failure {
        if (handle == null) throw invalid();
        try { graph().sharer.cancelBeforeDispatch(handle.stage); }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
    }

    synchronized Path stagedSharePath(ShareHandle handle) throws Failure {
        if (handle == null) throw invalid();
        try { return graph().sharer.stagedPathForProvider(handle.stage); }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
    }

    synchronized List<Path> stagedSharePaths(ShareHandle handle) throws Failure {
        if (handle == null) throw invalid();
        try { return graph().sharer.stagedPathsForProvider(handle.stage); }
        catch (AndroidDocumentSharer.Failure failure) { throw wrap(failure); }
    }

    public synchronized Intent createPickerIntent(PickerRequestPolicy.Request request)
            throws Failure {
        try { return requirePicker().createIntent(request); }
        catch (AndroidDocumentPickerController.Failure failure) {
            throw new Failure(failure.code(), failure.getMessage());
        }
    }

    public synchronized AndroidDocumentPickerController.Result handlePickerResult(
            PickerRequestPolicy.Request request, int resultCode, Intent resultIntent,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        try { return requirePicker().handleResult(request, resultCode, resultIntent, cancellation); }
        catch (AndroidDocumentPickerController.Failure failure) {
            throw new Failure(failure.code(), failure.getMessage());
        }
    }

    public synchronized ReadChunk readChunk(String ref, long offset, int length) throws Failure {
        if (offset < 0 || offset > BoundedDocumentReader.MAXIMUM_SAFE_OFFSET
                || length < 1 || length > BoundedDocumentReader.MAXIMUM_CHUNK_BYTES) {
            throw invalid();
        }
        if (isLegacy(ref)) {
            try {
                BoundedDocumentReader.Chunk chunk = graph().legacyResolver.readChunk(
                        ref, offset, length);
                return new ReadChunk(chunk.bytes(), chunk.nextOffset(), chunk.done());
            } catch (LegacyDocumentOpenResolver.Failure failure) {
                String code = failure.code().startsWith("LEGACY_")
                        ? failure.code().substring("LEGACY_".length()) : failure.code();
                throw new Failure(code, fixedMessage(code));
            }
        }
        if (!isOwned(ref)) throw invalid();
        try {
            OwnedReadCursor cursor = ownedReadCursors.get(ref);
            if (cursor == null || cursor.nextOffset != offset) {
                closeOwnedCursor(ref);
                cursor = new OwnedReadCursor(graph().writer.source(ref), offset);
            }
            OwnedDocumentWriter.DocumentSource source = cursor.source;
            long size = source.sizeBytes();
            if (offset > size) throw invalid();
            int requested = (int) Math.min((long) length, size - offset);
            byte[] bytes = new byte[requested];
            int total = 0;
            while (total < requested) {
                byte[] window = new byte[requested - total];
                int read = source.read(offset + total, window);
                if (read <= 0 || read > window.length) throw corrupt();
                System.arraycopy(window, 0, bytes, total, read);
                total += read;
            }
            long nextOffset = offset + total;
            boolean done = nextOffset == size;
            if (done) closeOwnedCursor(ref);
            else {
                cursor.nextOffset = nextOffset;
                ownedReadCursors.put(ref, cursor);
                while (ownedReadCursors.size() > 4) {
                    String eldest = ownedReadCursors.keySet().iterator().next();
                    closeOwnedCursor(eldest);
                }
            }
            return new ReadChunk(bytes, nextOffset, done);
        } catch (OwnedDocumentWriter.Failure failure) {
            closeOwnedCursor(ref);
            throw wrap(failure);
        } catch (Failure failure) {
            closeOwnedCursor(ref);
            throw failure;
        }
    }

    private void closeOwnedCursor(String ref) {
        OwnedReadCursor cursor = ownedReadCursors.remove(ref);
        if (cursor != null) cursor.source.close();
    }

    private void closeAllOwnedCursors() {
        for (OwnedReadCursor cursor : ownedReadCursors.values()) cursor.source.close();
        ownedReadCursors.clear();
    }

    private AndroidDocumentPickerController requirePicker() throws Failure {
        AndroidDocumentPickerController picker = graph().picker;
        return picker;
    }

    private Graph graph() {
        if (graph == null) graph = Graph.production(application);
        return graph;
    }

    private Snapshot snapshotLegacy(String ref, String mimeType,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (!AndroidDocumentIngressPolicy.isSupportedMimeType(mimeType) || cancellation == null) {
            throw invalid();
        }
        Path root = null;
        Path part = null;
        Path complete = null;
        try {
            root = prepareSnapshotRoot();
            part = direct(root, "current.part");
            complete = direct(root, "current.snapshot");
            deleteExact(part);
            deleteExact(complete);
            long total = 0;
            try (FileChannel output = FileChannel.open(part,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                while (true) {
                    checkCancelled(cancellation);
                    BoundedDocumentReader.Chunk chunk = graph().legacyResolver.readChunk(
                            ref, total, BoundedDocumentReader.MAXIMUM_CHUNK_BYTES);
                    byte[] bytes = chunk.bytes();
                    if (!chunk.done() && bytes.length == 0) throw unsafe();
                    if (total > OwnedDocumentWriter.MAXIMUM_FILE_BYTES - bytes.length) throw limit();
                    ByteBuffer buffer = ByteBuffer.wrap(bytes);
                    while (buffer.hasRemaining()) output.write(buffer);
                    long next = total + bytes.length;
                    if (chunk.nextOffset() != next) throw unsafe();
                    total = next;
                    if (chunk.done()) break;
                }
                if (total <= 0) throw invalid();
                output.force(true);
            }
            validateSnapshotMagic(mimeType, part);
            Files.move(part, complete, StandardCopyOption.ATOMIC_MOVE);
            fsyncDirectory(root);
            verifyLegacySnapshot(ref, complete, total, cancellation);
            return new Snapshot(complete, mimeType, total);
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            deleteExact(part); deleteExact(complete);
            if ("LEGACY_DOCUMENT_COLLECTION_UNSUPPORTED".equals(failure.code())) {
                throw collection();
            }
            throw new Failure(failure.code(), failure.getMessage());
        } catch (Failure failure) {
            deleteExact(part); deleteExact(complete); throw failure;
        } catch (IOException | RuntimeException failure) {
            deleteExact(part); deleteExact(complete); throw unsafe();
        }
    }

    private Path prepareSnapshotRoot() throws IOException {
        Path files = existingDirectory(graph().filesDir);
        Path documents = ensureDirectory(files, "pdfchef_documents");
        return ensureDirectory(documents, "legacy_snapshots");
    }

    private void verifyLegacySnapshot(String ref, Path snapshot, long expected,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure, IOException {
        long offset = 0;
        try (FileChannel local = FileChannel.open(snapshot, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            while (true) {
                checkCancelled(cancellation);
                BoundedDocumentReader.Chunk chunk = graph().legacyResolver.readChunk(ref, offset,
                        BoundedDocumentReader.MAXIMUM_CHUNK_BYTES);
                byte[] remote = chunk.bytes();
                ByteBuffer localBytes = ByteBuffer.allocate(remote.length);
                while (localBytes.hasRemaining()) {
                    if (local.read(localBytes) < 0) throw unsafe();
                }
                if (!java.util.Arrays.equals(remote, localBytes.array())) throw unsafe();
                offset += remote.length;
                if (chunk.nextOffset() != offset || offset > expected) throw unsafe();
                if (chunk.done()) break;
            }
            if (offset != expected || local.read(ByteBuffer.allocate(1)) != -1) throw unsafe();
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            if ("LEGACY_DOCUMENT_COLLECTION_UNSUPPORTED".equals(failure.code())) throw collection();
            throw new Failure(failure.code(), failure.getMessage());
        }
    }

    private static void validateSnapshotMagic(String mimeType, Path path) throws Failure, IOException {
        byte[] prefix = new byte[(int) Math.min(16L, Files.size(path))];
        try (FileChannel input = FileChannel.open(path, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer buffer = ByteBuffer.wrap(prefix);
            while (buffer.hasRemaining()) {
                if (input.read(buffer) < 0) throw unsafe();
            }
        }
        try { new AndroidDocumentIngressPolicy().validateMagic(mimeType, prefix); }
        catch (AndroidDocumentIngressPolicy.Failure failure) { throw invalid(); }
    }

    private static boolean isOwned(String ref) {
        return PendingImportRecord.isValidRef(ref);
    }

    private static boolean isLegacy(String ref) {
        return ref != null && ref.matches("a1_[1-9][0-9]{0,15}");
    }

    private static final class OwnedReadCursor {
        final OwnedDocumentWriter.DocumentSource source;
        long nextOffset;
        OwnedReadCursor(OwnedDocumentWriter.DocumentSource source, long nextOffset) {
            this.source = source;
            this.nextOffset = nextOffset;
        }
    }

    private static DocumentRecord record(OwnedDocumentWriter.OwnedDocument value) {
        return new DocumentRecord(value.ref, value.displayName, value.mimeType, value.sizeBytes,
                value.contentHash, value.createdAtMillis, value.available);
    }

    private static DocumentRecord record(PendingImportRecord value) {
        return new DocumentRecord(value.ref(), null, value.mimeType(), value.sizeBytes(),
                value.contentHash(), value.createdAtMillis(), true);
    }

    private static Failure wrap(OwnedDocumentWriter.Failure value) {
        return new Failure(value.code(), value.getMessage());
    }
    private static Failure wrap(AndroidDocumentExporter.Failure value) {
        return new Failure(value.code(), value.getMessage());
    }
    private static Failure wrap(AndroidDocumentSharer.Failure value) {
        return new Failure(value.code(), value.getMessage());
    }
    private static Failure wrapLegacy(LegacyDocumentOpenResolver.Failure value) {
        String code = value.code().startsWith("LEGACY_")
                ? value.code().substring("LEGACY_".length()) : value.code();
        return new Failure(code, fixedMessage(code));
    }

    private static void checkCancelled(OwnedPendingImportStore.CancellationSignal signal)
            throws Failure {
        if (Thread.currentThread().isInterrupted() || signal.isCancelled()) {
            throw new Failure("DOCUMENT_CANCELLED", "The document operation was cancelled.");
        }
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

    private static Path direct(Path parent, String name) throws IOException {
        Path normalized = parent.toAbsolutePath().normalize();
        Path child = normalized.resolve(name).normalize();
        if (!normalized.equals(child.getParent())) throw new IOException("unsafe");
        return child;
    }

    private static void fsyncDirectory(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        }
    }

    private static void deleteExact(Path path) {
        try {
            if (path != null && !Files.isSymbolicLink(path)
                    && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) Files.deleteIfExists(path);
        } catch (IOException | SecurityException ignored) { }
    }

    /** One lazily-created production graph. Its picker shares the graph's only pending store. */
    private static final class Graph {
        final Path filesDir;
        final OwnedPendingImportStore pendingStore;
        final AndroidDocumentPickerController picker;
        final OwnedDocumentWriter writer;
        final AndroidDocumentExporter exporter;
        final AndroidDocumentSharer sharer;
        final LegacyDocumentOpenResolver legacyResolver;

        Graph(Path filesDir, OwnedPendingImportStore pendingStore,
                AndroidDocumentPickerController picker, OwnedDocumentWriter writer,
                AndroidDocumentExporter exporter, AndroidDocumentSharer sharer,
                LegacyDocumentOpenResolver legacyResolver) {
            this.filesDir = Objects.requireNonNull(filesDir).toAbsolutePath().normalize();
            this.pendingStore = Objects.requireNonNull(pendingStore);
            this.picker = Objects.requireNonNull(picker);
            this.writer = Objects.requireNonNull(writer);
            this.exporter = Objects.requireNonNull(exporter);
            this.sharer = Objects.requireNonNull(sharer);
            this.legacyResolver = Objects.requireNonNull(legacyResolver);
        }

        static Graph production(Context application) {
            Path filesDir = application.getFilesDir().toPath().toAbsolutePath().normalize();
            OwnedPendingImportStore pendingStore = new OwnedPendingImportStore(filesDir);
            return new Graph(filesDir, pendingStore,
                    new AndroidDocumentPickerController(application, pendingStore),
                    new OwnedDocumentWriter(filesDir), new AndroidDocumentExporter(application),
                    new AndroidDocumentSharer(application),
                    new LegacyDocumentOpenResolver(application));
        }
    }

    public static final class WriteSession {
        private final String sessionId;
        private final int maximumChunkBytes;
        WriteSession(String sessionId, int maximumChunkBytes) {
            this.sessionId = sessionId; this.maximumChunkBytes = maximumChunkBytes;
        }
        public String sessionId() { return sessionId; }
        public int maximumChunkBytes() { return maximumChunkBytes; }
    }

    static final class PendingImportBatchRecords {
        private final String batchRef;
        private final List<DocumentRecord> records;
        PendingImportBatchRecords(String batchRef, List<DocumentRecord> records) {
            this.batchRef = batchRef;
            this.records = List.copyOf(records);
        }
        static PendingImportBatchRecords empty() {
            return new PendingImportBatchRecords(null, List.of());
        }
        String batchRef() { return batchRef; }
        List<DocumentRecord> records() { return records; }
    }

    public static final class DocumentRecord {
        private final String ref, displayName, mimeType, contentHash;
        private final long sizeBytes, createdAtMillis;
        private final boolean available;
        DocumentRecord(String ref, String displayName, String mimeType, long sizeBytes,
                String contentHash, long createdAtMillis, boolean available) {
            this.ref = ref; this.displayName = displayName; this.mimeType = mimeType; this.sizeBytes = sizeBytes;
            this.contentHash = contentHash; this.createdAtMillis = createdAtMillis;
            this.available = available;
        }
        public String ref() { return ref; }
        public String displayName() { return displayName; }
        public String mimeType() { return mimeType; }
        public long sizeBytes() { return sizeBytes; }
        public String contentHash() { return contentHash; }
        public long createdAtMillis() { return createdAtMillis; }
        public boolean available() { return available; }
    }

    public static final class UndoReceipt {
        private final String undoRef;
        private final long expiresAt;
        UndoReceipt(String undoRef, long expiresAt) {
            this.undoRef = undoRef;
            this.expiresAt = expiresAt;
        }
        public String undoRef() { return undoRef; }
        public long expiresAt() { return expiresAt; }
    }

    public static final class ShareHandle {
        private final AndroidDocumentSharer.Stage stage;
        ShareHandle(AndroidDocumentSharer.Stage stage) { this.stage = stage; }
    }

    public static final class ReadChunk {
        private final byte[] bytes;
        private final long nextOffset;
        private final boolean done;
        ReadChunk(byte[] bytes, long nextOffset, boolean done) {
            this.bytes = Objects.requireNonNull(bytes).clone();
            this.nextOffset = nextOffset;
            this.done = done;
        }
        public byte[] bytes() { return bytes.clone(); }
        public long nextOffset() { return nextOffset; }
        public boolean done() { return done; }
    }

    public static final class Failure extends Exception {
        private final String code;
        Failure(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }

    private static final class Snapshot implements OwnedDocumentWriter.DocumentSource, AutoCloseable {
        private final Path path; private final String mimeType; private final long size;
        private final BasicFileAttributes identity;
        Snapshot(Path path, String mimeType, long size) throws IOException {
            this.path = path; this.mimeType = mimeType; this.size = size;
            this.identity = Files.readAttributes(path, BasicFileAttributes.class,
                    LinkOption.NOFOLLOW_LINKS);
            if (!identity.isRegularFile() || Files.isSymbolicLink(path) || identity.size() != size) {
                throw new IOException("snapshot");
            }
        }
        @Override public String mimeType() { return mimeType; }
        @Override public long sizeBytes() { return size; }
        @Override public int read(long offset, byte[] target) throws OwnedDocumentWriter.Failure {
            if (offset < 0 || target == null || target.length == 0
                    || target.length > OwnedDocumentWriter.MAXIMUM_CHUNK_BYTES) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_INVALID_ARGUMENT",
                        "The document request is invalid.");
            }
            try {
                BasicFileAttributes before = Files.readAttributes(path, BasicFileAttributes.class,
                        LinkOption.NOFOLLOW_LINKS);
                requireSame(before);
                int read;
                try (FileChannel input = FileChannel.open(path, StandardOpenOption.READ,
                        LinkOption.NOFOLLOW_LINKS)) {
                    input.position(offset); read = input.read(ByteBuffer.wrap(target));
                }
                requireSame(Files.readAttributes(path, BasicFileAttributes.class,
                        LinkOption.NOFOLLOW_LINKS));
                return Math.max(read, 0);
            } catch (IOException failure) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_UNSAFE_STATE",
                        "The document state is unavailable.");
            }
        }
        private void requireSame(BasicFileAttributes value) throws IOException {
            if (!value.isRegularFile() || value.size() != identity.size()
                    || !Objects.equals(value.fileKey(), identity.fileKey())
                    || !value.lastModifiedTime().equals(identity.lastModifiedTime())) {
                throw new IOException("snapshot");
            }
        }
        @Override public void close() { deleteExact(path); }
    }

    private static Failure invalid() {
        return new Failure("DOCUMENT_INVALID_ARGUMENT", "The document request is invalid.");
    }
    private static Failure collection() {
        return new Failure("DOCUMENT_COLLECTION_UNSUPPORTED", "Collections are not supported.");
    }
    private static Failure limit() {
        return new Failure("DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded.");
    }
    private static Failure unsafe() {
        return new Failure("DOCUMENT_UNSAFE_STATE", "The document state is unavailable.");
    }
    private static Failure corrupt() {
        return new Failure("DOCUMENT_CORRUPT", "The document could not be validated.");
    }
    private static String fixedMessage(String code) {
        if ("DOCUMENT_NOT_FOUND".equals(code)) return "The document was not found.";
        if ("DOCUMENT_CORRUPT".equals(code)) return "The document could not be validated.";
        if ("DOCUMENT_UNAVAILABLE".equals(code)) return "The document is unavailable.";
        if ("DOCUMENT_UNSAFE_STATE".equals(code)) return "The document state is unavailable.";
        if ("DOCUMENT_COLLECTION_UNSUPPORTED".equals(code)) {
            return "Collections are not supported.";
        }
        if ("DOCUMENT_LIMIT_EXCEEDED".equals(code)) {
            return "The document limit was exceeded.";
        }
        if ("DOCUMENT_STORAGE_FULL".equals(code)) return "There is not enough storage.";
        if ("DOCUMENT_INTERRUPTED".equals(code)) {
            return "The document operation was interrupted.";
        }
        if ("DOCUMENT_CANCELLED".equals(code)) {
            return "The document operation was cancelled.";
        }
        return "The document request is invalid.";
    }
}
