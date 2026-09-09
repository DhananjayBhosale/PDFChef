package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.net.Uri;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/** One private, immutable PDF snapshot owned by a single native reader Activity. */
public final class PdfReaderDocumentSession implements AutoCloseable {
    static final int MAXIMUM_SESSIONS = 4;
    static final long MAXIMUM_RETAINED_BYTES = 256L * 1024L * 1024L;
    static final long SESSION_EXPIRY_MILLIS = 24L * 60L * 60L * 1000L;
    static final long STORAGE_RESERVE_BYTES = 1024L * 1024L;
    static final int COPY_CHUNK_BYTES = 512 * 1024;
    static final int RECOVERY_BATCH_LIMIT = MAXIMUM_SESSIONS * 2 + 1;
    private static final long MAXIMUM_DOCUMENT_BYTES = 128L * 1024L * 1024L;
    private static final String MIME_PDF = "application/pdf";
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{22,64}");
    private static final Pattern SNAPSHOT = Pattern.compile("r1_[A-Za-z0-9_-]{22,64}\\.pdf");
    private static final Pattern PART = Pattern.compile("r1_[A-Za-z0-9_-]{22,64}\\.part");

    private final String ref;
    private final String displayName;
    private final long sizeBytes;
    private final Path snapshot;
    private final FaultInjector faults;
    private boolean closed;

    private PdfReaderDocumentSession(String ref, String displayName, long sizeBytes,
            Path snapshot, FaultInjector faults) {
        this.ref = ref;
        this.displayName = displayName;
        this.sizeBytes = sizeBytes;
        this.snapshot = snapshot;
        this.faults = faults;
    }

    /** Native-only source contract; it never carries an address across the Capacitor bridge. */
    public interface Source {
        String mimeType();
        long sizeBytes();
        int read(long offset, byte[] target) throws Exception;
    }

    /** Called only by DocumentLifecycleCoordinator after opaque-ref resolution. */
    public static PdfReaderDocumentSession prepareForCoordinator(Path filesDir, String ref,
            String displayName, Source source) throws Failure {
        return prepare(filesDir, ref, displayName, source, System::currentTimeMillis,
                secureTokens(), required -> filesDir.toFile().getUsableSpace());
    }

    static PdfReaderDocumentSession prepare(Path filesDir, String ref, String displayName,
            Source source, Clock clock, TokenSource tokens, StorageProbe storage) throws Failure {
        return prepare(filesDir, ref, displayName, source, clock, tokens, storage,
                ignored -> {});
    }

