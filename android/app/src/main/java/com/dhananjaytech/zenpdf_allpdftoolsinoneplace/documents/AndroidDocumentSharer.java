package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderLaunchContract;
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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/** Inactive delayed-recipient share staging. FileProvider registration remains T040. */
final class AndroidDocumentSharer {
    static final int MAXIMUM_RETAINED_STAGES = 8;
    static final long MAXIMUM_RETAINED_BYTES = 256L * 1024L * 1024L;
    static final long STAGE_EXPIRY_MILLIS = 24L * 60L * 60L * 1000L;
    private static final int MAGIC = 0x50444831; // PDH1
    private static final int LEGACY_VERSION = 1;
    private static final int VERSION = 2;
    private static final int MAXIMUM_RECORD_BYTES = 768;
    private static final String DISPLAY_NAME_QUERY = "displayName";

    private final Path filesDir;
    private final String providerAuthority;
    private final OwnedDocumentWriter.Clock clock;
    private final OwnedDocumentWriter.TokenSource tokens;
    private final OwnedDocumentWriter.StorageProbe storageProbe;
    private final FaultInjector faults;

    AndroidDocumentSharer(Context context) {
        this(Objects.requireNonNull(context).getApplicationContext().getFilesDir().toPath(),
                context.getApplicationContext().getPackageName() + ".fileprovider",
                System::currentTimeMillis, secureTokens(),
                ignored -> context.getApplicationContext().getFilesDir().getUsableSpace(),
                ignored -> {});
    }

    AndroidDocumentSharer(Path filesDir, String providerAuthority,
            OwnedDocumentWriter.Clock clock, OwnedDocumentWriter.TokenSource tokens,
            OwnedDocumentWriter.StorageProbe storageProbe, FaultInjector faults) {
        this.filesDir = Objects.requireNonNull(filesDir).toAbsolutePath().normalize();
        this.providerAuthority = Objects.requireNonNull(providerAuthority);
        this.clock = Objects.requireNonNull(clock);
        this.tokens = Objects.requireNonNull(tokens);
        this.storageProbe = Objects.requireNonNull(storageProbe);
        this.faults = Objects.requireNonNull(faults);
    }

