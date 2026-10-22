package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import androidx.activity.result.ActivityResult;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderLaunchContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.content.ClipData;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;

/** Initial Android document bridge. Unimplemented catalogue methods remain unavailable. */
@CapacitorPlugin(name = "AndroidDocuments")
public final class AndroidDocumentsPlugin extends Plugin {
    private static final long MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final int MAXIMUM_CHUNK_BYTES = 524_288;
    private static final int MAXIMUM_PICKER_ITEMS = 100;
    private static final String PICKER_EVENT = "pendingImportReady";
    private static final String PICKER_SESSION_KEY = "_pdfChefPickerSessionRef";
    private static final String PICKER_MIMES_KEY = "_pdfChefPickerMimeTypes";
    private static final String PICKER_MAXIMUM_KEY = "_pdfChefPickerMaximumItems";
    private static final AtomicBoolean READER_LAUNCH_ACTIVE = new AtomicBoolean();
    private static final AtomicBoolean PICKER_LAUNCH_ACTIVE = new AtomicBoolean();
    private boolean readerLaunching;
    /** Picked file names by batch, applied once the batch is acknowledged. */
    private final Map<String, Map<String, String>> pickedNames = new HashMap<>();
    private boolean pickerLaunching;

    @PluginMethod
    public void readChunk(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 3 || !data.has("ref")
                    || !data.has("offset") || !data.has("length")) {
                rejectInvalid(call);
                return;
            }
            Object rawRef = data.get("ref");
            Long offset = exactInteger(data.get("offset"), 0, MAXIMUM_SAFE_INTEGER);
            Long length = exactInteger(data.get("length"), 1, MAXIMUM_CHUNK_BYTES);
            if (!(rawRef instanceof String) || offset == null || length == null) {
                rejectInvalid(call);
                return;
            }
            PdfChefApplication application =
                    (PdfChefApplication) getContext().getApplicationContext();
            DocumentLifecycleCoordinator.ReadChunk chunk = application
                    .getDocumentLifecycleCoordinator()
                    .readChunk((String) rawRef, offset, length.intValue());
            JSObject output = new JSObject();
            output.put("data", Base64.encodeToString(chunk.bytes(), Base64.NO_WRAP));
            output.put("nextOffset", chunk.nextOffset());
            output.put("done", chunk.done());
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            call.reject(fixedMessage(failure.code()), allowlistedCode(failure.code()));
        } catch (Exception ignored) {
            call.reject("The document is unavailable.", "DOCUMENT_UNAVAILABLE");
        }
    }

    @PluginMethod public void beginWrite(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || (data.length() != 1 && data.length() != 2) || !data.has("mimeType") || (data.length() == 2 && !data.has("displayName"))) { rejectInvalid(call); return; }
            Object name = data.has("displayName") ? data.get("displayName") : null, mime = data.get("mimeType");
            if (!(mime instanceof String) || (name != null && !(name instanceof String)) || !OwnedDocumentWritePolicy.isSupportedMimeType((String) mime) || !OwnedDocumentWritePolicy.isValidDisplayName((String) name)) { rejectInvalid(call); return; }
            DocumentLifecycleCoordinator.WriteSession session = application().getDocumentLifecycleCoordinator().beginWrite((String) name, (String) mime);
            JSObject output = new JSObject(); output.put("sessionRef", session.sessionId()); output.put("maximumChunkBytes", session.maximumChunkBytes()); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); } catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void appendWrite(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 2 || !data.has("sessionRef") || !data.has("data") || !(data.get("sessionRef") instanceof String) || !(data.get("data") instanceof String)) { rejectInvalid(call); return; }
            byte[] bytes = decodeCanonical((String) data.get("data")); if (bytes == null) { rejectInvalid(call); return; }
            int accepted = application().getDocumentLifecycleCoordinator().appendWrite((String) data.get("sessionRef"), bytes, () -> false);
            JSObject output = new JSObject(); output.put("acceptedBytes", accepted); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); } catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void finishWrite(PluginCall call) {
        try {
            JSObject data = call.getData(); if (data == null || (data.length() != 1 && data.length() != 2)
                    || !data.has("sessionRef") || !(data.get("sessionRef") instanceof String)
                    || (data.length() == 2 && (!data.has("transient") || !(data.get("transient") instanceof Boolean)))) { rejectInvalid(call); return; }
            DocumentLifecycleCoordinator.DocumentRecord record = application().getDocumentLifecycleCoordinator().finishWrite(
                    (String) data.get("sessionRef"), data.optBoolean("transient", false), () -> false);
            JSObject output = new JSObject(); output.put("item", publicItem(record)); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); } catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void abortWrite(PluginCall call) {
        try {
            JSObject data = call.getData(); if (data == null || data.length() != 1 || !data.has("sessionRef") || !(data.get("sessionRef") instanceof String)) { rejectInvalid(call); return; }
            boolean aborted = application().getDocumentLifecycleCoordinator().abortWrite((String) data.get("sessionRef"));
            JSObject output = new JSObject(); output.put("aborted", aborted); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); } catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void listOwned(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 0) { rejectInvalid(call); return; }
            JSArray items = new JSArray();
            for (DocumentLifecycleCoordinator.DocumentRecord record : application()
                    .getDocumentLifecycleCoordinator().listOwnedDocuments()) {
                items.put(publicItem(record));
            }
            JSObject output = new JSObject(); output.put("items", items); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void renameItem(PluginCall call) {
        RenameRequest request = renameRequest(call.getData());
        if (request == null) { rejectInvalid(call); return; }
        try {
            execute(() -> completeRenameItem(call, request));
        } catch (RuntimeException failure) {
            unavailable(call);
        }
    }

    private void completeRenameItem(PluginCall call, RenameRequest request) {
        try {
            application().getDocumentLifecycleCoordinator().renameOwnedDocument(
                    request.ref(), request.displayName());
            JSObject output = new JSObject();
            output.put("status", "completed");
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            reject(call, failure);
        } catch (Exception ignored) {
            unavailable(call);
        }
    }

    @PluginMethod public void renameExport(PluginCall call) {
        JSObject data = call.getData();
        Object rawRef = data == null ? null : data.opt("exportRef");
        Object rawName = data == null ? null : data.opt("displayName");
        if (data == null || data.length() != 2 || !(rawRef instanceof String)
                || !(rawName instanceof String)
                || !OwnedDocumentWritePolicy.isValidDisplayName((String) rawName)) {
            rejectInvalid(call);
            return;
        }
        try {
            execute(() -> completeRenameExport(call, (String) rawRef, (String) rawName));
        } catch (RuntimeException failure) {
            unavailable(call);
        }
    }

    private void completeRenameExport(PluginCall call, String exportRef, String displayName) {
        try {
            String savedName = application().getDocumentLifecycleCoordinator()
                    .renameExportedDocument(exportRef, displayName);
            JSObject output = deliveryStatus("completed");
            output.put("savedName", savedName);
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            reject(call, failure);
        } catch (Exception ignored) {
            unavailable(call);
        }
    }

    @PluginMethod public void trashOwned(PluginCall call) {
        JSObject data = call.getData();
        Object rawRef = data == null ? null : data.opt("ref");
        if (data == null || data.length() != 1 || !data.has("ref")
                || !(rawRef instanceof String)
                || !PendingImportRecord.isValidRef((String) rawRef)) {
            rejectInvalid(call); return;
        }
        String ref = (String) rawRef;
        try { execute(() -> completeTrashOwned(call, ref)); }
        catch (RuntimeException failure) { unavailable(call); }
    }

    private void completeTrashOwned(PluginCall call, String ref) {
        try {
            DocumentLifecycleCoordinator.UndoReceipt receipt = application()
                    .getDocumentLifecycleCoordinator().trashOwnedDocument(ref);
            JSObject output = new JSObject();
            output.put("undoRef", receipt.undoRef());
            output.put("expiresAt", receipt.expiresAt());
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void restoreOwned(PluginCall call) {
        JSObject data = call.getData();
        Object rawUndoRef = data == null ? null : data.opt("undoRef");
        if (data == null || data.length() != 1 || !data.has("undoRef")
                || !(rawUndoRef instanceof String)) {
            rejectInvalid(call); return;
        }
        String undoRef = (String) rawUndoRef;
        try { execute(() -> completeRestoreOwned(call, undoRef)); }
        catch (RuntimeException failure) { unavailable(call); }
    }

    private void completeRestoreOwned(PluginCall call, String undoRef) {
        try {
            application().getDocumentLifecycleCoordinator().restoreOwnedDocument(undoRef);
            JSObject output = new JSObject(); output.put("status", "completed");
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void deleteOwned(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 1 || !data.has("ref")
                    || !(data.get("ref") instanceof String)) { rejectInvalid(call); return; }
            boolean deleted = application().getDocumentLifecycleCoordinator()
                    .deleteOwnedDocument((String) data.get("ref"));
            JSObject output = new JSObject(); output.put("deleted", deleted); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void clearOwned(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 0) { rejectInvalid(call); return; }
            int deletedCount = application().getDocumentLifecycleCoordinator()
                    .clearOwnedDocuments();
            JSObject output = new JSObject();
            output.put("deletedCount", deletedCount); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void clearOwnedPayloads(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 0) { rejectInvalid(call); return; }
            int clearedCount = application().getDocumentLifecycleCoordinator()
                    .clearOwnedDocumentPayloads();
            JSObject output = new JSObject();
            output.put("clearedCount", clearedCount); call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void takePendingImports(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 0) { rejectInvalid(call); return; }
            DocumentLifecycleCoordinator.PendingImportBatchRecords pending = application()
                    .getDocumentLifecycleCoordinator().takePendingImports(MAXIMUM_PICKER_ITEMS);
            call.resolve(pendingEnvelope(pending.batchRef(), pending.records()));
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void acknowledgePendingImports(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 2 || !data.has("batchRef")
                    || !data.has("refs") || !(data.get("batchRef") instanceof String)) {
                rejectInvalid(call); return;
            }
            List<String> refs = exactRefs(data.get("refs"));
            String suppliedBatchRef = (String) data.get("batchRef");
            if (refs == null || !PendingImportBatch.isValidBatchRef(suppliedBatchRef)) {
                rejectInvalid(call); return;
            }
            DocumentLifecycleCoordinator coordinator = application().getDocumentLifecycleCoordinator();
            int acknowledged = coordinator.acknowledgePendingImports(suppliedBatchRef, refs, call::isReleased);
            Map<String, String> names;
            synchronized (pickedNames) { names = pickedNames.remove(suppliedBatchRef); }
            if (names != null) {
                for (Map.Entry<String, String> named : names.entrySet()) {
                    try { coordinator.renameOwnedDocument(named.getKey(), named.getValue()); }
                    catch (DocumentLifecycleCoordinator.Failure | RuntimeException ignored) {
                        // The copy is already safe under its unnamed ref; a name is a courtesy.
                    }
                }
            }
            JSObject output = new JSObject();
            output.put("acknowledgedCount", acknowledged);
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) { reject(call, failure); }
        catch (Exception ignored) { unavailable(call); }
    }

    @PluginMethod public void pickDocuments(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || data.length() != 2 || !data.has("acceptedMimeTypes")
                    || !data.has("maximumItems")) { rejectInvalid(call); return; }
            List<String> mimeTypes = exactMimeTypes(data.get("acceptedMimeTypes"));
            Long maximum = exactInteger(data.get("maximumItems"), 1, MAXIMUM_PICKER_ITEMS);
            if (mimeTypes == null || maximum == null) { rejectInvalid(call); return; }
            PickerRequestPolicy policy = new PickerRequestPolicy();
            PickerRequestPolicy.Request request = policy.create(
                    true, mimeTypes, maximum.intValue());
            synchronized (this) {
                if (pickerLaunching || !PICKER_LAUNCH_ACTIVE.compareAndSet(false, true)) {
                    call.reject("A document picker is already open.", "DOCUMENT_BUSY");
                    return;
                }
                pickerLaunching = true;
            }
            data.put(PICKER_SESSION_KEY, request.sessionRef());
            data.put(PICKER_MIMES_KEY, new JSArray(request.acceptedMimeTypes()));
            data.put(PICKER_MAXIMUM_KEY, request.maximumItems());
            startActivityForResult(call, application().getDocumentLifecycleCoordinator()
                    .createPickerIntent(request), "pickerResult");
            if (!launchAccepted(call.isReleased(),
                    getBridge().getSavedCall(call.getCallbackId()) == call)) {
                releasePickerLaunch();
            }
        } catch (PickerRequestPolicy.Failure failure) {
            releasePickerLaunch();
            call.reject(fixedMessage(failure.code()), allowlistedCode(failure.code()));
        } catch (DocumentLifecycleCoordinator.Failure | RuntimeException failure) {
            releasePickerLaunch();
            unavailable(call);
        } catch (Exception failure) {
            releasePickerLaunch();
            unavailable(call);
        }
    }

    @PluginMethod public void exportItem(PluginCall call) {
        DeliveryRequest request = deliveryRequest(call.getData());
        if (request == null) { rejectInvalid(call); return; }
        try {
            execute(() -> completeExportItem(call, request));
        } catch (RuntimeException failure) {
            unavailable(call);
        }
    }

    @PluginMethod public void shareItem(PluginCall call) {
        DeliveryRequest request = deliveryRequest(call.getData());
        if (request == null) { rejectInvalid(call); return; }
        try {
            execute(() -> completeShareItem(call, request));
        } catch (RuntimeException failure) {
            unavailable(call);
        }
    }

    private void completeExportItem(PluginCall call, DeliveryRequest request) {
        try {
            AndroidDocumentExporter.Result result = application()
                    .getDocumentLifecycleCoordinator().exportDocumentResult(
                    request.ref(), request.displayName(), request.mimeType(), call::isReleased);
            if (!result.completedValue()) { call.resolve(deliveryStatus("cancelled")); return; }
            JSObject output = deliveryStatus("completed");
            // A single file can be renamed later through renameExport, under the name
            // MediaStore actually kept (it may add " (1)" when the name was taken).
            if (result.token() != null && result.savedName() != null) {
                output.put("exportRef", result.token());
                output.put("savedName", result.savedName());
            }
            call.resolve(output);
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            if ("DOCUMENT_CANCELLED".equals(failure.code())) {
                call.resolve(deliveryStatus("cancelled"));
            } else {
                reject(call, failure);
            }
        } catch (Exception ignored) {
            unavailable(call);
        }
    }

    private void completeShareItem(PluginCall call, DeliveryRequest request) {
        DocumentLifecycleCoordinator.ShareHandle handle = null;
        try {
            DocumentLifecycleCoordinator coordinator = application()
                    .getDocumentLifecycleCoordinator();
            handle = coordinator.prepareShare(
                    request.ref(), request.mimeType(), call::isReleased);
            List<Uri> contentUris = coordinator.createShareContentUris(handle);
            if (request.mimeType() != null) {
                contentUris = List.of(contentUris.get(0).buildUpon()
                        .appendQueryParameter("displayName", request.displayName()).build());
            }
            Intent send = coordinator.createShareIntent(handle, contentUris);
            if (call.isReleased()) {
                coordinator.cancelShareBeforeDispatch(handle);
                return;
            }
            Activity activity = getActivity();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                coordinator.cancelShareBeforeDispatch(handle);
                unavailable(call);
                return;
            }
            DocumentLifecycleCoordinator.ShareHandle prepared = handle;
            activity.runOnUiThread(() -> launchPreparedShare(
                    call, activity, coordinator, prepared, send));
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            cancelPreparedShare(handle);
            if ("DOCUMENT_CANCELLED".equals(failure.code())) {
                call.resolve(deliveryStatus("cancelled"));
            } else {
                reject(call, failure);
            }
        } catch (Exception ignored) {
            cancelPreparedShare(handle);
            unavailable(call);
        }
    }

    private void launchPreparedShare(PluginCall call, Activity activity,
            DocumentLifecycleCoordinator coordinator,
            DocumentLifecycleCoordinator.ShareHandle handle, Intent send) {
        if (call.isReleased() || activity.isFinishing() || activity.isDestroyed()) {
            scheduleShareCancellation(call, handle, false);
            return;
        }
        try {
            activity.startActivity(Intent.createChooser(send, null));
        } catch (RuntimeException failure) {
            scheduleShareCancellation(call, handle, true);
            return;
        }
        call.resolve(deliveryStatus("completed"));
        try {
            execute(() -> {
                try { coordinator.markShareDispatched(handle); }
                catch (DocumentLifecycleCoordinator.Failure ignored) { }
            });
        } catch (RuntimeException ignored) {
            // The chooser owns a live read grant. The bounded stage remains until expiry.
        }
    }

    private void scheduleShareCancellation(PluginCall call,
            DocumentLifecycleCoordinator.ShareHandle handle, boolean rejectAfter) {
        try {
            execute(() -> {
                cancelPreparedShare(handle);
                if (rejectAfter && !call.isReleased()) unavailable(call);
            });
        } catch (RuntimeException failure) {
            if (rejectAfter && !call.isReleased()) unavailable(call);
        }
    }

    private void cancelPreparedShare(DocumentLifecycleCoordinator.ShareHandle handle) {
        if (handle == null) return;
        try {
            application().getDocumentLifecycleCoordinator().cancelShareBeforeDispatch(handle);
        } catch (DocumentLifecycleCoordinator.Failure ignored) { }
    }

    @PluginMethod public void openReader(PluginCall call) {
        try {
            JSObject data = call.getData();
            if (data == null || (data.length() != 2 && data.length() != 3)
                    || !data.has("ref") || !data.has("displayName")
                    || (data.length() == 3 && !data.has("initialAction"))
                    || !(data.get("ref") instanceof String)
                    || !(data.get("displayName") instanceof String)
                    || (data.has("initialAction")
                        && !(data.get("initialAction") instanceof String))) {
                rejectInvalid(call); return;
            }
            String ref = (String) data.get("ref");
            String displayName = (String) data.get("displayName");
            String initialAction = data.has("initialAction")
                    ? (String) data.get("initialAction") : null;
            if (!PdfReaderLaunchContract.isCanonicalRef(ref)
                    || !PdfReaderLaunchContract.isSafeDisplayName(displayName)
                    || (initialAction != null
                        && !PdfReaderLaunchContract.INITIAL_ACTION_VERIFY_SIGNATURES
                            .equals(initialAction))) {
                rejectInvalid(call); return;
            }
            synchronized (this) {
                if (readerLaunching || !READER_LAUNCH_ACTIVE.compareAndSet(false, true)) {
                    call.reject("A reader is already open.", "DOCUMENT_BUSY");
                    return;
                }
                readerLaunching = true;
            }
            Intent readerIntent = initialAction == null
                    ? PdfReaderLaunchContract.createIntent(getContext(), ref, displayName)
                    : PdfReaderLaunchContract.createSignatureVerificationIntent(
                            getContext(), ref, displayName);
            startActivityForResult(call, readerIntent, "readerResult");
            if (!launchAccepted(call.isReleased(),
                    getBridge().getSavedCall(call.getCallbackId()) == call)) {
                releaseReaderLaunch();
            }
        } catch (PdfReaderLaunchContract.Failure | RuntimeException failure) {
            releaseReaderLaunch();
            unavailable(call);
        } catch (Exception failure) {
            releaseReaderLaunch();
            unavailable(call);
        }
    }

    @ActivityCallback
    private void readerResult(PluginCall call, ActivityResult activityResult) {
        releaseReaderLaunch();
        if (call == null || activityResult == null) return;
        try {
            PdfReaderLaunchContract.Result result = PdfReaderLaunchContract.parseResult(
                    activityResult.getResultCode(), activityResult.getData());
            JSObject output = new JSObject(); output.put("action", result.action());
            if (result.toolPath() != null) output.put("toolPath", result.toolPath());
            call.resolve(output);
        } catch (PdfReaderLaunchContract.Failure | RuntimeException failure) {
            unavailable(call);
        }
    }

    @ActivityCallback
    private void pickerResult(PluginCall call, ActivityResult activityResult) {
        if (call == null || activityResult == null) {
            releasePickerLaunch();
            return;
        }
        try {
            execute(() -> completePickerResult(call, activityResult));
        } catch (RuntimeException failure) {
            releasePickerLaunch();
            unavailable(call);
        }
    }

    private void completePickerResult(PluginCall call, ActivityResult activityResult) {
        try {
            PickerRequestPolicy.Request request = restorePickerRequest(call.getData());
            AndroidDocumentPickerController.Result result = application()
                    .getDocumentLifecycleCoordinator().handlePickerResult(
                            request, activityResult.getResultCode(), activityResult.getData(),
                            call::isReleased);
            if ("cancelled".equals(result.status())) {
                JSObject output = new JSObject();
                output.put("status", "cancelled");
                output.put("batchRef", JSObject.NULL);
                output.put("items", new JSArray());
                call.resolve(output);
                return;
            }
            List<DocumentLifecycleCoordinator.DocumentRecord> records = application()
                    .getDocumentLifecycleCoordinator().pendingImportsForBatch(result.batchRef());
            Map<String, String> names = pickedPdfNames(
                    activityResult.getData(), result.itemRefs(), records);
            synchronized (pickedNames) { pickedNames.put(result.batchRef(), names); }
            JSObject output = acceptedPickerEnvelope(result.batchRef(), records);
            JSONArray items = output.getJSONArray("items");
            for (int index = 0; index < items.length(); index++) {
                org.json.JSONObject item = items.getJSONObject(index);
                String name = names.get(item.getString("ref"));
                if (name != null) item.put("displayName", name);
            }
            JSObject event = new JSObject();
            event.put("batchRef", output.getString("batchRef"));
            event.put("itemCount", records.size());
            notifyListeners(PICKER_EVENT, event, true);
            call.resolve(output);
        } catch (PickerRequestPolicy.Failure failure) {
            call.reject(fixedMessage(failure.code()), allowlistedCode(failure.code()));
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            reject(call, failure);
        } catch (Exception ignored) {
            unavailable(call);
        } finally {
            releasePickerLaunch();
        }
    }

    static boolean launchAccepted(boolean callReleased, boolean savedCallMatches) {
        return !callReleased && savedCallMatches;
    }

    private void releaseReaderLaunch() {
        synchronized (this) { readerLaunching = false; }
        READER_LAUNCH_ACTIVE.set(false);
    }

    private void releasePickerLaunch() {
        synchronized (this) { pickerLaunching = false; }
        PICKER_LAUNCH_ACTIVE.set(false);
    }

    private static PickerRequestPolicy.Request restorePickerRequest(JSObject data)
            throws PickerRequestPolicy.Failure {
        if (data == null || data.length() != 5 || !(data.opt(PICKER_SESSION_KEY) instanceof String)) {
            return invalidRestoredPickerRequest();
        }
        List<String> mimeTypes = exactMimeTypes(data.opt(PICKER_MIMES_KEY));
        Long maximum = exactInteger(data.opt(PICKER_MAXIMUM_KEY), 1, MAXIMUM_PICKER_ITEMS);
        if (mimeTypes == null || maximum == null) {
            return invalidRestoredPickerRequest();
        }
        return new PickerRequestPolicy().restore((String) data.opt(PICKER_SESSION_KEY),
                mimeTypes, maximum.intValue());
    }

    private static PickerRequestPolicy.Request invalidRestoredPickerRequest()
            throws PickerRequestPolicy.Failure {
        return new PickerRequestPolicy().restore("", List.of(), 0);
    }

    private static List<String> exactMimeTypes(Object raw) {
        if (!(raw instanceof JSONArray)) return null;
        JSONArray values = (JSONArray) raw;
        if (values.length() < 1 || values.length() > 6) return null;
        ArrayList<String> result = new ArrayList<>(values.length());
        Set<String> unique = new HashSet<>();
        for (int index = 0; index < values.length(); index++) {
            Object value = values.opt(index);
            if (!(value instanceof String)
                    || !AndroidDocumentIngressPolicy.isSupportedMimeType((String) value)
                    || !unique.add((String) value)) return null;
            result.add((String) value);
        }
        return List.copyOf(result);
    }

    private static List<String> exactRefs(Object raw) {
        if (!(raw instanceof JSONArray)) return null;
        JSONArray values = (JSONArray) raw;
        if (values.length() < 1 || values.length() > MAXIMUM_PICKER_ITEMS) return null;
        ArrayList<String> result = new ArrayList<>(values.length());
        Set<String> unique = new HashSet<>();
        for (int index = 0; index < values.length(); index++) {
            Object value = values.opt(index);
            if (!(value instanceof String) || !PendingImportRecord.isValidRef((String) value)
                    || !unique.add((String) value)) return null;
            result.add((String) value);
        }
        return List.copyOf(result);
    }

    static DeliveryRequest deliveryRequest(JSObject data) {
        if (data == null || data.length() < 1 || data.length() > 3 || !data.has("ref")) {
            return null;
        }
        boolean hasDisplayName = data.has("displayName");
        boolean hasMimeType = data.has("mimeType");
        if (data.length() != 1 + (hasDisplayName ? 1 : 0) + (hasMimeType ? 1 : 0)) {
            return null;
        }
        Object rawRef = data.opt("ref");
        Object rawName = hasDisplayName ? data.opt("displayName") : null;
        Object rawMime = hasMimeType ? data.opt("mimeType") : null;
        return deliveryRequestValues(
                rawRef, hasDisplayName, rawName, hasMimeType, rawMime);
    }

    static RenameRequest renameRequest(JSObject data) {
        if (data == null || data.length() != 2 || !data.has("ref")
                || !data.has("displayName")) return null;
        return renameRequestValues(data.opt("ref"), data.opt("displayName"));
    }

    static RenameRequest renameRequestValues(Object rawRef, Object rawDisplayName) {
        if (!(rawRef instanceof String) || !(rawDisplayName instanceof String)) return null;
        String ref = (String) rawRef;
        String displayName = (String) rawDisplayName;
        if (!PendingImportRecord.isValidRef(ref)
                || !OwnedDocumentWritePolicy.isValidDisplayName(displayName)
                || displayName == null) return null;
        return new RenameRequest(ref, displayName);
    }

    static DeliveryRequest deliveryRequestValues(Object rawRef,
            boolean hasDisplayName, Object rawName, boolean hasMimeType, Object rawMime) {
        if (!(rawRef instanceof String)
                || (hasDisplayName && !(rawName instanceof String))
                || (hasMimeType && !(rawMime instanceof String))) return null;
        String ref = (String) rawRef;
        String mimeType = hasMimeType ? (String) rawMime
                : (hasDisplayName ? null : AndroidDocumentIngressPolicy.MIME_PDF);
        String displayName = hasDisplayName
                ? (String) rawName : defaultDeliveryName(mimeType);
        if (!PdfReaderLaunchContract.isCanonicalRef(ref)
                || (mimeType == null && !ref.matches("a1_[1-9][0-9]{0,15}"))
                || (mimeType != null
                    && !(PendingImportRecord.isValidRef(ref)
                        ? OwnedDocumentWritePolicy.isSupportedMimeType(mimeType)
                        : AndroidDocumentIngressPolicy.isSupportedMimeType(mimeType)))
                || !OwnedDocumentWritePolicy.isValidDisplayName(displayName)
                || displayName == null) return null;
        return new DeliveryRequest(ref, displayName, mimeType);
    }

    private static String defaultDeliveryName(String mimeType) {
        if (AndroidDocumentIngressPolicy.MIME_JPEG.equals(mimeType)) return "Document.jpg";
        if (AndroidDocumentIngressPolicy.MIME_PNG.equals(mimeType)) return "Document.png";
        if (AndroidDocumentIngressPolicy.MIME_HEIC.equals(mimeType)) return "Document.heic";
        if (AndroidDocumentIngressPolicy.MIME_DOCX.equals(mimeType)) return "Document.docx";
        if (AndroidDocumentIngressPolicy.MIME_PPTX.equals(mimeType)) return "Document.pptx";
        if (OwnedDocumentWritePolicy.MIME_ZIP.equals(mimeType)) return "Document.zip";
        if (OwnedDocumentWritePolicy.MIME_TEXT.equals(mimeType)) return "Document.txt";
        if (OwnedDocumentWritePolicy.MIME_WEBP.equals(mimeType)) return "Document.webp";
        return "Document.pdf";
    }

    private static JSObject deliveryStatus(String status) {
        JSObject output = new JSObject();
        output.put("status", status);
        return output;
    }

    static String batchRef(List<String> refs) {
        try { return PendingImportBatch.batchRef(refs); }
        catch (java.io.IOException invalid) { throw new IllegalArgumentException(invalid); }
    }

    private static JSObject pendingEnvelope(
            String batchRef, List<DocumentLifecycleCoordinator.DocumentRecord> records) {
        JSObject output = new JSObject();
        if (records.isEmpty()) {
            output.put("batchRef", JSObject.NULL);
            output.put("items", new JSArray());
            return output;
        }
        output.put("batchRef", batchRef);
        output.put("items", pendingItems(records));
        return output;
    }

    /**
     * The picker copy keeps no source name, so Recent and the share sheet said "Document".
     * The provider's name is read here, made safe, and kept for picked PDFs only.
     */
    private Map<String, String> pickedPdfNames(Intent data, List<String> refs,
            List<DocumentLifecycleCoordinator.DocumentRecord> records) {
        Map<String, String> names = new HashMap<>();
        if (data == null) return names;
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int index = 0; index < clip.getItemCount(); index++) uris.add(clip.getItemAt(index).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.size() != refs.size()) return names;
        Set<String> pdfRefs = new HashSet<>();
        for (DocumentLifecycleCoordinator.DocumentRecord record : records) {
            if ("application/pdf".equals(record.mimeType())) pdfRefs.add(record.ref());
        }
        for (int index = 0; index < uris.size(); index++) {
            if (!pdfRefs.contains(refs.get(index))) continue;
            String name = IncomingPdfIntake.safeDisplayName(IncomingPdfIntake.displayNameOf(
                    getContext().getContentResolver(), uris.get(index)));
            if (name != null) names.put(refs.get(index), name);
        }
        return names;
    }

    private static JSObject acceptedPickerEnvelope(
            String batchRef, List<DocumentLifecycleCoordinator.DocumentRecord> records) {
        JSObject output = pendingEnvelope(batchRef, records);
        output.put("status", "accepted");
        return output;
    }

    private static JSArray pendingItems(
            List<DocumentLifecycleCoordinator.DocumentRecord> records) {
        JSArray items = new JSArray();
        for (DocumentLifecycleCoordinator.DocumentRecord record : records) {
            items.put(publicItem(record, true));
        }
        return items;
    }

    private static Long exactInteger(Object raw, long minimum, long maximum) {
        if (!(raw instanceof Number)) return null;
        double value = ((Number) raw).doubleValue();
        long integer = ((Number) raw).longValue();
        if (!Double.isFinite(value) || value != integer
                || integer < minimum || integer > maximum) return null;
        return integer;
    }

    /** A separate event prevents ordinary tool pickers from navigating away. */
    public void announceIncomingPdf(String ref) {
        if (!PendingImportRecord.isValidRef(ref)) return;
        JSObject event = new JSObject();
        event.put("ref", ref);
        notifyListeners("incomingPdfReady", event, true);
    }

    /** A handed-over file this app refused. Only a fixed reason word crosses, never the file. */
    public void announceIncomingPdfRejected(String reason) {
        if (!"tooLarge".equals(reason) && !"notPdf".equals(reason) && !"other".equals(reason)) return;
        JSObject event = new JSObject();
        event.put("reason", reason);
        notifyListeners("incomingPdfRejected", event, true);
    }

    private PdfChefApplication application() { return (PdfChefApplication) getContext().getApplicationContext(); }
    private static JSObject publicItem(DocumentLifecycleCoordinator.DocumentRecord record) {
        return publicItem(record, false);
    }
    private static JSObject publicItem(DocumentLifecycleCoordinator.DocumentRecord record,
            boolean pending) {
        JSObject item = new JSObject(); item.put("kind", "file"); item.put("ref", record.ref());
        item.put("displayName", record.displayName() == null ? JSObject.NULL : record.displayName());
        item.put("mimeType", record.mimeType());
        item.put("sizeBytes", record.sizeBytes()); item.put("contentHash", record.contentHash());
        item.put("createdAt", record.createdAtMillis());
        item.put("available", record.available());
        item.put("pending", pending); return item;
    }
    private static byte[] decodeCanonical(String value) { if (value.length() == 0 || value.length() > 699_052) return null; try { byte[] bytes = java.util.Base64.getDecoder().decode(value); return bytes.length < 1 || bytes.length > MAXIMUM_CHUNK_BYTES || !java.util.Base64.getEncoder().encodeToString(bytes).equals(value) ? null : bytes; } catch (IllegalArgumentException failure) { return null; } }
    private static void unavailable(PluginCall call) { call.reject("The document is unavailable.", "DOCUMENT_UNAVAILABLE"); }
    private static void reject(PluginCall call, DocumentLifecycleCoordinator.Failure failure) { call.reject(fixedMessage(failure.code()), allowlistedCode(failure.code())); }

    private static void rejectInvalid(PluginCall call) {
        call.reject("The document request is invalid.", "DOCUMENT_INVALID_ARGUMENT");
    }

    private static String allowlistedCode(String code) {
        if ("DOCUMENT_NOT_FOUND".equals(code) || "DOCUMENT_CORRUPT".equals(code)
                || "DOCUMENT_UNAVAILABLE".equals(code)
                || "DOCUMENT_UNSAFE_STATE".equals(code)
                || "DOCUMENT_COLLECTION_UNSUPPORTED".equals(code)
                || "DOCUMENT_BUSY".equals(code)
                || "DOCUMENT_LIMIT_EXCEEDED".equals(code) || "DOCUMENT_STORAGE_FULL".equals(code)
                || "DOCUMENT_INTERRUPTED".equals(code) || "DOCUMENT_CANCELLED".equals(code)) return code;
        return "DOCUMENT_INVALID_ARGUMENT";
    }

    private static String fixedMessage(String code) {
        if ("DOCUMENT_NOT_FOUND".equals(code)) return "The document was not found.";
        if ("DOCUMENT_CORRUPT".equals(code)) return "The document could not be validated.";
        if ("DOCUMENT_UNAVAILABLE".equals(code)) return "The document is unavailable.";
        if ("DOCUMENT_UNSAFE_STATE".equals(code)) return "The document state is unavailable.";
        if ("DOCUMENT_COLLECTION_UNSUPPORTED".equals(code)) {
            return "Collections are not supported.";
        }
        if ("DOCUMENT_BUSY".equals(code)) return "Another document operation is in progress.";
        if ("DOCUMENT_LIMIT_EXCEEDED".equals(code)) return "The document limit was exceeded.";
        if ("DOCUMENT_STORAGE_FULL".equals(code)) return "There is not enough storage.";
        if ("DOCUMENT_INTERRUPTED".equals(code)) return "The document operation was interrupted.";
        if ("DOCUMENT_CANCELLED".equals(code)) return "The document operation was cancelled.";
        return "The document request is invalid.";
    }

    record DeliveryRequest(String ref, String displayName, String mimeType) { }
    record RenameRequest(String ref, String displayName) { }
}
