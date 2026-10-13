package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.scanner;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Native ML Kit scanner bridge. Registration and frontend activation are separately gated. */
@CapacitorPlugin(name = "AndroidDocumentScanner")
public final class AndroidDocumentScannerPlugin extends Plugin {
    private static final OperationState OPERATIONS = new OperationState();
    private static final ExecutorService IMPORT_EXECUTOR =
            Executors.newSingleThreadExecutor(runnable -> {
                Thread thread = new Thread(runnable, "pdfchef-scanner-import");
                thread.setDaemon(true);
                return thread;
            });

    @PluginMethod
    public void scan(PluginCall call) {
        JSObject data = call.getData();
        if (data == null || data.length() != 0) {
            reject(call, "SCANNER_INVALID_ARGUMENT");
            return;
        }
        long operation = OPERATIONS.begin();
        if (operation == 0) {
            reject(call, "SCANNER_BUSY");
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            fail(operation, call, "SCANNER_UNAVAILABLE");
            return;
        }
        try {
            GmsDocumentScanner scanner = GmsDocumentScanning.getClient(createOptions());
            scanner.getStartScanIntent(activity)
                    .addOnSuccessListener(intentSender -> launchScanner(
                            operation, call, intentSender))
                    .addOnFailureListener(failure ->
                            fail(operation, call, "SCANNER_UNAVAILABLE"));
        } catch (RuntimeException failure) {
            fail(operation, call, "SCANNER_UNAVAILABLE");
        }
    }

    private void launchScanner(long operation, PluginCall call,
            android.content.IntentSender intentSender) {
        if (!OPERATIONS.isCurrent(operation)) return;
        try {
            Intent request = new Intent(
                    ActivityResultContracts.StartIntentSenderForResult
                            .ACTION_INTENT_SENDER_REQUEST);
            request.putExtra(
                    ActivityResultContracts.StartIntentSenderForResult
                            .EXTRA_INTENT_SENDER_REQUEST,
                    new IntentSenderRequest.Builder(intentSender).build());
            startActivityForResult(call, request, "scannerResult");
            if (call.isReleased()
                    || getBridge().getSavedCall(call.getCallbackId()) != call) {
                OPERATIONS.finish(operation);
            }
        } catch (RuntimeException failure) {
            fail(operation, call, "SCANNER_LAUNCH_FAILED");
        }
    }

    static GmsDocumentScannerOptions createOptions() {
        return new GmsDocumentScannerOptions.Builder()
                .setGalleryImportAllowed(true)
                .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                .setResultFormats(
                        GmsDocumentScannerOptions.RESULT_FORMAT_PDF,
                        GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
                .build();
    }

    @ActivityCallback
    private void scannerResult(PluginCall call, ActivityResult activityResult) {
        // ActivityResultRegistry can restore a result after process death, when the static
        // operation guard is empty. Still import it privately even if JS's call is gone.
        long operation = OPERATIONS.claimResult(call == null
                || PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId()));
        if (operation == 0) return;
        boolean sendIntentFailure = activityResult != null && activityResult.getData() != null
                && activityResult.getData().hasExtra(
                        ActivityResultContracts.StartIntentSenderForResult
                                .EXTRA_SEND_INTENT_EXCEPTION);
        ResultKind resultKind = classifyResult(
                activityResult == null ? Integer.MIN_VALUE : activityResult.getResultCode(),
                sendIntentFailure);
        if (resultKind == ResultKind.LAUNCH_FAILED) {
            fail(operation, call, "SCANNER_LAUNCH_FAILED");
            return;
        }
        if (resultKind == ResultKind.CANCELLED) {
            JSObject result = new JSObject();
            result.put("status", "cancelled");
            result.put("item", JSObject.NULL);
            result.put("pageCount", 0);
            result.put("jpegPageCount", 0);
            complete(operation, call, result);
            return;
        }
        if (resultKind != ResultKind.OK) {
            fail(operation, call, "SCANNER_RESULT_INVALID");
            return;
        }

        try {
            GmsDocumentScanningResult scan = GmsDocumentScanningResult
                    .fromActivityResultIntent(activityResult.getData());
            GmsDocumentScanningResult.Pdf pdf = scan == null ? null : scan.getPdf();
            List<GmsDocumentScanningResult.Page> pages = scan == null ? null : scan.getPages();
            Uri pdfUri = pdf == null ? null : pdf.getUri();
            int pageCount = pdf == null ? 0 : pdf.getPageCount();
            if (pdfUri == null || pages == null || pageCount < 1
                    || pages.size() != pageCount) {
                fail(operation, call, "SCANNER_RESULT_INVALID");
                return;
            }
            ArrayList<Uri> jpegUris = new ArrayList<>(pages.size());
            for (GmsDocumentScanningResult.Page page : pages) {
                Uri imageUri = page == null ? null : page.getImageUri();
                if (imageUri == null) {
                    fail(operation, call, "SCANNER_RESULT_INVALID");
                    return;
                }
                jpegUris.add(imageUri);
            }
            IMPORT_EXECUTOR.execute(() -> importResult(
                    operation, call, pdfUri, jpegUris, pageCount));
        } catch (RejectedExecutionException failure) {
            fail(operation, call, "SCANNER_INTERRUPTED");
        } catch (RuntimeException failure) {
            fail(operation, call, "SCANNER_RESULT_INVALID");
        }
    }

