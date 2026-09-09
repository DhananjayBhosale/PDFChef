package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.content.Context;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Inactive read-only resolver. It accepts opaque legacy authority, never a raw address. */
public final class LegacyDocumentOpenResolver {
    private static final long MAXIMUM_INDEX_BYTES = 4L * 1024L * 1024L;
    private static final int MAXIMUM_SOURCE_RECORDS = 10_000;
    private static final int MAXIMUM_JSON_NESTING = 64;
    static final int MAXIMUM_COLLECTION_ITEMS = 300;
    static final long MAXIMUM_COLLECTION_BYTES = OwnedDocumentWriter.MAXIMUM_FILE_BYTES;
    private static final long MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern REF = Pattern.compile("a1_([1-9][0-9]{0,15})");
    private static final Pattern ADDRESS = Pattern.compile(
            "(?:\\u0000|[\\\\/]|^[A-Za-z][A-Za-z0-9+.-]*:|\\.\\.)");

    private final File filesDir;
    private final BoundedDocumentReader reader;
    private final SourceObserver sourceObserver;

    public LegacyDocumentOpenResolver(Context context) {
        this(Objects.requireNonNull(context).getApplicationContext().getFilesDir(),
                new BoundedDocumentReader());
    }

    LegacyDocumentOpenResolver(File filesDir) {
        this(filesDir, new BoundedDocumentReader());
    }

    LegacyDocumentOpenResolver(File filesDir, BoundedDocumentReader reader) {
        this(filesDir, reader, ignored -> {});
    }

    LegacyDocumentOpenResolver(File filesDir, BoundedDocumentReader reader,
            SourceObserver sourceObserver) {
        this.filesDir = Objects.requireNonNull(filesDir);
        this.reader = Objects.requireNonNull(reader);
        this.sourceObserver = Objects.requireNonNull(sourceObserver);
    }

    public BoundedDocumentReader.Chunk readChunk(String ref, long offset, int length)
            throws Failure {
        long id = parseRef(ref);
        if (offset < 0 || offset > MAXIMUM_SAFE_INTEGER
                || length < 1 || length > BoundedDocumentReader.MAXIMUM_CHUNK_BYTES) {
            throw invalid();
        }

        Resolved resolved = resolve(id);
        try {
            return reader.read(resolved.path, resolved.identity, offset, length);
        } catch (IllegalArgumentException invalid) {
            throw invalid();
        } catch (BoundedDocumentReader.UnsafeReadException unsafe) {
            throw unsafe();
        } catch (IOException unavailable) {
            throw unavailable();
        }
    }

    /** Opens one identity-pinned native source so a private snapshot resolves the ref only once. */
    OwnedDocumentWriter.DocumentSource openSource(String ref, String expectedMimeType)
            throws Failure {
        long id = parseRef(ref);
        if (!AndroidDocumentIngressPolicy.MIME_PDF.equals(expectedMimeType)) throw invalid();
        Resolved resolved = resolve(id);
        if (!expectedMimeType.equals(resolved.mimeType)) throw invalid();
        return new ResolvedSource(resolved);
    }

