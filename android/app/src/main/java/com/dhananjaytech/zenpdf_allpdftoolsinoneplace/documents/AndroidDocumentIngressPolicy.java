package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Pure validation for future content-URI ingress. This class does not activate intent handling. */
public final class AndroidDocumentIngressPolicy {
    public static final String ACTION_VIEW = "android.intent.action.VIEW";
    public static final String ACTION_SEND = "android.intent.action.SEND";
    public static final String ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE";

    public static final String MIME_PDF = "application/pdf";
    public static final String MIME_JPEG = "image/jpeg";
    public static final String MIME_PNG = "image/png";
    public static final String MIME_HEIC = "image/heic";
    public static final String MIME_DOCX =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    public static final String MIME_PPTX =
            "application/vnd.openxmlformats-officedocument.presentationml.presentation";

    public static final int MAX_ITEMS = 100;
    public static final long MAX_ITEM_BYTES = 256L * 1024L * 1024L;
    public static final long MAX_AGGREGATE_BYTES = 256L * 1024L * 1024L;

    private static final Set<String> CLOSED_MIME_TYPES = Set.of(
            MIME_PDF, MIME_JPEG, MIME_PNG, MIME_HEIC, MIME_DOCX, MIME_PPTX);

    public ValidatedBatch validate(
            String action,
            boolean browsable,
            List<Candidate> candidates) throws Failure {
        if (browsable || !isAction(action) || candidates == null) {
            throw invalid();
        }
        int count = candidates.size();
        if (count == 0) throw invalid();
        if (count > MAX_ITEMS) throw limit();
        if ((ACTION_VIEW.equals(action) || ACTION_SEND.equals(action)) && count != 1) {
            throw invalid();
        }

        long aggregate = 0;
        Set<String> sources = new HashSet<>();
        ArrayList<ValidatedItem> accepted = new ArrayList<>(count);
        for (Candidate candidate : candidates) {
            if (candidate == null
                    || candidate.sourceIdentity == null
                    || candidate.sourceIdentity.isEmpty()
                    || candidate.sourceIdentity.codePointCount(0, candidate.sourceIdentity.length()) > 1024
                    || !sources.add(candidate.sourceIdentity)
                    || !"content".equals(candidate.scheme)
                    || !isSupportedMimeType(candidate.mimeType)) {
                throw invalid();
            }
            if (!candidate.hasReadGrant || !candidate.readable) throw unavailable();
            if (candidate.sizeBytes <= 0) throw invalid();
            if (candidate.sizeBytes > MAX_ITEM_BYTES) throw limit();
            if (aggregate > MAX_AGGREGATE_BYTES - candidate.sizeBytes) throw limit();
            aggregate += candidate.sizeBytes;
            validateMagic(candidate.mimeType, candidate.magicPrefix);
            accepted.add(new ValidatedItem(
                    candidate.sourceIdentity, candidate.mimeType,
                    candidate.sizeBytes, candidate.magicPrefix));
        }
        return new ValidatedBatch(action, accepted, aggregate);
    }

