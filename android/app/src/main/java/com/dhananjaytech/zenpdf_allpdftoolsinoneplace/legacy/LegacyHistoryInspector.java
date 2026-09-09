package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.legacy;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Read-only parser for the legacy index. It never delegates to the mutating legacy repository. */
public final class LegacyHistoryInspector {
    static final long DEFAULT_MAX_BYTES = 4L * 1024L * 1024L;
    static final int DEFAULT_MAX_SOURCE = 10_000;
    static final int DEFAULT_MAX_JSON_NESTING = 64;
    static final int DEFAULT_MAX_FILESYSTEM_DEPTH = 32;
    static final int DEFAULT_MAX_FILESYSTEM_NODES = 10_000;
    private static final int MAX_RETURNED = 300;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern ADDRESS = Pattern.compile("(?:\u0000|[\\\\/]|^[A-Za-z][A-Za-z0-9+.-]*:|\\.\\.)");

    private final File filesDir;
    private final long maxBytes;
    private final int maxSource;
    private final int maxJsonNesting;
    private final int maxFilesystemDepth;
    private final int maxFilesystemNodes;

    public LegacyHistoryInspector(File filesDir) {
        this(filesDir, DEFAULT_MAX_BYTES, DEFAULT_MAX_SOURCE, DEFAULT_MAX_JSON_NESTING,
                DEFAULT_MAX_FILESYSTEM_DEPTH, DEFAULT_MAX_FILESYSTEM_NODES);
    }

    LegacyHistoryInspector(File filesDir, long maxBytes, int maxSource, int maxJsonNesting,
            int maxFilesystemDepth, int maxFilesystemNodes) {
        this.filesDir = filesDir;
        this.maxBytes = maxBytes;
        this.maxSource = maxSource;
        this.maxJsonNesting = maxJsonNesting;
        this.maxFilesystemDepth = maxFilesystemDepth;
        this.maxFilesystemNodes = maxFilesystemNodes;
    }

    static JsonObject corruptSnapshot() { return emptySnapshot("corrupt"); }

    public JsonObject read() {
        File index = new File(filesDir, "processed_index.json");
        if (isSymlink(index)) return corruptSnapshot();
        if (!index.exists()) return emptySnapshot("missing");
        if (!index.isFile()) return corruptSnapshot();
        final String raw;
        try {
            raw = decodeUtf8(readBounded(index, maxBytes));
        } catch (IOException failure) {
            return corruptSnapshot();
        }
        if (raw.isBlank()) return emptySnapshot("blank");

        try (JsonReader reader = strictReader(raw, maxJsonNesting)) {
            if (reader.peek() != JsonToken.BEGIN_ARRAY) return corruptSnapshot();
            ArrayList<Record> records = new ArrayList<>();
            Map<Long, Integer> idFrequency = new HashMap<>();
            int sourceCount = 0;
            int invalidCount = 0;
            reader.beginArray();
            while (reader.hasNext()) {
                sourceCount++;
                if (sourceCount > maxSource) return corruptSnapshot();
                Record record = consumeRecord(reader, sourceCount);
                records.add(record);
                if (record.id != null) idFrequency.merge(record.id, 1, Integer::sum);
            }
            reader.endArray();
            if (reader.peek() != JsonToken.END_DOCUMENT) return corruptSnapshot();

            ArrayList<Record> valid = new ArrayList<>();
            int[] globalNodes = {0};
            for (Record record : records) {
                if (!record.schemaValid || record.id == null
                        || idFrequency.get(record.id) > 1) {
                    invalidCount++;
                    continue;
                }
                try {
                    record.validateOutput(filesDir, maxFilesystemDepth, maxFilesystemNodes,
                            globalNodes);
                    valid.add(record);
                } catch (IOException invalidRecord) {
                    invalidCount++;
                }
            }
            valid.sort(Comparator.comparingLong((Record record) -> record.createdAt)
                    .reversed().thenComparingInt(record -> record.sourceOrder));
            JsonArray entries = new JsonArray();
            for (int indexAt = 0; indexAt < Math.min(MAX_RETURNED, valid.size()); indexAt++) {
                entries.add(valid.get(indexAt).toSnapshot());
            }
            JsonObject snapshot = new JsonObject();
            snapshot.addProperty("health", invalidCount == 0 ? "ok" : "partial_invalid");
            snapshot.addProperty("sourceCount", sourceCount);
            snapshot.addProperty("invalidRecordCount", invalidCount);
            snapshot.addProperty("returnedCount", entries.size());
            snapshot.addProperty("truncated", valid.size() > MAX_RETURNED);
            snapshot.add("entries", entries);
            return snapshot;
        } catch (IOException syntaxOrNestingFailure) {
            return corruptSnapshot();
        }
    }

