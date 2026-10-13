package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class AndroidDocumentDeliveryInstrumentedTest {
    @Test public void mediaStoreUsesPendingPublicationAndRollbackWithoutStoragePermission()
            throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ContentResolver resolver = context.getContentResolver();
        String finalName = "pdfchef-t039-" + UUID.randomUUID() + ".pdf";
        Uri published = null;
        try {
            byte[] document = "%PDF-1.7\nactual MediaStore bytes\n%%EOF".getBytes();
            String token = "abcdefghijklmnopqrstuv";
            CountDownLatch allocated = new CountDownLatch(1);
            CountDownLatch inspectComplete = new CountDownLatch(1);
            RecordingDestination recording = new RecordingDestination(
                    new AndroidDocumentExporter.MediaStoreDestination(resolver));
            AndroidDocumentExporter exporter = new AndroidDocumentExporter(
                    context.getFilesDir().toPath(), recording,
                    System::currentTimeMillis, () -> token,
                    required -> context.getFilesDir().getUsableSpace(), checkpoint -> {
                        if (checkpoint == AndroidDocumentExporter.Checkpoint.AFTER_PENDING_ROW) {
                            allocated.countDown();
                            try {
                                if (!inspectComplete.await(10, TimeUnit.SECONDS)) {
                                    throw new java.io.IOException("inspection timeout");
                                }
                            } catch (InterruptedException failure) {
                                Thread.currentThread().interrupt();
                                throw new java.io.IOException("inspection interrupted", failure);
                            }
                        }
                    });
            FutureTask<Boolean> export = new FutureTask<>(() -> exporter.export(
                    source(document), finalName, AndroidDocumentIngressPolicy.MIME_PDF,
                    () -> false).completedValue());
            Thread worker = new Thread(export, "t039-export");
            worker.start();
            assertTrue(allocated.await(10, TimeUnit.SECONDS));
            Uri pending = Uri.parse(recording.address);
            assertNotNull(pending);
            assertEquals(1, pendingValue(resolver, pending));
            inspectComplete.countDown();
            assertTrue(export.get(20, TimeUnit.SECONDS));
            published = findByName(resolver, finalName);
            assertNotNull(published);
            assertEquals(0, pendingValue(resolver, published));
            assertEquals(document.length, sizeValue(resolver, published));

            String rollbackToken = "zyxwvutsrqponmlkjihgfe";
            RecordingDestination rollbackRecording = new RecordingDestination(
                    new AndroidDocumentExporter.MediaStoreDestination(resolver));
            AndroidDocumentExporter rollbackExporter = new AndroidDocumentExporter(
                    context.getFilesDir().toPath(), rollbackRecording,
                    System::currentTimeMillis, () -> rollbackToken,
                    required -> context.getFilesDir().getUsableSpace(), checkpoint -> {
                        if (checkpoint == AndroidDocumentExporter.Checkpoint.AFTER_PENDING_ROW) {
                            throw new java.io.IOException("rollback checkpoint");
                        }
                    });
            try {
                rollbackExporter.export(source(document), "must-not-publish.pdf",
                        AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
                fail("Expected rollback failure");
            } catch (AndroidDocumentExporter.Failure failure) {
                assertEquals("DOCUMENT_FAILED", failure.code());
            }
            assertFalse(exists(resolver, Uri.parse(rollbackRecording.address)));
            assertEquals(null, findByName(resolver, "must-not-publish.pdf"));
        } finally {
            if (published != null) resolver.delete(published, null, null);
        }
    }

    private static OwnedDocumentWriter.DocumentSource source(byte[] bytes) {
        return new OwnedDocumentWriter.DocumentSource() {
            @Override public String mimeType() { return AndroidDocumentIngressPolicy.MIME_PDF; }
            @Override public long sizeBytes() { return bytes.length; }
            @Override public int read(long offset, byte[] target) {
                if (offset >= bytes.length) return 0;
                int count = Math.min(target.length, bytes.length - (int) offset);
                System.arraycopy(bytes, (int) offset, target, 0, count);
                return count;
            }
        };
    }

    @Test public void shareIntentIsContentOnlyReadOnlyAndStageIsNarrow() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = new DocumentLifecycleCoordinator(context);
        Field graphField = DocumentLifecycleCoordinator.class.getDeclaredField("graph");
        graphField.setAccessible(true);
        assertEquals(null, graphField.get(coordinator));
        DocumentLifecycleCoordinator.WriteSession session = coordinator.beginWrite(
                AndroidDocumentIngressPolicy.MIME_PDF);
        Object graph = graphField.get(coordinator);
        assertNotNull(graph);
        Field pendingField = graph.getClass().getDeclaredField("pendingStore");
        pendingField.setAccessible(true);
        Field pickerField = graph.getClass().getDeclaredField("picker");
        pickerField.setAccessible(true);
        Object picker = pickerField.get(graph);
        assertNotNull(picker);
        Field pickerStore = AndroidDocumentPickerController.class.getDeclaredField("store");
        pickerStore.setAccessible(true);
        assertSame(pendingField.get(graph), pickerStore.get(picker));
        coordinator.appendWrite(session.sessionId(), "%PDF-1.7\nshare\n%%EOF".getBytes(),
                () -> false);
        DocumentLifecycleCoordinator.DocumentRecord document = coordinator.finishWrite(
                session.sessionId(), () -> false);
        DocumentLifecycleCoordinator.ShareHandle handle = coordinator.prepareShare(document.ref(),
                AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
        Path staged = coordinator.stagedSharePath(handle);
        Uri content = new Uri.Builder().scheme("content")
                .authority(context.getPackageName() + ".fileprovider")
                .appendPath("pdfchef_share_staging")
                .appendPath(staged.getFileName().toString()).build();
        String authority = context.getPackageName() + ".fileprovider";
        Uri[] invalidUris = new Uri[] {
                content.buildUpon().path("pdfchef_share_staging/other.bin").build(),
                Uri.parse("content://" + authority + "/wrong/" + staged.getFileName()),
                Uri.parse("content://" + authority + "/pdfchef_share_staging/extra/"
                        + staged.getFileName()),
                Uri.parse("content://" + authority + "/pdfchef_share_staging/%2e%2e%2f"
                        + staged.getFileName()),
                content.buildUpon().appendQueryParameter("x", "1").build(),
                content.buildUpon().fragment("x").build(),
                Uri.parse("content://user@" + authority + "/pdfchef_share_staging/"
                        + staged.getFileName()),
                Uri.parse("content://" + authority + ":443/pdfchef_share_staging/"
                        + staged.getFileName()),
                content.buildUpon().appendQueryParameter("displayName", "One.pdf")
                        .appendQueryParameter("displayName", "Two.pdf").build(),
                content.buildUpon().appendQueryParameter("displayName", "../private.pdf").build(),
                Uri.parse(content + "?displayName=Shared%2epdf")
        };
        for (Uri invalidUri : invalidUris) {
            try {
                coordinator.createShareIntent(handle, invalidUri);
                fail("Expected exact stage URI rejection for " + invalidUri);
            } catch (DocumentLifecycleCoordinator.Failure failure) {
                assertEquals("DOCUMENT_INVALID_ARGUMENT", failure.code());
            }
        }
        Uri namedContent = content.buildUpon()
                .appendQueryParameter("displayName", "Scanned document ₹.pdf")
                .build();
        Intent namedIntent = coordinator.createShareIntent(handle, namedContent);
        assertEquals(namedContent,
                namedIntent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class));
        assertEquals(namedContent, namedIntent.getClipData().getItemAt(0).getUri());
        Intent intent = coordinator.createShareIntent(handle, content);
        assertEquals(Intent.ACTION_SEND, intent.getAction());
        assertEquals(AndroidDocumentIngressPolicy.MIME_PDF, intent.getType());
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.getFlags());
        assertEquals(content, intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class));
        ClipData clipData = intent.getClipData();
        assertNotNull(clipData);
        assertEquals(1, clipData.getItemCount());
        assertEquals(content, clipData.getItemAt(0).getUri());
        assertFalse((intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0);
        assertFalse((intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0);
        assertFalse((intent.getFlags() & Intent.FLAG_GRANT_PREFIX_URI_PERMISSION) != 0);
        assertTrue(staged.toRealPath().startsWith(
                context.getFilesDir().toPath().resolve("pdfchef_documents/share").toRealPath()));
        coordinator.cancelShareBeforeDispatch(handle);
        assertFalse(Files.exists(staged));

        DocumentLifecycleCoordinator.ShareHandle dispatched = coordinator.prepareShare(
                document.ref(), AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
        Path retained = coordinator.stagedSharePath(dispatched);
        coordinator.markShareDispatched(dispatched);
        coordinator.cancelShareBeforeDispatch(dispatched);
        assertTrue(Files.exists(retained));
        Files.deleteIfExists(retained);
        Files.deleteIfExists(shareMetadata(retained));
        assertTrue(coordinator.deleteOwnedDocument(document.ref()));
    }

    private static Path shareMetadata(Path staged) {
        String name = staged.getFileName().toString();
        int extension = name.lastIndexOf('.');
        if (extension <= 0) throw new IllegalArgumentException("share stage");
        return staged.resolveSibling(name.substring(0, extension) + ".share");
    }

    private static int countInternalPending(ContentResolver resolver) {
        String selection = MediaStore.Downloads.DISPLAY_NAME + " LIKE ? AND "
                + MediaStore.Downloads.IS_PENDING + "=1";
        try (Cursor cursor = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[] {MediaStore.Downloads._ID}, selection,
                new String[] {"pdfchef-%"}, null)) {
            return cursor == null ? 0 : cursor.getCount();
        }
    }

    private static Uri findByName(ContentResolver resolver, String name) {
        try (Cursor cursor = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[] {MediaStore.Downloads._ID},
                MediaStore.Downloads.DISPLAY_NAME + "=?", new String[] {name}, null)) {
            if (cursor == null || !cursor.moveToFirst()) return null;
            return Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    Long.toString(cursor.getLong(0)));
        }
    }

    private static int pendingValue(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri,
                new String[] {MediaStore.Downloads.IS_PENDING}, null, null, null)) {
            assertNotNull(cursor); assertTrue(cursor.moveToFirst()); return cursor.getInt(0);
        }
    }

    private static long sizeValue(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri,
                new String[] {MediaStore.Downloads.SIZE}, null, null, null)) {
            assertNotNull(cursor); assertTrue(cursor.moveToFirst()); return cursor.getLong(0);
        }
    }

    private static boolean exists(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri,
                new String[] {MediaStore.Downloads._ID}, null, null, null)) {
            return cursor != null && cursor.moveToFirst();
        }
    }

    private static final class RecordingDestination implements AndroidDocumentExporter.Destination {
        private final AndroidDocumentExporter.Destination delegate;
        volatile String address;
        RecordingDestination(AndroidDocumentExporter.Destination delegate) {
            this.delegate = delegate;
        }
        @Override public String allocate(String token, String mimeType) throws java.io.IOException {
            address = delegate.allocate(token, mimeType); return address;
        }
        @Override public Output open(String value) throws java.io.IOException {
            return delegate.open(value);
        }
        @Override public void publish(String value, String name, String mime, long size)
                throws java.io.IOException {
            delegate.publish(value, name, mime, size);
        }
        @Override public AndroidDocumentExporter.PublicationState publicationState(String value)
                throws java.io.IOException {
            return delegate.publicationState(value);
        }
        @Override public void deleteAddress(String value) throws java.io.IOException {
            delegate.deleteAddress(value);
        }
        @Override public void deletePendingToken(String token) throws java.io.IOException {
            delegate.deletePendingToken(token);
        }
    }
}
