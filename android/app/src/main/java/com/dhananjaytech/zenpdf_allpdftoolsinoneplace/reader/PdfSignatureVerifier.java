package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.content.Context;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.cos.COSBase;
import com.tom_roush.pdfbox.cos.COSName;
import com.tom_roush.pdfbox.cos.COSString;
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

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertPathBuilder;
import java.security.cert.CertPathBuilderException;
import java.security.cert.CertStore;
import java.security.cert.CertificateFactory;
import java.security.cert.CollectionCertStoreParameters;
import java.security.cert.PKIXBuilderParameters;
import java.security.cert.PKIXCertPathBuilderResult;
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
    private static final int CONTENTS_KEY_WINDOW = 4096;
    private static final String PKCS7_SHA1 = "adbe.pkcs7.sha1";
    private static final String PKCS7_DETACHED = "adbe.pkcs7.detached";
    private static final String CADES_DETACHED = "ETSI.CAdES.detached";
    private static final String CCA_INDIA_2022_SHA256 =
            "9a3fd3176798e842ddcb12c262f11cfacca70a8b84c6ea6fda30842a95a94cd8";
    private static final BouncyCastleProvider BC = new BouncyCastleProvider();

    private final Context context;
    private final Clock clock;
    private final TrustEvaluator trustEvaluator;

    PdfSignatureVerifier(Context context) {
        this(context, Clock.systemUTC(), androidTrustEvaluator(context));
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
            // Memory only: PDFBox decrypts streams into its scratch storage, which must never be a file.
            MemoryUsageSetting memory = PdfVerifiedCopy.memory();
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

        // The format requires a direct /Contents string, and the unsigned gap may hold nothing but
        // that string. Otherwise the bytes it leaves unsigned could be visible content.
        COSBase contents = signature.getCOSObject().getItem(COSName.CONTENTS);
        if (!(contents instanceof COSString)) return invalid(subFilter, now);
        byte[] cmsBytes = ((COSString) contents).getBytes();
        if (cmsBytes.length == 0 || cmsBytes.length > MAX_CMS_BYTES) return invalid(subFilter, now);
        try {
            if (!MessageDigest.isEqual(cmsBytes, contentsGap(file, range))) return invalid(subFilter, now);
        } catch (IOException unreadable) {
            return invalid(subFilter, now);
        }
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
            // A certificate that has not signed these bytes says nothing about their signer.
            if (!documentBinding || !cmsValid) return invalid(subFilter, now);

            ArrayList<X509Certificate> chainMaterial = new ArrayList<>();
            for (X509CertificateHolder candidate : certificates.getMatches(null)) {
                if (chainMaterial.size() >= 16) return invalid(subFilter, now);
                chainMaterial.add(new JcaX509CertificateConverter()
                        .setProvider(BC).getCertificate(candidate));
            }
            PdfSignatureReport.Trust trust = trustEvaluator.evaluate(certificate, chainMaterial, now);
            PdfSignatureReport.CertificateValidity validity = validity(certificate, now);
            PdfSignatureReport.TimestampLtv timestamp = timestampStatus(signer, ltvMaterial);
            return new PdfSignatureReport.Signature(commonName(certificate), subFilter,
                    PdfSignatureReport.Integrity.VALID, coverage, trust, validity,
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

    /** Decodes the gap between the signed ranges; null unless it is exactly one hex string. */
    static byte[] decodeContentsGap(byte[] gap) {
        int first = 0;
        int last = gap.length - 1;
        while (first <= last && isPdfWhitespace(gap[first])) first++;
        while (last >= first && isPdfWhitespace(gap[last])) last--;
        if (last - first < 1 || gap[first] != '<' || gap[last] != '>') return null;
        ByteArrayOutputStream decoded = new ByteArrayOutputStream((last - first) / 2);
        int high = -1;
        for (int index = first + 1; index < last; index++) {
            if (isPdfWhitespace(gap[index])) continue;
            int nibble = Character.digit(gap[index], 16);
            if (nibble < 0) return null;
            if (high < 0) {
                high = nibble;
            } else {
                decoded.write((high << 4) | nibble);
                high = -1;
            }
        }
        return high < 0 ? decoded.toByteArray() : null;
    }

    /**
     * True when {@code prefix}, the bytes just before the gap, ends with this dictionary's
     * {@code /Contents} key as syntax. A {@code % /Contents} comment, a key inside a string, or
     * a line longer than the prefix could otherwise pass another string for the signed value.
     */
    static boolean followsContentsKey(byte[] prefix) {
        byte[] key = "/Contents".getBytes(StandardCharsets.US_ASCII);
        int end = prefix.length;
        while (end > 0 && isPdfWhitespace(prefix[end - 1])) end--;
        int start = end - key.length;
        if (start < 0) return false;
        for (int index = 0; index < key.length; index++) {
            if (prefix[start + index] != key[index]) return false;
        }
        int index = start;
        while (index > 0 && prefix[index - 1] != '\n' && prefix[index - 1] != '\r') index--;
        if (index == 0) return false;
        int stringDepth = 0;
        for (; index < start; index++) {
            byte value = prefix[index];
            if (value == '\\' && stringDepth > 0) {
                index++;
            } else if (value == '(') {
                stringDepth++;
            } else if (value == ')') {
                if (stringDepth == 0) return false;
                stringDepth--;
            } else if (value == '%' && stringDepth == 0) {
                return false;
            }
        }
        return stringDepth == 0;
    }

    private static boolean isPdfWhitespace(byte value) {
        return value == 0 || value == 9 || value == 10 || value == 12 || value == 13 || value == 32;
    }

    private static byte[] contentsGap(Path file, int[] range) throws IOException {
        long length = (long) range[2] - range[1];
        if (length <= 0 || length > 4L * MAX_CMS_BYTES + 64) throw new IOException("Unbounded gap");
        int prefixLength = (int) Math.min(range[1], CONTENTS_KEY_WINDOW);
        ByteBuffer buffer = ByteBuffer.allocate(prefixLength + (int) length);
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ,
                LinkOption.NOFOLLOW_LINKS)) {
            channel.position(range[1] - prefixLength);
            while (buffer.hasRemaining()) {
                if (channel.read(buffer) <= 0) throw new IOException("Truncated signature gap");
            }
        }
        byte[] bytes = buffer.array();
        if (!followsContentsKey(Arrays.copyOfRange(bytes, 0, prefixLength))) {
            throw new IOException("The signature gap does not follow its dictionary's /Contents key");
        }
        byte[] decoded = decodeContentsGap(Arrays.copyOfRange(bytes, prefixLength, bytes.length));
        if (decoded == null) throw new IOException("The signature gap is not one hex string");
        return decoded;
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

    private static TrustEvaluator androidTrustEvaluator(Context context) {
        List<X509Certificate> bundledAnchors = loadBundledAnchors(context);
        return (leaf, chain, now) -> evaluateTrust(leaf, chain, now, bundledAnchors, true);
    }

    private static List<X509Certificate> loadBundledAnchors(Context context) {
        try (InputStream input = context.getResources().openRawResource(R.raw.cca_india_2022)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            byte[] encoded = output.toByteArray();
            if (!isCcaIndia2022(encoded)) return List.of();
            X509Certificate anchor = (X509Certificate) CertificateFactory.getInstance("X.509", BC)
                    .generateCertificate(new ByteArrayInputStream(encoded));
            return List.of(anchor);
        } catch (Exception failure) {
            return List.of();
        }
    }

    private static boolean isCcaIndia2022(byte[] encoded) throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256", BC).digest(encoded);
        StringBuilder fingerprint = new StringBuilder(digest.length * 2);
        for (byte value : digest) fingerprint.append(String.format("%02x", value));
        return CCA_INDIA_2022_SHA256.contentEquals(fingerprint);
    }

    static PdfSignatureReport.Trust evaluateTrust(X509Certificate leaf,
            List<X509Certificate> chain, Instant now,
            Collection<X509Certificate> bundledAnchors, boolean includeSystemAnchors) {
        try {
            Set<TrustAnchor> anchors = new HashSet<>();
            if (includeSystemAnchors) {
                KeyStore store = KeyStore.getInstance("AndroidCAStore");
                store.load(null);
                Enumeration<String> aliases = store.aliases();
                while (aliases.hasMoreElements()) {
                    java.security.cert.Certificate candidate = store.getCertificate(aliases.nextElement());
                    if (candidate instanceof X509Certificate) {
                        anchors.add(new TrustAnchor((X509Certificate) candidate, null));
                    }
                }
            }
            for (X509Certificate anchor : bundledAnchors) anchors.add(new TrustAnchor(anchor, null));
            if (anchors.isEmpty()) return PdfSignatureReport.Trust.UNTRUSTED;
            PKIXCertPathBuilderResult result = buildPath(leaf, chain, anchors, now);
            if (result == null) return PdfSignatureReport.Trust.UNTRUSTED;
            byte[] trusted = result.getTrustAnchor().getTrustedCert().getEncoded();
            for (X509Certificate anchor : bundledAnchors) {
                if (Arrays.equals(trusted, anchor.getEncoded()) && isCcaIndia2022(trusted)) {
                    return PdfSignatureReport.Trust.TRUSTED_CCA_INDIA_2022;
                }
            }
            return PdfSignatureReport.Trust.TRUSTED;
        } catch (Exception failure) {
            return PdfSignatureReport.Trust.INDETERMINATE;
        }
    }

    private static PKIXCertPathBuilderResult buildPath(X509Certificate leaf,
            List<X509Certificate> certificates, Set<TrustAnchor> anchors, Instant at)
            throws GeneralSecurityException {
        try {
            X509CertSelector selector = new X509CertSelector();
            selector.setCertificate(leaf);
            PKIXBuilderParameters parameters = new PKIXBuilderParameters(anchors, selector);
            parameters.setRevocationEnabled(false);
            parameters.setDate(Date.from(at));
            parameters.addCertStore(CertStore.getInstance("Collection",
                    new CollectionCertStoreParameters(certificates)));
            return (PKIXCertPathBuilderResult) CertPathBuilder.getInstance("PKIX").build(parameters);
        } catch (CertPathBuilderException noPath) {
            return null;
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
