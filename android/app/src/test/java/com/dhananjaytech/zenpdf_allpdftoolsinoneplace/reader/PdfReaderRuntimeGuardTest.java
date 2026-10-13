package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class PdfReaderRuntimeGuardTest {
    @Test public void returnsTheProviderValueWhenItIsValid() {
        assertEquals("node", PdfReaderRuntimeGuard.value(() -> "node", "fallback"));
    }

    @Test public void containsAThirdPartyRuntimeFailure() {
        assertEquals("fallback", PdfReaderRuntimeGuard.value(() -> {
            throw new RuntimeException("invalid transient virtual node");
        }, "fallback"));
        PdfReaderRuntimeGuard.action(() -> {
            throw new RuntimeException("invalid transient virtual node");
        });
    }
}