    static ResultKind classifyResult(int resultCode, boolean hasSendIntentException) {
        if (hasSendIntentException) return ResultKind.LAUNCH_FAILED;
        if (resultCode == Activity.RESULT_CANCELED) return ResultKind.CANCELLED;
        if (resultCode == Activity.RESULT_OK) return ResultKind.OK;
        return ResultKind.INVALID;
    }

    private void importResult(long operation, PluginCall call, Uri pdfUri,
            List<Uri> jpegUris, int pageCount) {
        AndroidDocumentScannerResultSource.Batch batch = null;
        JSObject completed = null;
        String failureCode = null;
        try {
            ArrayList<String> jpegAddresses = new ArrayList<>(jpegUris.size());
            for (Uri uri : jpegUris) jpegAddresses.add(uri.toString());
            batch = AndroidDocumentScannerResultSource.resolve(
                    getContext().getCacheDir().toPath(), pdfUri.toString(), jpegAddresses);
            try (InputStream input = batch.openPdf(
                    () -> getContext().getContentResolver().openInputStream(pdfUri))) {
                PdfChefApplication application =
                        (PdfChefApplication) getContext().getApplicationContext();
                AndroidDocumentScannerImporter.OwnedItem item =
                        AndroidDocumentScannerImporter.forCoordinator(
                                application.getDocumentLifecycleCoordinator())
                                .importPdf(input, Thread.currentThread()::isInterrupted);
                JSObject publicItem = new JSObject();
                publicItem.put("kind", "file");
                publicItem.put("ref", item.ref());
                publicItem.put("displayName", item.displayName());
                publicItem.put("mimeType", item.mimeType());
                publicItem.put("sizeBytes", item.sizeBytes());
                publicItem.put("contentHash", item.contentHash());
                publicItem.put("createdAt", item.createdAtMillis());
                publicItem.put("available", true);
                publicItem.put("pending", false);

                completed = new JSObject();
                completed.put("status", "completed");
                completed.put("item", publicItem);
                completed.put("pageCount", pageCount);
                completed.put("jpegPageCount", jpegUris.size());
            }
        } catch (AndroidDocumentScannerImporter.Failure failure) {
            failureCode = code(failure.code());
        } catch (AndroidDocumentScannerResultSource.Failure failure) {
            failureCode = resultSourceCode(failure.code());
        } catch (Exception failure) {
            failureCode = Thread.currentThread().isInterrupted()
                    ? "SCANNER_INTERRUPTED" : "SCANNER_IMPORT_FAILED";
        } finally {
            if (batch != null) {
                try { batch.close(); }
                catch (AndroidDocumentScannerResultSource.Failure failure) {
                    failureCode = "SCANNER_IMPORT_FAILED";
                    completed = null;
                }
            }
        }

        if (failureCode == null && completed != null) {
            completeOnMain(operation, call, completed);
        } else {
            failOnMain(operation, call,
                    failureCode == null ? "SCANNER_IMPORT_FAILED" : failureCode);
        }
    }