    /** Always consumes one complete array member. Schema problems are retained as record-local invalid. */
    private static Record consumeRecord(JsonReader reader, int sourceOrder) throws IOException {
        Record record = new Record(sourceOrder);
        if (reader.peek() != JsonToken.BEGIN_OBJECT) {
            reader.skipValue();
            return record;
        }
        Set<String> seen = new HashSet<>();
        reader.beginObject();
        while (reader.hasNext()) {
            String name = reader.nextName();
            if (!seen.add(name)) {
                record.schemaValid = false;
                reader.skipValue();
                continue;
            }
            try {
                switch (name) {
                    case "id": record.id = positiveLong(reader); break;
                    case "displayName": record.displayName = requiredString(reader); break;
                    case "toolName": record.toolName = requiredString(reader); break;
                    case "sizeBytes": record.sizeBytes = nonNegativeLong(reader); break;
                    case "createdAtMillis": record.createdAt = nonNegativeLong(reader); break;
                    case "storedFileName": record.storedFileName = requiredString(reader); break;
                    case "mimeType": record.mimeType = requiredString(reader); record.hasMime = true; break;
                    case "isDirectory": record.collection = requiredBoolean(reader); record.hasCollection = true; break;
                    case "itemCount": record.itemCount = positiveInt(reader); record.hasItemCount = true; break;
                    default: record.schemaValid = false; reader.skipValue();
                }
            } catch (IOException invalidField) {
                record.schemaValid = false;
            }
        }
        reader.endObject();
        if (record.id == null || record.displayName == null || record.toolName == null
                || record.sizeBytes == null || record.createdAt == null
                || record.storedFileName == null) {
            record.schemaValid = false;
        }
        if (record.schemaValid && (ADDRESS.matcher(record.displayName).find()
                || ADDRESS.matcher(record.toolName).find()
                || record.displayName.isBlank()
                || !isBasename(record.storedFileName))) {
            record.schemaValid = false;
        }
        return record;
    }

    private static JsonReader strictReader(String raw, int maxNesting) {
        JsonReader reader = new JsonReader(new StringReader(raw));
        reader.setStrictness(Strictness.STRICT);
        reader.setNestingLimit(maxNesting);
        return reader;
    }

    private static long positiveLong(JsonReader reader) throws IOException {
        long value = nonNegativeLong(reader);
        if (value < 1) throw new IOException("invalid");
        return value;
    }

    private static long nonNegativeLong(JsonReader reader) throws IOException {
        if (reader.peek() != JsonToken.NUMBER) {
            reader.skipValue();
            throw new IOException("invalid");
        }
        String text = reader.nextString();
        if (!text.matches("0|[1-9][0-9]*")) throw new IOException("invalid");
        try {
            long value = Long.parseLong(text);
            if (value < 0 || value > MAX_SAFE_INTEGER) throw new IOException("invalid");
            return value;
        } catch (NumberFormatException failure) {
            throw new IOException("invalid");
        }
    }

    private static int positiveInt(JsonReader reader) throws IOException {
        long value = positiveLong(reader);
        if (value > Integer.MAX_VALUE) throw new IOException("invalid");
        return (int) value;
    }

    private static String requiredString(JsonReader reader) throws IOException {
        if (reader.peek() != JsonToken.STRING) {
            reader.skipValue();
            throw new IOException("invalid");
        }
        String value = reader.nextString();
        if (value.indexOf(' ') >= 0) throw new IOException("invalid");
        return value;
    }

    private static boolean requiredBoolean(JsonReader reader) throws IOException {
        if (reader.peek() != JsonToken.BOOLEAN) {
            reader.skipValue();
            throw new IOException("invalid");
        }
        return reader.nextBoolean();
    }

