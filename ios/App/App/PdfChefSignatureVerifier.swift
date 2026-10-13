import CoreGraphics
import CryptoKit
import Foundation
import OpenSSL
import Security

enum PdfChefSignatureStatus: String, Equatable {
    case valid
    case invalid
    case trusted
    case untrusted
    case expired
    case notYetValid
    case revoked
    case good
    case notPresent
    case indeterminate
    case unsupported
    case offline
}

struct PdfChefSignatureCheck: Equatable {
    let status: PdfChefSignatureStatus
    let detail: String
}

struct PdfChefSignatureReport: Equatable {
    let signerName: String?
    let integrity: PdfChefSignatureCheck
    let trust: PdfChefSignatureCheck
    let certificateValidity: PdfChefSignatureCheck
    let revocation: PdfChefSignatureCheck
    let timestampAndLTV: PdfChefSignatureCheck
    let warnings: [String]
}

final class PdfChefSignatureVerifier: @unchecked Sendable {
    /// Detached checks hold a second copy of the signed bytes in memory, so every check is bounded.
    static let maximumFileSizeBytes: Int64 = 64 * 1024 * 1024
    private static let maximumSignatureCount = 32
    private static let maximumFieldDepth = 32
    private static let maximumCertificateCount = 32
    private static let maximumCMSBytes = 2 * 1024 * 1024
    private static let legacySubfilter = "adbe.pkcs7.sha1"
    private static let detachedSubfilters: Set<String> = ["adbe.pkcs7.detached", "etsi.cades.detached"]
    /// India's Controller of Certifying Authorities root. It anchors UIDAI e-Aadhaar and other
    /// Indian document-signing certificates but is not in Apple's root store.
    static let ccaIndia2022SHA256 = "9a3fd3176798e842ddcb12c262f11cfacca70a8b84c6ea6fda30842a95a94cd8"

    /// Roots trusted in addition to the device store. A bundled file that does not match its pin is ignored.
    static let bundledAnchors: [SecCertificate] = {
        guard let url = Bundle.main.url(forResource: "cca_india_2022", withExtension: "der"),
              let data = try? Data(contentsOf: url),
              sha256Hex(data) == ccaIndia2022SHA256,
              let certificate = SecCertificateCreateWithData(nil, data as CFData) else { return [] }
        return [certificate]
    }()

    static var isAvailable: Bool { PdfChefOpenSSLCMSAdapter.isSupportedRuntime }

    private let additionalAnchors: [SecCertificate]

    init(additionalAnchors: [SecCertificate] = PdfChefSignatureVerifier.bundledAnchors) {
        self.additionalAnchors = additionalAnchors
    }