    /** Opens one bounded, immediate, identity-pinned legacy collection for native delivery. */
    CollectionSource openCollection(String ref) throws Failure {
        long id = parseRef(ref);
        RecordResolution resolution = resolveRecord(id);
        RawRecord record = resolution.record;
        if (!record.collection) throw invalid();
        Path directory = resolveCollectionDirectory(resolution.root, record.storedFileName);
        try {
            BasicFileAttributes directoryIdentity = attributes(directory);
            ArrayList<CollectionItem> items = new ArrayList<>();
            List<Path> children;
            try { children = boundedChildren(directory); }
            catch (CollectionTooLargeException failure) { throw collectionLimit(); }
            for (Path path : children) {
                items.add(collectionItem(directory, path));
            }
            if (items.isEmpty()) throw collectionEmpty();
            long aggregate = 0;
            for (CollectionItem item : items) {
                if (aggregate > MAXIMUM_COLLECTION_BYTES - item.identity.size) {
                    throw collectionLimit();
                }
                aggregate += item.identity.size;
            }
            if ((record.itemCount != null && record.itemCount != items.size())
                    || record.sizeBytes != aggregate) throw corrupt();
            boolean images = items.stream().allMatch(item -> item.mimeType.startsWith("image/"));
            String common = commonMime(items);
            String actualMime = images ? (common.isEmpty() ? "image/*" : common) : common;
            if (actualMime.isEmpty()) throw corrupt();
            if (record.mimeType != null
                    && !"application/vnd.zenpdf.directory".equals(record.mimeType)
                    && !record.mimeType.equals(actualMime)
                    && !(images && "image/*".equals(record.mimeType))) throw corrupt();
            return new CollectionSource(directory, directoryIdentity, List.copyOf(items),
                    aggregate, actualMime);
        } catch (Failure failure) {
            throw failure;
        } catch (NoSuchFileException disappeared) {
            throw unsafe();
        } catch (IOException | SecurityException failure) {
            throw unavailable();
        }
    }

    private Resolved resolve(long id) throws Failure {
        RecordResolution resolution = resolveRecord(id);
        Path root = resolution.root;
        RawRecord record = resolution.record;
        if (record.collection) throw collection();
        Path processed = root.resolve("processed");
        if (!Files.exists(processed, LinkOption.NOFOLLOW_LINKS)) throw missing();
        try {
            if (Files.isSymbolicLink(processed)
                    || !Files.isDirectory(processed, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
            Path canonicalProcessed = processed.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path candidate = canonicalProcessed.resolve(record.storedFileName).normalize();
            if (!canonicalProcessed.equals(candidate.getParent())) throw unsafe();
            if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) throw missing();
            if (Files.isSymbolicLink(candidate)) throw unsafe();
            if (!Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)
                    || !Files.isReadable(candidate)) throw unavailable();
            Path canonicalCandidate = candidate.toRealPath(LinkOption.NOFOLLOW_LINKS);
            if (!canonicalProcessed.equals(canonicalCandidate.getParent())) throw unsafe();
            BoundedDocumentReader.Identity identity = reader.identity(canonicalCandidate);
            if (identity.size != record.sizeBytes) throw corrupt();
            return new Resolved(canonicalCandidate, identity, record.mimeType);
        } catch (Failure failure) {
            throw failure;
        } catch (BoundedDocumentReader.UnsafeReadException failure) {
            throw unsafe();
        } catch (NoSuchFileException disappeared) {
            throw unsafe();
        } catch (IOException | SecurityException failure) {
            throw unavailable();
        }
    }

    private RecordResolution resolveRecord(long id) throws Failure {
        Path root = requireFilesRoot();
        Path index = root.resolve("processed_index.json");
        if (!Files.exists(index, LinkOption.NOFOLLOW_LINKS)) throw missing();
        if (Files.isSymbolicLink(index)
                || !Files.isRegularFile(index, LinkOption.NOFOLLOW_LINKS)) throw corrupt();
        byte[] indexBytes;
        try {
            indexBytes = readStableIndex(index);
        } catch (NoSuchFileException disappeared) {
            throw unsafe();
        } catch (UnsafeIndexException unsafe) {
            throw unsafe();
        } catch (IOException failure) {
            throw corrupt();
        }

        Lookup lookup;
        try {
            lookup = find(indexBytes, id);
        } catch (IOException failure) {
            throw corrupt();
        }
        if (lookup.matchCount == 0) throw missing();
        if (lookup.matchCount != 1 || lookup.record == null || !lookup.record.schemaValid) {
            throw corrupt();
        }
        if (!lookup.record.hasCollection) {
            inferLegacyKind(root, lookup.record);
        }
        if (!lookup.record.collection && lookup.record.mimeType == null) throw corrupt();
        return new RecordResolution(root, lookup.record);
    }

