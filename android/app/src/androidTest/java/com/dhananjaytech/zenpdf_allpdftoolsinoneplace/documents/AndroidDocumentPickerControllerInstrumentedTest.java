package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class AndroidDocumentPickerControllerInstrumentedTest {
    private static final byte[] PDF = "%PDF-1.7\nowned\n%%EOF".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] PNG = new byte[] {
            (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4};

    @Test public void createsNarrowUnregisteredPickerIntent() throws Exception {
        Fixture fixture = fixture();
        PickerRequestPolicy.Request request = fixture.policy.create(true,
                List.of(AndroidDocumentIngressPolicy.MIME_PDF,
                        AndroidDocumentIngressPolicy.MIME_PNG), 2);
        Intent intent = fixture.controller.createIntent(request);
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("*/*", intent.getType());
        assertArrayEquals(request.acceptedMimeTypes().toArray(new String[0]),
                intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0);
        assertFalse((intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0);
        assertNull(intent.getComponent());
    }

    @Test public void cancellationIsSideEffectFree() throws Exception {
        Fixture fixture = fixture();
        PickerRequestPolicy.Request request = fixture.policy.create(
                true, List.of(AndroidDocumentIngressPolicy.MIME_PDF), 1);
        AndroidDocumentPickerController.Result result = fixture.controller.handleResult(
                request, Activity.RESULT_CANCELED, null, () -> false);
        assertEquals("cancelled", result.status());
        assertNull(result.batchRef());
        assertTrue(result.itemRefs().isEmpty());
        assertEquals(0, fixture.resolver.openCalls);
        assertTrue(fixture.store.listPending().isEmpty());
    }

    @Test public void simulatedOrderedSelectionStagesBeforeReturnDespiteGrantFailureAndRecreation()
            throws Exception {
        Fixture fixture = fixture();
        Uri pdf = Uri.parse("content://private.provider/first.pdf");
        Uri png = Uri.parse("content://private.provider/second.png");
        fixture.resolver.add(pdf, AndroidDocumentIngressPolicy.MIME_PDF, PDF);
        fixture.resolver.add(png, AndroidDocumentIngressPolicy.MIME_PNG, PNG);
        fixture.resolver.failPersist = true;

        PickerRequestPolicy.Request original = fixture.policy.create(true,
                List.of(AndroidDocumentIngressPolicy.MIME_PDF,
                        AndroidDocumentIngressPolicy.MIME_PNG), 2);
        PickerRequestPolicy.Request restored = fixture.policy.restore(
                original.sessionRef(), original.acceptedMimeTypes(), original.maximumItems());

        Intent resultIntent = new Intent();
        ClipData clip = ClipData.newRawUri("ordered", pdf);
        clip.addItem(new ClipData.Item(png));
        resultIntent.setClipData(clip);
        resultIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);

        AndroidDocumentPickerController.Result result = fixture.controller.handleResult(
                restored, Activity.RESULT_OK, resultIntent, () -> false);
        assertEquals("accepted", result.status());
        assertEquals(List.of(
                fixture.policy.documentRef(restored, 0),
                fixture.policy.documentRef(restored, 1)), result.itemRefs());
        assertEquals(PendingImportBatch.batchRef(result.itemRefs()), result.batchRef());
        assertFalse(original.sessionRef().equals(result.batchRef()));
        assertEquals(2, fixture.resolver.persistCalls);

        fixture.resolver.revoked = true;
        assertEquals(result.itemRefs().get(0), fixture.store.load(result.itemRefs().get(0)).ref());
        assertEquals(result.itemRefs().get(1), fixture.store.load(result.itemRefs().get(1)).ref());
        assertEquals(2, fixture.store.listPending().size());
        assertTrue(fixture.resolver.openFailsWhenRevoked());
    }

    @Test public void actualContentResolverCopiesExactMediaStoreItemBeforeProviderDeletion()
            throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME,
                "pdfchef-t037-" + UUID.randomUUID() + ".pdf");
        values.put(MediaStore.Downloads.MIME_TYPE, AndroidDocumentIngressPolicy.MIME_PDF);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        assertTrue("MediaStore insert failed", uri != null);

        Path base = context.getCacheDir().toPath().resolve("picker-real-" + UUID.randomUUID());
        Files.createDirectory(base);
        OwnedPendingImportStore store = new OwnedPendingImportStore(base);
        PickerRequestPolicy policy = new PickerRequestPolicy();
        AndroidDocumentPickerController controller =
                new AndroidDocumentPickerController(context, store);
        try {
            try (OutputStream output = resolver.openOutputStream(uri, "w")) {
                assertTrue("MediaStore output unavailable", output != null);
                output.write(PDF);
            }
            ContentValues published = new ContentValues();
            published.put(MediaStore.Downloads.IS_PENDING, 0);
            assertEquals(1, resolver.update(uri, published, null, null));

            PickerRequestPolicy.Request request = policy.create(
                    true, List.of(AndroidDocumentIngressPolicy.MIME_PDF), 1);
            Intent resultIntent = new Intent().setData(uri).addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            AndroidDocumentPickerController.Result result = controller.handleResult(
                    request, Activity.RESULT_OK, resultIntent, () -> false);

            String expectedRef = policy.documentRef(request, 0);
            assertEquals("accepted", result.status());
            assertEquals(List.of(expectedRef), result.itemRefs());
            assertEquals(PendingImportBatch.batchRef(result.itemRefs()), result.batchRef());
            assertFalse(request.sessionRef().equals(result.batchRef()));
            assertEquals(expectedRef, store.load(expectedRef).ref());

            assertEquals(1, resolver.delete(uri, null, null));
            uri = null;
            assertTrue(providerItemIsUnavailable(resolver, resultIntent.getData()));
            assertEquals(expectedRef, store.load(expectedRef).ref());
        } finally {
            if (uri != null) resolver.delete(uri, null, null);
        }
    }

    @Test public void simulatedPartialBatchFailureRollsBackThenRetriesInOriginalOrder()
            throws Exception {
        Fixture fixture = fixture();
        Uri first = Uri.parse("content://private.provider/source-first.pdf");
        Uri second = Uri.parse("content://private.provider/source-second.png");
        fixture.resolver.add(first, AndroidDocumentIngressPolicy.MIME_PDF, PDF);
        fixture.resolver.add(second, AndroidDocumentIngressPolicy.MIME_PNG, PNG);
        fixture.resolver.failOpen(second, 2);

        PickerRequestPolicy.Request original = fixture.policy.create(true,
                List.of(AndroidDocumentIngressPolicy.MIME_PDF,
                        AndroidDocumentIngressPolicy.MIME_PNG), 2);
        Intent resultIntent = new Intent();
        ClipData clip = ClipData.newRawUri("ordered-partial", first);
        clip.addItem(new ClipData.Item(second));
        resultIntent.setClipData(clip);
        resultIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        assertFailure("DOCUMENT_UNAVAILABLE", () -> fixture.controller.handleResult(
                original, Activity.RESULT_OK, resultIntent, () -> false));
        String firstRef = fixture.policy.documentRef(original, 0);
        String secondRef = fixture.policy.documentRef(original, 1);
        assertTrue(fixture.store.listPending().isEmpty());
        assertNull(fixture.store.takeCompleteBatch(100));
        try (var paths = Files.walk(fixture.base)) {
            assertFalse(paths.anyMatch(Files::isRegularFile));
        }

        fixture.resolver.clearOpenFailure();
        PickerRequestPolicy.Request restored = fixture.policy.restore(
                original.sessionRef(), original.acceptedMimeTypes(), original.maximumItems());
        AndroidDocumentPickerController.Result retried = fixture.controller.handleResult(
                restored, Activity.RESULT_OK, resultIntent, () -> false);

        assertEquals("accepted", retried.status());
        assertEquals(List.of(firstRef, secondRef), retried.itemRefs());
        assertEquals(PendingImportBatch.batchRef(retried.itemRefs()), retried.batchRef());
        assertFalse(original.sessionRef().equals(retried.batchRef()));
        List<String> pendingRefs = refs(fixture.store.listPending());
        assertEquals(2, pendingRefs.size());
        assertTrue(pendingRefs.contains(firstRef));
        assertTrue(pendingRefs.contains(secondRef));
        assertTreeDoesNotContain(fixture.base,
                "content://", "private.provider", "source-first.pdf", "source-second.png");
    }

    @Test public void rejectsMissingReadGrantDuplicatesAndRevokedProviderGenerically()
            throws Exception {
        Fixture fixture = fixture();
        Uri pdf = Uri.parse("content://private.provider/name.pdf");
        fixture.resolver.add(pdf, AndroidDocumentIngressPolicy.MIME_PDF, PDF);
        PickerRequestPolicy.Request request = fixture.policy.create(
                true, List.of(AndroidDocumentIngressPolicy.MIME_PDF), 2);

        Intent noGrant = new Intent().setData(pdf);
        assertFailure("DOCUMENT_UNAVAILABLE", () -> fixture.controller.handleResult(
                request, Activity.RESULT_OK, noGrant, () -> false));

        Intent duplicate = new Intent();
        ClipData clip = ClipData.newRawUri("duplicate", pdf);
        clip.addItem(new ClipData.Item(pdf));
        duplicate.setClipData(clip);
        duplicate.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> fixture.controller.handleResult(
                request, Activity.RESULT_OK, duplicate, () -> false));

        fixture.resolver.revoked = true;
        Intent revoked = new Intent().setData(pdf)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            fixture.controller.handleResult(request, Activity.RESULT_OK, revoked, () -> false);
            fail("Expected unavailable");
        } catch (AndroidDocumentPickerController.Failure failure) {
            assertEquals("DOCUMENT_UNAVAILABLE", failure.code());
            assertEquals("The document is unavailable.", failure.getMessage());
            assertFalse(failure.getMessage().contains("provider"));
        }
    }

    private static Fixture fixture() throws Exception {
        Path base = InstrumentationRegistry.getInstrumentation().getTargetContext()
                .getCacheDir().toPath().resolve("picker-" + UUID.randomUUID());
        Files.createDirectory(base);
        FakeResolver resolver = new FakeResolver();
        PickerRequestPolicy policy = new PickerRequestPolicy();
        OwnedPendingImportStore store = new OwnedPendingImportStore(base);
        AndroidDocumentPickerController controller = new AndroidDocumentPickerController(
                resolver, store, policy, new AndroidDocumentIngressPolicy());
        return new Fixture(base, resolver, policy, store, controller);
    }

    private static boolean providerItemIsUnavailable(ContentResolver resolver, Uri uri) {
        try (InputStream input = resolver.openInputStream(uri)) {
            return input == null;
        } catch (IOException | SecurityException expected) {
            return true;
        }
    }

    private static List<String> refs(List<PendingImportRecord> records) {
        ArrayList<String> refs = new ArrayList<>(records.size());
        for (PendingImportRecord record : records) refs.add(record.ref());
        return refs;
    }

    private static void assertTreeDoesNotContain(Path root, String... forbidden)
            throws IOException {
        try (var paths = Files.walk(root)) {
            for (Path path : (Iterable<Path>) paths::iterator) {
                String text = path.toString();
                if (Files.isRegularFile(path)) {
                    text += "\n" + new String(Files.readAllBytes(path), StandardCharsets.ISO_8859_1);
                }
                for (String value : forbidden) assertFalse(text.contains(value));
            }
        }
    }

    private static void assertFailure(String code, ThrowingRunnable runnable) throws Exception {
        try {
            runnable.run();
            fail("Expected " + code);
        } catch (AndroidDocumentPickerController.Failure failure) {
            assertEquals(code, failure.code());
        }
    }

    private static final class Fixture {
        final Path base;
        final FakeResolver resolver;
        final PickerRequestPolicy policy;
        final OwnedPendingImportStore store;
        final AndroidDocumentPickerController controller;
        Fixture(Path base, FakeResolver resolver, PickerRequestPolicy policy,
                OwnedPendingImportStore store, AndroidDocumentPickerController controller) {
            this.base = base;
            this.resolver = resolver;
            this.policy = policy;
            this.store = store;
            this.controller = controller;
        }
    }

    private static final class FakeResolver implements AndroidDocumentPickerController.Resolver {
        final Map<Uri, Entry> entries = new LinkedHashMap<>();
        boolean failPersist;
        boolean revoked;
        int persistCalls;
        int openCalls;
        Uri failOpenUri;
        int failOpenCall;
        final Map<Uri, Integer> perUriOpenCalls = new LinkedHashMap<>();

        void add(Uri uri, String mimeType, byte[] bytes) {
            entries.put(uri, new Entry(mimeType, bytes.clone()));
        }

        void failOpen(Uri uri, int call) {
            failOpenUri = uri;
            failOpenCall = call;
        }

        void clearOpenFailure() {
            failOpenUri = null;
            failOpenCall = 0;
        }

        @Override public String mimeType(Uri uri) throws IOException {
            return entry(uri).mimeType;
        }

        @Override public long sizeBytes(Uri uri) throws IOException {
            return entry(uri).bytes.length;
        }

        @Override public InputStream open(Uri uri) throws IOException {
            openCalls++;
            int uriCalls = perUriOpenCalls.getOrDefault(uri, 0) + 1;
            perUriOpenCalls.put(uri, uriCalls);
            if (uri.equals(failOpenUri) && uriCalls == failOpenCall) {
                throw new IOException("simulated partial provider failure");
            }
            return new ByteArrayInputStream(entry(uri).bytes);
        }

        @Override public void takePersistableReadPermission(Uri uri) {
            persistCalls++;
            if (failPersist) throw new SecurityException("simulated revoked grant");
        }

        boolean openFailsWhenRevoked() {
            try {
                open(entries.keySet().iterator().next());
                return false;
            } catch (IOException expected) {
                return true;
            }
        }

        private Entry entry(Uri uri) throws IOException {
            if (revoked) throw new IOException("simulated provider revocation");
            Entry entry = entries.get(uri);
            if (entry == null) throw new IOException("missing provider entry");
            return entry;
        }
    }

    private static final class Entry {
        final String mimeType;
        final byte[] bytes;
        Entry(String mimeType, byte[] bytes) {
            this.mimeType = mimeType;
            this.bytes = bytes;
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
