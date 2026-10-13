package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.scanner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public final class AndroidDocumentScannerPluginContractTest {
    @Test public void bridgeSurfaceIsExactlyOneScanMethod() throws Exception {
        CapacitorPlugin annotation = AndroidDocumentScannerPlugin.class
                .getAnnotation(CapacitorPlugin.class);
        assertEquals("AndroidDocumentScanner", annotation.name());
        int pluginMethods = 0;
        for (Method method : AndroidDocumentScannerPlugin.class.getDeclaredMethods()) {
            if (method.isAnnotationPresent(PluginMethod.class)) {
                pluginMethods++;
                assertEquals("scan", method.getName());
                assertEquals(1, method.getParameterCount());
            }
        }
        assertEquals(1, pluginMethods);
        Method callback = AndroidDocumentScannerPlugin.class
                .getDeclaredMethod("scannerResult", com.getcapacitor.PluginCall.class,
                        androidx.activity.result.ActivityResult.class);
        assertTrue(callback.isAnnotationPresent(ActivityCallback.class));
    }

    @Test public void scannerIsTheExactSixthPluginRegisteredBeforeBridgeStartup()
            throws Exception {
        String source = source("android/app/src/main/java/com/dhananjaytech/"
                + "zenpdf_allpdftoolsinoneplace/MainActivity.java");
        String inspector = "registerPlugin(AndroidLegacyInspectorPlugin.class)";
        String writer = "registerPlugin(AndroidLegacySettingsWriterPlugin.class)";
        String documents = "registerPlugin(AndroidDocumentsPlugin.class)";
        String scanner = "registerPlugin(AndroidDocumentScannerPlugin.class)";
        int inspectorAt = source.indexOf(inspector);
        int writerAt = source.indexOf(writer);
        int documentsAt = source.indexOf(documents);
        int scannerAt = source.indexOf(scanner);
        int bridgeStartupAt = source.indexOf("super.onCreate(savedInstanceState)");

        assertEquals(6, occurrences(source, "registerPlugin("));
        assertEquals(1, occurrences(source, scanner));
        assertTrue(inspectorAt >= 0);
        assertTrue(inspectorAt < writerAt);
        assertTrue(writerAt < documentsAt);
        assertTrue(documentsAt < scannerAt);
        assertTrue(scannerAt < bridgeStartupAt);
    }

    @Test public void sourceFreezesFullGalleryPdfAndJpegBehavior() throws Exception {
        String source = source("android/app/src/main/java/com/dhananjaytech/"
                + "zenpdf_allpdftoolsinoneplace/scanner/AndroidDocumentScannerPlugin.java");
        assertTrue(source.contains(".setGalleryImportAllowed(true)"));
        assertTrue(source.contains("GmsDocumentScannerOptions.SCANNER_MODE_FULL"));
        assertTrue(source.contains("GmsDocumentScannerOptions.RESULT_FORMAT_PDF"));
        assertTrue(source.contains("GmsDocumentScannerOptions.RESULT_FORMAT_JPEG"));
        assertTrue(source.contains("data.length() != 0"));
        assertTrue(source.contains("Thread.currentThread()::isInterrupted"));
        assertTrue(source.contains("getDocumentLifecycleCoordinator()"));
        assertTrue(source.contains("ACTION_INTENT_SENDER_REQUEST"));
        assertTrue(source.contains("EXTRA_INTENT_SENDER_REQUEST"));
        assertTrue(source.contains("startActivityForResult(call, request, \"scannerResult\")"));
        assertFalse(source.contains("new DocumentLifecycleCoordinator"));
        assertFalse(source.contains("ActivityResultLauncher<IntentSenderRequest>"));
        assertFalse(source.contains("pendingCall"));
        assertFalse(source.contains("shutdownNow"));
    }

    @Test public void publicResultsAndErrorsContainNoNativeAddressOrExceptionDetail()
            throws Exception {
        String source = source("android/app/src/main/java/com/dhananjaytech/"
                + "zenpdf_allpdftoolsinoneplace/scanner/AndroidDocumentScannerPlugin.java");
        for (String key : new String[] {"status", "item", "pageCount", "jpegPageCount",
                "kind", "ref", "displayName", "mimeType", "sizeBytes", "contentHash",
                "createdAt", "available", "pending"}) {
            assertTrue(key, source.contains("put(\"" + key + "\""));
        }
        for (String forbidden : new String[] {"put(\"uri\"", "put(\"path\"",
                "put(\"bytes\"", "put(\"exception\"", "getMessage()", "printStackTrace",
                "android.util.Log", "System.out"}) {
            assertFalse(forbidden, source.contains(forbidden));
        }
        assertTrue(source.contains("EXTRA_SEND_INTENT_EXCEPTION"));
        assertTrue(source.contains("result.put(\"status\", \"cancelled\")"));
        assertTrue(source.contains("result.put(\"item\", JSObject.NULL)"));
    }

    @Test public void launchExceptionPrecedesCancellationAndGenuineCancelStaysNeutral() {
        assertEquals(AndroidDocumentScannerPlugin.ResultKind.LAUNCH_FAILED,
                AndroidDocumentScannerPlugin.classifyResult(0, true));
        assertEquals(AndroidDocumentScannerPlugin.ResultKind.CANCELLED,
                AndroidDocumentScannerPlugin.classifyResult(0, false));
        assertEquals(AndroidDocumentScannerPlugin.ResultKind.OK,
                AndroidDocumentScannerPlugin.classifyResult(-1, false));
        assertEquals(AndroidDocumentScannerPlugin.ResultKind.INVALID,
                AndroidDocumentScannerPlugin.classifyResult(9, false));
    }

    @Test public void processOperationSurvivesInstanceRecreationAndRejectsDuplicates() {
        AndroidDocumentScannerPlugin.OperationState operation =
                new AndroidDocumentScannerPlugin.OperationState();
        long first = operation.begin();
        assertTrue(first > 0);
        assertEquals(0, operation.begin());
        assertTrue(operation.isCurrent(first));
        assertEquals(first, operation.claimResult());
        assertEquals(0, operation.claimResult());
        assertTrue(operation.finish(first));
        assertFalse(operation.finish(first));
        long afterRecreation = operation.begin();
        assertTrue(afterRecreation > first);
        assertTrue(operation.finish(afterRecreation));
    }

    @Test public void danglingOrNullRestoredCallsFinishWithoutAttemptingDelivery() {
        assertTrue(AndroidDocumentScannerPlugin.shouldDeliver(true, false));
        assertFalse(AndroidDocumentScannerPlugin.shouldDeliver(false, false));
        assertFalse(AndroidDocumentScannerPlugin.shouldDeliver(true, true));
        assertFalse(AndroidDocumentScannerPlugin.shouldDeliver(false, true));
    }

    @Test public void firstRestoredScannerResultSurvivesProcessDeathWithoutDuplicateImport() {
        AndroidDocumentScannerPlugin.OperationState fresh =
                new AndroidDocumentScannerPlugin.OperationState();
        assertEquals(0, fresh.claimResult(false));
        long restored = fresh.claimResult(true);
        assertTrue(restored > 0);
        assertEquals(0, fresh.begin());
        assertEquals(0, fresh.claimResult(true));
        assertTrue(fresh.finish(restored));
        assertEquals(0, fresh.claimResult(true));
        long next = fresh.begin();
        assertTrue(next > restored);
        assertEquals(next, fresh.claimResult(false));
    }

    private static int occurrences(String source, String value) {
        int count = 0;
        for (int at = 0; (at = source.indexOf(value, at)) >= 0; at += value.length()) count++;
        return count;
    }

    private static String source(String relative) throws Exception {
        Path directory = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (directory != null) {
            Path file = directory.resolve(relative);
            if (Files.isRegularFile(file)) {
                return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            }
            directory = directory.getParent();
        }
        throw new AssertionError("Could not locate source: " + relative);
    }
}