    private static boolean isBasename(String name) {
        return !name.isEmpty() && !name.equals(".") && !name.equals("..")
                && name.indexOf('/') < 0 && name.indexOf('\\') < 0;
    }

    private static JsonObject emptySnapshot(String health) {
        JsonObject result = new JsonObject();
        result.addProperty("health", health);
        result.addProperty("sourceCount", 0);
        result.addProperty("invalidRecordCount", 0);
        result.addProperty("returnedCount", 0);
        result.addProperty("truncated", false);
        result.add("entries", new JsonArray());
        return result;
    }

    private static byte[] readBounded(File source, long limit) throws IOException {
        try (FileInputStream input = new FileInputStream(source);
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            long count = 0;
            for (int read; (read = input.read(buffer)) != -1;) {
                count += read;
                if (count > limit) throw new IOException("limit");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static String decodeUtf8(byte[] input) throws IOException {
        try {
            CharBuffer decoded = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(input));
            return decoded.toString();
        } catch (CharacterCodingException failure) {
            throw new IOException("utf8");
        }
    }

    private static boolean isSymlink(File file) {
        try { return Files.isSymbolicLink(file.toPath()); }
        catch (Exception ignored) { return true; }
    }

    private static final class Record {
        final int sourceOrder;
        boolean schemaValid = true;
        Long id, sizeBytes, createdAt;
        String displayName, toolName, storedFileName, mimeType;
        boolean collection, hasCollection, hasMime, hasItemCount, available;
        Integer itemCount;
        int resolvedItemCount;

        Record(int sourceOrder) { this.sourceOrder = sourceOrder; }

        void validateOutput(File filesDir, int maxDepth, int maxNodes, int[] globalNodes)
                throws IOException {
            File root = new File(filesDir, "processed");
            File output = new File(root, storedFileName);
            if (isSymlink(root)
                    || !output.getCanonicalFile().getParentFile().equals(root.getCanonicalFile())
                    || isSymlink(output)) throw new IOException("unsafe");
            if (!output.exists()) {
                available = false;
                if (collection) resolvedItemCount = hasItemCount ? itemCount : 1;
                return;
            }
            // Early PDF Chef indexes predate the explicit isDirectory field.
            // Infer only from this exact no-follow managed child; never reject
            // an otherwise valid older file merely because the newer metadata
            // key did not exist when it was created.
            if (!hasCollection) {
                collection = Files.isDirectory(output.toPath(), LinkOption.NOFOLLOW_LINKS);
            }
            boolean correctType = collection
                    ? Files.isDirectory(output.toPath(), LinkOption.NOFOLLOW_LINKS)
                    : Files.isRegularFile(output.toPath(), LinkOption.NOFOLLOW_LINKS);
            if (!correctType || !Files.isReadable(output.toPath())) throw new IOException("wrong type");
            available = true;
            if (collection) {
                resolvedItemCount = hasItemCount ? itemCount
                        : countFiles(output, 0, maxDepth, maxNodes, globalNodes);
            }
        }

        JsonObject toSnapshot() {
            JsonObject result = new JsonObject();
            result.addProperty("kind", collection ? "collection" : "file");
            result.addProperty("ref", "a1_" + id);
            result.addProperty("displayName", displayName);
            result.addProperty("toolId", toolName);
            result.addProperty("createdAt", createdAt);
            result.addProperty("available", available);
            if (collection) result.addProperty("itemCount", resolvedItemCount);
            else {
                result.add("mimeType", hasMime ? new JsonPrimitive(mimeType) : JsonNull.INSTANCE);
                result.addProperty("sizeBytes", sizeBytes);
            }
            return result;
        }
    }

    private static int countFiles(File item, int depth, int maxDepth, int maxNodes,
            int[] globalNodes) throws IOException {
        if (depth > maxDepth || ++globalNodes[0] > maxNodes || isSymlink(item)) {
            throw new IOException("bound");
        }
        if (item.isFile()) return 1;
        File[] children = item.listFiles();
        if (children == null) throw new IOException("unreadable");
        int count = 0;
        for (File child : children) count += countFiles(child, depth + 1, maxDepth, maxNodes, globalNodes);
        return Math.max(1, count);
    }
}