    func verifyDocument(
        at url: URL,
        password: String? = nil,
        now: Date = Date()
    ) async -> [PdfChefSignatureReport] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: self.verifyDocumentSynchronously(
                    at: url,
                    password: password,
                    now: now
                ))
            }
        }
    }

    func verifyDocumentSynchronously(
        at url: URL,
        password: String? = nil,
        now: Date = Date()
    ) -> [PdfChefSignatureReport] {
        dispatchPrecondition(condition: .notOnQueue(.main))

        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let fileSize = (attributes[.size] as? NSNumber)?.int64Value,
              fileSize > 0,
              fileSize <= Self.maximumFileSizeBytes,
              let document = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            return [Self.failedReport(.invalid, "The document could not be read safely.")]
        }

        let candidates: [SignatureCandidate]
        do {
            candidates = try Self.parseSignatures(in: document, password: password)
        } catch let error as VerificationFailure {
            return [Self.failedReport(error.status, error.userDetail)]
        } catch {
            return [Self.failedReport(.invalid, "The signature structure is malformed.")]
        }

        guard !candidates.isEmpty else { return [] }
        return candidates.map { candidate in
            verify(candidate: candidate, document: document, now: now)
        }
    }

    #if DEBUG
    func verifyCMSFixture(
        cmsData: Data,
        signedContentDigest: Data,
        now: Date,
        coversWholeDocument: Bool = true,
        hasDSS: Bool = false
    ) -> PdfChefSignatureReport {
        let candidate = SignatureCandidate(
            byteRanges: [],
            contents: cmsData,
            subfilter: Self.legacySubfilter,
            coversWholeDocument: coversWholeDocument,
            hasDSS: hasDSS
        )
        return verifyCMS(candidate: candidate, signedContent: .embeddedSHA1(signedContentDigest), now: now)
    }

    func acceptsByteRangeFixture(_ values: [Int], documentSize: Int) -> Bool {
        (try? Self.validateByteRange(values, documentSize: documentSize)) != nil
    }
    #endif

    private func verify(candidate: SignatureCandidate, document: Data, now: Date) -> PdfChefSignatureReport {
        let subfilter = candidate.subfilter.lowercased()
        if subfilter == Self.legacySubfilter {
            guard let digest = Self.sha1(document: document, byteRanges: candidate.byteRanges) else {
                return Self.failedReport(.invalid, "The signed byte range is malformed.")
            }
            return verifyCMS(candidate: candidate, signedContent: .embeddedSHA1(digest), now: now)
        }
        guard Self.detachedSubfilters.contains(subfilter) else {
            return Self.failedReport(.unsupported, "This signature format is not supported on this device.")
        }

        // Detached signatures cover the original file bytes, including any encrypted objects.
        var signedBytes = Data(capacity: candidate.byteRanges.reduce(0) { $0 + $1.count })
        for range in candidate.byteRanges {
            signedBytes.append(document[range])
        }
        return verifyCMS(candidate: candidate, signedContent: .detached(signedBytes), now: now)
    }

    private func verifyCMS(
        candidate: SignatureCandidate,
        signedContent: SignedContent,
        now: Date
    ) -> PdfChefSignatureReport {
        guard PdfChefOpenSSLCMSAdapter.isSupportedRuntime else {
            return Self.failedReport(.unsupported, "Signature verification is unavailable with this cryptographic runtime.")
        }
        guard let cmsBytes = Self.derObject(fromPaddedContents: candidate.contents) else {
            return Self.failedReport(.invalid, "The signature container is malformed.")
        }

        var cms: OpaquePointer?
        let decoded = cmsBytes.withUnsafeBytes { bytes -> OpaquePointer? in
            guard let base = bytes.bindMemory(to: UInt8.self).baseAddress else { return nil }
            var cursor: UnsafePointer<UInt8>? = base
            return d2i_CMS_ContentInfo(&cms, &cursor, cmsBytes.count)
        }
        guard let decoded else {
            return Self.failedReport(.invalid, "The signature container is malformed.")
        }
        defer { CMS_ContentInfo_free(decoded) }

        switch signedContent {
        case .embeddedSHA1(let signedDigest):
            guard Self.cmsEmbeddedContent(decoded) == signedDigest else {
                return Self.failedReport(.invalid, "The signed bytes no longer match this document.")
            }
            guard Self.verifyCryptographicSignature(decoded, detachedContent: nil) else {
                return Self.failedReport(.invalid, "The cryptographic signature is invalid.")
            }
        case .detached(let signedBytes):
            guard CMS_is_detached(decoded) == 1 else {
                return Self.failedReport(.invalid, "The signature container does not match its declared format.")
            }
            guard Self.verifyCryptographicSignature(decoded, detachedContent: signedBytes) else {
                return Self.failedReport(.invalid, "The signed bytes no longer match this document, or the signature is invalid.")
            }
        }

        guard let certificates = Self.certificates(from: decoded), let signer = certificates.first else {
            return Self.failedReport(.unsupported, "The CMS signer could not be resolved unambiguously.")
        }
        let signerName = Self.commonName(signer)
        let validity = Self.certificateValidity(signer, now: now)
        let trust = evaluateTrust(certificates: certificates, now: now)
        let timestampPresent = Self.containsTimestampToken(cmsBytes)
        let timestamp = timestampPresent
            ? PdfChefSignatureCheck(status: .unsupported, detail: "A timestamp is present but cannot be validated on this device.")
            : candidate.hasDSS
            ? PdfChefSignatureCheck(status: .unsupported, detail: "Long-term validation data is present but cannot be validated on this device.")
            : PdfChefSignatureCheck(status: .notPresent, detail: "No trusted timestamp or long-term validation data is present.")
        let integrityDetail = candidate.coversWholeDocument
            ? "The signed byte range matches the complete document."
            : "The signed byte range is intact, but later unsigned document data is present."
        var warnings: [String] = []
        if candidate.subfilter.lowercased() == Self.legacySubfilter || Self.usesSHA1Digest(decoded) {
            warnings.append("This signature uses legacy SHA-1 digesting.")
        }
        if !candidate.coversWholeDocument {
            warnings.append("Unsigned changes follow the signed document revision.")
        }

        return PdfChefSignatureReport(
            signerName: signerName,
            integrity: PdfChefSignatureCheck(
                status: candidate.coversWholeDocument ? .valid : .indeterminate,
                detail: integrityDetail
            ),
            trust: trust,
            certificateValidity: validity,
            revocation: PdfChefSignatureCheck(status: .offline, detail: "PDF Chef checks signatures on this device without contacting certificate revocation services."),
            timestampAndLTV: timestamp,
            warnings: warnings
        )
    }

    private static func parseSignatures(in document: Data, password: String?) throws -> [SignatureCandidate] {
        let pdf = try openDocument(document, password: password)
        return try withExtendedLifetime(pdf) {
            guard let catalog = pdf.catalog else {
                throw VerificationFailure(.invalid, "The signature structure is malformed.")
            }
            var dssObject: CGPDFObjectRef?
            let hasDSS = CGPDFDictionaryGetObject(catalog, "DSS", &dssObject)
            guard let signatures = try signatureDictionaries(in: catalog) else {
                if document.range(of: Data("/ByteRange".utf8)) != nil {
                    throw VerificationFailure(.unsupported, "A signature structure exists but could not be read safely.")
                }
                return []
            }

            let candidates = try signatures.map {
                try signatureCandidate(from: $0, document: document, hasDSS: hasDSS, comparesParsedContents: !pdf.isEncrypted)
            }
            if pdf.isEncrypted, !candidates.isEmpty {
                try requireGapsAreSignatureContents(candidates, of: signatures, document: document, password: password)
            }
            return candidates
        }
    }

    private static func openDocument(_ document: Data, password: String?) throws -> CGPDFDocument {
        guard let provider = CGDataProvider(data: document as CFData),
              let pdf = CGPDFDocument(provider) else {
            throw VerificationFailure(.invalid, "The signature structure is malformed.")
        }
        if pdf.isEncrypted && !pdf.isUnlocked {
            guard let password, pdf.unlockWithPassword(password) else {
                throw VerificationFailure(.invalid, "The PDF password is required or incorrect.")
            }
        }
        return pdf
    }

    /// Signature dictionaries in AcroForm field order, or nil when the document has no form fields.
    private static func signatureDictionaries(in catalog: CGPDFDictionaryRef) throws -> [CGPDFDictionaryRef]? {
        guard let acroForm = dictionary(named: "AcroForm", in: catalog),
              let fields = array(named: "Fields", in: acroForm) else { return nil }
        var signatures: [CGPDFDictionaryRef] = []
        try collectSignatureFields(fields, inheritedType: nil, depth: 0, signatures: &signatures)
        return signatures
    }

    private static func collectSignatureFields(
        _ fields: CGPDFArrayRef,
        inheritedType: String?,
        depth: Int,
        signatures: inout [CGPDFDictionaryRef]
    ) throws {
        guard depth <= maximumFieldDepth else {
            throw VerificationFailure(.unsupported, "The signature field structure is too deeply nested to inspect safely.")
        }
        for index in 0..<CGPDFArrayGetCount(fields) {
            var object: CGPDFObjectRef?
            var field: CGPDFDictionaryRef?
            guard CGPDFArrayGetObject(fields, index, &object),
                  let object,
                  CGPDFObjectGetValue(object, .dictionary, &field),
                  let field else {
                throw VerificationFailure(.invalid, "The signature field structure is malformed.")
            }

            let fieldType = name(named: "FT", in: field) ?? inheritedType
            if fieldType == "Sig", let signature = dictionary(named: "V", in: field) {
                guard signatures.count < maximumSignatureCount else {
                    throw VerificationFailure(.unsupported, "This document contains too many signatures to inspect safely.")
                }
                signatures.append(signature)
            }

            if let kids = array(named: "Kids", in: field) {
                try collectSignatureFields(kids, inheritedType: fieldType, depth: depth + 1, signatures: &signatures)
            }
        }
    }

    /// CoreGraphics decrypts every string of an encrypted PDF, including a signature's /Contents,
    /// which the PDF format leaves unencrypted, so the raw gap cannot be compared with it. Changing
    /// one byte of a signature's own gap must change what that signature dictionary reads as
    /// /Contents. If it does not, the gap is some other string, and the bytes it leaves unsigned
    /// could be visible content rather than the signature.
    private static func requireGapsAreSignatureContents(
        _ candidates: [SignatureCandidate],
        of signatures: [CGPDFDictionaryRef],
        document: Data,
        password: String?
    ) throws {
        let mismatch = VerificationFailure(.invalid, "The signature container does not match the signed byte range.")
        var altered = Data(document)
        for (index, candidate) in candidates.enumerated() {
            // The first hex digit is the first byte of the value (the IV for AES), so padding stays valid.
            guard let digit = (candidate.byteRanges[0].upperBound..<candidate.byteRanges[1].lowerBound)
                .first(where: { hexNibble(altered[$0]) != nil }) else { throw mismatch }
            let original = altered[digit]
            altered[digit] = original == UInt8(ascii: "0") ? UInt8(ascii: "1") : UInt8(ascii: "0")
            defer { altered[digit] = original }

            let alteredPDF = try openDocument(altered, password: password)
            try withExtendedLifetime(alteredPDF) {
                guard let catalog = alteredPDF.catalog,
                      let alteredSignatures = try signatureDictionaries(in: catalog),
                      alteredSignatures.count == signatures.count,
                      let before = pdfStringData(named: "Contents", in: signatures[index]),
                      let after = pdfStringData(named: "Contents", in: alteredSignatures[index]),
                      before.count == after.count,
                      before != after else { throw mismatch }
            }
        }
    }

    private static func signatureCandidate(
        from signature: CGPDFDictionaryRef,
        document: Data,
        hasDSS: Bool,
        comparesParsedContents: Bool
    ) throws -> SignatureCandidate {
        guard let byteRange = array(named: "ByteRange", in: signature),
              CGPDFArrayGetCount(byteRange) == 4 else {
            throw VerificationFailure(.invalid, "The signed byte range is malformed.")
        }
        var values: [Int] = []
        for index in 0..<4 {
            var integer: CGPDFInteger = 0
            guard CGPDFArrayGetInteger(byteRange, index, &integer), integer >= 0 else {
                throw VerificationFailure(.invalid, "The signed byte range is malformed.")
            }
            values.append(Int(integer))
        }
        let ranges = try validateByteRange(values, documentSize: document.count)

        guard let subfilter = name(named: "SubFilter", in: signature) else {
            throw VerificationFailure(.invalid, "The signature format is missing.")
        }
        guard let parsedContents = pdfStringData(named: "Contents", in: signature) else {
            throw VerificationFailure(.invalid, "The signature container is missing.")
        }

        // The unsigned gap may hold nothing but the hex signature, written directly after this
        // dictionary's /Contents key as the PDF format requires, so its bytes are the container.
        let gap = ranges[0].upperBound..<ranges[1].lowerBound
        guard !gap.isEmpty,
              gap.count <= 4 * maximumCMSBytes,
              followsContentsKey(gap.lowerBound, in: document),
              let rawContents = decodeContentsGap(document[gap]),
              rawContents.count <= maximumCMSBytes,
              !comparesParsedContents || rawContents == parsedContents else {
            throw VerificationFailure(.invalid, "The signature container does not match the signed byte range.")
        }

        return SignatureCandidate(
            byteRanges: ranges,
            contents: rawContents,
            subfilter: subfilter,
            coversWholeDocument: ranges[0].lowerBound == 0 && ranges[1].upperBound == document.count,
            hasDSS: hasDSS
        )
    }

    private static func dictionary(named key: String, in dictionary: CGPDFDictionaryRef) -> CGPDFDictionaryRef? {
        var value: CGPDFDictionaryRef?
        return CGPDFDictionaryGetDictionary(dictionary, key, &value) ? value : nil
    }

    private static func array(named key: String, in dictionary: CGPDFDictionaryRef) -> CGPDFArrayRef? {
        var value: CGPDFArrayRef?
        return CGPDFDictionaryGetArray(dictionary, key, &value) ? value : nil
    }

    private static func name(named key: String, in dictionary: CGPDFDictionaryRef) -> String? {
        var value: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(dictionary, key, &value), let value else { return nil }
        return String(cString: value)
    }

    private static func pdfStringData(named key: String, in dictionary: CGPDFDictionaryRef) -> Data? {
        var value: CGPDFStringRef?
        guard CGPDFDictionaryGetString(dictionary, key, &value), let value,
              let bytes = CGPDFStringGetBytePtr(value) else { return nil }
        return Data(bytes: bytes, count: CGPDFStringGetLength(value))
    }

    private static func validateByteRange(_ values: [Int], documentSize: Int) throws -> [Range<Int>] {
        guard values.count == 4,
              values.allSatisfy({ $0 >= 0 }),
              values[1] <= documentSize - values[0],
              values[3] <= documentSize - values[2] else {
            throw VerificationFailure(.invalid, "The signed byte range is malformed.")
        }
        let first = values[0]..<(values[0] + values[1])
        let second = values[2]..<(values[2] + values[3])
        guard first.lowerBound == 0,
              first.upperBound <= second.lowerBound,
              second.upperBound <= documentSize else {
            throw VerificationFailure(.invalid, "The signed byte range is malformed.")
        }
        return [first, second]
    }

    private static func followsContentsKey(_ offset: Int, in document: Data) -> Bool {
        let whitespace: Set<UInt8> = [0, 9, 10, 12, 13, 32]
        var end = offset
        while end > 0, whitespace.contains(document[end - 1]) { end -= 1 }
        let key = Data("/Contents".utf8)
        let start = end - key.count
        guard start >= 0, document[start..<end].elementsEqual(key) else { return false }

        // The key must be syntax, not comment text: `% /Contents` on the line above an
        // indirect string would otherwise pass for this dictionary's direct value. Anything
        // this line scan cannot read with certainty is rejected.
        var index = start
        while index > 0, document[index - 1] != 10, document[index - 1] != 13 { index -= 1 }
        var stringDepth = 0
        while index < start {
            switch document[index] {
            case UInt8(ascii: "\\") where stringDepth > 0:
                index += 1
            case UInt8(ascii: "("):
                stringDepth += 1
            case UInt8(ascii: ")"):
                guard stringDepth > 0 else { return false }
                stringDepth -= 1
            case UInt8(ascii: "%") where stringDepth == 0:
                return false
            default:
                break
            }
            index += 1
        }
        return stringDepth == 0
    }

    private static func decodeContentsGap(_ gap: Data.SubSequence) -> Data? {
        let whitespace: Set<UInt8> = [0, 9, 10, 12, 13, 32]
        guard let first = gap.firstIndex(where: { !whitespace.contains($0) }),
              let last = gap.lastIndex(where: { !whitespace.contains($0) }),
              gap[first] == 0x3c,
              gap[last] == 0x3e,
              first < last else { return nil }
        let afterFirst = gap.index(after: first)
        guard afterFirst < last,
              gap[afterFirst] != 0x3c,
              gap[..<first].allSatisfy(whitespace.contains),
              gap[gap.index(after: last)...].allSatisfy(whitespace.contains) else { return nil }

        let filtered = gap[afterFirst..<last].filter { !whitespace.contains($0) }
        guard filtered.count.isMultiple(of: 2) else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(filtered.count / 2)
        var index = 0
        while index < filtered.count {
            guard let high = hexNibble(filtered[index]),
                  let low = hexNibble(filtered[index + 1]) else { return nil }
            bytes.append((high << 4) | low)
            index += 2
        }
        return Data(bytes)
    }

    private static func hexNibble(_ value: UInt8) -> UInt8? {
        switch value {
        case 48...57: return value - 48
        case 65...70: return value - 65 + 10
        case 97...102: return value - 97 + 10
        default: return nil
        }
    }

    private static func derObject(fromPaddedContents data: Data) -> Data? {
        guard data.count >= 2 else { return nil }
        let lengthByte = Int(data[1])
        let headerLength: Int
        let payloadLength: Int
        if lengthByte & 0x80 == 0 {
            headerLength = 2
            payloadLength = lengthByte
        } else {
            let byteCount = lengthByte & 0x7f
            guard byteCount > 0, byteCount <= 4, data.count >= 2 + byteCount else { return nil }
            headerLength = 2 + byteCount
            var decodedLength = 0
            for byte in data[2..<headerLength] {
                guard decodedLength <= (Int.max - Int(byte)) / 256 else { return nil }
                decodedLength = decodedLength * 256 + Int(byte)
            }
            payloadLength = decodedLength
        }
        guard payloadLength <= data.count - headerLength else { return nil }
        let totalLength = headerLength + payloadLength
        guard data[totalLength...].allSatisfy({ $0 == 0 }) else { return nil }
        return data.prefix(totalLength)
    }

    private static func sha1(document: Data, byteRanges: [Range<Int>]) -> Data? {
        guard byteRanges.count == 2, let context = EVP_MD_CTX_new() else { return nil }
        defer { EVP_MD_CTX_free(context) }
        guard EVP_DigestInit_ex(context, EVP_sha1(), nil) == 1 else { return nil }
        let didUpdate = document.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            for range in byteRanges {
                guard EVP_DigestUpdate(context, base.advanced(by: range.lowerBound), range.count) == 1 else {
                    return false
                }
            }
            return true
        }
        guard didUpdate else { return nil }
        var digest = [UInt8](repeating: 0, count: Int(EVP_MAX_MD_SIZE))
        var digestLength: UInt32 = 0
        guard EVP_DigestFinal_ex(context, &digest, &digestLength) == 1 else { return nil }
        return Data(digest.prefix(Int(digestLength)))
    }

    private static func cmsEmbeddedContent(_ cms: OpaquePointer) -> Data? {
        guard let holder = CMS_get0_content(cms), let content = holder.pointee else { return nil }
        let length = ASN1_STRING_length(content)
        guard length >= 0, let bytes = ASN1_STRING_get0_data(content) else { return nil }
        return Data(bytes: bytes, count: Int(length))
    }

    /// Checks the signed attributes, message digest and signature value. Chain trust is
    /// evaluated separately by Security, so OpenSSL's own certificate checks stay off.
    private static func verifyCryptographicSignature(_ cms: OpaquePointer, detachedContent: Data?) -> Bool {
        guard let output = BIO_new(BIO_s_null()) else { return false }
        defer { BIO_free(output) }
        let flags = UInt32(CMS_BINARY | CMS_NO_SIGNER_CERT_VERIFY)
        guard let detachedContent else {
            return CMS_verify(cms, nil, nil, nil, output, flags) == 1
        }
        return detachedContent.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress,
                  let length = Int32(exactly: raw.count),
                  let input = BIO_new_mem_buf(base, length) else { return false }
            defer { BIO_free(input) }
            return CMS_verify(cms, nil, nil, input, output, flags) == 1
        }
    }

    private static func usesSHA1Digest(_ cms: OpaquePointer) -> Bool {
        guard let signerInfos = CMS_get0_SignerInfos(cms) else { return false }
        for index in 0..<OPENSSL_sk_num(signerInfos) {
            guard let signerInfo = OPENSSL_sk_value(signerInfos, index) else { continue }
            var digestAlgorithm: UnsafeMutablePointer<X509_ALGOR>?
            CMS_SignerInfo_get0_algs(OpaquePointer(signerInfo), nil, nil, &digestAlgorithm, nil)
            if let algorithm = digestAlgorithm?.pointee.algorithm, OBJ_obj2nid(algorithm) == NID_sha1 {
                return true
            }
        }
        return false
    }

    private static func certificates(from cms: OpaquePointer) -> [SecCertificate]? {
        guard let stack = CMS_get1_certs(cms) else { return nil }
        defer {
            for index in 0..<OPENSSL_sk_num(stack) {
                if let value = OPENSSL_sk_value(stack, index) {
                    X509_free(OpaquePointer(value))
                }
            }
            OPENSSL_sk_free(stack)
        }

        let signerStack = CMS_get0_signers(cms)
        defer { if let signerStack { OPENSSL_sk_free(signerStack) } }
        guard let signerDER = signerStack.flatMap({ signerStack -> Data? in
            guard OPENSSL_sk_num(signerStack) == 1,
                  let value = OPENSSL_sk_value(signerStack, 0) else { return nil }
            return derCertificate(OpaquePointer(value))
        }), let signer = SecCertificateCreateWithData(nil, signerDER as CFData) else { return nil }
        var result: [SecCertificate] = [signer]
        let count = min(OPENSSL_sk_num(stack), Int32(maximumCertificateCount))
        for index in 0..<count {
            guard let raw = OPENSSL_sk_value(stack, index) else { continue }
            let x509 = OpaquePointer(raw)
            guard let der = derCertificate(x509),
                  der != signerDER,
                  let certificate = SecCertificateCreateWithData(nil, der as CFData) else { continue }
            result.append(certificate)
        }
        return result
    }

    private static func derCertificate(_ certificate: OpaquePointer) -> Data? {
        let length = i2d_X509(certificate, nil)
        guard length > 0 else { return nil }
        var data = Data(count: Int(length))
        let written = data.withUnsafeMutableBytes { raw -> Int32 in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            var cursor: UnsafeMutablePointer<UInt8>? = base
            return i2d_X509(certificate, &cursor)
        }
        return written == length ? data : nil
    }

    private static func commonName(_ certificate: SecCertificate) -> String? {
        SecCertificateCopySubjectSummary(certificate) as String?
    }

    private func evaluateTrust(certificates: [SecCertificate], now: Date) -> PdfChefSignatureCheck {
        guard !certificates.isEmpty else {
            return PdfChefSignatureCheck(status: .indeterminate, detail: "The signer certificate is unavailable.")
        }
        // Embedded certificates are chain material only; anchors come from the device and this app.
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(certificates as CFArray, SecPolicyCreateBasicX509(), &trust) == errSecSuccess,
              let trust,
              additionalAnchors.isEmpty
                || (SecTrustSetAnchorCertificates(trust, additionalAnchors as CFArray) == errSecSuccess
                    && SecTrustSetAnchorCertificatesOnly(trust, false) == errSecSuccess),
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustSetVerifyDate(trust, now as CFDate) == errSecSuccess else {
            return PdfChefSignatureCheck(status: .indeterminate, detail: "The signer trust could not be evaluated.")
        }
        var error: CFError?
        guard SecTrustEvaluateWithError(trust, &error) else {
            return PdfChefSignatureCheck(
                status: .indeterminate,
                detail: "Trust could not be established at the current time; the issuer may be untrusted, a certificate may have expired, or the chain may be incomplete."
            )
        }

        let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
        let root = chain.last.map { Self.sha256Hex(SecCertificateCopyData($0) as Data) }
        if root == Self.ccaIndia2022SHA256 {
            return PdfChefSignatureCheck(
                status: .trusted,
                detail: "The signer certificate chains to CCA India 2022, the root of India’s Controller of Certifying Authorities, which PDF Chef trusts."
            )
        }
        if let root, additionalAnchors.contains(where: { Self.sha256Hex(SecCertificateCopyData($0) as Data) == root }) {
            return PdfChefSignatureCheck(status: .trusted, detail: "The signer certificate chains to a root bundled with PDF Chef.")
        }
        return PdfChefSignatureCheck(status: .trusted, detail: "The signer certificate chains to an Apple-trusted authority.")
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func certificateValidity(_ certificate: SecCertificate, now: Date) -> PdfChefSignatureCheck {
        guard let dates = certificateDates(certificate) else {
            return PdfChefSignatureCheck(status: .indeterminate, detail: "Certificate validity dates could not be read.")
        }
        if now < dates.notBefore {
            return PdfChefSignatureCheck(status: .notYetValid, detail: "The signer certificate is not valid yet.")
        }
        if now > dates.notAfter {
            return PdfChefSignatureCheck(status: .expired, detail: "The signer certificate has expired.")
        }
        return PdfChefSignatureCheck(status: .valid, detail: "The signer certificate is valid at this device’s current time.")
    }

    private static func certificateDates(_ certificate: SecCertificate) -> (notBefore: Date, notAfter: Date)? {
        let der = SecCertificateCopyData(certificate) as Data
        var parsed: OpaquePointer?
        let x509 = der.withUnsafeBytes { raw -> OpaquePointer? in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return nil }
            var cursor: UnsafePointer<UInt8>? = base
            return d2i_X509(&parsed, &cursor, der.count)
        }
        guard let x509 else { return nil }
        defer { X509_free(x509) }
        guard let start = date(from: X509_get0_notBefore(x509)),
              let end = date(from: X509_get0_notAfter(x509)) else { return nil }
        return (start, end)
    }

    private static func date(from value: UnsafePointer<ASN1_TIME>?) -> Date? {
        guard let value else { return nil }
        var components = tm()
        guard ASN1_TIME_to_tm(value, &components) == 1 else { return nil }
        var dateComponents = DateComponents()
        dateComponents.calendar = Calendar(identifier: .gregorian)
        dateComponents.timeZone = TimeZone(secondsFromGMT: 0)
        dateComponents.year = Int(components.tm_year) + 1900
        dateComponents.month = Int(components.tm_mon) + 1
        dateComponents.day = Int(components.tm_mday)
        dateComponents.hour = Int(components.tm_hour)
        dateComponents.minute = Int(components.tm_min)
        dateComponents.second = Int(components.tm_sec)
        return dateComponents.date
    }

    private static func containsTimestampToken(_ cms: Data) -> Bool {
        let timestampOID = Data([0x06, 0x0b, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x02, 0x0e])
        return cms.range(of: timestampOID) != nil
    }

    private static func failedReport(_ status: PdfChefSignatureStatus, _ detail: String) -> PdfChefSignatureReport {
        PdfChefSignatureReport(
            signerName: nil,
            integrity: PdfChefSignatureCheck(status: status, detail: detail),
            trust: PdfChefSignatureCheck(status: .indeterminate, detail: "Signer trust was not evaluated."),
            certificateValidity: PdfChefSignatureCheck(status: .indeterminate, detail: "Certificate validity was not evaluated."),
            revocation: PdfChefSignatureCheck(status: .indeterminate, detail: "Revocation status was not evaluated."),
            timestampAndLTV: PdfChefSignatureCheck(status: .indeterminate, detail: "Timestamp and long-term validation were not evaluated."),
            warnings: []
        )
    }
}

private enum PdfChefOpenSSLCMSAdapter {
    // The binary package is pinned. Refuse a different ABI line instead of making
    // optimistic verification claims after an unreviewed dependency change.
    static var isSupportedRuntime: Bool {
        OPENSSL_version_major() == 3
            && OPENSSL_version_minor() == 6
            && OPENSSL_version_patch() >= 3
    }
}

private enum SignedContent {
    /// adbe.pkcs7.sha1 embeds the SHA-1 digest of the signed ranges as its content.
    case embeddedSHA1(Data)
    /// Detached formats sign the concatenated ranges themselves.
    case detached(Data)
}

private struct SignatureCandidate {
    let byteRanges: [Range<Int>]
    let contents: Data
    let subfilter: String
    let coversWholeDocument: Bool
    let hasDSS: Bool
}

private struct VerificationFailure: Error {
    let status: PdfChefSignatureStatus
    let userDetail: String

    init(_ status: PdfChefSignatureStatus, _ userDetail: String) {
        self.status = status
        self.userDetail = userDetail
    }
}
