package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.IBinder;
import android.os.Parcel;
import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Cross-UID proof that the T039 stage is exactly read-only and revocable. */
@RunWith(AndroidJUnit4.class)
public final class AndroidDocumentFileProviderInstrumentedTest {
    private static final long TIMEOUT_SECONDS = 20;

    @Test public void exactShareGrantIsReadOnlyNarrowAndRevocableAcrossUid() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Context test = InstrumentationRegistry.getInstrumentation().getContext();
        assertEquals("com.dhananjaytech.pdfchef.debug", target.getPackageName());
        assertNotEquals("recipient must be a separate installed package",
                target.getPackageName(), test.getPackageName());
        int targetUid = target.getApplicationInfo().uid;
        int testUid = test.getPackageManager().getApplicationInfo(test.getPackageName(), 0).uid;
        assertNotEquals("recipient must be a separate UID", targetUid, testUid);

        PdfChefApplication application = (PdfChefApplication) target.getApplicationContext();
        DocumentLifecycleCoordinator coordinator = application.getDocumentLifecycleCoordinator();
        byte[] bytes = "%PDF-1.7\ncross-uid-t040\n%%EOF".getBytes(StandardCharsets.UTF_8);
        DocumentLifecycleCoordinator.WriteSession session = null;
        DocumentLifecycleCoordinator.DocumentRecord document = null;
        DocumentLifecycleCoordinator.ShareHandle handle = null;
        Path staged = null;
        File outside = new File(target.getFilesDir(), "t040-outside-private.pdf");
        BoundRecipient recipient = null;
        Uri content = null;
        ComponentName component = new ComponentName(test.getPackageName(),
                DocumentRecipientProbeService.class.getName());
        try {
            session = coordinator.beginWrite(AndroidDocumentIngressPolicy.MIME_PDF);
            coordinator.appendWrite(session.sessionId(), bytes, () -> false);
            document = coordinator.finishWrite(session.sessionId(), () -> false);
            handle = coordinator.prepareShare(document.ref(),
                    AndroidDocumentIngressPolicy.MIME_PDF, () -> false);
            staged = coordinator.stagedSharePath(handle);
            String authority = target.getPackageName() + ".fileprovider";
            content = FileProvider.getUriForFile(target, authority, staged.toFile());
            assertEquals("content", content.getScheme());
            assertEquals(authority, content.getAuthority());
            assertEquals("/pdfchef_share_staging/" + staged.getFileName(), content.getPath());
            assertEquals("application/pdf", target.getContentResolver().getType(content));
            assertArrayEquals(bytes, Files.readAllBytes(staged));

            Intent share = coordinator.createShareIntent(handle, content);
            assertEquals(Intent.ACTION_SEND, share.getAction());
            assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, share.getFlags());
            assertFalse((share.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0);
            assertNotNull(share.getClipData());
            assertEquals(content, share.getClipData().getItemAt(0).getUri());

            recipient = BoundRecipient.bind(target, new Intent().setComponent(component));
            assertEquals(testUid, recipient.uid());
            assertFalse("separate UID cannot read before grant", recipient.probe(
                    DocumentRecipientProbeService.READ, content).allowed);

            Intent dispatch = new Intent(share).setComponent(component);
            assertEquals("exact T039 intent dispatch", component, target.startService(dispatch));
            assertArrayEquals("exact T039 intent grants exact bytes", bytes,
                    recipient.probe(DocumentRecipientProbeService.READ, content).bytes);
            coordinator.markShareDispatched(handle);

            for (String operation : new String[] {
                    DocumentRecipientProbeService.WRITE,
                    DocumentRecipientProbeService.TRUNCATE,
                    DocumentRecipientProbeService.INSERT,
                    DocumentRecipientProbeService.UPDATE,
                    DocumentRecipientProbeService.DELETE}) {
                assertFalse(operation + " must be denied", recipient.probe(operation, content).allowed);
            }
            assertArrayEquals(bytes, Files.readAllBytes(staged));

            write(outside, bytes);
            try {
                FileProvider.getUriForFile(target, authority, outside);
                fail("Expected out-of-root file rejection");
            } catch (IllegalArgumentException expected) { }

            Uri traversal = Uri.parse("content://" + authority
                    + "/pdfchef_share_staging/%2e%2e%2f" + outside.getName());
            assertTargetOpenRejected(target, traversal);
            assertFalse("recipient traversal rejected",
                    recipient.probe(DocumentRecipientProbeService.READ, traversal).allowed);
            Uri wrongRoot = Uri.parse("content://" + authority + "/wrong/"
                    + staged.getFileName());
            assertTargetOpenRejected(target, wrongRoot);
            assertFalse("recipient out-of-root URI rejected",
                    recipient.probe(DocumentRecipientProbeService.READ, wrongRoot).allowed);

            target.revokeUriPermission(content, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            assertFalse("revocation removes recipient access", recipient.probe(
                    DocumentRecipientProbeService.READ, content).allowed);
            assertArrayEquals("stage unchanged after revocation", bytes, Files.readAllBytes(staged));
            assertArrayEquals("owned source unchanged", bytes, ownedBytes(target, document.ref()));
        } finally {
            if (content != null) {
                target.revokeUriPermission(content, Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            }
            if (recipient != null) recipient.close();
            target.stopService(new Intent().setComponent(component));
            if (outside.exists()) assertTrue("delete exact outside fixture", outside.delete());
            if (staged != null) {
                Files.deleteIfExists(staged);
                Files.deleteIfExists(shareMetadata(staged));
            }
            cleanupOwned(target, session, document);
        }
    }

    private static Path shareMetadata(Path staged) {
        String name = staged.getFileName().toString();
        int extension = name.lastIndexOf('.');
        if (extension <= 0) throw new IllegalArgumentException("share stage");
        return staged.resolveSibling(name.substring(0, extension) + ".share");
    }

    private static void assertTargetOpenRejected(Context context, Uri uri) throws Exception {
        try {
            context.getContentResolver().openFileDescriptor(uri, "r");
            fail("Expected provider path rejection for " + uri);
        } catch (java.io.FileNotFoundException | SecurityException | IllegalArgumentException expected) { }
    }

    private static void write(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
    }
    private static byte[] ownedBytes(Context context, String ref) throws Exception {
        String payload = ref.substring("d1_".length());
        return Files.readAllBytes(context.getFilesDir().toPath().resolve("pdfchef_documents")
                .resolve("owned").resolve(payload + ".bin"));
    }
    private static void cleanupOwned(Context context,
            DocumentLifecycleCoordinator.WriteSession session,
            DocumentLifecycleCoordinator.DocumentRecord document) throws Exception {
        if (session == null) return;
        Path root = context.getFilesDir().toPath().resolve("pdfchef_documents");
        Files.deleteIfExists(root.resolve("sessions").resolve(session.sessionId() + ".part"));
        Files.deleteIfExists(root.resolve("sessions").resolve(session.sessionId() + ".session"));
        Files.deleteIfExists(root.resolve("operations").resolve(session.sessionId() + ".finish"));
        if (document != null) {
            String payload = document.ref().substring("d1_".length());
            Files.deleteIfExists(root.resolve("owned").resolve(payload + ".bin"));
            Files.deleteIfExists(root.resolve("records").resolve(payload + ".owned"));
        }
    }

    private static final class ProbeResult {
        final boolean allowed;
        final byte[] bytes;
        ProbeResult(boolean allowed, byte[] bytes) {
            this.allowed = allowed;
            this.bytes = bytes;
        }
    }

    private static final class BoundRecipient implements AutoCloseable {
        private final Context context;
        private final ServiceConnection connection;
        private final IBinder binder;
        private boolean closed;
        private BoundRecipient(Context context, ServiceConnection connection, IBinder binder) {
            this.context = context;
            this.connection = connection;
            this.binder = binder;
        }
        static BoundRecipient bind(Context context, Intent intent) throws Exception {
            CountDownLatch connected = new CountDownLatch(1);
            AtomicReference<IBinder> reference = new AtomicReference<>();
            ServiceConnection connection = new ServiceConnection() {
                @Override public void onServiceConnected(ComponentName name, IBinder service) {
                    reference.set(service);
                    connected.countDown();
                }
                @Override public void onServiceDisconnected(ComponentName name) { }
            };
            assertTrue("bind explicit test recipient",
                    context.bindService(intent, connection, Context.BIND_AUTO_CREATE));
            if (!connected.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                context.unbindService(connection);
                throw new AssertionError("recipient bind timeout");
            }
            return new BoundRecipient(context, connection, reference.get());
        }
        int uid() throws Exception {
            ProbeResult result = probe(DocumentRecipientProbeService.UID, null);
            assertTrue(result.allowed);
            return Integer.parseInt(new String(result.bytes, StandardCharsets.US_ASCII));
        }
        ProbeResult probe(String operation, Uri uri) throws Exception {
            Parcel request = Parcel.obtain();
            Parcel response = Parcel.obtain();
            try {
                request.writeInterfaceToken(DocumentRecipientProbeService.DESCRIPTOR);
                request.writeString(operation);
                request.writeString(uri == null ? null : uri.toString());
                assertTrue("recipient Binder transaction", binder.transact(
                        DocumentRecipientProbeService.TRANSACTION_PROBE,
                        request, response, 0));
                response.readException();
                int status = response.readInt();
                byte[] bytes = response.createByteArray();
                if (status < 0) throw new AssertionError("unexpected recipient failure");
                return new ProbeResult(status == 1, bytes);
            } finally {
                request.recycle();
                response.recycle();
            }
        }
        @Override public void close() {
            if (!closed) {
                closed = true;
                context.unbindService(connection);
            }
        }
    }
}
