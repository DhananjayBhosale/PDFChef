package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.MainActivity;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Disposable-emulator proof for the registered Android document bridge. */
@RunWith(AndroidJUnit4.class)
public final class AndroidDocumentsPluginInstrumentedTest {
    private static final long WEB_TIMEOUT_SECONDS = 20;
    private static final AtomicInteger CALL_SEQUENCE = new AtomicInteger();

    @Test public void pickerAndPendingBridgeAreDiscoverableAndCancellationIsNeutral()
            throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            JSONObject discovery = bridgeValue(scenario,
                    "({available:Capacitor.isPluginAvailable('AndroidDocuments'),"
                    + "pick:typeof Capacitor.Plugins.AndroidDocuments.pickDocuments,"
                    + "take:typeof Capacitor.Plugins.AndroidDocuments.takePendingImports,"
                    + "ack:typeof Capacitor.Plugins.AndroidDocuments.acknowledgePendingImports,"
                    + "renameItem:typeof Capacitor.Plugins.AndroidDocuments.renameItem,"
                    + "trashOwned:typeof Capacitor.Plugins.AndroidDocuments.trashOwned,"
                    + "restoreOwned:typeof Capacitor.Plugins.AndroidDocuments.restoreOwned,"
                    + "exportItem:typeof Capacitor.Plugins.AndroidDocuments.exportItem,"
                    + "shareItem:typeof Capacitor.Plugins.AndroidDocuments.shareItem,"
                    + "clearPayloads:typeof Capacitor.Plugins.AndroidDocuments.clearOwnedPayloads,"
                    + "listen:typeof Capacitor.Plugins.AndroidDocuments.addListener})");
            assertTrue(discovery.getBoolean("available"));
            assertEquals("function", discovery.getString("pick"));
            assertEquals("function", discovery.getString("take"));
            assertEquals("function", discovery.getString("ack"));
            assertEquals("function", discovery.getString("renameItem"));
            assertEquals("function", discovery.getString("trashOwned"));
            assertEquals("function", discovery.getString("restoreOwned"));
            assertEquals("function", discovery.getString("exportItem"));
            assertEquals("function", discovery.getString("shareItem"));
            assertEquals("function", discovery.getString("clearPayloads"));
            assertEquals("function", discovery.getString("listen"));

            JSONObject empty = bridgeValue(scenario,
                    "Capacitor.Plugins.AndroidDocuments.takePendingImports({})");
            assertEquals(2, empty.length());
            assertTrue(empty.isNull("batchRef"));
            assertEquals(0, empty.getJSONArray("items").length());
            assertInvalid(bridgeEnvelope(scenario,
                    "Capacitor.Plugins.AndroidDocuments.takePendingImports({extra:true})"));

            String slot = "__pdfChefT902Picker" + CALL_SEQUENCE.incrementAndGet();
            evaluate(scenario, "window['" + slot + "']=null;(async()=>{try{const value=await "
                    + "Capacitor.Plugins.AndroidDocuments.pickDocuments({"
                    + "acceptedMimeTypes:['application/pdf'],maximumItems:1});"
                    + "window['" + slot + "']=JSON.stringify({ok:true,value});}catch(error){"
                    + "window['" + slot + "']=JSON.stringify({ok:false,code:error&&error.code,"
                    + "message:error&&error.message});}})();true");
            Thread.sleep(750);
            try (ParcelFileDescriptor ignored = InstrumentationRegistry.getInstrumentation()
                    .getUiAutomation().executeShellCommand("input keyevent KEYCODE_BACK")) { }