    Stage prepare(OwnedDocumentWriter.DocumentSource source,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (source == null || cancellation == null || source.sizeBytes() <= 0
                || source.sizeBytes() > OwnedDocumentWriter.MAXIMUM_FILE_BYTES
                || !OwnedDocumentWritePolicy.isSupportedMimeType(source.mimeType())) throw invalid();
        checkCancelled(cancellation);
        Layout layout = prepareAndRecover();
        List<StageRecord> records;
        try { records = readRecords(layout); }
        catch (IOException failure) { throw unsafe(); }
        long aggregate = 0;
        for (StageRecord record : records) {
            if (!record.complete) throw busy();
            if (aggregate > MAXIMUM_RETAINED_BYTES - record.size) throw unsafe();
            aggregate += record.size;
        }
        try { makeRoom(layout, records, source.sizeBytes()); }
        catch (IOException failure) { throw unsafe(); }
        long required = source.sizeBytes() + OwnedDocumentWriter.STORAGE_RESERVE_BYTES;
        try {
            if (storageProbe.availableBytes(required) < required) throw storageFull();
            String token = validToken();
            long createdAt = now();
            StageRecord record = new StageRecord(token, source.mimeType(), source.sizeBytes(),
                    createdAt, false, false, null, 1, false);
            Path metadata = layout.metadata(token);
            publish(metadata, record);
            fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_PREPARING_RECORD);
            Snapshot snapshot = copy(source, layout.part(token), cancellation);
            if (snapshot.size != source.sizeBytes()) throw corrupt();
            Path data = layout.data(token, source.mimeType());
            atomicMoveNew(layout.part(token), data);
            fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_STAGE_MOVE);
            StageRecord completed = record.completed(snapshot.hash);
            publish(metadata, completed);
            fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_STAGE_RECORD);
            return new Stage(token, completed.mimeType, completed.size, completed.hash,
                    List.of(new StageItem(0, null, completed.mimeType,
                            completed.size, completed.hash)), false);
        } catch (Failure failure) {
            cleanupPreparing(layout);
            throw failure;
        } catch (IOException | RuntimeException failure) {
            cleanupPreparing(layout);
            throw unsafe();
        }
    }

    Stage prepareCollection(LegacyDocumentOpenResolver.CollectionSource collection,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (collection == null || cancellation == null) throw invalid();
        checkCancelled(cancellation);
        Layout layout = prepareAndRecover();
        List<StageRecord> records;
        try { records = readRecords(layout); }
        catch (IOException failure) { throw unsafe(); }
        long retained = 0;
        for (StageRecord record : records) {
            if (!record.complete) throw busy();
            if (retained > MAXIMUM_RETAINED_BYTES - record.size) throw unsafe();
            retained += record.size;
        }
        try {
            collection.validateUnchanged();
            int count = collection.itemCount();
            long total = collection.totalBytes();
            if (count < 1 || count > LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_ITEMS
                    || total <= 0 || total > LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_BYTES)
                throw limit();
            makeRoom(layout, records, total);
            long required = total + OwnedDocumentWriter.STORAGE_RESERVE_BYTES;
            if (storageProbe.availableBytes(required) < required) throw storageFull();
            String token = validToken();
            StageRecord record = new StageRecord(token, collection.mimeType(), total, now(),
                    false, false, null, count, true);
            Path metadata = layout.metadata(token);
            publish(metadata, record); fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_PREPARING_RECORD);
            ArrayList<StageItem> staged = new ArrayList<>(count);
            MessageDigest aggregate = sha256();
            int index = 0;
            for (LegacyDocumentOpenResolver.CollectionItem item : collection.items()) {
                checkCancelled(cancellation);
                collection.validateUnchanged();
                Snapshot snapshot;
                try (OwnedDocumentWriter.DocumentSource source = item.openSource()) {
                    snapshot = copy(source, layout.collectionPart(token, index), cancellation);
                }
                if (snapshot.size != item.sizeBytes()) throw corrupt();
                atomicMoveNew(layout.collectionPart(token, index),
                        layout.collectionData(token, index, item.mimeType()));
                updateAggregate(aggregate, snapshot, item.mimeType());
                staged.add(new StageItem(index, item.displayName(), item.mimeType(),
                        snapshot.size, snapshot.hash));
                index++;
            }
            collection.validateUnchanged();
            fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_STAGE_MOVE);
            StageRecord completed = record.completed(hex(aggregate.digest()));
            publish(metadata, completed); fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_STAGE_RECORD);
            return new Stage(token, completed.mimeType, completed.size, completed.hash,
                    List.copyOf(staged), true);
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            cleanupPreparing(layout);
            String code = failure.code().startsWith("LEGACY_")
                    ? failure.code().substring("LEGACY_".length()) : failure.code();
            throw new Failure(code, failure.getMessage());
        } catch (Failure failure) {
            cleanupPreparing(layout); throw failure;
        } catch (IOException | RuntimeException failure) {
            cleanupPreparing(layout); throw unsafe();
        }
    }

    Intent createReadOnlyIntent(Stage stage, Uri contentUri) throws Failure {
        if (stage == null || contentUri == null) throw invalid();
        Layout layout = prepareAndRecover();
        StageRecord record = load(layout, stage.token);
        if (!record.complete || record.dispatched || !stage.matches(record)) throw invalid();
        try {
            Path staged = existingSingleData(layout, record);
            Uri expected = new Uri.Builder().scheme("content").authority(providerAuthority)
                    .appendPath("pdfchef_share_staging")
                    .appendPath(staged.getFileName().toString()).build();
            if (!matchesCanonicalShareUri(expected, contentUri)) throw invalid();
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(record.mimeType);
            intent.putExtra(Intent.EXTRA_STREAM, contentUri);
            intent.setClipData(ClipData.newRawUri("document", contentUri));
            intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return intent;
        } catch (IOException failure) {
            throw unsafe();
        } catch (RuntimeException failure) {
            throw failed();
        }
    }

    Intent createReadOnlyIntent(Stage stage, List<Uri> contentUris) throws Failure {
        if (stage == null || contentUris == null || contentUris.size() != stage.items.size()) {
            throw invalid();
        }
        if (!stage.collection && contentUris.size() == 1) {
            return createReadOnlyIntent(stage, contentUris.get(0));
        }
        Layout layout = prepareAndRecover();
        StageRecord record = load(layout, stage.token);
        if (!record.complete || record.dispatched || !stage.matches(record)) throw invalid();
        try {
            ArrayList<Uri> streams = new ArrayList<>(contentUris.size());
            ClipData clip = null;
            for (int index = 0; index < contentUris.size(); index++) {
                StageItem item = stage.items.get(index);
                Uri expected = new Uri.Builder().scheme("content").authority(providerAuthority)
                        .appendPath("pdfchef_share_staging")
                        .appendPath(layout.collectionData(stage.token, item.index)
                                .getFileName().toString()).build();
                Uri candidate = contentUris.get(index);
                if (!matchesCanonicalShareUri(expected, candidate)) throw invalid();
                streams.add(candidate);
                ClipData.Item clipItem = new ClipData.Item(candidate);
                if (clip == null) {
                    clip = new ClipData("documents", new String[] {record.mimeType}, clipItem);
                } else {
                    clip.addItem(clipItem);
                }
            }
            Intent intent = new Intent(Intent.ACTION_SEND_MULTIPLE);
            intent.setType(record.mimeType);
            intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);
            intent.setClipData(clip);
            intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return intent;
        } catch (IOException failure) { throw unsafe(); }
        catch (Failure failure) { throw failure; }
        catch (RuntimeException failure) { throw failed(); }
    }

    private static boolean matchesCanonicalShareUri(Uri canonical, Uri candidate) {
        if (canonical.equals(candidate)) return true; // Legacy queryless shares remain valid.
        try {
            if (!candidate.getQueryParameterNames().equals(java.util.Set.of(DISPLAY_NAME_QUERY))) {
                return false;
            }
            List<String> values = candidate.getQueryParameters(DISPLAY_NAME_QUERY);
            if (values.size() != 1) return false;
            String displayName = values.get(0);
            if (!PdfReaderLaunchContract.isSafeDisplayName(displayName)) return false;
            Uri reconstructed = canonical.buildUpon()
                    .appendQueryParameter(DISPLAY_NAME_QUERY, displayName)
                    .build();
            return reconstructed.equals(candidate);
        } catch (IllegalArgumentException | UnsupportedOperationException failure) {
            return false;
        }
    }

    void markDispatched(Stage stage) throws Failure {
        if (stage == null) throw invalid();
        Layout layout = prepareAndRecover();
        StageRecord record = load(layout, stage.token);
        if (!record.complete || !stage.matches(record)) throw invalid();
        try {
            publish(layout.metadata(stage.token), record.asDispatched());
            fsyncDirectory(layout.root);
        } catch (IOException failure) { throw unsafe(); }
    }

    void cancelBeforeDispatch(Stage stage) throws Failure {
        if (stage == null) throw invalid();
        Layout layout = prepareAndRecover();
        StageRecord record = load(layout, stage.token);
        if (record.dispatched) return;
        try {
            deleteStageFiles(layout, record);
            deleteExact(layout.metadata(stage.token));
            fsyncDirectory(layout.root);
        }
        catch (IOException failure) { throw unsafe(); }
    }

    Path stagedPathForProvider(Stage stage) throws Failure {
        if (stage == null) throw invalid();
        Layout layout = prepareAndRecover();
        StageRecord record = load(layout, stage.token);
        if (!record.complete || !stage.matches(record)) throw invalid();
        try {
            return existingSingleData(layout, record);
        } catch (IOException failure) { throw unsafe(); }
    }

    List<Path> stagedPathsForProvider(Stage stage) throws Failure {
        if (stage == null) throw invalid();
        Layout layout = prepareAndRecover();
        StageRecord record = load(layout, stage.token);
        if (!record.complete || !stage.matches(record)) throw invalid();
        try {
            ArrayList<Path> paths = new ArrayList<>(stage.items.size());
            for (StageItem item : stage.items) {
                Path path = !record.collection ? existingSingleData(layout, record)
                        : layout.collectionData(stage.token, item.index);
                requireRegular(path, item.size);
                paths.add(path);
            }
            return List.copyOf(paths);
        } catch (IOException failure) { throw unsafe(); }
    }

    List<String> stagedDisplayNames(Stage stage) throws Failure {
        if (stage == null || stage.items.size() < 1) throw invalid();
        ArrayList<String> names = new ArrayList<>(stage.items.size());
        for (StageItem item : stage.items) names.add(item.displayName);
        return Collections.unmodifiableList(names);
    }

    private Layout prepareAndRecover() throws Failure {
        try {
            Layout layout = Layout.prepare(filesDir);
            List<StageRecord> records = readRecords(layout);
            long current = now();
            for (StageRecord record : records) {
                if (current - record.createdAt >= STAGE_EXPIRY_MILLIS) {
                    deleteStageFiles(layout, record);
                    deleteExact(layout.metadata(record.token));
                } else if (!record.complete) {
                    // A non-expired preparation is the single active share preparation.
                    validatePreparingFiles(layout, record);
                } else {
                    validateCompletedFiles(layout, record);
                }
            }
            return layout;
        } catch (Failure failure) { throw failure; }
        catch (IOException | RuntimeException failure) { throw unsafe(); }
    }

    private List<StageRecord> readRecords(Layout layout) throws IOException, Failure {
        ArrayList<Path> paths = new ArrayList<>();
        try (var stream = Files.list(layout.root)) {
            stream.filter(path -> path.getFileName().toString().endsWith(".share"))
                    .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                    .limit(MAXIMUM_RETAINED_STAGES + 1L).forEach(paths::add);
        }
        if (paths.size() > MAXIMUM_RETAINED_STAGES) throw limit();
        ArrayList<StageRecord> result = new ArrayList<>();
        for (Path path : paths) result.add(decode(readRecord(path)));
        return result;
    }

    private StageRecord load(Layout layout, String token) throws Failure {
        try {
            Path metadata = layout.metadata(token);
            if (!Files.exists(metadata, LinkOption.NOFOLLOW_LINKS)) throw notFound();
            StageRecord record = decode(readRecord(metadata));
            if (!record.token.equals(token)) throw corrupt();
            return record;
        } catch (Failure failure) { throw failure; }
        catch (IOException failure) { throw corrupt(); }
    }

    private Snapshot copy(OwnedDocumentWriter.DocumentSource source, Path target,
            OwnedPendingImportStore.CancellationSignal cancellation) throws IOException, Failure {
        deleteExact(target);
        MessageDigest digest = sha256();
        byte[] bytes = new byte[64 * 1024];
        long total = 0;
        try (FileChannel output = FileChannel.open(target,
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            while (total < source.sizeBytes()) {
                checkCancelled(cancellation);
                int wanted = (int) Math.min(bytes.length, source.sizeBytes() - total);
                byte[] window = wanted == bytes.length ? bytes : new byte[wanted];
                int read;
                try { read = source.read(total, window); }
                catch (OwnedDocumentWriter.Failure failure) {
                    throw new Failure(failure.code(), failure.getMessage());
                }
                if (read <= 0 || read > wanted) throw corrupt();
                ByteBuffer buffer = ByteBuffer.wrap(window, 0, read);
                while (buffer.hasRemaining()) output.write(buffer);
                digest.update(window, 0, read);
                total += read;
            }
            output.force(true);
        }
        fsyncDirectory(target.getParent());
        return new Snapshot(total, hex(digest.digest()));
    }

    /**
     * A share copy only has to outlive the hand-off to the receiving app. When the bounded
     * staging area is full, the oldest finished copies make room; otherwise every share after
     * the eighth failed until the first copy expired a day later.
     */
    private static void makeRoom(Layout layout, List<StageRecord> records, long incoming)
            throws IOException, Failure {
        ArrayList<StageRecord> oldestFirst = new ArrayList<>(records);
        oldestFirst.sort(Comparator.comparingLong(StageRecord::createdAt)
                .thenComparing(StageRecord::token));
        int count = oldestFirst.size();
        long retained = 0;
        for (StageRecord record : oldestFirst) retained += record.size;
        boolean removed = false;
        for (StageRecord record : oldestFirst) {
            if (count < MAXIMUM_RETAINED_STAGES
                    && retained <= MAXIMUM_RETAINED_BYTES - incoming) break;
            deleteStageFiles(layout, record);
            deleteExact(layout.metadata(record.token));
            count--;
            retained -= record.size;
            removed = true;
        }
        if (removed) fsyncDirectory(layout.root);
        if (count >= MAXIMUM_RETAINED_STAGES
                || retained > MAXIMUM_RETAINED_BYTES - incoming) throw limit();
    }

    private void cleanupPreparing(Layout layout) {
        try {
            for (StageRecord record : readRecords(layout)) {
                if (!record.complete) {
                    deleteStageFiles(layout, record);
                    deleteExact(layout.metadata(record.token));
                    return;
                }
            }
        } catch (IOException | Failure ignored) { }
    }

    private long now() throws Failure {
        long value = clock.nowMillis();
        if (value < 0) throw unsafe();
        return value;
    }

    private String validToken() throws Failure {
        String value = tokens.next();
        if (value == null || !value.matches("[A-Za-z0-9_-]{22,64}")) throw unsafe();
        return value;
    }

    private static byte[] encode(StageRecord record) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(MAGIC); output.writeInt(VERSION);
            writeAscii(output, record.token); writeAscii(output, record.mimeType);
            output.writeLong(record.size); output.writeLong(record.createdAt);
            output.writeBoolean(record.complete); output.writeBoolean(record.dispatched);
            output.writeBoolean(record.hash != null);
            if (record.hash != null) writeAscii(output, record.hash);
            output.writeInt(record.itemCount);
            output.writeBoolean(record.collection);
        }
        byte[] result = bytes.toByteArray();
        if (result.length > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        return result;
    }

    private static StageRecord decode(byte[] bytes) throws IOException {
        if (bytes.length == 0 || bytes.length > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (input.readInt() != MAGIC) throw new IOException("record");
            int version = input.readInt();
            if (version != LEGACY_VERSION && version != VERSION) throw new IOException("record");
            StageRecord result = new StageRecord(readAscii(input, 64), readAscii(input, 128),
                    input.readLong(), input.readLong(), input.readBoolean(), input.readBoolean(),
                    input.readBoolean() ? readAscii(input, 64) : null,
                    version == LEGACY_VERSION ? 1 : input.readInt(),
                    version != LEGACY_VERSION && input.readBoolean());
            if (input.read() != -1 || result.size <= 0
                    || result.size > OwnedDocumentWriter.MAXIMUM_FILE_BYTES || result.createdAt < 0
                    || !(OwnedDocumentWritePolicy.isSupportedMimeType(result.mimeType)
                        || (result.collection && "image/*".equals(result.mimeType)))
                    || result.itemCount < 1
                    || result.itemCount > LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_ITEMS
                    || (!result.collection && result.itemCount != 1)
                    || (result.complete && (result.hash == null || !result.hash.matches("[0-9a-f]{64}")))) {
                throw new IOException("record");
            }
            return result;
        } catch (EOFException failure) { throw new IOException("record", failure); }
    }

    private static void writeAscii(DataOutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        if (bytes.length > 255 || !value.equals(new String(bytes,
                java.nio.charset.StandardCharsets.US_ASCII))) throw new IOException("field");
        output.writeByte(bytes.length); output.write(bytes);
    }

    private static String readAscii(DataInputStream input, int maximum) throws IOException {
        int size = input.readUnsignedByte();
        if (size > maximum) throw new IOException("field");
        byte[] bytes = new byte[size];
        input.readFully(bytes);
        return new String(bytes, java.nio.charset.StandardCharsets.US_ASCII);
    }

    private static byte[] readRecord(Path path) throws IOException {
        requireRegular(path, -1);
        if (Files.size(path) <= 0 || Files.size(path) > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        return Files.readAllBytes(path);
    }

    private static void publish(Path target, StageRecord record) throws IOException {
        Path temp = direct(target.getParent(), target.getFileName() + ".tmp");
        deleteExact(temp);
        byte[] bytes = encode(record);
        try (FileChannel output = FileChannel.open(temp,
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) output.write(buffer);
            output.force(true);
        }
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException failure) {
            deleteExact(temp); throw failure;
        }
    }

    private static void atomicMoveNew(Path source, Path target) throws IOException {
        Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
    }

    private static void requireRegular(Path path, long expected) throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || (expected >= 0 && Files.size(path) != expected)) throw new IOException("unsafe");
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

    private static void validatePreparingFiles(Layout layout, StageRecord record)
            throws IOException {
        if (!record.collection) {
            Path part = layout.part(record.token);
            if (Files.exists(part, LinkOption.NOFOLLOW_LINKS)) requireRegular(part, -1);
            return;
        }
        for (int index = 0; index < record.itemCount; index++) {
            Path part = layout.collectionPart(record.token, index);
            Path data = layout.findCollectionData(record.token, index);
            if (Files.exists(part, LinkOption.NOFOLLOW_LINKS)) requireRegular(part, -1);
            if (data != null) requireRegular(data, -1);
        }
    }

    private static void validateCompletedFiles(Layout layout, StageRecord record)
            throws IOException {
        if (!record.collection) {
            existingSingleData(layout, record);
            return;
        }
        long total = 0;
        MessageDigest aggregate = sha256();
        for (int index = 0; index < record.itemCount; index++) {
            Path path = layout.collectionData(record.token, index);
            requireRegular(path, -1);
            long size = Files.size(path);
            if (size <= 0 || total > record.size - size) throw new IOException("stage");
            total += size;
            Snapshot snapshot = digest(path);
            updateAggregate(aggregate, snapshot, null);
        }
        if (total != record.size || !hex(aggregate.digest()).equals(record.hash)) {
            throw new IOException("stage");
        }
    }

    private static void deleteStageFiles(Layout layout, StageRecord record) throws IOException {
        if (!record.collection) {
            deleteExact(layout.part(record.token));
            deleteExact(layout.data(record.token, record.mimeType));
            deleteExact(layout.legacyData(record.token));
            return;
        }
        for (int index = 0; index < record.itemCount; index++) {
            deleteExact(layout.collectionPart(record.token, index));
            deleteExact(layout.findCollectionData(record.token, index));
        }
    }

    private static Snapshot digest(Path path) throws IOException {
        MessageDigest digest = sha256();
        long total = 0;
        byte[] bytes = new byte[64 * 1024];
        try (FileChannel input = FileChannel.open(path, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (true) {
                buffer.clear();
                int read = input.read(buffer);
                if (read < 0) break;
                if (read == 0) continue;
                digest.update(bytes, 0, read); total += read;
            }
        }
        return new Snapshot(total, hex(digest.digest()));
    }

    private static void updateAggregate(MessageDigest aggregate, Snapshot snapshot,
            String mimeType) {
        aggregate.update(snapshot.hash.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        aggregate.update(ByteBuffer.allocate(Long.BYTES).putLong(snapshot.size).array());
    }

    private static String collectionFileName(String token, int index) {
        return token + "-" + String.format(Locale.ROOT, "%03d", index) + ".bin";
    }

    private static Path existingSingleData(Layout layout, StageRecord record) throws IOException {
        Path typed = layout.data(record.token, record.mimeType);
        Path legacy = layout.legacyData(record.token);
        boolean typedExists = Files.exists(typed, LinkOption.NOFOLLOW_LINKS);
        boolean legacyExists = Files.exists(legacy, LinkOption.NOFOLLOW_LINKS);
        if (typedExists == legacyExists) throw new IOException("unsafe");
        Path result = typedExists ? typed : legacy;
        requireRegular(result, record.size);
        return result;
    }

    private static String extensionForMime(String mimeType) throws IOException {
        if (OwnedDocumentWritePolicy.MIME_PDF.equals(mimeType)) return ".pdf";
        if (OwnedDocumentWritePolicy.MIME_ZIP.equals(mimeType)) return ".zip";
        if (OwnedDocumentWritePolicy.MIME_TEXT.equals(mimeType)) return ".txt";
        if (OwnedDocumentWritePolicy.MIME_JPEG.equals(mimeType)) return ".jpg";
        if (OwnedDocumentWritePolicy.MIME_PNG.equals(mimeType)) return ".png";
        if (OwnedDocumentWritePolicy.MIME_WEBP.equals(mimeType)) return ".webp";
        if (OwnedDocumentWritePolicy.MIME_HEIC.equals(mimeType)) return ".heic";
        if (OwnedDocumentWritePolicy.MIME_DOCX.equals(mimeType)) return ".docx";
        if (OwnedDocumentWritePolicy.MIME_PPTX.equals(mimeType)) return ".pptx";
        throw new IOException("mime");
    }

    private static MessageDigest sha256() throws IOException {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private static void checkCancelled(OwnedPendingImportStore.CancellationSignal signal)
            throws Failure {
        if (Thread.currentThread().isInterrupted() || signal.isCancelled()) throw cancelled();
    }

    private static OwnedDocumentWriter.TokenSource secureTokens() {
        SecureRandom random = new SecureRandom();
        return () -> {
            byte[] bytes = new byte[18]; random.nextBytes(bytes);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        };
    }

    static final class Stage {
        private final String token; final String mimeType; final long sizeBytes; final String hash;
        private final List<StageItem> items;
        private final boolean collection;
        Stage(String token, String mimeType, long sizeBytes, String hash,
                List<StageItem> items, boolean collection) {
            this.token = token; this.mimeType = mimeType; this.sizeBytes = sizeBytes;
            this.hash = hash; this.items = items; this.collection = collection;
        }
        String tokenForTests() { return token; }
        private boolean matches(StageRecord record) {
            return token.equals(record.token) && mimeType.equals(record.mimeType)
                    && sizeBytes == record.size && hash.equals(record.hash)
                    && items.size() == record.itemCount && collection == record.collection;
        }
    }

    static final class StageItem {
        final int index; final String displayName; final String mimeType;
        final long size; final String hash;
        StageItem(int index, String displayName, String mimeType, long size, String hash) {
            this.index = index; this.displayName = displayName; this.mimeType = mimeType;
            this.size = size; this.hash = hash;
        }
    }

    static final class Failure extends Exception {
        private final String code;
        Failure(String code, String message) { super(message); this.code = code; }
        String code() { return code; }
    }

    @FunctionalInterface interface FaultInjector { void checkpoint(Checkpoint checkpoint) throws IOException; }
    enum Checkpoint { AFTER_PREPARING_RECORD, AFTER_STAGE_MOVE, AFTER_STAGE_RECORD }
    private record Snapshot(long size, String hash) { }
    private record StageRecord(String token, String mimeType, long size, long createdAt,
            boolean complete, boolean dispatched, String hash, int itemCount,
            boolean collection) {
        StageRecord completed(String value) { return new StageRecord(token, mimeType, size,
                createdAt, true, false, value, itemCount, collection); }
        StageRecord asDispatched() { return new StageRecord(token, mimeType, size,
                createdAt, complete, true, hash, itemCount, collection); }
    }

    private static final class Layout {
        final Path root;
        Layout(Path root) { this.root = root; }
        static Layout prepare(Path filesDir) throws IOException {
            Path files = existing(filesDir);
            Path documents = ensure(files, "pdfchef_documents");
            return new Layout(ensure(documents, "share"));
        }
        Path metadata(String token) throws IOException { return direct(root, token + ".share"); }
        Path part(String token) throws IOException { return direct(root, token + ".part"); }
        Path data(String token, String mimeType) throws IOException {
            return direct(root, token + extensionForMime(mimeType));
        }
        Path legacyData(String token) throws IOException { return direct(root, token + ".bin"); }
        Path collectionPart(String token, int index) throws IOException {
            return direct(root, collectionFileName(token, index) + ".part");
        }
        Path collectionData(String token, int index) throws IOException {
            Path path = findCollectionData(token, index);
            if (path == null) throw new IOException("missing collection item");
            return path;
        }
        Path collectionData(String token, int index, String mimeType) throws IOException {
            return direct(root, token + "-" + String.format(Locale.ROOT, "%03d", index)
                    + extensionForMime(mimeType));
        }
        Path findCollectionData(String token, int index) throws IOException {
            // Older in-flight shares used .bin. Preserve their granted URIs until expiry,
            // while new shares expose the actual MIME through FileProvider's extension lookup.
            String stem = token + "-" + String.format(Locale.ROOT, "%03d", index);
            Path found = null;
            for (String extension : List.of(".bin", ".pdf", ".zip", ".txt", ".jpg",
                    ".png", ".webp", ".heic", ".docx", ".pptx")) {
                Path candidate = direct(root, stem + extension);
                if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) continue;
                requireRegular(candidate, -1);
                if (found != null) throw new IOException("ambiguous collection item");
                found = candidate;
            }
            return found;
        }
        private static Path existing(Path path) throws IOException {
            if (Files.isSymbolicLink(path) || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("unsafe");
            }
            return path.toRealPath(LinkOption.NOFOLLOW_LINKS);
        }
        private static Path ensure(Path parent, String name) throws IOException {
            Path child = direct(parent, name);
            if (!Files.exists(child, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(child); fsyncDirectory(parent);
            }
            return existing(child);
        }
    }

    private static Failure invalid() { return new Failure("DOCUMENT_INVALID_ARGUMENT", "The document request is invalid."); }
    private static Failure notFound() { return new Failure("DOCUMENT_NOT_FOUND", "The document is unavailable."); }
    private static Failure busy() { return new Failure("DOCUMENT_LIMIT_EXCEEDED", "A share preparation is already active."); }
    private static Failure limit() { return new Failure("DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded."); }
    private static Failure storageFull() { return new Failure("DOCUMENT_STORAGE_FULL", "There is not enough storage."); }
    private static Failure cancelled() { return new Failure("DOCUMENT_CANCELLED", "The document operation was cancelled."); }
    private static Failure corrupt() { return new Failure("DOCUMENT_CORRUPT", "The document could not be validated."); }
    private static Failure unsafe() { return new Failure("DOCUMENT_UNSAFE_STATE", "The document state is unavailable."); }
    private static Failure failed() { return new Failure("DOCUMENT_FAILED", "The document operation failed."); }
}
