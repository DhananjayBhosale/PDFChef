package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Instant;

import javax.security.auth.x500.X500Principal;

public final class PdfSignatureVerifierContractTest {
    @Test public void bundledCcaRootHasPinnedIdentityAndValidity() throws Exception {
        byte[] encoded = Files.readAllBytes(Path.of("src/main/res/raw/cca_india_2022.der"));
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(encoded);
        StringBuilder fingerprint = new StringBuilder(digest.length * 2);
        for (byte value : digest) fingerprint.append(String.format("%02x", value));
        assertEquals("9a3fd3176798e842ddcb12c262f11cfacca70a8b84c6ea6fda30842a95a94cd8",
                fingerprint.toString());
        X509Certificate root = (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(encoded));
        assertEquals(new X500Principal("CN=CCA India 2022,O=India PKI,C=IN"), root.getSubjectX500Principal());
        assertEquals(root.getSubjectX500Principal(), root.getIssuerX500Principal());
        assertTrue(root.getBasicConstraints() >= 0);
        root.verify(root.getPublicKey());
        assertEquals(Instant.parse("2022-02-02T12:04:37Z"), root.getNotBefore().toInstant());
        assertEquals(Instant.parse("2042-02-02T12:04:37Z"), root.getNotAfter().toInstant());
    }

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

    @Test public void signatureGapMustBeExactlyOneHexString() {
        assertArrayEquals(new byte[] {0x0a, (byte) 0xbc}, PdfSignatureVerifier.decodeContentsGap(gap(" <0a B c>\n")));
        assertNull(PdfSignatureVerifier.decodeContentsGap(gap("<0abc> /M (D:2026)")));
        assertNull(PdfSignatureVerifier.decodeContentsGap(gap("<< /Contents <0a> >>")));
        assertNull(PdfSignatureVerifier.decodeContentsGap(gap("<0ab>")));
        assertNull(PdfSignatureVerifier.decodeContentsGap(gap("0abc")));
    }

    @Test public void signatureGapMustFollowItsOwnContentsKey() {
        assertTrue(PdfSignatureVerifier.followsContentsKey(gap("5 0 obj\n<< /Type /Sig /Contents ")));
        assertTrue(PdfSignatureVerifier.followsContentsKey(gap("\n<< /M (a \\) b) /Contents\n")));
        assertFalse(PdfSignatureVerifier.followsContentsKey(gap("8 0 obj\n")));
        assertFalse(PdfSignatureVerifier.followsContentsKey(gap("\n% /Contents\n")));
        assertFalse(PdfSignatureVerifier.followsContentsKey(gap("\n<< /Contents 7 0 R % /Contents")));
        assertFalse(PdfSignatureVerifier.followsContentsKey(gap("\n<< /T (x /Contents")));
        assertFalse(PdfSignatureVerifier.followsContentsKey(gap("\n<< /T x) /Contents")));
        // A line with no start inside the bounded window cannot be read with certainty.
        assertFalse(PdfSignatureVerifier.followsContentsKey(gap("<< /Contents")));
    }

    private static byte[] gap(String text) {
        return text.getBytes(StandardCharsets.ISO_8859_1);
    }
}
