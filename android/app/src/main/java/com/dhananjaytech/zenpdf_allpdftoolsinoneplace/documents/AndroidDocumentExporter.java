package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.FileOutputStream;
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
import java.util.Base64;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/** Inactive MediaStore exporter. Provider rows are private recovery data and never returned. */
final class AndroidDocumentExporter {
    static final long INCOMPLETE_EXPIRY_MILLIS = 30L * 60L * 1000L;
    static final long COMPLETED_EXPIRY_MILLIS = 24L * 60L * 60L * 1000L;
    private static final int MAGIC = 0x50444531; // PDE1
    private static final int VERSION = 1;
    private static final int MAXIMUM_RECORD_BYTES = 1024;
    private static final String RECORD_NAME = "current.export";

    private final Path filesDir;
    private final Destination destination;
    private final OwnedDocumentWriter.Clock clock;
    private final OwnedDocumentWriter.TokenSource tokens;
    private final OwnedDocumentWriter.StorageProbe storageProbe;
    private final FaultInjector faults;

    AndroidDocumentExporter(Context context) {
        this(Objects.requireNonNull(context).getApplicationContext().getFilesDir().toPath(),
                new MediaStoreDestination(context.getApplicationContext().getContentResolver()),
                System::currentTimeMillis, secureTokens(),
                ignored -> context.getApplicationContext().getFilesDir().getUsableSpace(),
                ignored -> {});
    }

    AndroidDocumentExporter(Path filesDir, Destination destination,
            OwnedDocumentWriter.Clock clock, OwnedDocumentWriter.TokenSource tokens,
            OwnedDocumentWriter.StorageProbe storageProbe, FaultInjector faults) {
        this.filesDir = Objects.requireNonNull(filesDir).toAbsolutePath().normalize();
        this.destination = Objects.requireNonNull(destination);
        this.clock = Objects.requireNonNull(clock);
        this.tokens = Objects.requireNonNull(tokens);
        this.storageProbe = Objects.requireNonNull(storageProbe);
        this.faults = Objects.requireNonNull(faults);
    }

    Result export(OwnedDocumentWriter.DocumentSource source, String displayName, String mimeType,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        return exportOne(source, displayName, mimeType, cancellation,
                MediaTarget.DOWNLOADS, null);
    }

    Result exportCollection(LegacyDocumentOpenResolver.CollectionSource collection,
            String displayName, OwnedPendingImportStore.CancellationSignal cancellation)
            throws Failure {
        if (collection == null || cancellation == null || displayName == null
                || displayName.isBlank() || displayName.length() > 180
                || displayName.indexOf('\0') >= 0 || displayName.contains("/")
                || displayName.contains("\\")) throw invalid();
        ArrayList<Result> completed = new ArrayList<>();
        try {
            collection.validateUnchanged();
            if (collection.itemCount() < 1
                    || collection.itemCount() > LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_ITEMS
                    || collection.totalBytes() <= 0
                    || collection.totalBytes()
                    > LegacyDocumentOpenResolver.MAXIMUM_COLLECTION_BYTES) throw invalid();
            MediaTarget target = collection.imageCollection()
                    ? MediaTarget.PICTURES : MediaTarget.DOWNLOADS;
            for (LegacyDocumentOpenResolver.CollectionItem item : collection.items()) {
                checkCancelled(cancellation);
                collection.validateUnchanged();
                try (OwnedDocumentWriter.DocumentSource source = item.openSource()) {
                    completed.add(exportOne(source, item.displayName(), item.mimeType(),
                            cancellation, target, displayName));
                }
            }
            collection.validateUnchanged();
            return Result.collectionCompleted(completed.size());
        } catch (LegacyDocumentOpenResolver.Failure failure) {
            rollbackCompleted(completed);
            String code = failure.code().startsWith("LEGACY_")
                    ? failure.code().substring("LEGACY_".length()) : failure.code();
            throw new Failure(code, failure.getMessage());
        } catch (Failure failure) {
            rollbackCompleted(completed);
            throw failure;
        }
    }