    static PdfReaderDocumentSession prepare(Path filesDir, String ref, String displayName,
            Source source, Clock clock, TokenSource tokens, StorageProbe storage,
            FaultInjector faults) throws Failure {
        if (filesDir == null || source == null || clock == null || tokens == null
                || storage == null || faults == null
                || !PdfReaderLaunchContract.isCanonicalRef(ref)
                || !PdfReaderLaunchContract.isSafeDisplayName(displayName)
                || !MIME_PDF.equals(source.mimeType()) || source.sizeBytes() <= 0
                || source.sizeBytes() > MAXIMUM_DOCUMENT_BYTES) {
            throw invalid();
        }
        Path part = null;
        Path complete = null;
        try {
            long now = clock.nowMillis();
            if (now < 0) throw unsafe();
            throwIfInterrupted();
            Path root = prepareRoot(filesDir);
            List<Path> retained = recoverAndList(root, now, faults);
            long aggregate = 0;
            for (Path path : retained) {
                long size = attributes(path).size();
                if (aggregate > MAXIMUM_RETAINED_BYTES - size) throw unsafe();
                aggregate += size;
            }
            if (retained.size() >= MAXIMUM_SESSIONS
                    || aggregate > MAXIMUM_RETAINED_BYTES - source.sizeBytes()) throw limit();
            long required = source.sizeBytes() + STORAGE_RESERVE_BYTES;
            if (storage.availableBytes(required) < required) throw storageFull();

            String token = tokens.next();
            if (token == null || !TOKEN.matcher(token).matches()) throw unsafe();
            part = direct(root, "r1_" + token + ".part");
            complete = direct(root, "r1_" + token + ".pdf");
            if (Files.exists(part, LinkOption.NOFOLLOW_LINKS)
                    || Files.exists(complete, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
            copyOnce(source, part);
            makeReadOnly(part);
            fsyncFile(part);
            if (!isReadOnly(part)) throw unsafe();
            faults.checkpoint(Checkpoint.BEFORE_ATOMIC_PUBLISH);
            throwIfInterrupted();
            Files.move(part, complete, StandardCopyOption.ATOMIC_MOVE);
            faults.checkpoint(Checkpoint.AFTER_ATOMIC_PUBLISH);
            throwIfInterrupted();
            fsyncDirectory(root);
            BasicFileAttributes published = attributes(complete);
            if (!published.isRegularFile() || published.size() != source.sizeBytes()
                    || Files.isSymbolicLink(complete) || !isReadOnly(complete)) throw unsafe();
            return new PdfReaderDocumentSession(ref, displayName, source.sizeBytes(), complete,
                    faults);
        } catch (Failure failure) {
            cleanupFailure(part, complete);
            throw failure;
        } catch (IOException | RuntimeException failure) {
            cleanupFailure(part, complete);
            throw unsafe();
        }
    }

    public synchronized Uri documentUri() {
        if (closed) throw new IllegalStateException("Reader session is closed");
        return Uri.fromFile(snapshot.toFile());
    }

    public String ref() { return ref; }
    public String displayName() { return displayName; }
    public long sizeBytes() { return sizeBytes; }

    @Override public synchronized void close() {
        if (closed) return;
        try {
            faults.checkpoint(Checkpoint.BEFORE_CLOSE_DELETE);
            deleteVerified(snapshot);
            fsyncDirectory(snapshot.getParent());
            faults.checkpoint(Checkpoint.AFTER_CLOSE_DIRECTORY_FSYNC);
            closed = true;
        } catch (IOException | Failure | RuntimeException failure) {
            throw new IllegalStateException("Reader session could not be closed.");
        }
    }

    Path snapshotForTest() { return snapshot; }

    synchronized Path snapshotForVerification() {
        if (closed) throw new IllegalStateException("Reader session is closed");
        return snapshot;
    }

    private static void copyOnce(Source source, Path part) throws IOException, Failure {
        byte[] prefix = new byte[5];
        int prefixLength = 0;
        long total = 0;
        try (FileChannel output = FileChannel.open(part,
                StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            while (total < source.sizeBytes()) {
                throwIfInterrupted();
                int wanted = (int) Math.min(COPY_CHUNK_BYTES, source.sizeBytes() - total);
                byte[] window = new byte[wanted];
                int read;
                try { read = source.read(total, window); }
                catch (Failure failure) {
                    if (Thread.currentThread().isInterrupted()) throw interrupted();
                    throw failure;
                }
                catch (Exception failure) { throw unavailable(); }
                throwIfInterrupted();
                if (read <= 0 || read > wanted) throw corrupt();
                int prefixCopy = Math.min(read, prefix.length - prefixLength);
                if (prefixCopy > 0) {
                    System.arraycopy(window, 0, prefix, prefixLength, prefixCopy);
                    prefixLength += prefixCopy;
                }
                ByteBuffer buffer = ByteBuffer.wrap(window, 0, read);
                while (buffer.hasRemaining()) output.write(buffer);
                total += read;
                throwIfInterrupted();
            }
            throwIfInterrupted();
            output.force(true);
        } catch (IOException failure) {
            if (Thread.currentThread().isInterrupted()) throw interrupted();
            throw failure;
        }
        throwIfInterrupted();
        if (total != source.sizeBytes() || prefixLength < prefix.length
                || prefix[0] != '%' || prefix[1] != 'P' || prefix[2] != 'D'
                || prefix[3] != 'F' || prefix[4] != '-') throw corrupt();
        fsyncDirectory(part.getParent());
    }

    private static void throwIfInterrupted() throws Failure {
        if (Thread.currentThread().isInterrupted()) throw interrupted();
    }

    private static List<Path> recoverAndList(Path root, long now, FaultInjector faults)
            throws IOException, Failure {
        ArrayList<Path> candidates = new ArrayList<>();
        try (var stream = Files.list(root)) {
            stream.limit(RECOVERY_BATCH_LIMIT + 1L).forEach(candidates::add);
        }
        boolean truncated = candidates.size() > RECOVERY_BATCH_LIMIT;
        candidates.sort(Comparator.comparing(path -> path.getFileName().toString()));
        ArrayList<Path> retained = new ArrayList<>();
        boolean changed = false;
        for (Path path : candidates) {
            String name = path.getFileName().toString();
            if (Files.isSymbolicLink(path)) throw unsafe();
            BasicFileAttributes attributes = attributes(path);
            if (!attributes.isRegularFile()) throw unsafe();
            if (PART.matcher(name).matches()) {
                faults.checkpoint(Checkpoint.BEFORE_RECOVERY_DELETE);
                deleteVerified(path);
                changed = true;
                continue;
            }
            if (!SNAPSHOT.matcher(name).matches()) throw unsafe();
            long age = now - attributes.lastModifiedTime().toMillis();
            if (age < 0) throw unsafe();
            if (age >= SESSION_EXPIRY_MILLIS || !isReadOnly(path)) {
                faults.checkpoint(Checkpoint.BEFORE_RECOVERY_DELETE);
                deleteVerified(path);
                changed = true;
            } else retained.add(path);
        }
        if (changed) {
            fsyncDirectory(root);
            faults.checkpoint(Checkpoint.AFTER_RECOVERY_DIRECTORY_FSYNC);
        }
        if (truncated) throw limit();
        if (retained.size() > MAXIMUM_SESSIONS) throw limit();
        return retained;
    }

    private static Path prepareRoot(Path filesDir) throws IOException {
        Path files = existingDirectory(filesDir);
        Path documents = ensureDirectory(files, "pdfchef_documents");
        return ensureDirectory(documents, "reader");
    }

    private static Path existingDirectory(Path path) throws IOException {
        Path normalized = Objects.requireNonNull(path).toAbsolutePath().normalize();
        if (Files.isSymbolicLink(normalized)
                || !Files.isDirectory(normalized, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("unsafe");
        }
        return normalized.toRealPath(LinkOption.NOFOLLOW_LINKS);
    }

    private static Path ensureDirectory(Path parent, String name) throws IOException {
        Path child = direct(parent, name);
        if (!Files.exists(child, LinkOption.NOFOLLOW_LINKS)) {
            Files.createDirectory(child);
            fsyncDirectory(parent);
        }
        return existingDirectory(child);
    }

    private static Path direct(Path parent, String name) throws IOException {
        Path normalized = parent.toAbsolutePath().normalize();
        Path child = normalized.resolve(name).normalize();
        if (!normalized.equals(child.getParent())) throw new IOException("unsafe");
        return child;
    }

    private static BasicFileAttributes attributes(Path path) throws IOException {
        return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }

    private static void makeReadOnly(Path path) throws IOException {
        try {
            Set<PosixFilePermission> permissions = EnumSet.of(PosixFilePermission.OWNER_READ);
            Files.setPosixFilePermissions(path, permissions);
        } catch (UnsupportedOperationException ignored) {
            if (!path.toFile().setReadOnly()) throw new IOException("read-only");
        }
    }

    private static boolean isReadOnly(Path path) throws IOException {
        try {
            Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path,
                    LinkOption.NOFOLLOW_LINKS);
            return !permissions.contains(PosixFilePermission.OWNER_WRITE)
                    && !permissions.contains(PosixFilePermission.GROUP_WRITE)
                    && !permissions.contains(PosixFilePermission.OTHERS_WRITE);
        } catch (UnsupportedOperationException ignored) {
            return !Files.isWritable(path);
        }
    }

    private static void fsyncFile(Path path) throws IOException {
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            channel.force(true);
        }
    }

    private static void fsyncDirectory(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        }
    }

    private static void deleteVerified(Path path) throws IOException, Failure {
        if (path == null || !Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
        Files.delete(path);
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("present");
    }

    private static void cleanupFailure(Path part, Path complete) {
        boolean restoreInterrupt = Thread.interrupted();
        Path parent = part != null ? part.getParent()
                : complete == null ? null : complete.getParent();
        try {
            deleteVerified(part);
            deleteVerified(complete);
            if (parent != null && Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
                fsyncDirectory(parent);
            }
        } catch (IOException | Failure | RuntimeException ignored) {
            // Explicit recovery will account for and retry any verified regular remnant.
        } finally {
            if (restoreInterrupt) Thread.currentThread().interrupt();
        }
    }

    private static TokenSource secureTokens() {
        SecureRandom random = new SecureRandom();
        return () -> {
            byte[] bytes = new byte[18];
            random.nextBytes(bytes);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        };
    }

    @FunctionalInterface interface Clock { long nowMillis(); }
    @FunctionalInterface interface TokenSource { String next(); }
    @FunctionalInterface interface StorageProbe { long availableBytes(long required) throws IOException; }
    @FunctionalInterface interface FaultInjector { void checkpoint(Checkpoint checkpoint) throws IOException; }
    enum Checkpoint { BEFORE_ATOMIC_PUBLISH, AFTER_ATOMIC_PUBLISH,
        BEFORE_RECOVERY_DELETE, AFTER_RECOVERY_DIRECTORY_FSYNC,
        BEFORE_CLOSE_DELETE, AFTER_CLOSE_DIRECTORY_FSYNC }

    public static final class Failure extends Exception {
        private final String code;
        public Failure(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }

    private static Failure invalid() {
        return new Failure("DOCUMENT_INVALID_ARGUMENT", "The document request is invalid.");
    }
    private static Failure unavailable() {
        return new Failure("DOCUMENT_UNAVAILABLE", "The document is unavailable.");
    }
    private static Failure storageFull() {
        return new Failure("DOCUMENT_STORAGE_FULL", "There is not enough storage.");
    }
    private static Failure limit() {
        return new Failure("DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded.");
    }
    private static Failure corrupt() {
        return new Failure("DOCUMENT_CORRUPT", "The document could not be validated.");
    }
    private static Failure interrupted() {
        return new Failure("DOCUMENT_INTERRUPTED", "The document operation was interrupted.");
    }
    private static Failure unsafe() {
        return new Failure("DOCUMENT_UNSAFE_STATE", "The document state is unavailable.");
    }
}