    /**
     * The earliest Kotlin history records did not carry an explicit collection bit.
     * Resolve only the exact managed child without following links; this keeps old
     * multi-file results openable without trusting a name or walking their tree.
     */
    private static void inferLegacyKind(Path root, RawRecord record) throws Failure {
        try {
            Path processed = root.resolve("processed");
            if (!Files.exists(processed, LinkOption.NOFOLLOW_LINKS)) throw missing();
            if (Files.isSymbolicLink(processed)
                    || !Files.isDirectory(processed, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
            Path canonicalProcessed = processed.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path candidate = canonicalProcessed.resolve(record.storedFileName).normalize();
            if (!canonicalProcessed.equals(candidate.getParent())) throw unsafe();
            if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) throw missing();
            if (Files.isSymbolicLink(candidate)) throw unsafe();
            boolean directory = Files.isDirectory(candidate, LinkOption.NOFOLLOW_LINKS);
            boolean file = Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS);
            if (!directory && !file) throw unavailable();
            Path canonicalCandidate = candidate.toRealPath(LinkOption.NOFOLLOW_LINKS);
            if (!canonicalProcessed.equals(canonicalCandidate.getParent())) throw unsafe();
            record.collection = directory;
        } catch (Failure failure) {
            throw failure;
        } catch (NoSuchFileException disappeared) {
            throw unsafe();
        } catch (IOException | SecurityException failure) {
            throw unavailable();
        }
    }

