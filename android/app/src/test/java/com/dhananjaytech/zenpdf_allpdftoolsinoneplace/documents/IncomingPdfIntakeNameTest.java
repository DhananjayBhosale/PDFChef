package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

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
}
