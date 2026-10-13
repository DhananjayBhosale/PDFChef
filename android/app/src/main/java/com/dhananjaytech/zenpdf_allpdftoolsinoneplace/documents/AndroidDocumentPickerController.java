package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Inactive picker mechanics. No Activity, plugin, manifest, or visible route registers this class. */
public final class AndroidDocumentPickerController {
    private static final int MAGIC_PREFIX_BYTES = 16;
    private final Resolver resolver;
    private final OwnedPendingImportStore store;
    private final PickerRequestPolicy requestPolicy;
    private final AndroidDocumentIngressPolicy ingressPolicy;

    public AndroidDocumentPickerController(Context context, OwnedPendingImportStore store) {
        this(new ContentResolverAdapter(context.getApplicationContext().getContentResolver()),
                store, new PickerRequestPolicy(), new AndroidDocumentIngressPolicy());
    }

    AndroidDocumentPickerController(
            Resolver resolver,
            OwnedPendingImportStore store,
            PickerRequestPolicy requestPolicy,
            AndroidDocumentIngressPolicy ingressPolicy) {
        this.resolver = Objects.requireNonNull(resolver);
        this.store = Objects.requireNonNull(store);
        this.requestPolicy = Objects.requireNonNull(requestPolicy);
        this.ingressPolicy = Objects.requireNonNull(ingressPolicy);
    }

