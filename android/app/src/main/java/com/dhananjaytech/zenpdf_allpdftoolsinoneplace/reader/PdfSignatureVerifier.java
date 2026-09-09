package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.content.Context;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.cos.COSName;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException;
import com.tom_roush.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;

import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.x500.RDN;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x500.style.BCStyle;
import org.bouncycastle.asn1.x500.style.IETFUtils;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cms.CMSProcessable;
import org.bouncycastle.cms.CMSSignedData;
import org.bouncycastle.cms.SignerInformation;
import org.bouncycastle.cms.SignerInformationStore;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoVerifierBuilder;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.util.Store;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertPathBuilder;
import java.security.cert.CertStore;
import java.security.cert.CollectionCertStoreParameters;
import java.security.cert.PKIXBuilderParameters;
import java.security.cert.TrustAnchor;
import java.security.cert.X509CertSelector;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Bounded, offline PDF/CMS verification over one private reader snapshot. */
final class PdfSignatureVerifier {
    static final int MAX_SIGNATURES = 16;
    static final int MAX_CMS_BYTES = 2 * 1024 * 1024;
    static final int BUFFER_BYTES = 64 * 1024;
    private static final String PKCS7_SHA1 = "adbe.pkcs7.sha1";
    private static final String PKCS7_DETACHED = "adbe.pkcs7.detached";
    private static final String CADES_DETACHED = "ETSI.CAdES.detached";
    private static final BouncyCastleProvider BC = new BouncyCastleProvider();

    private final Context context;
    private final Clock clock;
    private final TrustEvaluator trustEvaluator;

    PdfSignatureVerifier(Context context) {
        this(context, Clock.systemUTC(), PdfSignatureVerifier::evaluateAndroidTrust);
    }

    PdfSignatureVerifier(Context context, Clock clock, TrustEvaluator trustEvaluator) {
        this.context = context.getApplicationContext();
        this.clock = clock;
        this.trustEvaluator = trustEvaluator;
    }

    PdfSignatureReport verify(Path snapshot) {
        return verify(snapshot, null);
    }

    PdfSignatureReport verify(Path snapshot, char[] password) {
        try {
            requirePrivateRegularFile(snapshot);
            PDFBoxResourceLoader.init(context);
            MemoryUsageSetting memory = MemoryUsageSetting.setupMixed(8L * 1024L * 1024L);
            memory.setTempDir(context.getCacheDir());
            String submittedPassword = password == null ? "" : new String(password);
            try (PDDocument document = PDDocument.load(snapshot.toFile(), submittedPassword, memory)) {
                List<PDSignature> dictionaries = document.getSignatureDictionaries();
                if (dictionaries.size() > MAX_SIGNATURES) return PdfSignatureReport.malformed();
                boolean ltvMaterial = document.getDocumentCatalog().getCOSObject()
                        .containsKey(COSName.getPDFName("DSS"));
                ArrayList<PdfSignatureReport.Signature> results = new ArrayList<>();
                for (PDSignature signature : dictionaries) {
                    if (Thread.currentThread().isInterrupted()) return PdfSignatureReport.malformed();
                    results.add(verifyOne(snapshot, signature, ltvMaterial));
                }
                return new PdfSignatureReport(results, false, false);
            } catch (InvalidPasswordException encrypted) {
                return PdfSignatureReport.encrypted();
            }
        } catch (Exception malformed) {
            return PdfSignatureReport.malformed();
        }
    }