    private Result exportOne(OwnedDocumentWriter.DocumentSource source, String displayName,
            String mimeType, OwnedPendingImportStore.CancellationSignal cancellation,
            MediaTarget target, String containerName) throws Failure {
        validate(source, displayName, mimeType, cancellation);
        Layout layout = prepare();
        recoverOne(layout);
        Path recordPath;
        String token = "pdfchef-" + validToken();
        long now = now();
        ExportRecord record = new ExportRecord(token, displayName, mimeType, now,
                null, false, false);
        Path snapshot;
        try {
            recordPath = layout.record();
            snapshot = layout.snapshot(token);
        } catch (IOException failure) { throw unsafe(); }
        if (Files.exists(recordPath, LinkOption.NOFOLLOW_LINKS)) throw busy();
        String address = null;
        try {
            long required = source.sizeBytes() + OwnedDocumentWriter.STORAGE_RESERVE_BYTES;
            if (source.sizeBytes() <= 0 || source.sizeBytes() > OwnedDocumentWriter.MAXIMUM_FILE_BYTES) {
                throw invalid();
            }
            if (storageProbe.availableBytes(required) < required) throw storageFull();
            Snapshot copied = copySnapshot(source, snapshot, cancellation);
            publishRecord(recordPath, record);
            fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_ALLOCATING_INTENT);
            address = destination.allocate(token, mimeType, target, containerName);
            record = record.withAddress(address);
            publishRecord(recordPath, record);
            fsyncDirectory(layout.root);
            faults.checkpoint(Checkpoint.AFTER_PENDING_ROW);
            copyToDestination(snapshot, copied.size, copied.hash, address, cancellation);
            faults.checkpoint(Checkpoint.AFTER_DESTINATION_FORCE);
            destination.publish(address, displayName, mimeType, copied.size);
            faults.checkpoint(Checkpoint.AFTER_PUBLICATION);
            record = record.asCompleted();
            publishRecord(recordPath, record);
            fsyncDirectory(layout.root);
            archiveCompleted(layout, record);
            deleteExact(snapshot);
            return Result.completed(token, address);
        } catch (Failure failure) {
            rollbackIfPositivelyPending(token, address, snapshot, recordPath);
            throw failure;
        } catch (IOException | RuntimeException failure) {
            rollbackIfPositivelyPending(token, address, snapshot, recordPath);
            throw failed();
        }
    }

    private void rollbackCompleted(List<Result> completed) throws Failure {
        for (int index = completed.size() - 1; index >= 0; index--) {
            Result result = completed.get(index);
            try {
                destination.deleteAddress(result.address);
                Layout layout = prepare();
                deleteExact(layout.completed(result.token));
                fsyncDirectory(layout.root);
            } catch (IOException | RuntimeException failure) {
                throw durabilityUncertain();
            }
        }
    }

    private void recoverOne(Layout layout) throws Failure {
        cleanupOneCompleted(layout);
        Path recordPath;
        try { recordPath = layout.record(); }
        catch (IOException failure) { throw unsafe(); }
        if (!Files.exists(recordPath, LinkOption.NOFOLLOW_LINKS)) return;
        ExportRecord record;
        try {
            record = decode(readRecord(recordPath));
            long age = now() - record.createdAt;
            if (record.completed) {
                archiveCompleted(layout, record);
                deleteExact(layout.snapshot(record.token));
                return;
            }
            if (record.address != null) {
                PublicationState state = probe(record.address);
                if (state == PublicationState.PUBLISHED) {
                    ExportRecord completed = record.asCompleted();
                    publishRecord(recordPath, completed);
                    fsyncDirectory(layout.root);
                    archiveCompleted(layout, completed);
                    deleteExact(layout.snapshot(record.token));
                    return;
                }
                if (state == PublicationState.UNKNOWN) throw durabilityUncertain();
            }
            if (age < INCOMPLETE_EXPIRY_MILLIS) return;
            rollbackPositivelyPending(record.token, record.address);
            deleteExact(layout.snapshot(record.token));
            deleteExact(recordPath);
            fsyncDirectory(layout.root);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw unsafe();
        }
    }

    private void cleanupOneCompleted(Layout layout) throws Failure {
        try {
            Path candidate = null;
            try (var stream = Files.list(layout.root)) {
                candidate = stream.filter(path -> path.getFileName().toString().endsWith(".completed"))
                        .sorted().findFirst().orElse(null);
            }
            if (candidate == null) return;
            ExportRecord record = decode(readRecord(candidate));
            if (!record.completed) throw unsafe();
            if (now() - record.createdAt >= COMPLETED_EXPIRY_MILLIS) {
                deleteExact(candidate);
                fsyncDirectory(layout.root);
            }
        } catch (Failure failure) { throw failure; }
        catch (IOException | RuntimeException failure) { throw unsafe(); }
    }

    private static void archiveCompleted(Layout layout, ExportRecord record) throws IOException {
        Path current = layout.record();
        Path completed = layout.completed(record.token);
        if (Files.exists(completed, LinkOption.NOFOLLOW_LINKS)) {
            deleteExact(current);
            return;
        }
        Files.move(current, completed, StandardCopyOption.ATOMIC_MOVE);
        fsyncDirectory(layout.root);
    }

    private Snapshot copySnapshot(OwnedDocumentWriter.DocumentSource source, Path target,
            OwnedPendingImportStore.CancellationSignal cancellation) throws IOException, Failure {
        deleteExact(target);
        MessageDigest digest = sha256();
        long total = 0;
        byte[] bytes = new byte[64 * 1024];
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
        if (total != source.sizeBytes()) throw corrupt();
        fsyncDirectory(target.getParent());
        return new Snapshot(total, hex(digest.digest()));
    }

    private void copyToDestination(Path snapshot, long expectedSize, String expectedHash,
            String address, OwnedPendingImportStore.CancellationSignal cancellation)
            throws IOException, Failure {
        requireRegular(snapshot, expectedSize);
        MessageDigest digest = sha256();
        long total = 0;
        byte[] bytes = new byte[64 * 1024];
        try (FileChannel input = FileChannel.open(snapshot, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS);
             Destination.Output output = destination.open(address)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (true) {
                checkCancelled(cancellation);
                buffer.clear();
                int read = input.read(buffer);
                if (read < 0) break;
                if (read == 0) continue;
                output.write(bytes, 0, read);
                digest.update(bytes, 0, read);
                total += read;
                if (total > expectedSize) throw corrupt();
            }
            output.force();
        }
        if (total != expectedSize || !hex(digest.digest()).equals(expectedHash)) throw corrupt();
    }

    private void rollbackIfPositivelyPending(String token, String address, Path snapshot,
            Path recordPath) throws Failure {
        if (address != null && probe(address) != PublicationState.PENDING) {
            throw durabilityUncertain();
        }
        rollbackPositivelyPending(token, address);
        deleteExact(snapshot);
        deleteExact(recordPath);
    }

    private PublicationState probe(String address) {
        try {
            PublicationState state = destination.publicationState(address);
            return state == null ? PublicationState.UNKNOWN : state;
        } catch (IOException | RuntimeException failure) {
            return PublicationState.UNKNOWN;
        }
    }

    private void rollbackPositivelyPending(String token, String address) throws Failure {
        try {
            if (address != null) {
                if (destination.publicationState(address) != PublicationState.PENDING) {
                    throw durabilityUncertain();
                }
                destination.deleteAddress(address);
            } else {
                destination.deletePendingToken(token);
            }
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | RuntimeException failure) {
            throw durabilityUncertain();
        }
    }

    private Layout prepare() throws Failure {
        try { return Layout.prepare(filesDir); }
        catch (IOException | RuntimeException failure) { throw unsafe(); }
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

    private static void validate(OwnedDocumentWriter.DocumentSource source, String displayName,
            String mimeType, OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (source == null || cancellation == null || displayName == null || displayName.isBlank()
                || displayName.length() > 180 || displayName.indexOf('\0') >= 0
                || displayName.contains("/") || displayName.contains("\\")
                || mimeType == null || !mimeType.equals(source.mimeType())
                || !OwnedDocumentWritePolicy.isSupportedMimeType(mimeType)) throw invalid();
    }

    private static byte[] encode(ExportRecord value) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(MAGIC); output.writeInt(VERSION);
            writeUtf(output, value.token, 80); writeUtf(output, value.displayName, 360);
            writeUtf(output, value.mimeType, 128); output.writeLong(value.createdAt);
            output.writeBoolean(value.address != null);
            if (value.address != null) writeUtf(output, value.address, 360);
            output.writeBoolean(value.completed); output.writeBoolean(value.durabilityUncertain);
        }
        byte[] result = bytes.toByteArray();
        if (result.length > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        return result;
    }

    private static ExportRecord decode(byte[] bytes) throws IOException {
        if (bytes.length == 0 || bytes.length > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (input.readInt() != MAGIC || input.readInt() != VERSION) throw new IOException("record");
            String token = readUtf(input, 80); String name = readUtf(input, 360);
            String mime = readUtf(input, 128); long created = input.readLong();
            String address = input.readBoolean() ? readUtf(input, 360) : null;
            ExportRecord result = new ExportRecord(token, name, mime, created, address,
                    input.readBoolean(), input.readBoolean());
            if (input.read() != -1 || created < 0) throw new IOException("record");
            return result;
        } catch (EOFException failure) { throw new IOException("record", failure); }
    }

    private static void writeUtf(DataOutputStream output, String value, int maximum)
            throws IOException {
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > maximum) throw new IOException("field");
        output.writeShort(bytes.length); output.write(bytes);
    }

    private static String readUtf(DataInputStream input, int maximum) throws IOException {
        int size = input.readUnsignedShort();
        if (size > maximum) throw new IOException("field");
        byte[] bytes = new byte[size];
        input.readFully(bytes);
        return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static byte[] readRecord(Path path) throws IOException {
        requireRegular(path, -1);
        if (Files.size(path) <= 0 || Files.size(path) > MAXIMUM_RECORD_BYTES) throw new IOException("record");
        return Files.readAllBytes(path);
    }

    private static void publishRecord(Path target, ExportRecord record) throws IOException {
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

    static final class Result {
        private final boolean completed;
        private final String token;
        private final String address;
        private final int itemCount;
        private Result(boolean completed, String token, String address, int itemCount) {
            this.completed = completed; this.token = token; this.address = address;
            this.itemCount = itemCount;
        }
        static Result completed(String token, String address) {
            return new Result(true, token, address, 1);
        }
        static Result collectionCompleted(int itemCount) {
            return new Result(true, null, null, itemCount);
        }
        boolean completedValue() { return completed; }
        int itemCount() { return itemCount; }
    }

    static final class Failure extends Exception {
        private final String code;
        Failure(String code, String message) { super(message); this.code = code; }
        String code() { return code; }
    }

    interface Destination {
        String allocate(String token, String mimeType) throws IOException;
        default String allocate(String token, String mimeType, MediaTarget target,
                String containerName) throws IOException {
            return allocate(token, mimeType);
        }
        Output open(String address) throws IOException;
        void publish(String address, String displayName, String mimeType, long size) throws IOException;
        PublicationState publicationState(String address) throws IOException;
        void deleteAddress(String address) throws IOException;
        void deletePendingToken(String token) throws IOException;

        interface Output extends AutoCloseable {
            void write(byte[] bytes, int offset, int length) throws IOException;
            void force() throws IOException;
            @Override void close() throws IOException;
        }
    }

    enum PublicationState { PENDING, PUBLISHED, UNKNOWN }
    enum MediaTarget { DOWNLOADS, PICTURES }

    static final class MediaStoreDestination implements Destination {
        private final ContentResolver resolver;
        MediaStoreDestination(ContentResolver resolver) { this.resolver = resolver; }
        @Override public String allocate(String token, String mimeType) throws IOException {
            return allocate(token, mimeType, MediaTarget.DOWNLOADS, "PDF Chef");
        }
        @Override public String allocate(String token, String mimeType, MediaTarget target,
                String containerName) throws IOException {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, token);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            String relative = (target == MediaTarget.PICTURES ? Environment.DIRECTORY_PICTURES
                    : Environment.DIRECTORY_DOWNLOADS) + "/PDF Chef";
            if (containerName != null) relative += "/" + containerName;
            values.put(MediaStore.Downloads.RELATIVE_PATH, relative);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri collection = target == MediaTarget.PICTURES
                    ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            Uri uri = resolver.insert(collection, values);
            if (uri == null) throw new IOException("insert");
            return uri.toString();
        }
        @Override public Output open(String address) throws IOException {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(Uri.parse(address), "w");
            if (descriptor == null) throw new IOException("open");
            FileOutputStream stream = new FileOutputStream(descriptor.getFileDescriptor());
            return new Output() {
                @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                    stream.write(bytes, offset, length);
                }
                @Override public void force() throws IOException { stream.getFD().sync(); }
                @Override public void close() throws IOException {
                    try { stream.close(); } finally { descriptor.close(); }
                }
            };
        }
        @Override public void publish(String address, String displayName, String mimeType, long size)
                throws IOException {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            if (resolver.update(Uri.parse(address), values, null, null) != 1) throw new IOException("publish");
            try (Cursor cursor = resolver.query(Uri.parse(address),
                    new String[] {MediaStore.Downloads.SIZE, MediaStore.Downloads.IS_PENDING},
                    null, null, null)) {
                if (cursor == null || !cursor.moveToFirst() || cursor.getLong(0) != size
                        || cursor.getInt(1) != 0) throw new IOException("verify");
            }
        }
        @Override public PublicationState publicationState(String address) throws IOException {
            try (Cursor cursor = resolver.query(Uri.parse(address),
                    new String[] {MediaStore.Downloads.IS_PENDING}, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) return PublicationState.UNKNOWN;
                int value = cursor.getInt(0);
                if (value == 1) return PublicationState.PENDING;
                if (value == 0) return PublicationState.PUBLISHED;
                return PublicationState.UNKNOWN;
            }
        }
        @Override public void deleteAddress(String address) throws IOException {
            if (resolver.delete(Uri.parse(address), null, null) != 1) {
                throw new IOException("delete");
            }
        }
        @Override public void deletePendingToken(String token) throws IOException {
            String selection = MediaStore.Downloads.DISPLAY_NAME + "=? AND "
                    + MediaStore.Downloads.IS_PENDING + "=1";
            resolver.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    selection, new String[] {token});
        }
    }

    @FunctionalInterface interface FaultInjector { void checkpoint(Checkpoint checkpoint) throws IOException; }
    enum Checkpoint { AFTER_ALLOCATING_INTENT, AFTER_PENDING_ROW, AFTER_DESTINATION_FORCE, AFTER_PUBLICATION }
    private record Snapshot(long size, String hash) { }
    private record ExportRecord(String token, String displayName, String mimeType, long createdAt,
            String address, boolean completed, boolean durabilityUncertain) {
        ExportRecord withAddress(String value) { return new ExportRecord(token, displayName,
                mimeType, createdAt, value, completed, durabilityUncertain); }
        ExportRecord asCompleted() { return new ExportRecord(token, displayName, mimeType,
                createdAt, address, true, false); }
    }

    private static final class Layout {
        final Path root;
        Layout(Path root) { this.root = root; }
        static Layout prepare(Path filesDir) throws IOException {
            Path files = existing(filesDir);
            Path documents = ensure(files, "pdfchef_documents");
            return new Layout(ensure(documents, "export"));
        }
        Path record() throws IOException { return direct(root, RECORD_NAME); }
        Path snapshot(String token) throws IOException { return direct(root, token + ".snapshot"); }
        Path completed(String token) throws IOException { return direct(root, token + ".completed"); }
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
    private static Failure busy() { return new Failure("DOCUMENT_LIMIT_EXCEEDED", "A document export is already active."); }
    private static Failure storageFull() { return new Failure("DOCUMENT_STORAGE_FULL", "There is not enough storage."); }
    private static Failure cancelled() { return new Failure("DOCUMENT_CANCELLED", "The document operation was cancelled."); }
    private static Failure corrupt() { return new Failure("DOCUMENT_CORRUPT", "The document could not be validated."); }
    private static Failure unsafe() { return new Failure("DOCUMENT_UNSAFE_STATE", "The document state is unavailable."); }
    private static Failure durabilityUncertain() { return new Failure("DOCUMENT_DURABILITY_UNCERTAIN", "The export may already be complete."); }
    private static Failure failed() { return new Failure("DOCUMENT_FAILED", "The document operation failed."); }
}