    public Intent createIntent(PickerRequestPolicy.Request request) throws Failure {
        if (request == null) throw invalid();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(request.acceptedMimeTypes().size() == 1
                ? request.acceptedMimeTypes().get(0)
                : "*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES,
                request.acceptedMimeTypes().toArray(new String[0]));
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, request.maximumItems() > 1);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        return intent;
    }

    public Result handleResult(
            PickerRequestPolicy.Request request,
            int resultCode,
            Intent resultIntent,
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (request == null || cancellation == null) throw invalid();
        if (resultCode == Activity.RESULT_CANCELED) return Result.cancelled();
        if (resultCode != Activity.RESULT_OK || resultIntent == null) throw invalid();
        checkCancelled(cancellation);

        List<Uri> uris = orderedUris(resultIntent, request.maximumItems());
        int flags = resultIntent.getFlags();
        boolean hasReadGrant = (flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
        if (!hasReadGrant) throw unavailable();
        boolean mayPersist = (flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0;

        ArrayList<AndroidDocumentIngressPolicy.Candidate> candidates =
                new ArrayList<>(uris.size());
        for (Uri uri : uris) {
            checkCancelled(cancellation);
            if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) throw invalid();
            String mimeType;
            long sizeBytes;
            byte[] prefix;
            try {
                mimeType = resolver.mimeType(uri);
                sizeBytes = resolver.sizeBytes(uri);
                prefix = readPrefix(uri);
            } catch (IOException | SecurityException failure) {
                throw unavailable();
            }
            if (!request.acceptsMimeType(mimeType)) throw invalid();
            candidates.add(new AndroidDocumentIngressPolicy.Candidate(
                    uri.toString(), uri.getScheme(), mimeType, sizeBytes,
                    true, true, prefix));
        }

        AndroidDocumentIngressPolicy.ValidatedBatch validated;
        try {
            validated = ingressPolicy.validate(
                    candidates.size() == 1
                            ? AndroidDocumentIngressPolicy.ACTION_VIEW
                            : AndroidDocumentIngressPolicy.ACTION_SEND_MULTIPLE,
                    false,
                    candidates);
        } catch (AndroidDocumentIngressPolicy.Failure failure) {
            throw new Failure(failure.code(), failure.getMessage());
        }

        if (mayPersist) {
            for (Uri uri : uris) {
                try {
                    resolver.takePersistableReadPermission(uri);
                } catch (SecurityException ignored) {
                    // Persisted access is optional; owned copied bytes are the durability boundary.
                }
            }
        }

        ArrayList<String> itemRefs = new ArrayList<>(uris.size());
        for (int index = 0; index < uris.size(); index++) {
            try {
                itemRefs.add(requestPolicy.documentRef(request, index));
            } catch (PickerRequestPolicy.Failure failure) {
                throw new Failure(failure.code(), failure.getMessage());
            }
        }
        final PendingImportBatch batch;
        try {
            batch = store.beginBatch(itemRefs);
        } catch (OwnedPendingImportStore.Failure failure) {
            throw new Failure(failure.code(), failure.getMessage());
        }
        if (batch.isAcknowledged()) return Result.accepted(batch.batchRef(), itemRefs);
        try {
            for (int index = 0; index < uris.size(); index++) {
                checkCancelled(cancellation);
                try (InputStream input = resolver.open(uris.get(index))) {
                    store.stage(itemRefs.get(index), validated.items().get(index), input, cancellation);
                } catch (IOException | SecurityException failure) {
                    throw unavailable();
                }
            }
            checkCancelled(cancellation);
            store.completeBatch(batch.batchRef(), itemRefs);
        } catch (OwnedPendingImportStore.Failure failure) {
            abortIncompleteBatch(batch.batchRef(), failure);
            throw new Failure(failure.code(), failure.getMessage());
        } catch (Failure | RuntimeException failure) {
            abortIncompleteBatch(batch.batchRef(), failure);
            throw failure;
        }
        return Result.accepted(batch.batchRef(), itemRefs);
    }

    private void abortIncompleteBatch(String batchRef, Exception originalFailure) {
        try { store.abortIncompleteBatch(batchRef); }
        catch (OwnedPendingImportStore.Failure cleanupFailure) {
            // An incomplete manifest remains recoverable if storage is temporarily unavailable.
            originalFailure.addSuppressed(cleanupFailure);
        }
    }

    private byte[] readPrefix(Uri uri) throws IOException {
        try (InputStream input = resolver.open(uri)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(MAGIC_PREFIX_BYTES);
            byte[] buffer = new byte[MAGIC_PREFIX_BYTES];
            while (bytes.size() < MAGIC_PREFIX_BYTES) {
                int read = input.read(buffer, 0, MAGIC_PREFIX_BYTES - bytes.size());
                if (read < 0) break;
                if (read == 0) continue;
                bytes.write(buffer, 0, read);
            }
            return bytes.toByteArray();
        }
    }

    private static List<Uri> orderedUris(Intent intent, int maximumItems) throws Failure {
        ArrayList<Uri> result = new ArrayList<>();
        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            if (intent.getData() != null || clipData.getItemCount() <= 0) throw invalid();
            if (clipData.getItemCount() > maximumItems) throw limit();
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri == null) throw invalid();
                result.add(uri);
            }
        } else {
            Uri uri = intent.getData();
            if (uri == null) throw invalid();
            result.add(uri);
        }
        Set<String> unique = new HashSet<>();
        for (Uri uri : result) {
            if (!unique.add(uri.toString())) throw invalid();
        }
        return result;
    }

    private static void checkCancelled(
            OwnedPendingImportStore.CancellationSignal cancellation) throws Failure {
        if (Thread.currentThread().isInterrupted() || cancellation.isCancelled()) {
            throw cancelledFailure();
        }
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
    private static Failure cancelledFailure() {
        return new Failure("DOCUMENT_CANCELLED", "The document operation was cancelled.");
    }

    public static final class Result {
        private final String status;
        private final String batchRef;
        private final List<String> itemRefs;
        private Result(String status, String batchRef, List<String> itemRefs) {
            this.status = status;
            this.batchRef = batchRef;
            this.itemRefs = Collections.unmodifiableList(new ArrayList<>(itemRefs));
        }
        static Result cancelled() { return new Result("cancelled", null, List.of()); }
        static Result accepted(String batchRef, List<String> itemRefs) {
            return new Result("accepted", batchRef, itemRefs);
        }
        public String status() { return status; }
        public String batchRef() { return batchRef; }
        public List<String> itemRefs() { return itemRefs; }
    }

    public static final class Failure extends Exception {
        private final String code;
        private Failure(String code, String message) {
            super(message);
            this.code = code;
        }
        public String code() { return code; }
    }

    interface Resolver {
        String mimeType(Uri uri) throws IOException;
        long sizeBytes(Uri uri) throws IOException;
        InputStream open(Uri uri) throws IOException;
        void takePersistableReadPermission(Uri uri) throws SecurityException;
    }

    private static final class ContentResolverAdapter implements Resolver {
        private final ContentResolver resolver;
        ContentResolverAdapter(ContentResolver resolver) { this.resolver = resolver; }

        @Override public String mimeType(Uri uri) { return resolver.getType(uri); }

        @Override public long sizeBytes(Uri uri) throws IOException {
            try (Cursor cursor = resolver.query(
                    uri, new String[] {OpenableColumns.SIZE}, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0)) {
                    throw new IOException("Size unavailable");
                }
                return cursor.getLong(0);
            }
        }

        @Override public InputStream open(Uri uri) throws IOException {
            InputStream input = resolver.openInputStream(uri);
            if (input == null) throw new IOException("Input unavailable");
            return input;
        }

        @Override public void takePersistableReadPermission(Uri uri) {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
    }
}
