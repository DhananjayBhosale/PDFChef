package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;

/** Inactive owned staging store. Construction performs no I/O and nothing registers this class. */
public final class OwnedPendingImportStore {
    private static final String ROOT_NAME = "pdfchef_pending_imports";
    private static final String DATA_NAME = "data";
    private static final String RECORDS_NAME = "records";
    private static final String BATCHES_NAME = "batches";
    private static final String ACKNOWLEDGED_NAME = "acknowledged";
    private static final long STORAGE_RESERVE_BYTES = 1024L * 1024L;
    private static final int COPY_BUFFER_BYTES = 64 * 1024;
    private static final int MAGIC_PREFIX_BYTES = 16;
    private static final int MAX_LIST_RECORDS = 300;
    private static final int MAX_BATCH_MANIFESTS = 300;
    private static final int MAX_ACKNOWLEDGED_BATCHES = 300;
    private static final long ACKNOWLEDGED_BATCH_MAX_AGE_MILLIS = 7L * 24L * 60L * 60L * 1000L;
    static final long INCOMPLETE_BATCH_MAX_AGE_MILLIS = 24L * 60L * 60L * 1000L;

    private final Path filesDir;
    private final StorageProbe storageProbe;
    private final Clock clock;
    private final FaultInjector faultInjector;
    private final AndroidDocumentIngressPolicy policy = new AndroidDocumentIngressPolicy();

    public OwnedPendingImportStore(Path filesDir) {
        this(filesDir,
                ignored -> filesDir.toFile().getUsableSpace(),
                System::currentTimeMillis,
                checkpoint -> {});
    }

    OwnedPendingImportStore(
            Path filesDir,
            StorageProbe storageProbe,
            Clock clock,
            FaultInjector faultInjector) {
        this.filesDir = Objects.requireNonNull(filesDir).toAbsolutePath().normalize();
        this.storageProbe = Objects.requireNonNull(storageProbe);
        this.clock = Objects.requireNonNull(clock);
        this.faultInjector = Objects.requireNonNull(faultInjector);
    }

