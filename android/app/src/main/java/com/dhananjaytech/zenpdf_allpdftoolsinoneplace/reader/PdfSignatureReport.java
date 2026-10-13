package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import java.time.Instant;
import java.util.List;

/** Immutable native result. No document bytes or addresses are retained. */
final class PdfSignatureReport {
    public enum Integrity { VALID, INVALID, UNSUPPORTED, INDETERMINATE }
    public enum Coverage { WHOLE_DOCUMENT, SIGNED_REVISION_WITH_LATER_CHANGES, INDETERMINATE }
    public enum Trust { TRUSTED, TRUSTED_CCA_INDIA_2022, UNTRUSTED, INDETERMINATE }
    public enum CertificateValidity { VALID, EXPIRED, NOT_YET_VALID, INDETERMINATE }
    public enum Revocation { GOOD, REVOKED, OFFLINE_NOT_CHECKED, INDETERMINATE }
    public enum TimestampLtv { VALID, INVALID, ABSENT, PRESENT_NOT_VERIFIED, INDETERMINATE }

    public static final class Signature {
        public final String signerName;
        public final String subFilter;
        public final Integrity integrity;
        public final Coverage coverage;
        public final Trust trust;
        public final CertificateValidity certificateValidity;
        public final Revocation revocation;
        public final TimestampLtv timestampLtv;
        public final Instant evaluatedAt;
        public final Instant certificateNotAfter;
        public final boolean legacyWeakAlgorithm;

        Signature(String signerName, String subFilter, Integrity integrity, Coverage coverage,
                Trust trust, CertificateValidity certificateValidity, Revocation revocation,
                TimestampLtv timestampLtv, Instant evaluatedAt, Instant certificateNotAfter,
                boolean legacyWeakAlgorithm) {
            this.signerName = signerName;
            this.subFilter = subFilter;
            this.integrity = integrity;
            this.coverage = coverage;
            this.trust = trust;
            this.certificateValidity = certificateValidity;
            this.revocation = revocation;
            this.timestampLtv = timestampLtv;
            this.evaluatedAt = evaluatedAt;
            this.certificateNotAfter = certificateNotAfter;
            this.legacyWeakAlgorithm = legacyWeakAlgorithm;
        }
    }

    public final List<Signature> signatures;
    public final boolean malformed;
    public final boolean encrypted;

    PdfSignatureReport(List<Signature> signatures, boolean malformed, boolean encrypted) {
        this.signatures = List.copyOf(signatures);
        this.malformed = malformed;
        this.encrypted = encrypted;
    }

    static PdfSignatureReport malformed() {
        return new PdfSignatureReport(List.of(), true, false);
    }

    static PdfSignatureReport encrypted() {
        return new PdfSignatureReport(List.of(), false, true);
    }

    /** Eligibility for a visual printing/sharing copy of the checked snapshot. */
    static boolean fullyVerified(PdfSignatureReport report) {
        if (report == null || report.encrypted || report.malformed || report.signatures.isEmpty()) {
            return false;
        }
        for (Signature signature : report.signatures) {
            if (signature.integrity != Integrity.VALID
                    || signature.coverage != Coverage.WHOLE_DOCUMENT
                    || (signature.trust != Trust.TRUSTED
                        && signature.trust != Trust.TRUSTED_CCA_INDIA_2022)
                    || signature.certificateValidity != CertificateValidity.VALID) {
                return false;
            }
        }
        return true;
    }
}
