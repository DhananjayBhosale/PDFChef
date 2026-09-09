package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class PdfSignatureVerifierContractTest {
    @Test public void coverageRequiresCanonicalNonOverlappingRanges() {
        assertEquals(PdfSignatureReport.Coverage.WHOLE_DOCUMENT,
                PdfSignatureVerifier.coverage(new int[] {0, 80, 100, 20}, 120));
        assertEquals(PdfSignatureReport.Coverage.SIGNED_REVISION_WITH_LATER_CHANGES,
                PdfSignatureVerifier.coverage(new int[] {0, 80, 100, 20}, 140));
        assertEquals(PdfSignatureReport.Coverage.INDETERMINATE,
                PdfSignatureVerifier.coverage(new int[] {1, 79, 100, 20}, 120));
        assertEquals(PdfSignatureReport.Coverage.INDETERMINATE,
                PdfSignatureVerifier.coverage(new int[] {0, 110, 100, 20}, 120));
        assertEquals(PdfSignatureReport.Coverage.INDETERMINATE,
                PdfSignatureVerifier.coverage(new int[] {0, 80, 100, 21}, 120));
        assertEquals(PdfSignatureReport.Coverage.INDETERMINATE,
                PdfSignatureVerifier.coverage(new int[] {0, 1, Integer.MAX_VALUE, 1}, 100));
    }
}
