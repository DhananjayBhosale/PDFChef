package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

/** Keeps third-party accessibility failures from taking down the reader process. */
final class PdfReaderRuntimeGuard {
    interface ValueCall<T> { T run(); }
    interface ActionCall { void run(); }

    private PdfReaderRuntimeGuard() { }

    static <T> T value(ValueCall<T> call, T fallback) {
        try { return call.run(); }
        catch (RuntimeException failure) { return fallback; }
    }

    static void action(ActionCall call) {
        try { call.run(); }
        catch (RuntimeException ignored) { }
    }
}
