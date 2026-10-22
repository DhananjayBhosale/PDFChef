package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.Test;

public final class AndroidDocumentsPluginContractTest {
    @Test public void pluginExposesOnlyDocumentsOwnedRecordsAndReaderMethods() throws Exception {
        Class<?> type = AndroidDocumentsPlugin.class;
        CapacitorPlugin annotation = type.getAnnotation(CapacitorPlugin.class);
        assertNotNull(annotation);
        assertEquals("AndroidDocuments", annotation.name());
        assertArrayEquals(new int[0], annotation.requestCodes());
        assertEquals(0, annotation.permissions().length);
        assertTrue(Modifier.isPublic(type.getModifiers()));
        assertTrue(Modifier.isFinal(type.getModifiers()));
        assertEquals(Plugin.class, type.getSuperclass());
        Constructor<?> constructor = type.getConstructor();
        assertTrue(Modifier.isPublic(constructor.getModifiers()));
        assertEquals(0, constructor.getParameterCount());

        TreeSet<String> exposed = new TreeSet<>();
        for (Method method : type.getDeclaredMethods()) {
            PluginMethod pluginMethod = method.getAnnotation(PluginMethod.class);
            if (pluginMethod == null) continue;
            exposed.add(method.getName());
            assertTrue(Modifier.isPublic(method.getModifiers()));
            assertEquals(void.class, method.getReturnType());
            assertArrayEquals(new Class<?>[] {PluginCall.class}, method.getParameterTypes());
            assertEquals(PluginMethod.RETURN_PROMISE, pluginMethod.returnType());
        }
        assertEquals(19, exposed.size());
        assertEquals(Set.of("abortWrite", "appendWrite", "beginWrite", "clearOwned",
                "clearOwnedPayloads",
                "deleteOwned", "exportItem", "finishWrite", "listOwned", "openReader",
                "readChunk", "renameExport", "renameItem", "restoreOwned", "shareItem", "takePendingImports",
                "trashOwned",
                "acknowledgePendingImports", "pickDocuments"), exposed);
        Method readerResult = type.getDeclaredMethod("readerResult", PluginCall.class,
                androidx.activity.result.ActivityResult.class);
        assertNotNull(readerResult.getAnnotation(ActivityCallback.class));
        Method pickerResult = type.getDeclaredMethod("pickerResult", PluginCall.class,
                androidx.activity.result.ActivityResult.class);
        assertNotNull(pickerResult.getAnnotation(ActivityCallback.class));
        String source = source("src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/"
                + "documents/AndroidDocumentsPlugin.java");
        for (String absent : Arrays.asList("stat", "exists", "listDocuments", "exportDocument",
                "shareDocument")) {
            assertFalse(absent, source.contains("public void " + absent + "("));
        }
        assertTrue(source.contains("pendingImportReady"));
        assertTrue(source.contains("notifyListeners(PICKER_EVENT, event, true)"));
    }

    @Test public void inputAndOutputWireAreStrictBoundedAndNonleaking() throws Exception {
        String source = source("src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/"
                + "documents/AndroidDocumentsPlugin.java");
        assertTrue(source.contains("data.length() != 3"));
        assertTrue(source.contains("data.has(\"ref\")"));
        assertTrue(source.contains("data.has(\"offset\")"));
        assertTrue(source.contains("data.has(\"length\")"));
        assertTrue(source.contains("MAXIMUM_CHUNK_BYTES = 524_288"));
        assertTrue(source.contains("MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L"));
        assertTrue(source.contains("Base64.NO_WRAP"));
        assertEquals(1, occurrences(source, "output.put(\"data\""));
        assertEquals(1, occurrences(source, "output.put(\"nextOffset\""));
        assertEquals(1, occurrences(source, "output.put(\"done\""));
        assertTrue(occurrences(source, "getDocumentLifecycleCoordinator()") >= 8);
        assertTrue(source.contains("startActivityForResult(call,"));
        assertTrue(source.contains("PdfReaderLaunchContract.createIntent("));
        assertTrue(source.contains("PdfReaderLaunchContract.createSignatureVerificationIntent("));
        assertTrue(source.contains("data.has(\"initialAction\")"));
        assertTrue(source.contains("INITIAL_ACTION_VERIFY_SIGNATURES"));
        assertTrue(source.contains("PdfReaderLaunchContract.parseResult("));
        assertTrue(source.contains("private static final AtomicBoolean READER_LAUNCH_ACTIVE"));
        assertTrue(source.contains("READER_LAUNCH_ACTIVE.compareAndSet(false, true)"));
        assertTrue(source.contains("READER_LAUNCH_ACTIVE.set(false)"));
        assertTrue(source.contains("if (!launchAccepted(call.isReleased(),"));
        assertTrue(source.contains("releaseReaderLaunch();"));
        assertTrue(source.contains("PICKER_LAUNCH_ACTIVE.compareAndSet(false, true)"));
        assertTrue(source.contains("execute(() -> completePickerResult(call, activityResult))"));
        assertTrue(source.contains("data.length() != 5"));
        assertTrue(source.contains("PendingImportBatch.batchRef(refs)"));
        assertTrue(source.contains("pendingImportsForBatch(result.batchRef())"));
        assertTrue(source.contains("acknowledgePendingImports(suppliedBatchRef, refs"));
        assertTrue(source.contains("execute(() -> completeExportItem(call, request))"));
        assertTrue(source.contains("execute(() -> completeShareItem(call, request))"));
        assertTrue(source.indexOf("activity.startActivity(Intent.createChooser(send, null))")
                < source.indexOf("coordinator.markShareDispatched(handle)"));
        assertTrue(source.contains("cancelShareBeforeDispatch(handle)"));
        assertTrue(source.contains("appendQueryParameter(\"displayName\""));
        assertTrue(source.contains("data.length() != 2"));
        assertTrue(source.contains("data.has(\"displayName\")"));
        for (String leak : Arrays.asList("getMessage()", "printStackTrace(", "Log.",
                "System.out", "getFilesDir(", "new DocumentLifecycleCoordinator(",
                "content://", "file://", "put(\"uri\"", "put(\"path\"",
                "put(\"filename\"", "put(\"bytes\"")) {
            assertFalse(leak, source.contains(leak));
        }

        Method exact = AndroidDocumentsPlugin.class.getDeclaredMethod(
                "exactInteger", Object.class, long.class, long.class);
        exact.setAccessible(true);
        assertEquals(0L, exact.invoke(null, 0, 0L, 9_007_199_254_740_991L));
        assertEquals(524_288L, exact.invoke(null, 524_288L, 1L, 524_288L));
        assertNull(exact.invoke(null, 1.5d, 0L, 10L));
        assertNull(exact.invoke(null, Double.NaN, 0L, 10L));
        assertNull(exact.invoke(null, "1", 0L, 10L));
    }