    public void validateMagic(String mimeType, byte[] prefix) throws Failure {
        if (!isSupportedMimeType(mimeType) || prefix == null) throw invalid();
        boolean valid;
        switch (mimeType) {
            case MIME_PDF:
                valid = begins(prefix, 0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
                break;
            case MIME_JPEG:
                valid = begins(prefix, 0xff, 0xd8, 0xff);
                break;
            case MIME_PNG:
                valid = begins(prefix, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
                break;
            case MIME_HEIC:
                valid = isHeif(prefix);
                break;
            case MIME_DOCX:
            case MIME_PPTX:
                valid = begins(prefix, 0x50, 0x4b, 0x03, 0x04);
                break;
            default:
                throw invalid();
        }
        if (!valid) throw corrupt();
    }

    public static boolean isSupportedMimeType(String mimeType) {
        return CLOSED_MIME_TYPES.contains(mimeType);
    }

    private static boolean isAction(String action) {
        return ACTION_VIEW.equals(action)
                || ACTION_SEND.equals(action)
                || ACTION_SEND_MULTIPLE.equals(action);
    }

    private static boolean begins(byte[] bytes, int... expected) {
        if (bytes.length < expected.length) return false;
        for (int i = 0; i < expected.length; i++) {
            if ((bytes[i] & 0xff) != expected[i]) return false;
        }
        return true;
    }

    private static boolean isHeif(byte[] bytes) {
        if (bytes.length < 12 || !beginsAt(bytes, 4, 0x66, 0x74, 0x79, 0x70)) return false;
        String brand = new String(bytes, 8, 4, java.nio.charset.StandardCharsets.US_ASCII);
        return Set.of("heic", "heix", "hevc", "hevx", "mif1", "msf1").contains(brand);
    }

    private static boolean beginsAt(byte[] bytes, int offset, int... expected) {
        if (bytes.length < offset + expected.length) return false;
        for (int i = 0; i < expected.length; i++) {
            if ((bytes[offset + i] & 0xff) != expected[i]) return false;
        }
        return true;
    }

    private static Failure invalid() {
        return new Failure("DOCUMENT_INVALID_ARGUMENT", "The document request is invalid.");
    }

    private static Failure unavailable() {
        return new Failure("DOCUMENT_UNAVAILABLE", "The document is unavailable.");
    }

    private static Failure limit() {
        return new Failure("DOCUMENT_LIMIT_EXCEEDED", "The document limit was exceeded.");
    }

    private static Failure corrupt() {
        return new Failure("DOCUMENT_CORRUPT", "The document could not be validated.");
    }

    public static final class Candidate {
        private final String sourceIdentity;
        private final String scheme;
        private final String mimeType;
        private final long sizeBytes;
        private final boolean hasReadGrant;
        private final boolean readable;
        private final byte[] magicPrefix;

        public Candidate(
                String sourceIdentity,
                String scheme,
                String mimeType,
                long sizeBytes,
                boolean hasReadGrant,
                boolean readable,
                byte[] magicPrefix) {
            this.sourceIdentity = sourceIdentity;
            this.scheme = scheme;
            this.mimeType = mimeType;
            this.sizeBytes = sizeBytes;
            this.hasReadGrant = hasReadGrant;
            this.readable = readable;
            this.magicPrefix = magicPrefix == null ? null : magicPrefix.clone();
        }
    }

    public static final class ValidatedItem {
        private final String sourceIdentity;
        private final String mimeType;
        private final long sizeBytes;
        private final byte[] magicPrefix;

        private ValidatedItem(
                String sourceIdentity, String mimeType, long sizeBytes, byte[] magicPrefix) {
            this.sourceIdentity = sourceIdentity;
            this.mimeType = mimeType;
            this.sizeBytes = sizeBytes;
            this.magicPrefix = magicPrefix.clone();
        }

        /** Transient resolver identity; callers must never persist or bridge this value. */
        public String sourceIdentity() { return sourceIdentity; }
        public String mimeType() { return mimeType; }
        public long sizeBytes() { return sizeBytes; }
        public byte[] magicPrefix() { return magicPrefix.clone(); }
    }

    public static final class ValidatedBatch {
        private final String action;
        private final List<ValidatedItem> items;
        private final long aggregateBytes;

        private ValidatedBatch(String action, List<ValidatedItem> items, long aggregateBytes) {
            this.action = action;
            this.items = Collections.unmodifiableList(new ArrayList<>(items));
            this.aggregateBytes = aggregateBytes;
        }

        public String action() { return action; }
        public List<ValidatedItem> items() { return items; }
        public long aggregateBytes() { return aggregateBytes; }
    }

    public static final class Failure extends Exception {
        private final String code;

        private Failure(String code, String message) {
            super(message);
            this.code = Objects.requireNonNull(code);
        }

        public String code() { return code; }
    }
}