    private void completeOnMain(long operation, PluginCall call, JSObject result) {
        getBridge().executeOnMainThread(() -> complete(operation, call, result));
    }

    private void failOnMain(long operation, PluginCall call, String code) {
        getBridge().executeOnMainThread(() -> fail(operation, call, code));
    }

    private static void complete(long operation, PluginCall call, JSObject result) {
        if (!OPERATIONS.finish(operation)
                || !shouldDeliver(call != null, call != null && call.isReleased())) return;
        call.resolve(result);
    }

    private static void fail(long operation, PluginCall call, String code) {
        if (!OPERATIONS.finish(operation)
                || !shouldDeliver(call != null, call != null && call.isReleased())) return;
        reject(call, code);
    }

    static boolean shouldDeliver(boolean callPresent, boolean callReleased) {
        return callPresent && !callReleased;
    }

    @Override protected void handleOnDestroy() {
        // Activity recreation must not cancel a scanner UI or private import in flight.
    }

    private static String resultSourceCode(AndroidDocumentScannerResultSource.Code code) {
        if (code == AndroidDocumentScannerResultSource.Code.INVALID_RESULT) {
            return "SCANNER_RESULT_INVALID";
        }
        return "SCANNER_IMPORT_FAILED";
    }

    private static String code(AndroidDocumentScannerImporter.Code code) {
        if (code == AndroidDocumentScannerImporter.Code.STORAGE_FULL) {
            return "SCANNER_STORAGE_FULL";
        }
        if (code == AndroidDocumentScannerImporter.Code.LIMIT_EXCEEDED) {
            return "SCANNER_LIMIT_EXCEEDED";
        }
        if (code == AndroidDocumentScannerImporter.Code.INTERRUPTED) {
            return "SCANNER_INTERRUPTED";
        }
        if (code == AndroidDocumentScannerImporter.Code.INVALID_RESULT) {
            return "SCANNER_RESULT_INVALID";
        }
        return "SCANNER_IMPORT_FAILED";
    }

    private static void reject(PluginCall call, String code) {
        call.reject(message(code), code);
    }

    private static String message(String code) {
        if ("SCANNER_INVALID_ARGUMENT".equals(code)) return "The scanner request is invalid.";
        if ("SCANNER_BUSY".equals(code)) return "A document scan is already in progress.";
        if ("SCANNER_UNAVAILABLE".equals(code)) return "The document scanner is unavailable.";
        if ("SCANNER_LAUNCH_FAILED".equals(code)) return "The document scanner could not start.";
        if ("SCANNER_RESULT_INVALID".equals(code)) return "The scanner result is unavailable.";
        if ("SCANNER_STORAGE_FULL".equals(code)) return "There is not enough storage for the scan.";
        if ("SCANNER_LIMIT_EXCEEDED".equals(code)) return "The scanned document is too large.";
        if ("SCANNER_INTERRUPTED".equals(code)) return "The scanner operation was interrupted.";
        return "The scanned document could not be imported.";
    }

    enum ResultKind { LAUNCH_FAILED, CANCELLED, OK, INVALID }

    static final class OperationState {
        private long generation;
        private boolean active;
        private boolean resultClaimed;

        synchronized long begin() {
            if (active) return 0;
            active = true;
            resultClaimed = false;
            return ++generation;
        }

        synchronized boolean isCurrent(long operation) {
            return active && generation == operation;
        }

        synchronized long claimResult() {
            return claimResult(false);
        }

        synchronized long claimResult(boolean restoredCallback) {
            // Only the first restored callback in a fresh process can recover an operation.
            // Finishing must not make a duplicate result eligible for a second import.
            if (!active && generation == 0 && restoredCallback) begin();
            if (!active || resultClaimed) return 0;
            resultClaimed = true;
            return generation;
        }

        synchronized boolean finish(long operation) {
            if (!active || generation != operation) return false;
            active = false;
            resultClaimed = false;
            return true;
        }
    }
}
