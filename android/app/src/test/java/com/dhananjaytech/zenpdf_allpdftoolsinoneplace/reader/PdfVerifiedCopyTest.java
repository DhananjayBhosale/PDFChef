package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PdfVerifiedCopyTest {
    @Test public void passwordPreservationRequiresAsciiAndAtMost32Bytes() {
        assertTrue(PdfVerifiedCopy.canPreservePassword(null));
        assertTrue(PdfVerifiedCopy.canPreservePassword(new char[0]));
        assertTrue(PdfVerifiedCopy.canPreservePassword("a".repeat(32).toCharArray()));
        assertFalse(PdfVerifiedCopy.canPreservePassword("a".repeat(33).toCharArray()));
        assertTrue(PdfVerifiedCopy.canPreservePassword(new char[] {0, 0x7f}));
        assertFalse(PdfVerifiedCopy.canPreservePassword(new char[] {0x80}));
        assertFalse(PdfVerifiedCopy.canPreservePassword("café".toCharArray()));
        assertFalse(PdfVerifiedCopy.canPreservePassword("🔑".toCharArray()));
    }

    @Test public void replacesFixtureStatusAndAddsGreenAfterFirstBt() {
        assertEquals("BT\n0.13 0.5 0.25 rg\n 1 0 0 1 2 23.3 Tm /F1 4.7 Tf (Signature valid)Tj ET",
                PdfVerifiedCopy.validStatusText("BT 1 0 0 1 2 23.3 Tm /F1 4.7 Tf (Signature Not Verified)Tj ET"));
    }

    @Test public void changesOnlyFirstTextAndPreservesEscapedAndNestedStrings() {
        assertEquals("BT\n0.13 0.5 0.25 rg\n (Signature valid) Tj (keep)Tj ET BT (last)Tj ET",
                PdfVerifiedCopy.validStatusText("BT (Not \\(verified\\) (nested)) Tj (keep)Tj ET BT (last)Tj ET"));
    }

    @Test public void ignoresCommentsNamesAndHexStrings() {
        assertEquals("% BT (comment)Tj\n/BT <4254> BT\n0.13 0.5 0.25 rg\n (Signature valid)Tj ET",
                PdfVerifiedCopy.validStatusText("% BT (comment)Tj\n/BT <4254> BT (old)Tj ET"));
    }

    @Test public void noLiteralTjLeavesLayerExactlyUnchanged() {
        for (String text : new String[] {"% DSBlank\n", "BT <1234>Tj ET", "BT [(old)]TJ ET",
                "BT (unterminated Tj", "BT (old)TjSomething ET", "(old)Tj"}) {
            assertEquals(text, PdfVerifiedCopy.validStatusText(text));
        }
    }

    @Test public void provenanceNoteSaysWhatTheCopyIsAndWhenItWasChecked() {
        java.util.Calendar checked = java.util.Calendar.getInstance(java.util.Locale.US);
        checked.set(2026, java.util.Calendar.SEPTEMBER, 28, 12, 0, 0);
        assertEquals("Copy of a digitally signed PDF. Its signature was checked by PDF Chef on 28 Sep 2026."
                        + " This copy itself is not digitally signed.",
                PdfVerifiedCopy.provenanceNote(checked.getTime()));
    }

    @Test public void safeFilenamePreservesBaseAndCannotEscapeDirectory() {
        assertEquals("My file (verified copy).pdf", PdfVerifiedCopy.copyName("My file.PDF"));
        assertEquals(".._outside (verified copy).pdf", PdfVerifiedCopy.copyName("../outside.pdf"));
    }
}
