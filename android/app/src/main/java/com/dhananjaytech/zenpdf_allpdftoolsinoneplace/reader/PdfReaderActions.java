package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Native-only reader actions. Preparation is off-main and failure never closes the reader. */
public final class PdfReaderActions implements AutoCloseable {
    private static final String MIME_PDF = "application/pdf";
    private static final String DISPLAY_NAME_QUERY = "displayName";

    private final Backend backend;
    private final MainDispatcher main;
    private final ExecutorService executor;
    private final Object stateLock = new Object();
    private boolean busy;
    private boolean closed;
    private boolean chooserLaunched;
    private long generation;
    private Object preparedHandle;

    public PdfReaderActions(Activity activity, DocumentLifecycleCoordinator coordinator) {
        this(new ProductionBackend(activity, coordinator), activity::runOnUiThread,
                Executors.newSingleThreadExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "pdfchef-reader-share");
                    thread.setDaemon(true);
                    return thread;
                }));
    }

    PdfReaderActions(Backend backend, MainDispatcher main, ExecutorService executor) {
        this.backend = Objects.requireNonNull(backend);
        this.main = Objects.requireNonNull(main);
        this.executor = Objects.requireNonNull(executor);
    }

    /** Returns immediately; the fixed completion callback is dispatched on the main thread. */
    public void share(String ref, Callback callback) {
        share(ref, null, callback);
    }

    /** Reader-only overload. The Activity has already validated this display name. */
    void share(String ref, String displayName, Callback callback) {
        Objects.requireNonNull(callback);
        long operation;
        synchronized (stateLock) {
            if (closed) return;
            if (busy) {
                completeIfOpen(callback, Result.failed("DOCUMENT_BUSY"));
                return;
            }
            if (!PdfReaderLaunchContract.isCanonicalRef(ref)) {
                completeIfOpen(callback, Result.failed("DOCUMENT_INVALID_ARGUMENT"));
                return;
            }
            if (displayName != null && !PdfReaderLaunchContract.isSafeDisplayName(displayName)) {
                completeIfOpen(callback, Result.failed("DOCUMENT_INVALID_ARGUMENT"));
                return;
            }
            busy = true;
            chooserLaunched = false;
            operation = ++generation;
        }
        try {
            executor.execute(() -> prepare(operation, ref, displayName, callback));
        } catch (RejectedExecutionException failure) {
            finish(operation, callback, Result.failed("DOCUMENT_UNAVAILABLE"));
        }
    }

    /**
     * Write a copy where the reader can find it again.
     *
     * Sharing hands the file to another app; someone who opened a PDF from a
     * browser wants to keep it. Same off-main discipline as {@link #share}: a
     * save that fails leaves the open document exactly as it was.
     */
    public void save(String ref, String displayName, Callback callback) {
        Objects.requireNonNull(callback);
        long operation;
        synchronized (stateLock) {
            if (closed) return;
            if (busy) {
                completeIfOpen(callback, Result.failed("DOCUMENT_BUSY"));
                return;
            }
            if (!PdfReaderLaunchContract.isCanonicalRef(ref)) {
                completeIfOpen(callback, Result.failed("DOCUMENT_INVALID_ARGUMENT"));
                return;
            }
            if (displayName != null && !PdfReaderLaunchContract.isSafeDisplayName(displayName)) {
                completeIfOpen(callback, Result.failed("DOCUMENT_INVALID_ARGUMENT"));
                return;
            }
            busy = true;
            operation = ++generation;
        }
        try {
            executor.execute(() -> {
                synchronized (stateLock) {
                    if (closed || generation != operation) return;
                }
                Result result;
                try {
                    result = backend.export(ref, displayName)
                            ? Result.success()
                            : Result.failed("DOCUMENT_UNAVAILABLE");
                } catch (Exception failure) {
                    result = Result.failed("DOCUMENT_UNAVAILABLE");
                }
                finish(operation, callback, result);
            });
        } catch (RejectedExecutionException failure) {
            finish(operation, callback, Result.failed("DOCUMENT_UNAVAILABLE"));
        }
    }

    private void prepare(long operation, String ref, String displayName, Callback callback) {
        Object handle = null;
        try {
            handle = displayName == null
                    ? backend.prepare(ref)
                    : backend.prepare(ref, displayName);
            boolean stale;
            synchronized (stateLock) {
                stale = closed || generation != operation;
                if (!stale) preparedHandle = handle;
            }
            if (stale) {
                cancel(handle);
                return;
            }
            Object prepared = handle;
            main.post(() -> launch(operation, prepared, callback));
        } catch (Exception failure) {
            cancel(handle);
            finish(operation, callback, Result.failed("DOCUMENT_UNAVAILABLE"));
        }
    }

    private void launch(long operation, Object handle, Callback callback) {
        try {
            synchronized (stateLock) {
                if (closed || generation != operation || preparedHandle != handle) {
                    return;
                }
                backend.launch(handle);
                chooserLaunched = true;
            }
        } catch (Exception failure) {
            scheduleCancel(operation, handle, callback);
            return;
        }
        Runnable finalize = () -> {
            Result result;
            try {
                backend.markDispatched(handle);
                result = Result.success();
            } catch (Exception failure) {
                result = Result.failed("DOCUMENT_UNAVAILABLE");
            }
            clearPrepared(operation, handle);
            finish(operation, callback, result);
        };
        try { executor.execute(finalize); }
        catch (RejectedExecutionException failure) { finalize.run(); }
    }

    private void scheduleCancel(long operation, Object handle, Callback callback) {
        Runnable cancellation = () -> {
            cancel(handle);
            clearPrepared(operation, handle);
            finish(operation, callback, Result.failed("DOCUMENT_UNAVAILABLE"));
        };
        try { executor.execute(cancellation); }
        catch (RejectedExecutionException ignored) { cancellation.run(); }
    }

    private void cancel(Object handle) {
        if (handle == null) return;
        try { backend.cancel(handle); } catch (Exception ignored) { }
    }

    private void clearPrepared(long operation, Object handle) {
        synchronized (stateLock) {
            if (generation == operation && preparedHandle == handle) {
                preparedHandle = null;
                chooserLaunched = false;
            }
        }
    }

    private void finish(long operation, Callback callback, Result result) {
        synchronized (stateLock) {
            if (closed || generation != operation) return;
            busy = false;
        }
        completeIfOpen(callback, result);
    }

    private void completeIfOpen(Callback callback, Result result) {
        main.post(() -> {
            synchronized (stateLock) { if (closed) return; }
            callback.onComplete(result);
        });
    }

    @Override public void close() {
        Object handleToCancel;
        synchronized (stateLock) {
            if (closed) return;
            closed = true;
            generation++;
            busy = false;
            handleToCancel = chooserLaunched ? null : preparedHandle;
            preparedHandle = null;
            chooserLaunched = false;
        }
        executor.shutdownNow();
        cancel(handleToCancel);
    }

    @FunctionalInterface public interface Callback { void onComplete(Result result); }

    public static final class Result {
        private final boolean completed;
        private final String code;
        private Result(boolean completed, String code) {
            this.completed = completed;
            this.code = code;
        }
        public boolean completed() { return completed; }
        public String code() { return code; }
        static Result success() { return new Result(true, null); }
        static Result failed(String code) { return new Result(false, code); }
    }

    interface Backend {
        Object prepare(String ref) throws Exception;
        boolean export(String ref, String displayName) throws Exception;
        default Object prepare(String ref, String displayName) throws Exception {
            return prepare(ref);
        }
        void launch(Object handle) throws Exception;
        void markDispatched(Object handle) throws Exception;
        void cancel(Object handle) throws Exception;
    }

    @FunctionalInterface interface MainDispatcher { void post(Runnable runnable); }

    private static final class ProductionBackend implements Backend {
        private final Activity activity;
        private final DocumentLifecycleCoordinator coordinator;
        ProductionBackend(Activity activity, DocumentLifecycleCoordinator coordinator) {
            this.activity = Objects.requireNonNull(activity);
            this.coordinator = Objects.requireNonNull(coordinator);
        }
        @Override public Object prepare(String ref) throws Exception {
            return prepare(ref, null);
        }
        @Override public Object prepare(String ref, String displayName) throws Exception {
            DocumentLifecycleCoordinator.ShareHandle handle = coordinator.prepareShare(
                    ref, MIME_PDF, Thread.currentThread()::isInterrupted);
            Uri contentUri = coordinator.createShareContentUri(handle);
            if (displayName != null) {
                contentUri = contentUri.buildUpon()
                        .appendQueryParameter(DISPLAY_NAME_QUERY, displayName)
                        .build();
            }
            Intent send = coordinator.createShareIntent(handle, contentUri);
            return new Prepared(handle, send);
        }
        @Override public boolean export(String ref, String displayName) throws Exception {
            return coordinator.exportDocument(
                    ref,
                    displayName,
                    MIME_PDF,
                    Thread.currentThread()::isInterrupted);
        }
        @Override public void launch(Object value) {
            Prepared prepared = requirePrepared(value);
            activity.startActivity(Intent.createChooser(prepared.send, null));
        }
        @Override public void markDispatched(Object value) throws Exception {
            coordinator.markShareDispatched(requirePrepared(value).handle);
        }
        @Override public void cancel(Object value) throws Exception {
            coordinator.cancelShareBeforeDispatch(requirePrepared(value).handle);
        }
        private static Prepared requirePrepared(Object value) {
            if (!(value instanceof Prepared prepared)) throw new IllegalArgumentException();
            return prepared;
        }
    }

    private record Prepared(DocumentLifecycleCoordinator.ShareHandle handle, Intent send) { }
}