    private PdfSignatureReport.Signature verifyOne(Path file, PDSignature signature,
            boolean ltvMaterial) {
        Instant now = clock.instant();
        String subFilter = safe(signature.getSubFilter());
        int[] range = signature.getByteRange();
        long fileLength;
        try { fileLength = Files.size(file); }
        catch (IOException failure) { return indeterminate(subFilter, now); }
        PdfSignatureReport.Coverage coverage = coverage(range, fileLength);
        if (coverage == PdfSignatureReport.Coverage.INDETERMINATE) {
            return invalid(subFilter, now);
        }

        byte[] cmsBytes = signature.getContents();
        if (cmsBytes.length == 0 || cmsBytes.length > MAX_CMS_BYTES) return invalid(subFilter, now);
        if (!PKCS7_SHA1.equals(subFilter) && !PKCS7_DETACHED.equals(subFilter)
                && !CADES_DETACHED.equals(subFilter)) {
            return unsupported(subFilter, coverage, now);
        }

        try {
            CMSSignedData cms;
            boolean documentBinding;
            if (PKCS7_SHA1.equals(subFilter)) {
                cms = new CMSSignedData(cmsBytes);
                Object encapsulated = cms.getSignedContent() == null
                        ? null : cms.getSignedContent().getContent();
                byte[] claimedDigest = encapsulated instanceof byte[] ? (byte[]) encapsulated : null;
                byte[] actualDigest = digestRanges(file, range, "SHA-1");
                documentBinding = claimedDigest != null
                        && MessageDigest.isEqual(claimedDigest, actualDigest);
            } else {
                cms = new CMSSignedData(new RangeProcessable(file, range), cmsBytes);
                documentBinding = true;
            }

            SignerInformationStore signers = cms.getSignerInfos();
            if (signers.size() != 1) return invalid(subFilter, now);
            SignerInformation signer = signers.getSigners().iterator().next();
            Store<X509CertificateHolder> certificates = cms.getCertificates();
            Collection<X509CertificateHolder> matches = certificates.getMatches(signer.getSID());
            if (matches.size() != 1) return invalid(subFilter, now);
            X509CertificateHolder holder = matches.iterator().next();
            X509Certificate certificate = new JcaX509CertificateConverter()
                    .setProvider(BC).getCertificate(holder);
            boolean cmsValid = signer.verify(new JcaSimpleSignerInfoVerifierBuilder()
                    .setProvider(BC).build(certificate));
            PdfSignatureReport.Integrity integrity = documentBinding && cmsValid
                    ? PdfSignatureReport.Integrity.VALID : PdfSignatureReport.Integrity.INVALID;

            ArrayList<X509Certificate> chainMaterial = new ArrayList<>();
            for (X509CertificateHolder candidate : certificates.getMatches(null)) {
                if (chainMaterial.size() >= 16) return invalid(subFilter, now);
                chainMaterial.add(new JcaX509CertificateConverter()
                        .setProvider(BC).getCertificate(candidate));
            }
            PdfSignatureReport.Trust trust = trustEvaluator.evaluate(certificate, chainMaterial, now);
            PdfSignatureReport.CertificateValidity validity = validity(certificate, now);
            PdfSignatureReport.TimestampLtv timestamp = timestampStatus(signer, ltvMaterial);
            return new PdfSignatureReport.Signature(commonName(certificate), subFilter, integrity,
                    coverage, trust, validity,
                    PdfSignatureReport.Revocation.OFFLINE_NOT_CHECKED, timestamp, now,
                    certificate.getNotAfter().toInstant(), usesWeakAlgorithm(signer, subFilter));
        } catch (Exception invalid) {
            return invalid(subFilter, now);
        }
    }

    static PdfSignatureReport.Coverage coverage(int[] range, long length) {
        if (range == null || range.length != 4 || length <= 0) {
            return PdfSignatureReport.Coverage.INDETERMINATE;
        }
        long a = range[0], b = range[1], c = range[2], d = range[3];
        if (a != 0 || b < 0 || c < 0 || d < 0 || b > c || c > length || d > length - c) {
            return PdfSignatureReport.Coverage.INDETERMINATE;
        }
        long end = c + d;
        return end == length ? PdfSignatureReport.Coverage.WHOLE_DOCUMENT
                : PdfSignatureReport.Coverage.SIGNED_REVISION_WITH_LATER_CHANGES;
    }

