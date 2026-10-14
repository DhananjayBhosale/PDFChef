package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** A PDF opened from another app keeps the name that app gave it, made safe for storage. */
public final class IncomingPdfIntakeNameTest {
    @Test public void senderNamesBecomeSafePdfNames() {
        assertEquals("QA Form.pdf", IncomingPdfIntake.safeDisplayName("QA Form.pdf"));
        assertEquals("Invoice.pdf", IncomingPdfIntake.safeDisplayName("Invoice.PDF"));
        assertEquals("Invoice.pdf", IncomingPdfIntake.safeDisplayName("Invoice"));
        assertEquals("रिपोर्ट हिंदी नाम.pdf", IncomingPdfIntake.safeDisplayName("रिपोर्ट हिंदी नाम.pdf"));
        assertEquals("a-b-c.pdf", IncomingPdfIntake.safeDisplayName("a/b\\c.pdf"));
        assertEquals("trail.pdf", IncomingPdfIntake.safeDisplayName("trail..pdf"));
    }

    @Test public void unusableNamesFallBackToNoName() {
        assertNull(IncomingPdfIntake.safeDisplayName(null));
        assertNull(IncomingPdfIntake.safeDisplayName(""));
        assertNull(IncomingPdfIntake.safeDisplayName("   "));
        assertNull(IncomingPdfIntake.safeDisplayName(".pdf"));
        assertNull(IncomingPdfIntake.safeDisplayName(".."));
    }

    @Test public void longNamesAreShortenedButKeepTheirExtension() {
        String name = IncomingPdfIntake.safeDisplayName("x".repeat(400) + ".pdf");
        assertEquals(124, name.length());
        assertEquals(".pdf", name.substring(120));
    }

    // Cycle-3 QA: after the process was killed, reopening from Recents showed the first
    // outside PDF again because Android replays the task's VIEW intent.
    @Test public void aRecentsRelaunchIsNotANewHandover() {
        assertTrue(IncomingPdfIntake.isReplayedFromRecents(
                android.content.Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY
                        | android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        assertFalse(IncomingPdfIntake.isReplayedFromRecents(
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION));
    }
}
