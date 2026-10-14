package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * A PDF handed to this app by another one.
 *
 * Chrome, Gmail and Files all pass a document the same way the system picker
 * does: a content URI plus a read grant. That is exactly the shape
 * {@link DocumentLifecycleCoordinator#handlePickerResult} already accepts, so an
 * incoming document walks the same validation, size limit and copy-into-owned-
 * storage path as one the reader picked themselves. Nothing here trusts the
 * sending app beyond the URI it granted.
 */
public final class IncomingPdfIntake {
    private static final String MIME_PDF = "application/pdf";
    private static final int SINGLE_ITEM = 1;

    private final PickerRequestPolicy requestPolicy;

    public IncomingPdfIntake() {
        this(new PickerRequestPolicy());
    }

    IncomingPdfIntake(PickerRequestPolicy requestPolicy) {
        this.requestPolicy = Objects.requireNonNull(requestPolicy);
    }

    /** True when this intent is another app handing over a single PDF. */
    public static boolean isIncomingPdf(Intent intent) {
        if (intent == null) return false;
        try {
            String action = intent.getAction();
            if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return false;
            if (intent.hasCategory(Intent.CATEGORY_BROWSABLE)) return false;
            Uri uri = uriOf(intent);
            return uri != null && "content".equals(uri.getScheme())
                    && (intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
        } catch (RuntimeException malformedExtra) {
            return false;
        }
    }

    /**
     * Copy the handed-over PDF into owned storage.
     *
     * Blocking: the bytes are read here, so this belongs off the main thread.
     * Returns the owned reference the reader can open, or null when the
     * intent carried nothing this app will accept.
     */
    public String accept(DocumentLifecycleCoordinator coordinator, Intent intent)
            throws DocumentLifecycleCoordinator.Failure {
        return accept(coordinator, intent, null);
    }

    /**
     * As {@link #accept(DocumentLifecycleCoordinator, Intent)}, keeping the name the
     * sending app gave the file. Without it every PDF opened from Files, WhatsApp or
     * Gmail showed as "Document", and every later save was called "edited-Document".
     * Opening the same file again reuses its existing copy instead of adding another
     * identical row to Recent.
     */
    public String accept(DocumentLifecycleCoordinator coordinator, Intent intent,
            String sourceDisplayName) throws DocumentLifecycleCoordinator.Failure {
        String ref = importCopy(coordinator, intent);
        String name = safeDisplayName(sourceDisplayName);
        if (ref == null || name == null) return ref;
        try {
            DocumentLifecycleCoordinator.DocumentRecord named =
                    coordinator.renameOwnedDocument(ref, name);
            for (DocumentLifecycleCoordinator.DocumentRecord existing
                    : coordinator.listOwnedDocuments()) {
                if (!existing.ref().equals(ref) && existing.available()
                        && name.equals(existing.displayName())
                        && named.contentHash().equals(existing.contentHash())
                        && named.sizeBytes() == existing.sizeBytes()) {
                    coordinator.deleteOwnedDocument(ref);
                    return existing.ref();
                }
            }
        } catch (DocumentLifecycleCoordinator.Failure | RuntimeException ignored) {
            // The copy is already safe under its unnamed ref; a name is a courtesy.
        }
        return ref;
    }

    /** The sender's name for the handed-over file, or null when it gives none. */
    public static String sourceDisplayName(ContentResolver resolver, Intent intent) {
        if (resolver == null || !isIncomingPdf(intent)) return null;
        return displayNameOf(resolver, uriOf(intent));
    }

    /** True when Android relaunched the task from Recents with its original intent. */
    public static boolean isReplayedFromRecents(int intentFlags) {
        return (intentFlags & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
    }

    /** The provider's name for one content URI, or null when it gives none. */
    static String displayNameOf(ContentResolver resolver, Uri uri) {
        if (resolver == null || uri == null) return null;
        try (Cursor cursor = resolver.query(uri,
                new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0)) return null;
            return cursor.getString(0);
        } catch (RuntimeException unreadable) {
            return null;
        }
    }

    /** A sender-supplied name made safe for owned storage, always ending in .pdf. */
    static String safeDisplayName(String value) {
        if (value == null) return null;
        String name = value.replace('\0', ' ').replace('/', '-').replace('\\', '-')
                .replaceAll("[\\p{Cntrl}]", " ").trim();
        if (name.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
            name = name.substring(0, name.length() - 4);
        }
        name = name.replaceAll("[\\s.]+$", "");
        if (name.length() > 120) name = name.substring(0, 120).trim();
        if (name.isEmpty()) return null;
        name = name + ".pdf";
        return OwnedDocumentWritePolicy.isValidDisplayName(name) ? name : null;
    }

    private String importCopy(DocumentLifecycleCoordinator coordinator, Intent intent)
            throws DocumentLifecycleCoordinator.Failure {
        if (coordinator == null || !isIncomingPdf(intent)) return null;
        Intent normalized = asPickerShapedIntent(intent);
        if (normalized == null) return null;
        PickerRequestPolicy.Request request;
        try {
            request = requestPolicy.create(true, List.of(MIME_PDF), SINGLE_ITEM);
        } catch (PickerRequestPolicy.Failure failure) {
            return null;
        }
        AndroidDocumentPickerController.Result result = coordinator.handlePickerResult(
                request, Activity.RESULT_OK, normalized, Thread.currentThread()::isInterrupted);
        if (result == null || "cancelled".equals(result.status())) return null;
        coordinator.acknowledgePendingImports(result.batchRef(), result.itemRefs(),
                Thread.currentThread()::isInterrupted);
        return result.itemRefs().get(0);
    }

    /**
     * A share puts the document in an extra rather than the intent's data, which
     * is the one shape the picker path does not read. Move it across, keeping
     * the read grant that came with the delivery.
     */
    private static Intent asPickerShapedIntent(Intent intent) {
        Uri uri = uriOf(intent);
        if (uri == null) return null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getClipData() == null) {
            return intent;
        }
        Intent shaped = new Intent(Intent.ACTION_VIEW);
        shaped.setData(uri);
        shaped.addFlags(intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION));
        return shaped;
    }

    /**
     * The typed overload of getParcelableExtra only exists from API 33, and this
     * app runs from 29. Reading it the old way on older releases keeps a shared
     * PDF from crashing the app it was handed to.
     */
    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        android.os.Parcelable extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return extra instanceof Uri uri ? uri : null;
    }

    private static Uri uriOf(Intent intent) {
        Uri data = intent.getData();
        if (data != null) return data;
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return null;
        Uri stream = streamExtra(intent);
        if (stream != null) return stream;
        return intent.getClipData() != null && intent.getClipData().getItemCount() > 0
                ? intent.getClipData().getItemAt(0).getUri()
                : null;
    }
}