    private static byte[] digestRanges(Path file, int[] range, String algorithm) throws Exception {
        MessageDigest digest = MessageDigest.getInstance(algorithm, BC);
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            updateDigest(channel, range[0], range[1], digest);
            updateDigest(channel, range[2], range[3], digest);
        }
        return digest.digest();
    }

    private static void updateDigest(FileChannel channel, long offset, long length,
            MessageDigest digest) throws IOException, InterruptedException {
        ByteBuffer buffer = ByteBuffer.allocate(BUFFER_BYTES);
        long remaining = length;
        channel.position(offset);
        while (remaining > 0) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            buffer.clear();
            buffer.limit((int) Math.min(buffer.capacity(), remaining));
            int read = channel.read(buffer);
            if (read <= 0) throw new IOException("Truncated signed range");
            remaining -= read;
            buffer.flip();
            digest.update(buffer);
        }
    }

    private static void copyRanges(Path file, int[] range, OutputStream output) throws IOException {
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            copyRange(channel, range[0], range[1], output);
            copyRange(channel, range[2], range[3], output);
        }
    }

    private static void copyRange(FileChannel channel, long offset, long length,
            OutputStream output) throws IOException {
        ByteBuffer buffer = ByteBuffer.allocate(BUFFER_BYTES);
        byte[] bytes = new byte[BUFFER_BYTES];
        long remaining = length;
        channel.position(offset);
        while (remaining > 0) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Interrupted");
            buffer.clear();
            buffer.limit((int) Math.min(buffer.capacity(), remaining));
            int read = channel.read(buffer);
            if (read <= 0) throw new IOException("Truncated signed range");
            remaining -= read;
            buffer.flip();
            buffer.get(bytes, 0, read);
            output.write(bytes, 0, read);
        }
    }

    private static PdfSignatureReport.CertificateValidity validity(X509Certificate certificate,
            Instant instant) {
        try {
            certificate.checkValidity(Date.from(instant));
            return PdfSignatureReport.CertificateValidity.VALID;
        } catch (java.security.cert.CertificateExpiredException expired) {
            return PdfSignatureReport.CertificateValidity.EXPIRED;
        } catch (java.security.cert.CertificateNotYetValidException future) {
            return PdfSignatureReport.CertificateValidity.NOT_YET_VALID;
        } catch (RuntimeException failure) {
            return PdfSignatureReport.CertificateValidity.INDETERMINATE;
        }
    }

    private static PdfSignatureReport.TimestampLtv timestampStatus(SignerInformation signer,
            boolean ltvMaterial) {
        boolean timestamp = signer.getUnsignedAttributes() != null
                && signer.getUnsignedAttributes().get(
                PKCSObjectIdentifiers.id_aa_signatureTimeStampToken) != null;
        if (timestamp || ltvMaterial) return PdfSignatureReport.TimestampLtv.PRESENT_NOT_VERIFIED;
        return PdfSignatureReport.TimestampLtv.ABSENT;
    }

    private static boolean usesWeakAlgorithm(SignerInformation signer, String subFilter) {
        String digestOid = signer.getDigestAlgOID();
        return PKCS7_SHA1.equals(subFilter) || "1.3.14.3.2.26".equals(digestOid);
    }

    private static PdfSignatureReport.Trust evaluateAndroidTrust(X509Certificate leaf,
            List<X509Certificate> certificates, Instant now) {
        try {
            KeyStore store = KeyStore.getInstance("AndroidCAStore");
            store.load(null);
            Set<TrustAnchor> anchors = new HashSet<>();
            Enumeration<String> aliases = store.aliases();
            while (aliases.hasMoreElements()) {
                java.security.cert.Certificate candidate = store.getCertificate(aliases.nextElement());
                if (candidate instanceof X509Certificate) {
                    anchors.add(new TrustAnchor((X509Certificate) candidate, null));
                }
            }
            if (anchors.isEmpty()) return PdfSignatureReport.Trust.INDETERMINATE;
            if (buildPath(leaf, certificates, anchors, now)) return PdfSignatureReport.Trust.TRUSTED;
            Instant midpoint = leaf.getNotBefore().toInstant().plusMillis(
                    Math.max(1, leaf.getNotAfter().getTime() - leaf.getNotBefore().getTime()) / 2);
            return buildPath(leaf, certificates, anchors, midpoint)
                    ? PdfSignatureReport.Trust.TRUSTED : PdfSignatureReport.Trust.UNTRUSTED;
        } catch (Exception failure) {
            return PdfSignatureReport.Trust.INDETERMINATE;
        }
    }

    private static boolean buildPath(X509Certificate leaf, List<X509Certificate> certificates,
            Set<TrustAnchor> anchors, Instant at) {
        try {
            X509CertSelector selector = new X509CertSelector();
            selector.setCertificate(leaf);
            PKIXBuilderParameters parameters = new PKIXBuilderParameters(anchors, selector);
            parameters.setRevocationEnabled(false);
            parameters.setDate(Date.from(at));
            parameters.addCertStore(CertStore.getInstance("Collection",
                    new CollectionCertStoreParameters(certificates)));
            CertPathBuilder.getInstance("PKIX").build(parameters);
            return true;
        } catch (Exception failure) {
            return false;
        }
    }

    private static String commonName(X509Certificate certificate) {
        try {
            RDN[] names = X500Name.getInstance(certificate.getSubjectX500Principal().getEncoded())
                    .getRDNs(BCStyle.CN);
            if (names.length > 0 && names[0].getFirst() != null) {
                return safe(IETFUtils.valueToString(names[0].getFirst().getValue()));
            }
        } catch (Exception ignored) { }
        String distinguished = certificate.getSubjectX500Principal().getName();
        return distinguished.length() <= 160 ? distinguished : distinguished.substring(0, 160);
    }

    private static void requirePrivateRegularFile(Path path) throws IOException {
        if (path == null || Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || Files.size(path) <= 0 || Files.size(path) > 128L * 1024L * 1024L) {
            throw new IOException("Unsafe PDF snapshot");
        }
    }

    private static String safe(String value) {
        if (value == null || value.isBlank()) return "Unknown signer";
        String cleaned = value.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "").trim();
        return cleaned.length() <= 160 ? cleaned : cleaned.substring(0, 160);
    }

    private static PdfSignatureReport.Signature invalid(String subFilter, Instant now) {
        return new PdfSignatureReport.Signature("Unknown signer", subFilter,
                PdfSignatureReport.Integrity.INVALID, PdfSignatureReport.Coverage.INDETERMINATE,
                PdfSignatureReport.Trust.INDETERMINATE,
                PdfSignatureReport.CertificateValidity.INDETERMINATE,
                PdfSignatureReport.Revocation.INDETERMINATE,
                PdfSignatureReport.TimestampLtv.INDETERMINATE, now, null, false);
    }

    private static PdfSignatureReport.Signature unsupported(String subFilter,
            PdfSignatureReport.Coverage coverage, Instant now) {
        return new PdfSignatureReport.Signature("Unknown signer", subFilter,
                PdfSignatureReport.Integrity.UNSUPPORTED, coverage,
                PdfSignatureReport.Trust.INDETERMINATE,
                PdfSignatureReport.CertificateValidity.INDETERMINATE,
                PdfSignatureReport.Revocation.INDETERMINATE,
                PdfSignatureReport.TimestampLtv.INDETERMINATE, now, null, false);
    }

    private static PdfSignatureReport.Signature indeterminate(String subFilter, Instant now) {
        return new PdfSignatureReport.Signature("Unknown signer", subFilter,
                PdfSignatureReport.Integrity.INDETERMINATE,
                PdfSignatureReport.Coverage.INDETERMINATE,
                PdfSignatureReport.Trust.INDETERMINATE,
                PdfSignatureReport.CertificateValidity.INDETERMINATE,
                PdfSignatureReport.Revocation.INDETERMINATE,
                PdfSignatureReport.TimestampLtv.INDETERMINATE, now, null, false);
    }

    private static final class RangeProcessable implements CMSProcessable {
        private final Path file;
        private final int[] range;

        RangeProcessable(Path file, int[] range) {
            this.file = file;
            this.range = Arrays.copyOf(range, range.length);
        }

        @Override public Object getContent() { return null; }
        @Override public void write(OutputStream output) throws IOException {
            copyRanges(file, range, output);
        }
    }

    @FunctionalInterface
    interface TrustEvaluator {
        PdfSignatureReport.Trust evaluate(X509Certificate leaf,
                List<X509Certificate> certificates, Instant now);
    }
}