            String encoded = null;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WEB_TIMEOUT_SECONDS);
            while (System.nanoTime() < deadline) {
                try {
                    encoded = evaluate(scenario, "window['" + slot + "']");
                    if (!"null".equals(encoded)) break;
                } catch (IllegalStateException ignored) {
                    // DocumentsUI may still be yielding focus back to MainActivity.
                }
                Thread.sleep(50);
            }
            assertTrue("picker cancellation result", encoded != null && !"null".equals(encoded));
            JSONObject envelope = new JSONObject(new JSONArray("[" + encoded + "]").getString(0));
            assertTrue(envelope.getBoolean("ok"));
            JSONObject cancelled = envelope.getJSONObject("value");
            assertEquals(3, cancelled.length());
            assertEquals("cancelled", cancelled.getString("status"));
            assertTrue(cancelled.isNull("batchRef"));
            assertEquals(0, cancelled.getJSONArray("items").length());
        }
    }

    @Test public void payloadClearKeepsUnavailableRecordAcrossActivityRecreation()
            throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        byte[] bytes = "%PDF-1.7\nt909-payload-clear\n%%EOF"
                .getBytes(StandardCharsets.UTF_8);
        DocumentLifecycleCoordinator.WriteSession session = null;
        DocumentLifecycleCoordinator.DocumentRecord owned = null;
        try {
            session = coordinator.beginWrite("T909 retained record.pdf",
                    AndroidDocumentIngressPolicy.MIME_PDF);
            coordinator.appendWrite(session.sessionId(), bytes, () -> false);
            owned = coordinator.finishWrite(session.sessionId(), () -> false);
            String ref = owned.ref();
            Path payload = context.getFilesDir().toPath().resolve("pdfchef_documents")
                    .resolve("owned").resolve(ref.substring(3) + ".bin");
            assertTrue(Files.exists(payload));

            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                JSONObject cleared = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.clearOwnedPayloads({})");
                assertEquals(1, cleared.length());
                assertEquals(1, cleared.getInt("clearedCount"));
                assertFalse(Files.exists(payload));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.clearOwnedPayloads({extra:true})"));

                JSONObject firstList = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.listOwned({})");
                assertUnavailableOwnedItem(firstList, ref, "T909 retained record.pdf");
                JSONObject unreadable = bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'" + ref
                        + "',offset:0,length:1})");
                assertFalse(unreadable.getBoolean("ok"));
                assertEquals("DOCUMENT_NOT_FOUND", unreadable.getString("code"));

                scenario.recreate();
                JSONObject relaunched = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.listOwned({})");
                assertUnavailableOwnedItem(relaunched, ref, "T909 retained record.pdf");
                JSONObject repeated = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.clearOwnedPayloads({})");
                assertEquals(0, repeated.getInt("clearedCount"));
                JSONObject deleted = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.deleteOwned({ref:'" + ref + "'})");
                assertTrue(deleted.getBoolean("deleted"));
                assertTrue(coordinator.listOwnedDocuments().stream()
                        .noneMatch(item -> ref.equals(item.ref())));
            }
        } finally {
            cleanupOwned(context, session, owned);
        }
    }

    @Test public void nativeExportAndShareCompleteWithoutBridgeAddresses() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        byte[] bytes = "%PDF-1.7\nt903-delivery\n%%EOF"
                .getBytes(StandardCharsets.UTF_8);
        byte[] legacyBytes = "%PDF-1.7\nt903-legacy-delivery\n%%EOF"
                .getBytes(StandardCharsets.UTF_8);
        String exportName = "T903-" + UUID.randomUUID() + ".pdf";
        String legacyExportName = "T903-Legacy-" + UUID.randomUUID() + ".pdf";
        DocumentLifecycleCoordinator.WriteSession session = null;
        DocumentLifecycleCoordinator.DocumentRecord owned = null;
        Uri exported = null;
        Uri legacyExported = null;
        File index = new File(context.getFilesDir(), "processed_index.json");
        File processed = new File(context.getFilesDir(), "processed");
        File legacy = new File(processed, "t903-legacy.pdf");
        Path shareRoot = context.getFilesDir().toPath().resolve("pdfchef_documents/share");
        Set<String> shareBefore = childNames(shareRoot);
        try {
            assertFalse("refuse existing legacy index", index.exists());
            assertFalse("refuse existing legacy fixture", legacy.exists());
            if (!processed.exists()) assertTrue("processed fixture directory", processed.mkdir());
            write(legacy, legacyBytes);
            write(index, "[{\"id\":920903,\"displayName\":\"T903 Legacy.pdf\","
                    + "\"toolName\":\"MERGE\",\"sizeBytes\":" + legacyBytes.length
                    + ",\"createdAtMillis\":3,\"storedFileName\":\"t903-legacy.pdf\","
                    + "\"mimeType\":\"application/pdf\",\"isDirectory\":false}]");
            session = coordinator.beginWrite(exportName, AndroidDocumentIngressPolicy.MIME_PDF);
            coordinator.appendWrite(session.sessionId(), bytes, () -> false);
            owned = coordinator.finishWrite(session.sessionId(), () -> false);
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                JSONObject exportedResult = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.exportItem({ref:'" + owned.ref()
                        + "',displayName:'" + exportName
                        + "',mimeType:'application/pdf'})");
                assertEquals(1, exportedResult.length());
                assertEquals("completed", exportedResult.getString("status"));
                exported = findDownload(context, exportName);
                assertNotNull("published MediaStore row", exported);
                try (java.io.InputStream input = context.getContentResolver()
                        .openInputStream(exported)) {
                    assertNotNull(input);
                    assertArrayEquals(bytes, input.readAllBytes());
                }
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.exportItem({ref:'" + owned.ref()
                        + "',displayName:'" + exportName
                        + "',mimeType:'application/pdf',uri:'content://private'})"));

                JSONObject shared = shareAndDismiss(scenario, owned.ref(), exportName);
                assertEquals(1, shared.length());
                assertEquals("completed", shared.getString("status"));

                JSONObject legacyResult = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.exportItem({ref:'a1_920903',"
                        + "displayName:'" + legacyExportName
                        + "',mimeType:'application/pdf'})");
                assertEquals("completed", legacyResult.getString("status"));
                legacyExported = findDownload(context, legacyExportName);
                assertNotNull("published legacy MediaStore row", legacyExported);
                try (java.io.InputStream input = context.getContentResolver()
                        .openInputStream(legacyExported)) {
                    assertNotNull(input);
                    assertArrayEquals(legacyBytes, input.readAllBytes());
                }
                JSONObject legacyShared = shareAndDismiss(
                        scenario, "a1_920903", "T903 Legacy.pdf");
                assertEquals(1, legacyShared.length());
                assertEquals("completed", legacyShared.getString("status"));
            }
        } finally {
            if (exported != null) context.getContentResolver().delete(exported, null, null);
            if (legacyExported != null) {
                context.getContentResolver().delete(legacyExported, null, null);
            }
            cleanupNewChildren(shareRoot, shareBefore);
            cleanupOwned(context, session, owned);
            if (index.exists()) assertTrue("delete exact legacy index", index.delete());
            if (legacy.exists()) assertTrue("delete exact legacy fixture", legacy.delete());
            if (processed.exists() && processed.list() != null && processed.list().length == 0) {
                assertTrue("delete empty processed fixture directory", processed.delete());
            }
        }
    }

    @Test public void systemBarContrastTracksTheExplicitWebTheme() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            for (boolean light : new boolean[] {false, true}) {
                bridgeValue(scenario, "Capacitor.Plugins.StatusBar.setStyle({style:'" + (light ? "LIGHT" : "DARK") + "'}).then(()=>({done:true}))");
                java.util.concurrent.atomic.AtomicBoolean matched = new java.util.concurrent.atomic.AtomicBoolean();
                long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
                while (!matched.get() && System.nanoTime() < deadline) {
                    scenario.onActivity(activity -> {
                        var controller = androidx.core.view.WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
                        var background = activity.findViewById(android.R.id.content).getBackground();
                        int expected = android.graphics.Color.parseColor(light ? "#f8f5ef" : "#16140f");
                        matched.set(background instanceof android.graphics.drawable.ColorDrawable color
                                && color.getColor() == expected
                                && controller.isAppearanceLightStatusBars() == light
                                && controller.isAppearanceLightNavigationBars() == light);
                    });
                    if (!matched.get()) Thread.sleep(50);
                }
                assertTrue("Inset background and both system icon sets must follow theme " + light, matched.get());
            }
        }
    }

    @Test public void generatedTransientOutputsReachDownloadsWithoutRecentHistory() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        java.io.ByteArrayOutputStream zipBytes = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(zipBytes)) {
            zip.putNextEntry(new java.util.zip.ZipEntry("result.txt"));
            zip.write("Generated ZIP".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        java.io.ByteArrayOutputStream webpBytes = new java.io.ByteArrayOutputStream();
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888);
        assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.WEBP, 90, webpBytes));
        bitmap.recycle();
        byte[][] outputs = {zipBytes.toByteArray(), "Generated text ₹".getBytes(StandardCharsets.UTF_8), webpBytes.toByteArray()};
        String[] mimes = {"application/zip", "text/plain", "image/webp"};
        String[] extensions = {"zip", "txt", "webp"};
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            for (int i = 0; i < outputs.length; i++) {
                String name = "Generated-" + UUID.randomUUID() + "." + extensions[i];
                String ref = null;
                Uri exported = null;
                try {
                    JSONObject session = bridgeValue(scenario, "Capacitor.Plugins.AndroidDocuments.beginWrite({mimeType:'" + mimes[i] + "',displayName:'" + name + "'})");
                    String sessionRef = session.getString("sessionRef");
                    bridgeValue(scenario, "Capacitor.Plugins.AndroidDocuments.appendWrite({sessionRef:'" + sessionRef + "',data:'" + Base64.encodeToString(outputs[i], Base64.NO_WRAP) + "'})");
                    JSONObject finished = bridgeValue(scenario, "Capacitor.Plugins.AndroidDocuments.finishWrite({sessionRef:'" + sessionRef + "',transient:true})");
                    ref = finished.getJSONObject("item").getString("ref");
                    for (var owned : coordinator.listOwnedDocuments()) assertFalse(ref.equals(owned.ref()));
                    JSONObject result = bridgeValue(scenario, "Capacitor.Plugins.AndroidDocuments.exportItem({ref:'" + ref + "',displayName:'" + name + "',mimeType:'" + mimes[i] + "'})");
                    assertEquals("completed", result.getString("status"));
                    exported = findDownload(context, name);
                    assertNotNull("Generated output must exist in Downloads", exported);
                    try (java.io.InputStream input = context.getContentResolver().openInputStream(exported)) {
                        assertArrayEquals(outputs[i], input.readAllBytes());
                    }
                } finally {
                    if (ref != null) coordinator.deleteOwnedDocument(ref);
                    if (exported != null) context.getContentResolver().delete(exported, null, null);
                }
            }
        }
    }

    @Test public void nativeOwnedRenameIsDurableExactAndPayloadPreserving() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        byte[] bytes = "%PDF-1.7\nt904-rename\n%%EOF"
                .getBytes(StandardCharsets.UTF_8);
        DocumentLifecycleCoordinator.WriteSession session = null;
        DocumentLifecycleCoordinator.DocumentRecord owned = null;
        try {
            session = coordinator.beginWrite("T904 original.pdf",
                    AndroidDocumentIngressPolicy.MIME_PDF);
            coordinator.appendWrite(session.sessionId(), bytes, () -> false);
            owned = coordinator.finishWrite(session.sessionId(), () -> false);
            Path payload = context.getFilesDir().toPath().resolve("pdfchef_documents")
                    .resolve("owned").resolve(owned.ref().substring(3) + ".bin");
            Object payloadKey = Files.readAttributes(payload,
                    java.nio.file.attribute.BasicFileAttributes.class).fileKey();
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                JSONObject renamed = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.renameItem({ref:'"
                        + owned.ref() + "',displayName:'T904 renamed.pdf'})");
                assertEquals(1, renamed.length());
                assertEquals("completed", renamed.getString("status"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.renameItem({ref:'a1_1',"
                        + "displayName:'Legacy.pdf'})"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.renameItem({ref:'"
                        + owned.ref() + "',displayName:'Bad.pdf',path:'/private'})"));
            }
            DocumentLifecycleCoordinator.DocumentRecord listed = null;
            for (DocumentLifecycleCoordinator.DocumentRecord candidate
                    : coordinator.listOwnedDocuments()) {
                if (candidate.ref().equals(owned.ref())) listed = candidate;
            }
            assertNotNull("renamed owned record listed", listed);
            assertEquals("T904 renamed.pdf", listed.displayName());
            assertEquals(owned.ref(), listed.ref());
            assertEquals(owned.mimeType(), listed.mimeType());
            assertEquals(owned.sizeBytes(), listed.sizeBytes());
            assertEquals(owned.contentHash(), listed.contentHash());
            assertEquals(owned.createdAtMillis(), listed.createdAtMillis());
            assertArrayEquals(bytes, Files.readAllBytes(payload));
            assertEquals(payloadKey, Files.readAttributes(payload,
                    java.nio.file.attribute.BasicFileAttributes.class).fileKey());
        } finally {
            cleanupOwned(context, session, owned);
        }
    }

    @Test public void nativeOwnedUndoIsOpaqueDurableAndRetrySafe() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        byte[] bytes = "%PDF-1.7\nt905-undo\n%%EOF".getBytes(StandardCharsets.UTF_8);
        DocumentLifecycleCoordinator.WriteSession session = null;
        DocumentLifecycleCoordinator.DocumentRecord owned = null;
        String undoRef = null;
        try {
            session = coordinator.beginWrite("T905 undo.pdf",
                    AndroidDocumentIngressPolicy.MIME_PDF);
            coordinator.appendWrite(session.sessionId(), bytes, () -> false);
            owned = coordinator.finishWrite(session.sessionId(), () -> false);
            String ownedRef = owned.ref();
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                JSONObject trashed = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.trashOwned({ref:'"
                        + ownedRef + "'})");
                assertEquals(2, trashed.length());
                undoRef = trashed.getString("undoRef");
                assertTrue(undoRef.matches("u1_[A-Za-z0-9_-]{22,64}"));
                assertTrue(trashed.getLong("expiresAt") > 0);
                JSONObject retry = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.trashOwned({ref:'"
                        + ownedRef + "'})");
                assertEquals(undoRef, retry.getString("undoRef"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.trashOwned({ref:'a1_1'})"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.trashOwned({ref:'"
                        + ownedRef + "',path:'/private'})"));
            }
            assertTrue(coordinator.listOwnedDocuments().stream()
                    .noneMatch(item -> item.ref().equals(ownedRef)));
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                JSONObject restored = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.restoreOwned({undoRef:'"
                        + undoRef + "'})");
                assertEquals(1, restored.length());
                assertEquals("completed", restored.getString("status"));
                JSONObject retry = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.restoreOwned({undoRef:'"
                        + undoRef + "'})");
                assertEquals("completed", retry.getString("status"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.restoreOwned({undoRef:'"
                        + undoRef + "',uri:'content://private'})"));
            }
            assertArrayEquals(bytes, Files.readAllBytes(context.getFilesDir().toPath()
                    .resolve("pdfchef_documents/owned/")
                    .resolve(ownedRef.substring(3) + ".bin")));
        } finally {
            if (undoRef != null && owned != null) {
                try { coordinator.restoreOwnedDocument(undoRef); }
                catch (DocumentLifecycleCoordinator.Failure ignored) { }
            }
            cleanupOwned(context, session, owned);
        }
    }

    @Test public void registeredBridgeReadsAndWritesWithoutMutatingLegacyState() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.dhananjaytech.pdfchef.debug", context.getPackageName());
        PdfChefApplication application = (PdfChefApplication) context.getApplicationContext();
        DocumentLifecycleCoordinator coordinator = application.getDocumentLifecycleCoordinator();
        assertSame(coordinator, application.getDocumentLifecycleCoordinator());

        byte[] legacyBytes = "%PDF-1.7\nlegacy-t040\n%%EOF".getBytes(StandardCharsets.UTF_8);
        byte[] ownedBytes = "%PDF-1.7\nowned-t040\n%%EOF".getBytes(StandardCharsets.UTF_8);
        File root = context.getFilesDir();
        File index = new File(root, "processed_index.json");
        File processed = new File(root, "processed");
        File legacy = new File(processed, "t040-legacy.pdf");
        assertFalse("refuse existing legacy index", index.exists());
        assertFalse("refuse existing legacy fixture", legacy.exists());

        DocumentLifecycleCoordinator.WriteSession session = null;
        DocumentLifecycleCoordinator.DocumentRecord owned = null;
        String bridgeSessionRef = null;
        String bridgeDocumentRef = null;
        String abortedSessionRef = null;
        try {
            if (!processed.exists()) assertTrue("processed fixture directory", processed.mkdir());
            write(legacy, legacyBytes);
            write(index, "[{\"id\":920040,\"displayName\":\"T040\",\"toolName\":\"MERGE\","
                    + "\"sizeBytes\":" + legacyBytes.length + ",\"createdAtMillis\":2,"
                    + "\"storedFileName\":\"t040-legacy.pdf\","
                    + "\"mimeType\":\"application/pdf\",\"isDirectory\":false}]");
            session = coordinator.beginWrite(AndroidDocumentIngressPolicy.MIME_PDF);
            coordinator.appendWrite(session.sessionId(), ownedBytes, () -> false);
            owned = coordinator.finishWrite(session.sessionId(), () -> false);

            byte[] indexBefore = Files.readAllBytes(index.toPath());
            byte[] legacyBefore = Files.readAllBytes(legacy.toPath());
            byte[] ownedBefore = ownedBytes(context, owned.ref());
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                scenario.onActivity(activity -> {
                    assertNotNull(activity.getBridge().getPlugin("AndroidDocuments"));
                    assertNotNull(activity.getBridge().getPlugin("AndroidLegacyInspector"));
                    assertNotNull(activity.getBridge().getPlugin("AndroidLegacySettingsWriter"));
                });
                JSONObject discovery = bridgeValue(scenario,
                        "({documents:Capacitor.isPluginAvailable('AndroidDocuments'),"
                        + "inspector:Capacitor.isPluginAvailable('AndroidLegacyInspector'),"
                        + "writer:Capacitor.isPluginAvailable('AndroidLegacySettingsWriter')})");
                assertTrue(discovery.getBoolean("documents"));
                assertTrue(discovery.getBoolean("inspector"));
                assertTrue(discovery.getBoolean("writer"));

                assertChunk(bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'a1_920040',offset:0,length:7})"),
                        java.util.Arrays.copyOfRange(legacyBytes, 0, 7), 7, false);
                assertChunk(bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'a1_920040',offset:"
                        + legacyBytes.length + ",length:1})"), new byte[0], legacyBytes.length, true);
                assertChunk(bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'" + owned.ref()
                        + "',offset:0,length:524288})"), ownedBytes, ownedBytes.length, true);
                assertChunk(bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'" + owned.ref()
                        + "',offset:" + ownedBytes.length + ",length:1})"),
                        new byte[0], ownedBytes.length, true);

                byte[] bridgeBytes = "%PDF-1.7\nowned-t041w\n%%EOF"
                        .getBytes(StandardCharsets.UTF_8);
                int split = 9;
                JSONObject begin = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.beginWrite({mimeType:'application/pdf',"
                        + "displayName:'Bridge T041W.pdf'})");
                assertEquals(2, begin.length());
                bridgeSessionRef = begin.getString("sessionRef");
                assertTrue(bridgeSessionRef.matches("w1_[A-Za-z0-9_-]{22,64}"));
                assertEquals(524_288, begin.getInt("maximumChunkBytes"));

                JSONObject firstAppend = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.appendWrite({sessionRef:'"
                        + bridgeSessionRef + "',data:'" + Base64.encodeToString(
                        java.util.Arrays.copyOfRange(bridgeBytes, 0, split), Base64.NO_WRAP)
                        + "'})");
                assertEquals(1, firstAppend.length());
                assertEquals(split, firstAppend.getInt("acceptedBytes"));
                JSONObject secondAppend = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.appendWrite({sessionRef:'"
                        + bridgeSessionRef + "',data:'" + Base64.encodeToString(
                        java.util.Arrays.copyOfRange(bridgeBytes, split, bridgeBytes.length),
                        Base64.NO_WRAP) + "'})");
                assertEquals(1, secondAppend.length());
                assertEquals(bridgeBytes.length - split, secondAppend.getInt("acceptedBytes"));

                JSONObject firstFinish = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.finishWrite({sessionRef:'"
                        + bridgeSessionRef + "'})");
                assertEquals(1, firstFinish.length());
                JSONObject bridgeItem = firstFinish.getJSONObject("item");
                assertEquals(9, bridgeItem.length());
                bridgeDocumentRef = bridgeItem.getString("ref");
                assertTrue(bridgeDocumentRef.matches("d1_[A-Za-z0-9_-]{22,64}"));
                assertEquals("file", bridgeItem.getString("kind"));
                assertEquals("Bridge T041W.pdf", bridgeItem.getString("displayName"));
                assertEquals("application/pdf", bridgeItem.getString("mimeType"));
                assertEquals(bridgeBytes.length, bridgeItem.getLong("sizeBytes"));
                assertTrue(bridgeItem.getString("contentHash").matches("[0-9a-f]{64}"));
                assertTrue(bridgeItem.getLong("createdAt") >= 0);
                assertTrue(bridgeItem.getBoolean("available"));
                assertFalse(bridgeItem.getBoolean("pending"));

                JSONObject renamed = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.renameItem({ref:'"
                        + bridgeDocumentRef + "',displayName:'Bridge renamed.pdf'})");
                assertEquals(1, renamed.length());
                assertEquals("completed", renamed.getString("status"));
                JSONObject listedAfterRename = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.listOwned({})");
                boolean foundRenamed = false;
                JSONArray renamedItems = listedAfterRename.getJSONArray("items");
                for (int indexAt = 0; indexAt < renamedItems.length(); indexAt++) {
                    JSONObject itemAt = renamedItems.getJSONObject(indexAt);
                    if (bridgeDocumentRef.equals(itemAt.getString("ref"))) {
                        assertEquals("Bridge renamed.pdf", itemAt.getString("displayName"));
                        foundRenamed = true;
                    }
                }
                assertTrue("renamed owned record listed", foundRenamed);
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.renameItem({ref:'a1_920040',"
                        + "displayName:'Legacy.pdf'})"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.renameItem({ref:'"
                        + bridgeDocumentRef + "',displayName:'Bad.pdf',path:'/private'})"));

                JSONObject repeatedFinish = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.finishWrite({sessionRef:'"
                        + bridgeSessionRef + "'})");
                JSONObject repeatedItem = repeatedFinish.getJSONObject("item");
                assertEquals(bridgeDocumentRef, repeatedItem.getString("ref"));
                assertEquals("Bridge renamed.pdf", repeatedItem.getString("displayName"));
                assertEquals(bridgeBytes.length, repeatedItem.getLong("sizeBytes"));
                assertChunk(bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'"
                        + bridgeDocumentRef + "',offset:0,length:524288})"),
                        bridgeBytes, bridgeBytes.length, true);
                assertChunk(bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'"
                        + bridgeDocumentRef + "',offset:" + bridgeBytes.length + ",length:1})"),
                        new byte[0], bridgeBytes.length, true);

                JSONObject abortBegin = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.beginWrite({mimeType:'application/pdf'})");
                abortedSessionRef = abortBegin.getString("sessionRef");
                JSONObject firstAbort = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.abortWrite({sessionRef:'"
                        + abortedSessionRef + "'})");
                assertEquals(1, firstAbort.length());
                assertTrue(firstAbort.getBoolean("aborted"));
                JSONObject repeatedAbort = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidDocuments.abortWrite({sessionRef:'"
                        + abortedSessionRef + "'})");
                assertFalse(repeatedAbort.getBoolean("aborted"));

                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.beginWrite({mimeType:'application/pdf',"
                        + "displayName:'bad/name'})"));
                assertInvalid(bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.appendWrite({sessionRef:'"
                        + bridgeSessionRef + "',data:'AQ'})"));

                JSONObject rejected = bridgeEnvelope(scenario,
                        "Capacitor.Plugins.AndroidDocuments.readChunk({ref:'" + owned.ref()
                        + "',offset:0,length:1,extra:true})");
                assertFalse(rejected.getBoolean("ok"));
                assertEquals("DOCUMENT_INVALID_ARGUMENT", rejected.getString("code"));
                assertEquals("The document request is invalid.", rejected.getString("message"));

                JSONObject legacyHistory = bridgeValue(scenario,
                        "Capacitor.Plugins.AndroidLegacyInspector.readHistory()");
                assertEquals("ok", legacyHistory.getString("health"));
                assertEquals("a1_920040", legacyHistory.getJSONArray("entries")
                        .getJSONObject(0).getString("ref"));
            }
            assertArrayEquals(indexBefore, Files.readAllBytes(index.toPath()));
            assertArrayEquals(legacyBefore, Files.readAllBytes(legacy.toPath()));
            assertArrayEquals(ownedBefore, ownedBytes(context, owned.ref()));
        } finally {
            if (index.exists()) assertTrue("delete exact legacy index", index.delete());
            if (legacy.exists()) assertTrue("delete exact legacy fixture", legacy.delete());
            if (processed.exists() && processed.list() != null && processed.list().length == 0) {
                assertTrue("delete empty processed fixture directory", processed.delete());
            }
            cleanupOwned(context, session, owned);
            cleanupOwned(context, bridgeSessionRef, bridgeDocumentRef);
            cleanupOwned(context, abortedSessionRef, null);
        }
    }

    private static void assertInvalid(JSONObject envelope) throws Exception {
        assertFalse(envelope.getBoolean("ok"));
        assertEquals("DOCUMENT_INVALID_ARGUMENT", envelope.getString("code"));
        assertEquals("The document request is invalid.", envelope.getString("message"));
    }

    private static void assertChunk(JSONObject value, byte[] bytes, long next, boolean done)
            throws Exception {
        assertEquals(3, value.length());
        assertArrayEquals(bytes, Base64.decode(value.getString("data"), Base64.DEFAULT));
        assertEquals(next, value.getLong("nextOffset"));
        assertEquals(done, value.getBoolean("done"));
    }

    private static void assertUnavailableOwnedItem(JSONObject envelope, String ref,
            String displayName) throws Exception {
        JSONArray items = envelope.getJSONArray("items");
        for (int index = 0; index < items.length(); index++) {
            JSONObject item = items.getJSONObject(index);
            if (!ref.equals(item.getString("ref"))) continue;
            assertEquals(9, item.length());
            assertEquals(displayName, item.getString("displayName"));
            assertFalse(item.getBoolean("available"));
            assertFalse(item.getBoolean("pending"));
            return;
        }
        throw new AssertionError("Unavailable owned item missing: " + ref);
    }

    private static JSONObject bridgeValue(ActivityScenario<MainActivity> scenario, String expression)
            throws Exception {
        JSONObject envelope = bridgeEnvelope(scenario, expression);
        assertTrue("bridge invocation: " + envelope, envelope.optBoolean("ok", false));
        return envelope.getJSONObject("value");
    }

    private static JSONObject bridgeEnvelope(ActivityScenario<MainActivity> scenario,
            String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WEB_TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline
                && !"true".equals(evaluate(scenario, "Boolean(window.Capacitor)"))) {
            Thread.sleep(50);
        }
        assertEquals("true", evaluate(scenario, "Boolean(window.Capacitor)"));
        String slot = "__pdfChefT041WResult" + CALL_SEQUENCE.incrementAndGet();
        evaluate(scenario, "window['" + slot + "']=null;(async()=>{try{const value=await ("
                + expression + ");window['" + slot
                + "']=JSON.stringify({ok:true,value});}catch(error){window['" + slot
                + "']=JSON.stringify({ok:false,code:error&&error.code,message:error&&error.message});}})();true");
        String result = null;
        while (System.nanoTime() < deadline) {
            result = evaluate(scenario, "window['" + slot + "']");
            if (!"null".equals(result)) break;
            Thread.sleep(50);
        }
        assertTrue("WebView bridge result slot", result != null && !"null".equals(result));
        return new JSONObject(new JSONArray("[" + result + "]").getString(0));
    }

    private static String waitForSlot(ActivityScenario<MainActivity> scenario, String slot)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WEB_TIMEOUT_SECONDS);
        String encoded = null;
        while (System.nanoTime() < deadline) {
            try {
                encoded = evaluate(scenario, "window['" + slot + "']");
                if (!"null".equals(encoded)) break;
            } catch (IllegalStateException ignored) {
                // The chooser may still be returning focus to MainActivity.
            }
            Thread.sleep(50);
        }
        assertTrue("bridge result slot", encoded != null && !"null".equals(encoded));
        return encoded;
    }

    private static JSONObject shareAndDismiss(ActivityScenario<MainActivity> scenario,
            String ref, String displayName) throws Exception {
        String slot = "__pdfChefT903Share" + CALL_SEQUENCE.incrementAndGet();
        evaluate(scenario, "window['" + slot + "']=null;(async()=>{try{const value=await "
                + "Capacitor.Plugins.AndroidDocuments.shareItem({ref:'" + ref
                + "',displayName:'" + displayName
                + "',mimeType:'application/pdf'});window['" + slot
                + "']=JSON.stringify({ok:true,value});}catch(error){window['" + slot
                + "']=JSON.stringify({ok:false,code:error&&error.code,message:error&&error.message});}})();true");
        Thread.sleep(750);
        try (ParcelFileDescriptor ignored = InstrumentationRegistry.getInstrumentation()
                .getUiAutomation().executeShellCommand("input keyevent KEYCODE_BACK")) { }
        String encoded = waitForSlot(scenario, slot);
        JSONObject envelope = new JSONObject(new JSONArray("[" + encoded + "]").getString(0));
        assertTrue(envelope.toString(), envelope.getBoolean("ok"));
        return envelope.getJSONObject("value");
    }

    private static Uri findDownload(Context context, String displayName) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            try (Cursor cursor = context.getContentResolver().query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[] {MediaStore.Downloads._ID},
                    MediaStore.Downloads.DISPLAY_NAME + "=?",
                    new String[] {displayName}, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    return Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            Long.toString(cursor.getLong(0)));
                }
            }
            Thread.sleep(50);
        }
        return null;
    }

    private static Set<String> childNames(Path root) throws Exception {
        if (!Files.isDirectory(root)) return Set.of();
        HashSet<String> names = new HashSet<>();
        try (var children = Files.list(root)) {
            children.forEach(path -> names.add(path.getFileName().toString()));
        }
        return names;
    }

    private static void cleanupNewChildren(Path root, Set<String> before) throws Exception {
        if (!Files.isDirectory(root)) return;
        try (var children = Files.list(root)) {
            for (Path child : children.toList()) {
                if (!before.contains(child.getFileName().toString())) Files.deleteIfExists(child);
            }
        }
    }

    private static String evaluate(ActivityScenario<MainActivity> scenario, String script)
            throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        String[] result = new String[1];
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
                script, value -> { result[0] = value; latch.countDown(); }));
        assertTrue(latch.await(WEB_TIMEOUT_SECONDS, TimeUnit.SECONDS));
        return result[0];
    }

    private static void write(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
    }
    private static void write(File file, String text) throws Exception {
        write(file, text.getBytes(StandardCharsets.UTF_8));
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
        cleanupOwned(context, session.sessionId(), document == null ? null : document.ref());
    }
    private static void cleanupOwned(Context context, String sessionRef, String documentRef)
            throws Exception {
        if (sessionRef == null) return;
        java.nio.file.Path root = context.getFilesDir().toPath().resolve("pdfchef_documents");
        Files.deleteIfExists(root.resolve("sessions").resolve(sessionRef + ".part"));
        Files.deleteIfExists(root.resolve("sessions").resolve(sessionRef + ".session"));
        Files.deleteIfExists(root.resolve("operations").resolve(sessionRef + ".finish"));
        if (documentRef != null) {
            String payload = documentRef.substring("d1_".length());
            Files.deleteIfExists(root.resolve("owned").resolve(payload + ".bin"));
            Files.deleteIfExists(root.resolve("records").resolve(payload + ".owned"));
        }
    }
}