    @Test public void appendBase64IsCanonicalBoundedAndNonempty() throws Exception {
        Method decode = AndroidDocumentsPlugin.class.getDeclaredMethod("decodeCanonical", String.class);
        decode.setAccessible(true);
        assertArrayEquals(new byte[] {1}, (byte[]) decode.invoke(null, "AQ=="));
        byte[] maximum = new byte[524_288];
        String encoded = java.util.Base64.getEncoder().encodeToString(maximum);
        assertEquals(524_288, ((byte[]) decode.invoke(null, encoded)).length);
        for (String invalid : Arrays.asList("", "AQ", "AQ==\n", "AQ--", "AR==",
                java.util.Base64.getEncoder().encodeToString(new byte[524_289]))) {
            assertNull(decode.invoke(null, invalid));
        }
    }

    @Test public void allowlistedOperationalCodesHaveHonestFixedMessages() throws Exception {
        Method fixed = AndroidDocumentsPlugin.class.getDeclaredMethod("fixedMessage", String.class);
        fixed.setAccessible(true);
        assertEquals("The document limit was exceeded.",
                fixed.invoke(null, "DOCUMENT_LIMIT_EXCEEDED"));
        assertEquals("There is not enough storage.",
                fixed.invoke(null, "DOCUMENT_STORAGE_FULL"));
        assertEquals("The document operation was interrupted.",
                fixed.invoke(null, "DOCUMENT_INTERRUPTED"));
        assertEquals("The document operation was cancelled.",
                fixed.invoke(null, "DOCUMENT_CANCELLED"));
        assertEquals("Another document operation is in progress.",
                fixed.invoke(null, "DOCUMENT_BUSY"));
    }