    public synchronized PendingImportRecord stage(
            String ref,
            AndroidDocumentIngressPolicy.ValidatedItem item,
            InputStream source,
            CancellationSignal cancellation) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)
                || item == null
                || source == null
                || cancellation == null
                || !AndroidDocumentIngressPolicy.isSupportedMimeType(item.mimeType())
                || item.sizeBytes() <= 0
                || item.sizeBytes() > AndroidDocumentIngressPolicy.MAX_ITEM_BYTES) {
            throw invalid();
        }

        Layout layout = null;
        Path dataTemp = null;
        Path recordTemp = null;
        boolean recordPublished = false;
        try {
            checkCancelled(cancellation);
            layout = prepareLayout();
            Path data = layout.dataPath(ref);
            Path record = layout.recordPath(ref);

            if (Files.exists(record, LinkOption.NOFOLLOW_LINKS)) {
                PendingImportRecord existing = readAndValidate(record, data, ref);
                requireCompatible(existing, item);
                return existing;
            }

            if (Files.exists(data, LinkOption.NOFOLLOW_LINKS)) {
                FileDigest recovered = digestOwnedFile(data, item.sizeBytes(), cancellation);
                policy.validateMagic(item.mimeType(), recovered.prefix);
                PendingImportRecord result = new PendingImportRecord(
                        ref, item.mimeType(), recovered.sizeBytes,
                        recovered.sha256, nonNegativeNow());
                publishRecord(layout, result, cancellation);
                return result;
            }

            long required = item.sizeBytes() + STORAGE_RESERVE_BYTES;
            if (storageProbe.availableBytes(required) < required) throw storageFull();
            checkCancelled(cancellation);

            dataTemp = layout.dataTempPath(ref);
            requireSafeReplacementTarget(dataTemp);
            Files.deleteIfExists(dataTemp);
            FileDigest copied = copyBounded(source, dataTemp, item.sizeBytes(), cancellation);
            policy.validateMagic(item.mimeType(), copied.prefix);
            faultInjector.checkpoint(Checkpoint.AFTER_DATA_FORCE);
            requireRegularFile(dataTemp, copied.sizeBytes);
            atomicMoveNew(dataTemp, data);
            dataTemp = null;
            fsyncDirectory(layout.dataDirectory);
            faultInjector.checkpoint(Checkpoint.AFTER_DATA_PUBLISH);
            checkCancelled(cancellation);

            PendingImportRecord result = new PendingImportRecord(
                    ref, item.mimeType(), copied.sizeBytes,
                    copied.sha256, nonNegativeNow());
            faultInjector.checkpoint(Checkpoint.BEFORE_RECORD_PUBLISH);
            recordTemp = layout.recordTempPath(ref);
            publishRecordBytes(layout, result, recordTemp, cancellation);
            recordTemp = null;
            recordPublished = true;
            faultInjector.checkpoint(Checkpoint.AFTER_RECORD_PUBLISH);
            return result;
        } catch (AndroidDocumentIngressPolicy.Failure failure) {
            throw new Failure(failure.code(), failure.getMessage());
        } catch (Failure failure) {
            throw failure;
        } catch (PublishedButUnsyncedException | AtomicMoveNotSupportedException failure) {
            throw unsafeState();
        } catch (IOException | RuntimeException failure) {
            throw recordPublished ? unsafeState() : failed();
        } finally {
            deleteExactTemp(dataTemp);
            deleteExactTemp(recordTemp);
        }
    }

    public synchronized PendingImportRecord load(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        try {
            Layout layout = prepareLayout();
            Path record = layout.recordPath(ref);
            if (!Files.exists(record, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            return readAndValidate(record, layout.dataPath(ref), ref);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    /**
     * Reads only the durable record and structural file metadata.
     *
     * The sole caller immediately hashes and validates the same data file before
     * any mutation. Keeping that full validation at the mutation boundary avoids
     * hashing a large pending PDF twice back-to-back.
     */
    synchronized PendingImportRecord loadMetadataForImmediateValidation(String ref)
            throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        try {
            Layout layout = prepareLayout();
            Path record = layout.recordPath(ref);
            if (!Files.exists(record, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            return readMetadata(record, layout.dataPath(ref), ref);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    public synchronized List<PendingImportRecord> listPending() throws Failure {
        try {
            Layout layout = prepareLayout();
            ArrayList<PendingImportRecord> records = new ArrayList<>();
            int count = 0;
            try (var paths = Files.list(layout.recordsDirectory)) {
                Iterator<Path> iterator = paths.iterator();
                while (iterator.hasNext()) {
                    Path path = iterator.next();
                    String name = path.getFileName().toString();
                    if (!name.endsWith(".pending")) continue;
                    if (++count > MAX_LIST_RECORDS) throw limit();
                    String payload = name.substring(0, name.length() - ".pending".length());
                    String ref = "d1_" + payload;
                    records.add(readAndValidate(path, layout.dataPath(ref), ref));
                }
            }
            Collections.sort(records);
            return Collections.unmodifiableList(records);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    /** Starts a durable incomplete manifest. Incomplete manifests are never deliverable. */
    synchronized PendingImportBatch beginBatch(List<String> refs) throws Failure {
        try {
            Layout layout = prepareLayout();
            PendingImportBatch requested = PendingImportBatch.begin(refs, nonNegativeNow());
            Path path = layout.batchPath(requested.batchRef());
            if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                PendingImportBatch existing = readBatch(path, requested.batchRef());
                if (!existing.refs().equals(requested.refs())) throw corrupt();
                return existing;
            }
            Path receiptPath = layout.acknowledgedPath(requested.batchRef());
            if (Files.exists(receiptPath, LinkOption.NOFOLLOW_LINKS)) {
                PendingImportBatch receipt = readBatch(receiptPath, requested.batchRef());
                if (!receipt.isAcknowledged() || !receipt.refs().equals(requested.refs())) {
                    throw corrupt();
                }
                return receipt;
            }
            ensureBatchCapacity(layout);
            publishNewBatch(layout, requested, path);
            return requested;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafeState();
        }
    }

    /** Makes an existing manifest deliverable only after every referenced pending record exists. */
    synchronized PendingImportBatch completeBatch(String batchRef, List<String> refs) throws Failure {
        try {
            Layout layout = prepareLayout();
            PendingImportBatch requested = PendingImportBatch.begin(refs, nonNegativeNow());
            if (!requested.batchRef().equals(batchRef)) throw invalid();
            PendingImportBatch batch = readBatch(layout.batchPath(batchRef), batchRef);
            if (!batch.refs().equals(requested.refs())) throw invalid();
            if (batch.isComplete()) return batch;
            for (String ref : batch.refs()) load(ref);
            PendingImportBatch complete = batch.complete(nonNegativeNow());
            replaceBatch(layout, complete, layout.batchPath(batchRef));
            return complete;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafeState();
        }
    }

    /** Roll back only this unsuccessful intake; completed or acknowledged deliveries are preserved. */
    synchronized void abortIncompleteBatch(String batchRef) throws Failure {
        if (!PendingImportBatch.isValidBatchRef(batchRef)) throw invalid();
        // Intake cancellation can interrupt its worker. FileChannel cleanup still needs to run;
        // restore the cancellation signal after the exact owned paths have been removed.
        boolean interrupted = Thread.interrupted();
        try {
            Layout layout = prepareLayout();
            Path path = layout.batchPath(batchRef);
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
            PendingImportBatch batch = readBatch(path, batchRef);
            if (!batch.isComplete() && !batch.isAcknowledged()) {
                removeIncompleteBatch(layout, batch, readBatches(layout));
            }
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafeState();
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    /** Returns one complete ordered batch. Incomplete crash state is deliberately not visible. */
    synchronized PendingImportBatch takeCompleteBatch(int maximumItems) throws Failure {
        if (maximumItems < 1 || maximumItems > AndroidDocumentIngressPolicy.MAX_ITEMS) throw invalid();
        try {
            Layout layout = prepareLayout();
            ArrayList<PendingImportBatch> complete = new ArrayList<>();
            int count = 0;
            try (var paths = Files.list(layout.batchesDirectory)) {
                Iterator<Path> iterator = paths.iterator();
                while (iterator.hasNext()) {
                    Path path = iterator.next();
                    String name = path.getFileName().toString();
                    if (!name.endsWith(".batch") || ++count > MAX_BATCH_MANIFESTS) {
                        throw corrupt();
                    }
                    PendingImportBatch batch = readBatch(path, batchRefForName(name, ".batch"));
                    if (batch.isComplete()) complete.add(batch);
                }
            }
            if (complete.isEmpty()) return null;
            Collections.sort(complete);
            PendingImportBatch batch = complete.get(0);
            if (batch.refs().size() > maximumItems) throw limit();
            return batch;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    synchronized PendingImportBatch loadCompleteBatch(String batchRef) throws Failure {
        try {
            Layout layout = prepareLayout();
            Path path = layout.batchPath(batchRef);
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            PendingImportBatch batch = readBatch(path, batchRef);
            if (!batch.isComplete()) throw notFound();
            return batch;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    synchronized PendingImportBatch loadAcknowledgedBatch(String batchRef) throws Failure {
        try {
            Layout layout = prepareLayout();
            Path path = layout.acknowledgedPath(batchRef);
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            PendingImportBatch batch = readBatch(path, batchRef);
            if (!batch.isAcknowledged()) throw corrupt();
            return batch;
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    /** Persists an exact acknowledgement receipt before deleting the complete manifest. */
    synchronized void finalizeAcknowledgedBatch(PendingImportBatch complete) throws Failure {
        if (complete == null || !complete.isComplete()) throw invalid();
        try {
            Layout layout = prepareLayout();
            PendingImportBatch current = readBatch(layout.batchPath(complete.batchRef()), complete.batchRef());
            if (!current.isComplete() || !current.refs().equals(complete.refs())) throw corrupt();
            for (String ref : current.refs()) {
                if (Files.exists(layout.recordPath(ref), LinkOption.NOFOLLOW_LINKS)) throw unsafeState();
                if (Files.exists(layout.dataPath(ref), LinkOption.NOFOLLOW_LINKS)) throw unsafeState();
            }
            PendingImportBatch receipt = current.acknowledge(nonNegativeNow());
            Path receiptPath = layout.acknowledgedPath(receipt.batchRef());
            if (Files.exists(receiptPath, LinkOption.NOFOLLOW_LINKS)) {
                PendingImportBatch existing = readBatch(receiptPath, receipt.batchRef());
                if (!existing.isAcknowledged() || !existing.refs().equals(receipt.refs())) throw corrupt();
            } else {
                publishNewAcknowledgement(layout, receipt, receiptPath);
            }
            deleteExactPublished(layout.batchPath(complete.batchRef()));
            fsyncDirectory(layout.batchesDirectory);
            cleanupAcknowledgements(layout, nonNegativeNow());
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafeState();
        }
    }

    synchronized boolean hasPendingMarker(String ref) throws Failure {
        if (!PendingImportRecord.isValidRef(ref)) throw invalid();
        try {
            Layout layout = prepareLayout();
            Path marker = layout.recordPath(ref);
            if (!Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) return false;
            requireRegularFile(marker, -1);
            return true;
        } catch (IOException | RuntimeException failure) {
            throw corrupt();
        }
    }

    private void publishNewBatch(Layout layout, PendingImportBatch batch, Path target)
            throws IOException, Failure {
        Path temp = layout.batchTempPath(batch.batchRef());
        try {
            requireSafeReplacementTarget(temp);
            Files.deleteIfExists(temp);
            writeForced(temp, batch.encode());
            requireRegularFile(temp, Files.size(temp));
            atomicMoveNew(temp, target);
            fsyncDirectory(layout.batchesDirectory);
        } finally {
            deleteExactTemp(temp);
        }
    }

    private void publishNewAcknowledgement(Layout layout, PendingImportBatch batch, Path target)
            throws IOException, Failure {
        Path temp = layout.acknowledgedTempPath(batch.batchRef());
        try {
            requireSafeReplacementTarget(temp);
            Files.deleteIfExists(temp);
            writeForced(temp, batch.encode());
            requireRegularFile(temp, Files.size(temp));
            atomicMoveNew(temp, target);
            fsyncDirectory(layout.acknowledgedDirectory);
        } finally {
            deleteExactTemp(temp);
        }
    }

    private void replaceBatch(Layout layout, PendingImportBatch batch, Path target)
            throws IOException, Failure {
        Path temp = layout.batchTempPath(batch.batchRef());
        try {
            requireSafeReplacementTarget(temp);
            Files.deleteIfExists(temp);
            writeForced(temp, batch.encode());
            requireRegularFile(temp, Files.size(temp));
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            fsyncDirectory(layout.batchesDirectory);
        } finally {
            deleteExactTemp(temp);
        }
    }

    private static PendingImportBatch readBatch(Path path, String expectedBatchRef)
            throws IOException, Failure {
        requireRegularFile(path, -1);
        long size = Files.size(path);
        if (size <= 0 || size > PendingImportBatch.MAX_ENCODED_BYTES) throw corrupt();
        PendingImportBatch batch = PendingImportBatch.decode(Files.readAllBytes(path));
        if (expectedBatchRef != null && !expectedBatchRef.equals(batch.batchRef())) throw corrupt();
        return batch;
    }

    private void cleanupAcknowledgements(Layout layout, long nowMillis) throws IOException, Failure {
        ArrayList<PendingImportBatch> receipts = new ArrayList<>();
        try (var paths = Files.list(layout.acknowledgedDirectory)) {
            Iterator<Path> iterator = paths.iterator();
            while (iterator.hasNext()) {
                Path path = iterator.next();
                String name = path.getFileName().toString();
                if (!name.endsWith(".ack") || receipts.size() >= MAX_ACKNOWLEDGED_BATCHES * 2) {
                    throw corrupt();
                }
                PendingImportBatch receipt = readBatch(path, batchRefForName(name, ".ack"));
                if (!receipt.isAcknowledged()) throw corrupt();
                if (nowMillis - receipt.stateAtMillis() > ACKNOWLEDGED_BATCH_MAX_AGE_MILLIS) {
                    deleteExactPublished(path);
                } else {
                    receipts.add(receipt);
                }
            }
        }
        Collections.sort(receipts);
        for (int index = 0; index < receipts.size() - MAX_ACKNOWLEDGED_BATCHES; index++) {
            deleteExactPublished(layout.acknowledgedPath(receipts.get(index).batchRef()));
        }
        fsyncDirectory(layout.acknowledgedDirectory);
    }

    private static void ensureBatchCapacity(Layout layout) throws IOException, Failure {
        int count = 0;
        try (var paths = Files.list(layout.batchesDirectory)) {
            Iterator<Path> iterator = paths.iterator();
            while (iterator.hasNext()) {
                Path path = iterator.next();
                String name = path.getFileName().toString();
                if (!name.endsWith(".batch") || ++count > MAX_BATCH_MANIFESTS) throw corrupt();
                batchRefForName(name, ".batch");
                requireRegularFile(path, -1);
            }
        }
        if (count >= MAX_BATCH_MANIFESTS) throw limit();
    }

    private void publishRecord(
            Layout layout,
            PendingImportRecord record,
            CancellationSignal cancellation) throws IOException, Failure {
        Path temp = layout.recordTempPath(record.ref());
        try {
            publishRecordBytes(layout, record, temp, cancellation);
        } finally {
            deleteExactTemp(temp);
        }
    }

    private void publishRecordBytes(
            Layout layout,
            PendingImportRecord record,
            Path temp,
            CancellationSignal cancellation) throws IOException, Failure {
        requireSafeReplacementTarget(temp);
        Files.deleteIfExists(temp);
        writeForced(temp, record.encode());
        checkCancelled(cancellation);
        requireRegularFile(temp, Files.size(temp));
        boolean published = false;
        try {
            atomicMoveNew(temp, layout.recordPath(record.ref()));
            published = true;
        } catch (FileAlreadyExistsException race) {
            PendingImportRecord existing = readAndValidate(
                    layout.recordPath(record.ref()), layout.dataPath(record.ref()), record.ref());
            if (!existing.equals(record)) throw new IOException("Conflicting record");
        }
        try {
            fsyncDirectory(layout.recordsDirectory);
        } catch (IOException failure) {
            if (published) throw new PublishedButUnsyncedException();
            throw failure;
        }
    }

    private PendingImportRecord readAndValidate(
            Path recordPath, Path dataPath, String expectedRef) throws IOException, Failure {
        PendingImportRecord record = readMetadata(recordPath, dataPath, expectedRef);
        FileDigest data = digestOwnedFile(dataPath, record.sizeBytes(), () -> false);
        if (!data.sha256.equals(record.contentHash())) throw corrupt();
        try {
            policy.validateMagic(record.mimeType(), data.prefix);
        } catch (AndroidDocumentIngressPolicy.Failure failure) {
            throw corrupt();
        }
        return record;
    }

    private PendingImportRecord readMetadata(
            Path recordPath, Path dataPath, String expectedRef) throws IOException, Failure {
        requireRegularFile(recordPath, -1);
        long recordSize = Files.size(recordPath);
        if (recordSize <= 0 || recordSize > PendingImportRecord.MAX_ENCODED_BYTES) throw corrupt();
        PendingImportRecord record = PendingImportRecord.decode(Files.readAllBytes(recordPath));
        if (!record.ref().equals(expectedRef)) throw corrupt();
        requireRegularFile(dataPath, record.sizeBytes());
        return record;
    }

    private static void requireCompatible(
            PendingImportRecord record,
            AndroidDocumentIngressPolicy.ValidatedItem item) throws Failure {
        if (!record.mimeType().equals(item.mimeType())
                || record.sizeBytes() != item.sizeBytes()) {
            throw corrupt();
        }
    }

    private FileDigest copyBounded(
            InputStream source,
            Path target,
            long expectedBytes,
            CancellationSignal cancellation) throws IOException, Failure {
        MessageDigest digest = sha256();
        ByteArrayOutputStream prefix = new ByteArrayOutputStream(MAGIC_PREFIX_BYTES);
        byte[] buffer = new byte[COPY_BUFFER_BYTES];
        long total = 0;
        try (FileChannel output = FileChannel.open(target,
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            while (true) {
                checkCancelled(cancellation);
                int read = source.read(buffer);
                if (read < 0) break;
                if (read == 0) continue;
                if (total > expectedBytes - read
                        || total > AndroidDocumentIngressPolicy.MAX_ITEM_BYTES - read) {
                    throw corrupt();
                }
                if (prefix.size() < MAGIC_PREFIX_BYTES) {
                    int count = Math.min(read, MAGIC_PREFIX_BYTES - prefix.size());
                    prefix.write(buffer, 0, count);
                }
                digest.update(buffer, 0, read);
                ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, read);
                while (bytes.hasRemaining()) output.write(bytes);
                total += read;
            }
            if (total != expectedBytes) throw corrupt();
            checkCancelled(cancellation);
            output.force(true);
        }
        return new FileDigest(total, lowercaseHex(digest.digest()), prefix.toByteArray());
    }

    private FileDigest digestOwnedFile(
            Path path, long expectedBytes, CancellationSignal cancellation)
            throws IOException, Failure {
        requireRegularFile(path, expectedBytes);
        MessageDigest digest = sha256();
        ByteArrayOutputStream prefix = new ByteArrayOutputStream(MAGIC_PREFIX_BYTES);
        long total = 0;
        ByteBuffer buffer = ByteBuffer.allocate(COPY_BUFFER_BYTES);
        try (FileChannel input = FileChannel.open(path, StandardOpenOption.READ)) {
            while (true) {
                checkCancelled(cancellation);
                int read = input.read(buffer);
                if (read < 0) break;
                if (read == 0) continue;
                total += read;
                if (total > expectedBytes || total > AndroidDocumentIngressPolicy.MAX_ITEM_BYTES) {
                    throw corrupt();
                }
                buffer.flip();
                byte[] bytes = new byte[read];
                buffer.get(bytes);
                buffer.clear();
                if (prefix.size() < MAGIC_PREFIX_BYTES) {
                    prefix.write(bytes, 0, Math.min(bytes.length, MAGIC_PREFIX_BYTES - prefix.size()));
                }
                digest.update(bytes);
            }
        }
        if (total != expectedBytes) throw corrupt();
        return new FileDigest(total, lowercaseHex(digest.digest()), prefix.toByteArray());
    }

    private Layout prepareLayout() throws IOException, Failure {
        Path root = requireExistingDirectory(filesDir);
        Path store = ensureDirectDirectory(root, root.resolve(ROOT_NAME));
        Path data = ensureDirectDirectory(store, store.resolve(DATA_NAME));
        Path records = ensureDirectDirectory(store, store.resolve(RECORDS_NAME));
        Path batches = ensureDirectDirectory(store, store.resolve(BATCHES_NAME));
        Path acknowledged = ensureDirectDirectory(store, store.resolve(ACKNOWLEDGED_NAME));
        cleanupBatchTemps(batches, ".batch");
        cleanupBatchTemps(acknowledged, ".ack");
        Layout layout = new Layout(store, data, records, batches, acknowledged);
        cleanupAbandonedBatches(layout);
        return layout;
    }

    private void cleanupAbandonedBatches(Layout layout) throws IOException, Failure {
        List<PendingImportBatch> batches = readBatches(layout);
        long now = nonNegativeNow();
        for (PendingImportBatch batch : batches) {
            if (!batch.isComplete() && !batch.isAcknowledged()
                    && now >= batch.stateAtMillis()
                    && now - batch.stateAtMillis() >= INCOMPLETE_BATCH_MAX_AGE_MILLIS) {
                removeIncompleteBatch(layout, batch, batches);
            }
        }
    }

    private static List<PendingImportBatch> readBatches(Layout layout) throws IOException, Failure {
        ArrayList<PendingImportBatch> batches = new ArrayList<>();
        try (var paths = Files.list(layout.batchesDirectory)) {
            Iterator<Path> iterator = paths.iterator();
            while (iterator.hasNext()) {
                Path path = iterator.next();
                if (batches.size() >= MAX_BATCH_MANIFESTS) throw limit();
                String ref = batchRefForName(path.getFileName().toString(), ".batch");
                batches.add(readBatch(path, ref));
            }
        }
        return batches;
    }

    private static void removeIncompleteBatch(Layout layout, PendingImportBatch batch,
            List<PendingImportBatch> batches) throws IOException, Failure {
        ArrayList<Path> targets = new ArrayList<>();
        for (String ref : batch.refs()) {
            for (PendingImportBatch other : batches) {
                if (!other.batchRef().equals(batch.batchRef()) && other.refs().contains(ref)) {
                    throw corrupt(); // Never remove bytes claimed by another durable delivery.
                }
            }
            for (Path path : List.of(layout.recordPath(ref), layout.dataPath(ref),
                    layout.recordTempPath(ref), layout.dataTempPath(ref))) {
                if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                    requireRegularFile(path, -1);
                    targets.add(path);
                }
            }
        }
        // Keep the manifest until every child is gone, so interrupted rollback is restartable.
        for (Path path : targets) Files.deleteIfExists(path);
        fsyncDirectory(layout.recordsDirectory);
        fsyncDirectory(layout.dataDirectory);
        deleteExactPublished(layout.batchPath(batch.batchRef()));
        fsyncDirectory(layout.batchesDirectory);
    }

    /** Removes only a crash-left exact temp name; published manifests are validated and retained. */
    private static void cleanupBatchTemps(Path directory, String publishedSuffix)
            throws IOException, Failure {
        boolean deleted = false;
        try (var paths = Files.list(directory)) {
            Iterator<Path> iterator = paths.iterator();
            while (iterator.hasNext()) {
                Path path = iterator.next();
                String name = path.getFileName().toString();
                if (name.endsWith(publishedSuffix)) {
                    batchRefForName(name, publishedSuffix);
                    requireRegularFile(path, -1);
                } else if (name.endsWith(".tmp")) {
                    batchRefForName(name, ".tmp");
                    requireRegularFile(path, -1);
                    Files.delete(path);
                    deleted = true;
                } else {
                    throw corrupt();
                }
            }
        }
        if (deleted) fsyncDirectory(directory);
    }

    private static Path ensureDirectDirectory(Path parent, Path child) throws IOException {
        requireDirectChild(parent, child);
        if (!Files.exists(child, LinkOption.NOFOLLOW_LINKS)) {
            Files.createDirectory(child);
            fsyncDirectory(parent);
        }
        return requireExistingDirectory(child);
    }

    private static Path requireExistingDirectory(Path path) throws IOException {
        if (Files.isSymbolicLink(path)
                || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Unsafe directory");
        }
        return path.toRealPath(LinkOption.NOFOLLOW_LINKS);
    }

    private static void requireDirectChild(Path parent, Path child) throws IOException {
        Path normalizedParent = parent.toAbsolutePath().normalize();
        Path normalizedChild = child.toAbsolutePath().normalize();
        if (!normalizedParent.equals(normalizedChild.getParent())) {
            throw new IOException("Unsafe child");
        }
    }

    private static void requireSafeReplacementTarget(Path path) throws IOException {
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)
                && (Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))) {
            throw new IOException("Unsafe temporary target");
        }
    }

    private static void requireRegularFile(Path path, long expectedSize) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(
                path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (Files.isSymbolicLink(path) || !attributes.isRegularFile()
                || (expectedSize >= 0 && attributes.size() != expectedSize)) {
            throw new IOException("Unsafe owned file");
        }
    }

    private static void atomicMoveNew(Path source, Path target) throws IOException {
        Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
    }

    private static void writeForced(Path path, byte[] bytes) throws IOException {
        try (FileChannel output = FileChannel.open(path,
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) output.write(buffer);
            output.force(true);
        }
    }

    private static void fsyncDirectory(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        }
    }

    private static void deleteExactTemp(Path path) {
        if (path == null) return;
        try {
            if (!Files.isSymbolicLink(path)
                    && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                Files.deleteIfExists(path);
            }
        } catch (IOException | SecurityException ignored) {
            // Exact ref-scoped temporary cleanup only; never sweep the store.
        }
    }

    private static void deleteExactPublished(Path path) throws IOException {
        requireRegularFile(path, -1);
        Files.delete(path);
    }

    private static String batchRefForName(String name, String suffix) throws Failure {
        if (name == null || !name.endsWith(suffix)) throw corrupt();
        String batchRef = "b1_" + name.substring(0, name.length() - suffix.length());
        if (!PendingImportBatch.isValidBatchRef(batchRef)) throw corrupt();
        return batchRef;
    }

    private static MessageDigest sha256() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 unavailable");
        }
    }

    private static String lowercaseHex(byte[] bytes) {
        char[] output = new char[bytes.length * 2];
        char[] alphabet = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            output[i * 2] = alphabet[value >>> 4];
            output[i * 2 + 1] = alphabet[value & 0x0f];
        }
        return new String(output);
    }

    private static long nonNegativeNow(Clock clock) throws Failure {
        long value = clock.nowMillis();
        if (value < 0) throw unsafeState();
        return value;
    }

    private long nonNegativeNow() throws Failure {
        return nonNegativeNow(clock);
    }

    private static void checkCancelled(CancellationSignal cancellation) throws Failure {
        if (Thread.currentThread().isInterrupted() || cancellation.isCancelled()) {
            throw cancelled();
        }
    }

    private static Failure invalid() {
        return new Failure("DOCUMENT_INVALID_ARGUMENT", "The document request is invalid.");
    }
    private static Failure notFound() {
        return new Failure("DOCUMENT_NOT_FOUND", "The document is unavailable.");
    }
    private static Failure storageFull() {
        return new Failure("DOCUMENT_STORAGE_FULL", "There is not enough storage.");
    }
    private static Failure cancelled() {
        return new Failure("DOCUMENT_CANCELLED", "The document operation was cancelled.");
    }
    private static Failure limit() {
        return new Failure("DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded.");
    }
    private static Failure corrupt() {
        return new Failure("DOCUMENT_CORRUPT", "The document could not be validated.");
    }
    private static Failure unsafeState() {
        return new Failure("DOCUMENT_UNSAFE_STATE", "The document state is unavailable.");
    }
    private static Failure failed() {
        return new Failure("DOCUMENT_FAILED", "The document operation failed.");
    }

    public static final class Failure extends Exception {
        private final String code;
        private Failure(String code, String message) {
            super(message);
            this.code = code;
        }
        public String code() { return code; }
    }

    @FunctionalInterface public interface CancellationSignal {
        boolean isCancelled();
    }

    @FunctionalInterface interface StorageProbe {
        long availableBytes(long requiredBytes) throws IOException;
    }

    @FunctionalInterface interface Clock {
        long nowMillis();
    }

    @FunctionalInterface interface FaultInjector {
        void checkpoint(Checkpoint checkpoint) throws IOException;
    }

    enum Checkpoint {
        AFTER_DATA_FORCE,
        AFTER_DATA_PUBLISH,
        BEFORE_RECORD_PUBLISH,
        AFTER_RECORD_PUBLISH
    }

    private static final class FileDigest {
        final long sizeBytes;
        final String sha256;
        final byte[] prefix;
        FileDigest(long sizeBytes, String sha256, byte[] prefix) {
            this.sizeBytes = sizeBytes;
            this.sha256 = sha256;
            this.prefix = prefix;
        }
    }

    private static final class PublishedButUnsyncedException extends IOException { }

    private static final class Layout {
        final Path root;
        final Path dataDirectory;
        final Path recordsDirectory;
        final Path batchesDirectory;
        final Path acknowledgedDirectory;
        Layout(Path root, Path dataDirectory, Path recordsDirectory,
                Path batchesDirectory, Path acknowledgedDirectory) {
            this.root = root;
            this.dataDirectory = dataDirectory;
            this.recordsDirectory = recordsDirectory;
            this.batchesDirectory = batchesDirectory;
            this.acknowledgedDirectory = acknowledgedDirectory;
        }
        Path dataPath(String ref) throws IOException {
            return child(dataDirectory, PendingImportRecord.refPayload(ref) + ".bin");
        }
        Path recordPath(String ref) throws IOException {
            return child(recordsDirectory, PendingImportRecord.refPayload(ref) + ".pending");
        }
        Path dataTempPath(String ref) throws IOException {
            return child(dataDirectory, PendingImportRecord.refPayload(ref) + ".tmp");
        }
        Path recordTempPath(String ref) throws IOException {
            return child(recordsDirectory, PendingImportRecord.refPayload(ref) + ".tmp");
        }
        Path batchPath(String batchRef) throws IOException {
            return child(batchesDirectory, batchPayload(batchRef) + ".batch");
        }
        Path batchTempPath(String batchRef) throws IOException {
            return child(batchesDirectory, batchPayload(batchRef) + ".tmp");
        }
        Path acknowledgedPath(String batchRef) throws IOException {
            return child(acknowledgedDirectory, batchPayload(batchRef) + ".ack");
        }
        Path acknowledgedTempPath(String batchRef) throws IOException {
            return child(acknowledgedDirectory, batchPayload(batchRef) + ".tmp");
        }
        private static String batchPayload(String batchRef) throws IOException {
            if (!PendingImportBatch.isValidBatchRef(batchRef)) throw new IOException("Invalid batch ref");
            return batchRef.substring("b1_".length());
        }
        private static Path child(Path parent, String name) throws IOException {
            Path child = parent.resolve(name).toAbsolutePath().normalize();
            requireDirectChild(parent, child);
            return child;
        }
    }
}