    private Path resolveCollectionDirectory(Path root, String storedFileName) throws Failure {
        try {
            Path processed = root.resolve("processed");
            if (Files.isSymbolicLink(processed)
                    || !Files.isDirectory(processed, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
            Path canonicalProcessed = processed.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path candidate = canonicalProcessed.resolve(storedFileName).normalize();
            if (!canonicalProcessed.equals(candidate.getParent())) throw unsafe();
            if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) throw missing();
            if (Files.isSymbolicLink(candidate)
                    || !Files.isDirectory(candidate, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
            Path canonical = candidate.toRealPath(LinkOption.NOFOLLOW_LINKS);
            if (!canonicalProcessed.equals(canonical.getParent())) throw unsafe();
            return canonical;
        } catch (Failure failure) { throw failure; }
        catch (NoSuchFileException disappeared) { throw unsafe(); }
        catch (IOException | SecurityException failure) { throw unavailable(); }
    }

    private CollectionItem collectionItem(Path root, Path candidate) throws IOException {
        if (!root.equals(candidate.toAbsolutePath().normalize().getParent())
                || Files.isSymbolicLink(candidate)
                || !Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)
                || !Files.isReadable(candidate)) throw new IOException("unsafe collection item");
        Path canonical = candidate.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!root.equals(canonical.getParent())) throw new IOException("escaped collection item");
        String name = candidate.getFileName().toString();
        String mimeType = mimeType(name);
        if (!isBasename(name)
                || !com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderLaunchContract
                    .isSafeDisplayName(name)
                || !AndroidDocumentIngressPolicy.isSupportedMimeType(mimeType)) {
            throw new IOException("unsupported collection item");
        }
        BoundedDocumentReader.Identity identity;
        try { identity = reader.identity(canonical); }
        catch (BoundedDocumentReader.UnsafeReadException failure) {
            throw new IOException("unsafe collection item", failure);
        }
        if (identity.size <= 0 || identity.size > OwnedDocumentWriter.MAXIMUM_FILE_BYTES) {
            throw new IOException("collection item size");
        }
        try {
            BoundedDocumentReader.Chunk prefix = reader.read(canonical, identity, 0,
                    (int) Math.min(16L, identity.size));
            new AndroidDocumentIngressPolicy().validateMagic(mimeType, prefix.bytes());
        } catch (BoundedDocumentReader.UnsafeReadException
                | AndroidDocumentIngressPolicy.Failure failure) {
            throw new IOException("invalid collection item", failure);
        }
        return new CollectionItem(canonical, identity, name, mimeType);
    }

    private static List<Path> boundedChildren(Path directory) throws IOException {
        ArrayList<Path> paths = new ArrayList<>(MAXIMUM_COLLECTION_ITEMS + 1);
        try (var children = Files.list(directory)) {
            children.limit(MAXIMUM_COLLECTION_ITEMS + 1L).forEach(paths::add);
        }
        if (paths.size() > MAXIMUM_COLLECTION_ITEMS) throw new CollectionTooLargeException();
        paths.sort(Comparator.comparing(path -> path.getFileName().toString()));
        return List.copyOf(paths);
    }

    private static String commonMime(List<CollectionItem> items) {
        String first = items.get(0).mimeType;
        return items.stream().allMatch(item -> first.equals(item.mimeType)) ? first : "";
    }

    private static String mimeType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".pdf")) return AndroidDocumentIngressPolicy.MIME_PDF;
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return AndroidDocumentIngressPolicy.MIME_JPEG;
        }
        if (lower.endsWith(".png")) return AndroidDocumentIngressPolicy.MIME_PNG;
        if (lower.endsWith(".heic") || lower.endsWith(".heif")) {
            return AndroidDocumentIngressPolicy.MIME_HEIC;
        }
        if (lower.endsWith(".docx")) return AndroidDocumentIngressPolicy.MIME_DOCX;
        if (lower.endsWith(".pptx")) return AndroidDocumentIngressPolicy.MIME_PPTX;
        return "";
    }

    private Path requireFilesRoot() throws Failure {
        Path root = filesDir.toPath().toAbsolutePath().normalize();
        try {
            if (Files.isSymbolicLink(root)
                    || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) throw unsafe();
            return root.toRealPath(LinkOption.NOFOLLOW_LINKS);
        } catch (Failure failure) {
            throw failure;
        } catch (IOException | SecurityException failure) {
            throw unsafe();
        }
    }

    private static long parseRef(String ref) throws Failure {
        if (ref == null) throw invalid();
        Matcher matcher = REF.matcher(ref);
        if (!matcher.matches()) throw invalid();
        try {
            long id = Long.parseLong(matcher.group(1));
            if (id < 1 || id > MAXIMUM_SAFE_INTEGER || !ref.equals("a1_" + id)) throw invalid();
            return id;
        } catch (NumberFormatException failure) {
            throw invalid();
        }
    }

    private static byte[] readStableIndex(Path path) throws IOException {
        if (Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new UnsafeIndexException();
        }
        BasicFileAttributes before = attributes(path);
        if (before.size() > MAXIMUM_INDEX_BYTES) throw new IOException("Index too large");
        byte[] bytes;
        try (FileChannel channel = FileChannel.open(
                path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            BasicFileAttributes afterOpen = attributes(path);
            requireSame(before, afterOpen);
            bytes = readBounded(channel);
            BasicFileAttributes afterRead = attributes(path);
            requireSame(afterOpen, afterRead);
        }
        return bytes;
    }

    private static byte[] readBounded(FileChannel channel) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ByteBuffer buffer = ByteBuffer.allocate(8192);
        long total = 0;
        while (true) {
            int read = channel.read(buffer);
            if (read < 0) break;
            if (read == 0) continue;
            total += read;
            if (total > MAXIMUM_INDEX_BYTES) throw new IOException("Index too large");
            output.write(buffer.array(), 0, read);
            buffer.clear();
        }
        return output.toByteArray();
    }

    private static Lookup find(byte[] bytes, long targetId) throws IOException {
        String raw = decodeUtf8(bytes);
        if (raw.isBlank()) throw new IOException("Blank index");
        JsonReader source = new JsonReader(new StringReader(raw));
        source.setStrictness(Strictness.STRICT);
        source.setNestingLimit(MAXIMUM_JSON_NESTING);
        try (source) {
            if (source.peek() != JsonToken.BEGIN_ARRAY) throw new IOException("Invalid index");
            source.beginArray();
            int sourceCount = 0;
            int matches = 0;
            RawRecord match = null;
            while (source.hasNext()) {
                if (++sourceCount > MAXIMUM_SOURCE_RECORDS) throw new IOException("Index limit");
                RawRecord record = consumeRecord(source);
                if (record.id != null && record.id == targetId) {
                    matches++;
                    if (matches == 1) match = record;
                }
            }
            source.endArray();
            if (source.peek() != JsonToken.END_DOCUMENT) throw new IOException("Trailing data");
            return new Lookup(matches, match);
        }
    }

    private static RawRecord consumeRecord(JsonReader source) throws IOException {
        RawRecord record = new RawRecord();
        if (source.peek() != JsonToken.BEGIN_OBJECT) {
            source.skipValue();
            record.schemaValid = false;
            return record;
        }
        Set<String> seen = new HashSet<>();
        source.beginObject();
        while (source.hasNext()) {
            String name = source.nextName();
            if (!seen.add(name)) {
                record.schemaValid = false;
                source.skipValue();
                continue;
            }
            try {
                switch (name) {
                    case "id": record.id = positiveLong(source); break;
                    case "displayName": record.displayName = requiredString(source); break;
                    case "toolName": record.toolName = requiredString(source); break;
                    case "sizeBytes": record.sizeBytes = nonNegativeLong(source); break;
                    case "createdAtMillis": record.createdAt = nonNegativeLong(source); break;
                    case "storedFileName": record.storedFileName = requiredString(source); break;
                    case "mimeType": record.mimeType = requiredString(source); break;
                    case "isDirectory":
                        record.collection = requiredBoolean(source);
                        record.hasCollection = true;
                        break;
                    case "itemCount": record.itemCount = positiveInt(source); break;
                    default:
                        record.schemaValid = false;
                        source.skipValue();
                }
            } catch (IOException invalidField) {
                record.schemaValid = false;
            }
        }
        source.endObject();
        if (record.mimeType == null && record.storedFileName != null) {
            String inferred = mimeType(record.storedFileName);
            if (!inferred.isEmpty()) record.mimeType = inferred;
        }
        if (record.id == null || record.displayName == null || record.toolName == null
                || record.sizeBytes == null || record.createdAt == null
                || record.storedFileName == null
                || (record.hasCollection && !record.collection && record.mimeType == null)
                || (record.mimeType != null
                    && !(AndroidDocumentIngressPolicy.isSupportedMimeType(record.mimeType)
                        || (record.collection && ("image/*".equals(record.mimeType)
                            || "application/vnd.zenpdf.directory".equals(record.mimeType)))))
                || (!record.collection && record.itemCount != null && record.itemCount != 1)
                || record.displayName.isBlank()
                || ADDRESS.matcher(record.displayName).find()
                || ADDRESS.matcher(record.toolName).find()
                || !isBasename(record.storedFileName)) {
            record.schemaValid = false;
        }
        return record;
    }

    private static long positiveLong(JsonReader source) throws IOException {
        long value = nonNegativeLong(source);
        if (value < 1) throw new IOException("Invalid positive integer");
        return value;
    }

    private static long nonNegativeLong(JsonReader source) throws IOException {
        if (source.peek() != JsonToken.NUMBER) {
            source.skipValue();
            throw new IOException("Invalid integer");
        }
        String value = source.nextString();
        if (!value.matches("0|[1-9][0-9]*")) throw new IOException("Invalid integer");
        try {
            long parsed = Long.parseLong(value);
            if (parsed < 0 || parsed > MAXIMUM_SAFE_INTEGER) throw new IOException("Invalid integer");
            return parsed;
        } catch (NumberFormatException failure) {
            throw new IOException("Invalid integer", failure);
        }
    }

    private static int positiveInt(JsonReader source) throws IOException {
        long value = positiveLong(source);
        if (value > Integer.MAX_VALUE) throw new IOException("Invalid integer");
        return (int) value;
    }

    private static String requiredString(JsonReader source) throws IOException {
        if (source.peek() != JsonToken.STRING) {
            source.skipValue();
            throw new IOException("Invalid string");
        }
        String value = source.nextString();
        if (value.indexOf('\0') >= 0) throw new IOException("Invalid string");
        return value;
    }

    private static boolean requiredBoolean(JsonReader source) throws IOException {
        if (source.peek() != JsonToken.BOOLEAN) {
            source.skipValue();
            throw new IOException("Invalid boolean");
        }
        return source.nextBoolean();
    }

    private static boolean isBasename(String value) {
        return !value.isEmpty() && !value.equals(".") && !value.equals("..")
                && value.indexOf('/') < 0 && value.indexOf('\\') < 0;
    }

    private static String decodeUtf8(byte[] bytes) throws IOException {
        try {
            CharBuffer result = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes));
            return result.toString();
        } catch (CharacterCodingException failure) {
            throw new IOException("Invalid UTF-8", failure);
        }
    }

    private static BasicFileAttributes attributes(Path path) throws IOException {
        return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }

    private static void requireSame(BasicFileAttributes first, BasicFileAttributes second)
            throws UnsafeIndexException {
        if (!Objects.equals(first.fileKey(), second.fileKey())
                || first.size() != second.size()
                || !first.lastModifiedTime().equals(second.lastModifiedTime())
                || !first.creationTime().equals(second.creationTime())) {
            throw new UnsafeIndexException();
        }
    }

    private static Failure invalid() {
        return new Failure("LEGACY_DOCUMENT_INVALID_ARGUMENT", "The document request is invalid.");
    }
    private static Failure missing() {
        return new Failure("LEGACY_DOCUMENT_NOT_FOUND", "The document was not found.");
    }
    private static Failure corrupt() {
        return new Failure("LEGACY_DOCUMENT_CORRUPT", "The document index is corrupt.");
    }
    private static Failure unavailable() {
        return new Failure("LEGACY_DOCUMENT_UNAVAILABLE", "The document is unavailable.");
    }
    private static Failure unsafe() {
        return new Failure("LEGACY_DOCUMENT_UNSAFE_STATE", "The document state is unsafe.");
    }
    private static Failure collection() {
        return new Failure("LEGACY_DOCUMENT_COLLECTION_UNSUPPORTED",
                "Collections cannot be read as documents.");
    }
    private static Failure collectionEmpty() {
        return new Failure("LEGACY_DOCUMENT_CORRUPT", "The document index is corrupt.");
    }
    private static Failure collectionLimit() {
        return new Failure("LEGACY_DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded.");
    }

    public static final class Failure extends Exception {
        private final String code;
        private Failure(String code, String message) {
            super(message);
            this.code = code;
        }
        public String code() { return code; }
    }

    private static final class RawRecord {
        boolean schemaValid = true;
        Long id;
        Long sizeBytes;
        Long createdAt;
        String displayName;
        String toolName;
        String storedFileName;
        String mimeType;
        Integer itemCount;
        boolean collection;
        boolean hasCollection;
    }

    private static final class Lookup {
        final int matchCount;
        final RawRecord record;
        Lookup(int matchCount, RawRecord record) {
            this.matchCount = matchCount;
            this.record = record;
        }
    }

    private static final class Resolved {
        final Path path;
        final BoundedDocumentReader.Identity identity;
        final String mimeType;
        Resolved(Path path, BoundedDocumentReader.Identity identity, String mimeType) {
            this.path = path;
            this.identity = identity;
            this.mimeType = mimeType;
        }
    }

    private record RecordResolution(Path root, RawRecord record) { }

    static final class CollectionSource implements AutoCloseable {
        private final Path directory;
        private final BasicFileAttributes directoryIdentity;
        private final List<CollectionItem> items;
        private final long totalBytes;
        private final String mimeType;
        private boolean closed;

        CollectionSource(Path directory, BasicFileAttributes directoryIdentity,
                List<CollectionItem> items, long totalBytes, String mimeType) {
            this.directory = directory;
            this.directoryIdentity = directoryIdentity;
            this.items = items;
            this.totalBytes = totalBytes;
            this.mimeType = mimeType;
        }

        synchronized int itemCount() throws Failure { requireOpen(); return items.size(); }
        synchronized long totalBytes() throws Failure { requireOpen(); return totalBytes; }
        synchronized String mimeType() throws Failure { requireOpen(); return mimeType; }
        synchronized boolean imageCollection() throws Failure {
            requireOpen(); return mimeType.startsWith("image/");
        }
        synchronized List<CollectionItem> items() throws Failure {
            requireOpen(); return items;
        }
        synchronized void validateUnchanged() throws Failure {
            requireOpen();
            try {
                requireSame(directoryIdentity, attributes(directory));
                List<Path> paths = boundedChildren(directory);
                if (paths.size() != items.size()) throw new UnsafeIndexException();
                for (int index = 0; index < paths.size(); index++) {
                    CollectionItem item = items.get(index);
                    Path path = paths.get(index);
                    if (!path.equals(item.path) || Files.isSymbolicLink(path)) {
                        throw new UnsafeIndexException();
                    }
                    item.identity.requireSame(attributes(path));
                }
            } catch (IOException | SecurityException failure) {
                throw unsafe();
            }
        }
        private void requireOpen() throws Failure { if (closed) throw invalid(); }
        @Override public synchronized void close() { closed = true; }
    }

    static final class CollectionItem {
        private final Path path;
        private final BoundedDocumentReader.Identity identity;
        private final String displayName;
        private final String mimeType;

        CollectionItem(Path path, BoundedDocumentReader.Identity identity,
                String displayName, String mimeType) {
            this.path = path; this.identity = identity;
            this.displayName = displayName; this.mimeType = mimeType;
        }
        String displayName() { return displayName; }
        String mimeType() { return mimeType; }
        long sizeBytes() { return identity.size; }
        OwnedDocumentWriter.DocumentSource openSource() throws Failure {
            return new CollectionItemSource(this);
        }
    }

    private static final class CollectionItemSource implements OwnedDocumentWriter.DocumentSource {
        private final CollectionItem item;
        private final FileChannel channel;
        private boolean closed;
        CollectionItemSource(CollectionItem item) throws Failure {
            this.item = item;
            FileChannel opened = null;
            try {
                item.identity.requireSame(attributes(item.path));
                opened = FileChannel.open(item.path, StandardOpenOption.READ,
                        LinkOption.NOFOLLOW_LINKS);
                item.identity.requireSame(attributes(item.path));
                if (opened.size() != item.identity.size) throw new IOException("size");
                channel = opened;
            } catch (BoundedDocumentReader.UnsafeReadException failure) {
                closeQuietly(opened); throw unsafe();
            } catch (IOException | SecurityException failure) {
                closeQuietly(opened); throw unavailable();
            }
        }
        @Override public String mimeType() { return item.mimeType; }
        @Override public long sizeBytes() { return item.identity.size; }
        @Override public synchronized int read(long offset, byte[] target)
                throws OwnedDocumentWriter.Failure {
            if (closed || offset < 0 || offset > item.identity.size || target == null
                    || target.length < 1
                    || target.length > BoundedDocumentReader.MAXIMUM_CHUNK_BYTES) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_INVALID_ARGUMENT",
                        "The document request is invalid.");
            }
            try {
                item.identity.requireSame(attributes(item.path));
                int wanted = (int) Math.min((long) target.length, item.identity.size - offset);
                ByteBuffer buffer = ByteBuffer.wrap(target, 0, wanted);
                int total = 0;
                while (buffer.hasRemaining()) {
                    int read = channel.read(buffer, offset + total);
                    if (read <= 0) throw new BoundedDocumentReader.UnsafeReadException();
                    total += read;
                }
                item.identity.requireSame(attributes(item.path));
                if (channel.size() != item.identity.size) {
                    throw new BoundedDocumentReader.UnsafeReadException();
                }
                return total;
            } catch (BoundedDocumentReader.UnsafeReadException failure) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_UNSAFE_STATE",
                        "The document state is unavailable.");
            } catch (IOException failure) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_UNAVAILABLE",
                        "The document is unavailable.");
            }
        }
        @Override public synchronized void close() {
            if (closed) return;
            closed = true;
            closeQuietly(channel);
        }
    }

    private static final class CollectionTooLargeException extends IOException { }

    private final class ResolvedSource implements OwnedDocumentWriter.DocumentSource {
        private final Resolved resolved;
        private final FileChannel channel;
        private boolean closed;

        ResolvedSource(Resolved resolved) throws Failure {
            this.resolved = resolved;
            FileChannel opened = null;
            try {
                resolved.identity.requireSame(attributes(resolved.path));
                opened = FileChannel.open(resolved.path, StandardOpenOption.READ,
                        LinkOption.NOFOLLOW_LINKS);
                resolved.identity.requireSame(attributes(resolved.path));
                if (opened.size() != resolved.identity.size) throw new IOException("size");
                sourceObserver.checkpoint(SourceCheckpoint.OPEN);
                this.channel = opened;
            } catch (BoundedDocumentReader.UnsafeReadException failure) {
                closeQuietly(opened);
                throw unsafe();
            } catch (IOException | SecurityException failure) {
                closeQuietly(opened);
                throw unavailable();
            }
        }
        @Override public String mimeType() { return resolved.mimeType; }
        @Override public long sizeBytes() { return resolved.identity.size; }
        @Override public synchronized int read(long offset, byte[] target)
                throws OwnedDocumentWriter.Failure {
            if (closed || offset < 0 || offset > resolved.identity.size
                    || target == null || target.length < 1
                    || target.length > BoundedDocumentReader.MAXIMUM_CHUNK_BYTES) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_INVALID_ARGUMENT",
                        "The document request is invalid.");
            }
            try {
                resolved.identity.requireSame(attributes(resolved.path));
                int requested = (int) Math.min((long) target.length,
                        resolved.identity.size - offset);
                ByteBuffer buffer = ByteBuffer.wrap(target, 0, requested);
                int total = 0;
                int emptyReads = 0;
                while (buffer.hasRemaining()) {
                    int read = channel.read(buffer, offset + total);
                    if (read < 0) throw new BoundedDocumentReader.UnsafeReadException();
                    if (read == 0) {
                        if (++emptyReads > 8) {
                            throw new BoundedDocumentReader.UnsafeReadException();
                        }
                        continue;
                    }
                    emptyReads = 0;
                    total += read;
                }
                sourceObserver.checkpoint(SourceCheckpoint.READ);
                resolved.identity.requireSame(attributes(resolved.path));
                if (channel.size() != resolved.identity.size) {
                    throw new BoundedDocumentReader.UnsafeReadException();
                }
                return total;
            } catch (BoundedDocumentReader.UnsafeReadException failure) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_UNSAFE_STATE",
                        "The document state is unavailable.");
            } catch (IOException failure) {
                throw new OwnedDocumentWriter.Failure("DOCUMENT_UNAVAILABLE",
                        "The document is unavailable.");
            }
        }

        @Override public synchronized void close() {
            if (closed) return;
            closed = true;
            closeQuietly(channel);
            try { sourceObserver.checkpoint(SourceCheckpoint.CLOSE); }
            catch (IOException ignored) { }
        }
    }

    private static void closeQuietly(FileChannel channel) {
        if (channel == null) return;
        try { channel.close(); } catch (IOException ignored) { }
    }

    enum SourceCheckpoint { OPEN, READ, CLOSE }
    @FunctionalInterface interface SourceObserver {
        void checkpoint(SourceCheckpoint checkpoint) throws IOException;
    }

    private static final class UnsafeIndexException extends IOException { }
}