    @Test public void deliveryRequestIsExactOpaqueAndUsesSafeDefaults() {
        AndroidDocumentsPlugin.DeliveryRequest parsed =
                AndroidDocumentsPlugin.deliveryRequestValues(
                        "a1_1", false, null, false, null);
        assertNotNull(parsed);
        assertEquals("a1_1", parsed.ref());
        assertEquals("Document.pdf", parsed.displayName());
        assertEquals("application/pdf", parsed.mimeType());

        parsed = AndroidDocumentsPlugin.deliveryRequestValues(
                "d1_abcdefghijklmnopqrstuv", true, "Picked image.png",
                true, "image/png");
        assertNotNull(parsed);
        assertEquals("Picked image.png", parsed.displayName());
        assertEquals("image/png", parsed.mimeType());

        assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                "a1_01", false, null, false, null));
        assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                "content://provider/item", false, null, false, null));
        assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                "a1_1", true, "bad/name", false, null));
        assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                "a1_1", false, null, true, "text/plain"));
        assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                "a1_1", true, 7, false, null));
    }

    @Test public void generatedOutputDeliveryDoesNotWidenLegacyOrPickerMimeTypes() {
        for (String mime : List.of("application/zip", "text/plain", "image/webp")) {
            assertNotNull(AndroidDocumentsPlugin.deliveryRequestValues(
                    "d1_abcdefghijklmnopqrstuv", true, "Output", true, mime));
            assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                    "a1_1", true, "Output", true, mime));
            assertFalse(AndroidDocumentIngressPolicy.isSupportedMimeType(mime));
        }
        assertNull(AndroidDocumentsPlugin.deliveryRequestValues(
                "d1_abcdefghijklmnopqrstuv", true, "Output", true, "application/javascript"));
    }

    @Test public void renameRequestIsOwnedOnlyExactAndNonleaking() {
        AndroidDocumentsPlugin.RenameRequest parsed =
                AndroidDocumentsPlugin.renameRequestValues(
                        "d1_abcdefghijklmnopqrstuv", "Renamed document.pdf");
        assertNotNull(parsed);
        assertEquals("d1_abcdefghijklmnopqrstuv", parsed.ref());
        assertEquals("Renamed document.pdf", parsed.displayName());
        assertNull(AndroidDocumentsPlugin.renameRequestValues("a1_1", "Legacy.pdf"));
        assertNull(AndroidDocumentsPlugin.renameRequestValues(
                "content://provider/item", "Document.pdf"));
        assertNull(AndroidDocumentsPlugin.renameRequestValues(
                "d1_abcdefghijklmnopqrstuv", "bad/name"));
        assertNull(AndroidDocumentsPlugin.renameRequestValues(
                "d1_abcdefghijklmnopqrstuv", 7));
    }

    @Test public void unavailableActivityLauncherCannotStrandTheProcessReaderGuard() {
        assertTrue(AndroidDocumentsPlugin.launchAccepted(false, true));
        assertFalse(AndroidDocumentsPlugin.launchAccepted(true, false));
        assertFalse(AndroidDocumentsPlugin.launchAccepted(false, false));
        assertFalse(AndroidDocumentsPlugin.launchAccepted(true, true));
    }

    // NAV-45, FIL-31: "Open with PDF Chef" on an empty file, a non-PDF or a 314 MB PDF did nothing.
    @Test public void aRefusedHandoverTellsThePageWhyWithAFixedWord() throws Exception {
        assertEquals("tooLarge", IncomingPdfIntake.rejectionReason("DOCUMENT_LIMIT_EXCEEDED"));
        assertEquals("notPdf", IncomingPdfIntake.rejectionReason("DOCUMENT_CORRUPT"));
        assertEquals("other", IncomingPdfIntake.rejectionReason("DOCUMENT_INVALID_ARGUMENT"));
        assertEquals("other", IncomingPdfIntake.rejectionReason("DOCUMENT_UNAVAILABLE"));
        assertEquals("other", IncomingPdfIntake.rejectionReason(null));
        // The app is going away; there is no page to tell.
        assertNull(IncomingPdfIntake.rejectionReason("DOCUMENT_CANCELLED"));
        assertNull(IncomingPdfIntake.rejectionReason("DOCUMENT_INTERRUPTED"));

        String plugin = source("src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/"
                + "documents/AndroidDocumentsPlugin.java");
        assertTrue(plugin.contains("public void announceIncomingPdfRejected(String reason)"));
        assertTrue(plugin.contains("!\"tooLarge\".equals(reason) && !\"notPdf\".equals(reason)"
                + " && !\"other\".equals(reason)"));
        assertTrue(plugin.contains("notifyListeners(\"incomingPdfRejected\", event, true)"));

        String activity = source("src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/"
                + "MainActivity.java");
        assertTrue(activity.contains("catch (DocumentLifecycleCoordinator.Failure failure)"));
        assertTrue(activity.contains("IncomingPdfIntake.rejectionReason(failure.code())"));
        assertTrue(activity.contains("documents.announceIncomingPdfRejected(reason)"));
        assertFalse(activity.contains("} catch (Exception failure) {\n                    return;"));
    }

    @Test public void pendingBatchIdentityIsVersionedOrderBoundAndOpaque() {
        String first = "d1_abcdefghijklmnopqrstuv";
        String second = "d1_zyxwvutsrqponmlkjihgfe";
        String one = AndroidDocumentsPlugin.batchRef(List.of(first, second));
        String repeated = AndroidDocumentsPlugin.batchRef(List.of(first, second));
        String reversed = AndroidDocumentsPlugin.batchRef(List.of(second, first));
        assertEquals(one, repeated);
        assertTrue(one.matches("b1_[A-Za-z0-9_-]{43}"));
        assertFalse(one.equals(reversed));
        assertFalse(one.contains(first));
        assertFalse(one.contains(second));
    }

    private static int occurrences(String source, String value) {
        int count = 0;
        for (int at = 0; (at = source.indexOf(value, at)) >= 0; at += value.length()) count++;
        return count;
    }

    private static String source(String relative) throws Exception {
        Path directory = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (directory != null) {
            Path app = Files.isDirectory(directory.resolve("src/main"))
                    ? directory : directory.resolve("android/app");
            Path file = app.resolve(relative);
            if (Files.isRegularFile(file)) {
                return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            }
            directory = directory.getParent();
        }
        throw new AssertionError("Could not locate " + relative);
    }
}
