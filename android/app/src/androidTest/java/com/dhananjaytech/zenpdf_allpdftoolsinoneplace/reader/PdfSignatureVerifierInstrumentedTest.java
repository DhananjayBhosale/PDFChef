package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission;
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy;

import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@RunWith(AndroidJUnit4.class)
public final class PdfSignatureVerifierInstrumentedTest {
    private static final String EXPECTED_SHA256 =
            "82dadbb3544bd4489902f2a133a242d05686c8183b3691f33d8da6715a06f7a0";
    private static final Clock FIXTURE_CLOCK = Clock.fixed(
            Instant.parse("2027-01-01T00:00:00Z"), ZoneOffset.UTC);

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

    @Test public void detachedSha256Rc4UsesRealPkixWithExplicitTestAnchor() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "detached-sha256-rc4.pdf");
        try {
            PdfSignatureReport.Signature signature = onlySignature(
                    fixtureVerifier(context, FIXTURE_CLOCK).verify(fixture, "fixture-user".toCharArray()));
            assertEquals(PdfSignatureReport.Integrity.VALID, signature.integrity);
            assertEquals(PdfSignatureReport.Coverage.WHOLE_DOCUMENT, signature.coverage);
            assertEquals("DS PDF Chef Test Signer 01", signature.signerName);
            assertFalse(signature.legacyWeakAlgorithm);
            assertEquals(PdfSignatureReport.CertificateValidity.VALID, signature.certificateValidity);
            assertEquals(PdfSignatureReport.Trust.TRUSTED, signature.trust);
            assertEquals(FIXTURE_CLOCK.instant(), signature.evaluatedAt);

            PdfSignatureReport.Signature production = onlySignature(new PdfSignatureVerifier(context)
                    .verify(fixture, "fixture-user".toCharArray()));
            assertEquals(PdfSignatureReport.Integrity.VALID, production.integrity);
            assertEquals(PdfSignatureReport.Trust.UNTRUSTED, production.trust);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void detachedRc4RejectsWrongAndMissingPasswords() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "detached-sha256-rc4.pdf");
        try {
            PdfSignatureVerifier verifier = new PdfSignatureVerifier(context);
            assertTrue(verifier.verify(fixture, "wrong".toCharArray()).encrypted);
            assertTrue(verifier.verify(fixture).encrypted);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void cadesSha256CoversWholeDocument() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "cades-sha256-plain.pdf");
        try {
            PdfSignatureReport.Signature signature = onlySignature(
                    fixtureVerifier(context, FIXTURE_CLOCK).verify(fixture));
            assertEquals(PdfSignatureReport.Integrity.VALID, signature.integrity);
            assertEquals(PdfSignatureReport.Coverage.WHOLE_DOCUMENT, signature.coverage);
            assertEquals(PdfSignatureReport.Trust.TRUSTED, signature.trust);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void cadesTamperingInEitherSignedRangeIsNeverValid() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "cades-sha256-plain.pdf");
        try {
            PdfSignatureVerifier verifier = fixtureVerifier(context, FIXTURE_CLOCK);
            assertEquals(PdfSignatureReport.Integrity.VALID, onlySignature(verifier.verify(fixture)).integrity);
            byte[] original = Files.readAllBytes(fixture);
            String pdf = new String(original, StandardCharsets.ISO_8859_1);
            Matcher range = Pattern.compile("/ByteRange\\s*\\[0\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*\\]")
                    .matcher(pdf);
            assertTrue("Fixture must have two signed ranges", range.find());
            int firstEnd = Integer.parseInt(range.group(1));
            int secondStart = Integer.parseInt(range.group(2));
            int secondEnd = secondStart + Integer.parseInt(range.group(3));
            int pageBox = pdf.indexOf("/MediaBox [0 0 200 200]");
            assertTrue("Page box must be in the first signed range", pageBox >= 0);
            int pageByte = pageBox + "/MediaBox [0 0 ".length();
            assertTrue(pageByte < firstEnd);
            // This fixture's drawing stream is in the second signed range.
            int drawingByte = pdf.indexOf("0.1 0.4 0.8 rg");
            assertTrue("Drawing must be signed", drawingByte >= secondStart && drawingByte < secondEnd);
            // The CMS is DER `30 82 LL LL ...`; its last bytes are the RSA signature value, which
            // this plain fixture stores identically in the gap and the parsed /Contents.
            int cmsHex = firstEnd + 1;
            int cmsBytes = 4 + Integer.parseInt(pdf.substring(cmsHex + 4, cmsHex + 8), 16);
            int signatureByte = cmsHex + 2 * (cmsBytes - 8);
            for (int offset : new int[] {pageByte, drawingByte, signatureByte}) {
                byte[] tampered = original.clone();
                tampered[offset] = offset == signatureByte
                        ? (byte) (tampered[offset] == '0' ? '1' : '0') : (byte) (tampered[offset] ^ 1);
                Files.write(fixture, tampered);
                PdfSignatureReport report = verifier.verify(fixture);
                assertFalse(report.encrypted);
                if (!report.malformed) {
                    PdfSignatureReport.Signature signature = onlySignature(report);
                    assertEquals(PdfSignatureReport.Integrity.INVALID, signature.integrity);
                    // An unproven signer's certificate must not read as trusted or current.
                    assertEquals(PdfSignatureReport.Trust.INDETERMINATE, signature.trust);
                    assertEquals(PdfSignatureReport.CertificateValidity.INDETERMINATE,
                            signature.certificateValidity);
                }
            }
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void expiredSignerIsNotTrustedAtItsMidpointDate() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "cades-sha256-plain.pdf");
        try {
            Clock expired = Clock.fixed(Instant.parse("2047-01-01T00:00:00Z"), ZoneOffset.UTC);
            PdfSignatureReport.Signature signature = onlySignature(fixtureVerifier(context, expired).verify(fixture));
            assertEquals(PdfSignatureReport.Integrity.VALID, signature.integrity);
            assertEquals(PdfSignatureReport.CertificateValidity.EXPIRED, signature.certificateValidity);
            assertEquals(PdfSignatureReport.Trust.UNTRUSTED, signature.trust);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void unsignedGapBeyondContentsIsInvalid() throws Exception {
        // The CMS is genuine, but the gap also leaves the dictionary's /M entry unsigned.
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "wide-gap-plain.pdf");
        try {
            assertEquals(PdfSignatureReport.Integrity.INVALID,
                    onlySignature(fixtureVerifier(context, FIXTURE_CLOCK).verify(fixture)).integrity);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void encryptedShadowGapIsInvalid() throws Exception {
        // The gap holds a CMS that verifies, but the dictionary's own /Contents is elsewhere.
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "shadow-gap-rc4.pdf");
        try {
            assertEquals(PdfSignatureReport.Integrity.INVALID, onlySignature(fixtureVerifier(context, FIXTURE_CLOCK)
                    .verify(fixture, "fixture-user".toCharArray())).integrity);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void shadowGapBehindUnsignedUpdateIsInvalid() throws Exception {
        // An unsigned update gives the dictionary a /Contents equal to the excluded string,
        // but the signed revision's dictionary never held it.
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "shadow-update-plain.pdf");
        try {
            assertEquals(PdfSignatureReport.Integrity.INVALID,
                    onlySignature(fixtureVerifier(context, FIXTURE_CLOCK).verify(fixture)).integrity);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void indirectContentsIsInvalid() throws Exception {
        // `/Contents 7 0 R` resolves to a string after a comment that only mentions the key.
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path fixture = copyFixture(context, "indirect-comment-plain.pdf");
        try {
            assertEquals(PdfSignatureReport.Integrity.INVALID,
                    onlySignature(fixtureVerifier(context, FIXTURE_CLOCK).verify(fixture)).integrity);
        } finally {
            Files.deleteIfExists(fixture);
        }
    }

    @Test public void productionBundledCcaResourceMatchesPin() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = context.getResources().openRawResource(R.raw.cca_india_2022)) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        assertEquals("9a3fd3176798e842ddcb12c262f11cfacca70a8b84c6ea6fda30842a95a94cd8",
                hex(digest.digest()));
    }

    private static Path copyFixture(Context context, String name) throws Exception {
        Path copy = Files.createTempFile(context.getCacheDir().toPath(), "signature-test-", ".pdf");
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open(name)) {
            Files.copy(input, copy, StandardCopyOption.REPLACE_EXISTING);
        }
        return copy;
    }

    private static PdfSignatureVerifier fixtureVerifier(Context context, Clock clock) throws Exception {
        X509Certificate root;
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open("test-root.der")) {
            root = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
        return new PdfSignatureVerifier(context, clock, (leaf, chain, now) ->
                PdfSignatureVerifier.evaluateTrust(leaf, chain, now, List.of(root), false));
    }

    private static PdfSignatureReport.Signature onlySignature(PdfSignatureReport report) {
        assertFalse(report.malformed);
        assertFalse(report.encrypted);
        assertEquals(1, report.signatures.size());
        return report.signatures.get(0);
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format("%02x", value));
        return result.toString();
    }
}
