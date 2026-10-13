package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.time.Instant;
import java.util.List;

public final class PdfSignatureReportTest {
    @Test public void allowsBothAcceptedTrustSourcesAndRequiresEverySignature() {
        PdfSignatureReport.Signature device = signature(PdfSignatureReport.Integrity.VALID,
                PdfSignatureReport.Coverage.WHOLE_DOCUMENT, PdfSignatureReport.Trust.TRUSTED,
                PdfSignatureReport.CertificateValidity.VALID);
        PdfSignatureReport.Signature cca = signature(PdfSignatureReport.Integrity.VALID,
                PdfSignatureReport.Coverage.WHOLE_DOCUMENT, PdfSignatureReport.Trust.TRUSTED_CCA_INDIA_2022,
                PdfSignatureReport.CertificateValidity.VALID);
        assertTrue(PdfSignatureReport.fullyVerified(new PdfSignatureReport(List.of(device, cca), false, false)));
        for (PdfSignatureReport.Integrity integrity : PdfSignatureReport.Integrity.values()) {
            if (integrity != PdfSignatureReport.Integrity.VALID) rejectAlongside(device, signature(integrity,
                    device.coverage, device.trust, device.certificateValidity));
        }
        for (PdfSignatureReport.Coverage coverage : PdfSignatureReport.Coverage.values()) {
            if (coverage != PdfSignatureReport.Coverage.WHOLE_DOCUMENT) rejectAlongside(device,
                    signature(device.integrity, coverage, device.trust, device.certificateValidity));
        }
        for (PdfSignatureReport.Trust trust : PdfSignatureReport.Trust.values()) {
            if (trust != PdfSignatureReport.Trust.TRUSTED && trust != PdfSignatureReport.Trust.TRUSTED_CCA_INDIA_2022) {
                rejectAlongside(device, signature(device.integrity, device.coverage, trust, device.certificateValidity));
            }
        }
        for (PdfSignatureReport.CertificateValidity validity : PdfSignatureReport.CertificateValidity.values()) {
            if (validity != PdfSignatureReport.CertificateValidity.VALID) rejectAlongside(device,
                    signature(device.integrity, device.coverage, device.trust, validity));
        }
        assertFalse(PdfSignatureReport.fullyVerified(new PdfSignatureReport(List.of(device), true, false)));
        assertFalse(PdfSignatureReport.fullyVerified(new PdfSignatureReport(List.of(device), false, true)));
        assertFalse(PdfSignatureReport.fullyVerified(new PdfSignatureReport(List.of(), false, false)));
        assertFalse(PdfSignatureReport.fullyVerified(null));
    }

    private static void rejectAlongside(PdfSignatureReport.Signature valid, PdfSignatureReport.Signature rejected) {
        assertFalse(PdfSignatureReport.fullyVerified(new PdfSignatureReport(List.of(valid, rejected), false, false)));
    }

    private static PdfSignatureReport.Signature signature(PdfSignatureReport.Integrity integrity,
            PdfSignatureReport.Coverage coverage, PdfSignatureReport.Trust trust,
            PdfSignatureReport.CertificateValidity validity) {
        return new PdfSignatureReport.Signature("Signer", "adbe.pkcs7.detached", integrity, coverage,
                trust, validity, PdfSignatureReport.Revocation.OFFLINE_NOT_CHECKED,
                PdfSignatureReport.TimestampLtv.ABSENT, Instant.EPOCH, null, false);
    }
}
