package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertEquals;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public final class PdfReaderActionsTest {
    private static final String REF = "d1_abcdefghijklmnopqrstuv";

    @Test public void closeAfterPrepareCancelsAndSuppressesQueuedLaunchAndCallback() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        int[] callbacks = {0};
        actions.share(REF, result -> callbacks[0]++);
        background.runNext();
        assertEquals(1, backend.prepares);
        actions.close();
        main.runAll();
        assertEquals(1, backend.cancels);
        assertEquals(0, backend.launches);
        assertEquals(0, callbacks[0]);
    }

    @Test public void closeAfterChooserBeforeMarkNeverDeletesLaunchedStage() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        int[] callbacks = {0};
        actions.share(REF, result -> callbacks[0]++);
        background.runNext();
        main.runAll();
        assertEquals(1, backend.launches);
        actions.close();
        background.runAll();
        main.runAll();
        assertEquals(0, backend.cancels);
        assertEquals(0, callbacks[0]);
    }

    @Test public void closeBeforePreparationRunsProducesNoWorkOrCallback() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        int[] callbacks = {0};
        actions.share(REF, result -> callbacks[0]++);
        actions.close();
        background.runAll();
        main.runAll();
        assertEquals(0, backend.prepares);
        assertEquals(0, backend.launches);
        assertEquals(0, backend.cancels);
        assertEquals(0, callbacks[0]);
    }

    @Test public void readerShareCarriesValidatedDisplayNameToPreparation() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        actions.share(REF, "Scanned document ₹.pdf", result -> { });
        background.runNext();
        assertEquals("Scanned document ₹.pdf", backend.displayName);
        actions.close();
    }

    @Test public void readerShareRejectsUnsafeDisplayNameBeforePreparation() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        String[] code = {null};
        actions.share(REF, "../private.pdf", result -> code[0] = result.code());
        main.runAll();
        assertEquals("DOCUMENT_INVALID_ARGUMENT", code[0]);
        assertEquals(0, backend.prepares);
        actions.close();
    }

    @Test public void saveWritesACopyAndReportsItCompleted() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        boolean[] completed = {false};
        actions.save(REF, "report.pdf", result -> completed[0] = result.completed());
        background.runAll();
        main.runAll();
        assertEquals(1, backend.exports);
        assertEquals("report.pdf", backend.exportedName);
        assertEquals(true, completed[0]);
        actions.close();
    }

    /** A save that could not be written says so, and never claims a copy exists. */
    @Test public void saveThatFailsIsReportedAsNotCompleted() {
        FakeBackend backend = new FakeBackend();
        backend.exportThrows = true;
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        boolean[] completed = {true};
        actions.save(REF, "report.pdf", result -> completed[0] = result.completed());
        background.runAll();
        main.runAll();
        assertEquals(false, completed[0]);
        actions.close();
    }

    /** Sharing and saving both take the single worker, so one waits rather than racing. */
    @Test public void saveWhileSharingIsRefusedAsBusy() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        actions.share(REF, result -> { });
        String[] code = {null};
        actions.save(REF, "report.pdf", result -> code[0] = result.code());
        main.runAll();
        assertEquals("DOCUMENT_BUSY", code[0]);
        assertEquals(0, backend.exports);
        actions.close();
    }

    /** A reference that is not one of ours never reaches the document store. */
    @Test public void saveRejectsARefThatIsNotCanonical() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        String[] code = {null};
        actions.save("../etc/passwd", "report.pdf", result -> code[0] = result.code());
        main.runAll();
        assertEquals("DOCUMENT_INVALID_ARGUMENT", code[0]);
        assertEquals(0, backend.exports);
        actions.close();
    }

    @Test public void saveDequeuedJustBeforeCloseDoesNotExportAfterTheReaderCloses() {
        FakeBackend backend = new FakeBackend();
        ManualExecutor background = new ManualExecutor();
        ManualMain main = new ManualMain();
        PdfReaderActions actions = new PdfReaderActions(backend, main, background);
        int[] callbacks = {0};
        actions.save(REF, "report.pdf", result -> callbacks[0]++);
        Runnable dequeued = background.queue.remove();
        actions.close();
        dequeued.run();
        main.runAll();
        assertEquals(0, backend.exports);
        assertEquals(0, callbacks[0]);
    }

    private static final class FakeBackend implements PdfReaderActions.Backend {
        int prepares, launches, marks, cancels, exports;
        String displayName, exportedName;
        boolean exportSucceeds = true;
        boolean exportThrows;
        final Object handle = new Object();
        @Override public boolean export(String ref, String value) throws Exception {
            exports++;
            exportedName = value;
            if (exportThrows) throw new IllegalStateException("no room");
            return exportSucceeds;
        }
        @Override public Object prepare(String ref) { prepares++; return handle; }
        @Override public Object prepare(String ref, String value) {
            displayName = value;
            return prepare(ref);
        }
        @Override public void launch(Object value) { launches++; }
        @Override public void markDispatched(Object value) { marks++; }
        @Override public void cancel(Object value) { cancels++; }
    }

    private static final class ManualMain implements PdfReaderActions.MainDispatcher {
        final Queue<Runnable> queue = new ArrayDeque<>();
        @Override public void post(Runnable runnable) { queue.add(runnable); }
        void runAll() { while (!queue.isEmpty()) queue.remove().run(); }
    }

    private static final class ManualExecutor extends AbstractExecutorService {
        final Queue<Runnable> queue = new ArrayDeque<>();
        boolean shutdown;
        @Override public void execute(Runnable command) {
            if (shutdown) throw new java.util.concurrent.RejectedExecutionException();
            queue.add(command);
        }
        void runNext() { if (!queue.isEmpty()) queue.remove().run(); }
        void runAll() { while (!queue.isEmpty()) queue.remove().run(); }
        @Override public void shutdown() { shutdown = true; }
        @Override public List<Runnable> shutdownNow() {
            shutdown = true;
            List<Runnable> pending = List.copyOf(queue);
            queue.clear();
            return pending;
        }
        @Override public boolean isShutdown() { return shutdown; }
        @Override public boolean isTerminated() { return shutdown && queue.isEmpty(); }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) {
            return isTerminated();
        }
    }
}
