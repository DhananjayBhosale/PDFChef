package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission;
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy;

import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;

@RunWith(AndroidJUnit4.class)
public final class PdfSignatureVerifierInstrumentedTest {
    private static final String EXPECTED_SHA256 =
            "82dadbb3544bd4489902f2a133a242d05686c8183b3691f33d8da6715a06f7a0";

    @Test public void realGstFixtureReportsEachSecurityAxisIndependently() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = context.getFilesDir().toPath().resolve("signature-fixture.pdf");
        Assume.assumeTrue("Stage the read-only fixture before this focused test", Files.isRegularFile(fixture));
        assertEquals(EXPECTED_SHA256, hex(MessageDigest.getInstance("SHA-256")
                .digest(Files.readAllBytes(fixture))));

        PdfSignatureReport report = new PdfSignatureVerifier(context).verify(fixture);

        assertFalse(report.malformed);
        assertFalse(report.encrypted);
        assertEquals(1, report.signatures.size());
        PdfSignatureReport.Signature signature = report.signatures.get(0);
        assertEquals(PdfSignatureReport.Integrity.VALID, signature.integrity);
        assertEquals(PdfSignatureReport.Coverage.WHOLE_DOCUMENT, signature.coverage);
        assertEquals("DS GOODS AND SERVICES TAX NETWORK 07", signature.signerName);
        assertEquals(PdfSignatureReport.Trust.UNTRUSTED, signature.trust);
        assertEquals(PdfSignatureReport.CertificateValidity.EXPIRED,
                signature.certificateValidity);
        assertEquals(PdfSignatureReport.Revocation.OFFLINE_NOT_CHECKED, signature.revocation);
        assertEquals(PdfSignatureReport.TimestampLtv.ABSENT, signature.timestampLtv);
        assertTrue(signature.legacyWeakAlgorithm);
    }

    @Test public void passwordProtectedPdfCanBeCheckedAfterUnlock() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path encrypted = context.getCacheDir().toPath().resolve("encrypted-signature-check.pdf");
        try {
            try (PDDocument document = new PDDocument()) {
                document.addPage(new PDPage());
                StandardProtectionPolicy policy = new StandardProtectionPolicy(
                        "owner-secret", "aadhaar-style-password", new AccessPermission());
                policy.setEncryptionKeyLength(128);
                document.protect(policy);
                document.save(encrypted.toFile());
            }

            PdfSignatureVerifier verifier = new PdfSignatureVerifier(context);
            assertTrue(verifier.verify(encrypted, "wrong".toCharArray()).encrypted);
            PdfSignatureReport unlocked = verifier.verify(
                    encrypted, "aadhaar-style-password".toCharArray());
            assertFalse(unlocked.encrypted);
            assertFalse(unlocked.malformed);
            assertTrue(unlocked.signatures.isEmpty());
        } finally {
            Files.deleteIfExists(encrypted);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format("%02x", value));
        return result.toString();
    }
}
