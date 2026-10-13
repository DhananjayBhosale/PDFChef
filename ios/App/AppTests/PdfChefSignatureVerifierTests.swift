import CoreGraphics
import Foundation
import PDFKit
import XCTest
@testable import App

final class PdfChefSignatureVerifierTests: XCTestCase {
    func testRealGSTNetworkCMSKeepsFiveVerificationStatesSeparate() async throws {
        let cms = try XCTUnwrap(Data(base64Encoded: Self.realFixtureCMS))
        let digest = try XCTUnwrap(Data(hex: "2446237d77be93ad786752b4844ec0b9bb9dcb96"))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-09T00:00:00Z"))

        let report = await fixtureReport(
            cmsData: cms,
            signedContentDigest: digest,
            now: now
        )

        XCTAssertEqual(report.signerName, "DS GOODS AND SERVICES TAX NETWORK 07")
        XCTAssertEqual(report.integrity.status, .valid)
        XCTAssertEqual(report.trust.status, .indeterminate)
        XCTAssertEqual(report.certificateValidity.status, .expired)
        XCTAssertEqual(report.revocation.status, .offline)
        XCTAssertEqual(report.timestampAndLTV.status, .notPresent)
        XCTAssertEqual(report.warnings, ["This signature uses legacy SHA-1 digesting."])
    }

    func testChangedSignedDigestFailsClosedBeforeTrustClaims() async throws {
        let cms = try XCTUnwrap(Data(base64Encoded: Self.realFixtureCMS))
        let report = await fixtureReport(
            cmsData: cms,
            signedContentDigest: Data(repeating: 0, count: 20),
            now: Date()
        )

        XCTAssertEqual(report.integrity.status, .invalid)
        XCTAssertEqual(report.trust.status, .indeterminate)
        XCTAssertEqual(report.certificateValidity.status, .indeterminate)
        XCTAssertEqual(report.revocation.status, .indeterminate)
        XCTAssertEqual(report.timestampAndLTV.status, .indeterminate)
    }

    func testTrailingUnsignedDataIsNotReportedAsValidIntegrity() async throws {
        let cms = try XCTUnwrap(Data(base64Encoded: Self.realFixtureCMS))
        let digest = try XCTUnwrap(Data(hex: "2446237d77be93ad786752b4844ec0b9bb9dcb96"))

        let report = await fixtureReport(
            cmsData: cms,
            signedContentDigest: digest,
            now: Date(),
            coversWholeDocument: false
        )

        XCTAssertEqual(report.integrity.status, .indeterminate)
        XCTAssertTrue(report.warnings.contains("Unsigned changes follow the signed document revision."))
    }

    func testOverlappingByteRangeFailsValidation() {
        let verifier = PdfChefSignatureVerifier()

        XCTAssertFalse(verifier.acceptsByteRangeFixture([0, 40, 20, 10], documentSize: 100))
        XCTAssertFalse(verifier.acceptsByteRangeFixture([1, 10, 20, 10], documentSize: 100))
        XCTAssertFalse(verifier.acceptsByteRangeFixture([0, 10, 90, 20], documentSize: 100))
        XCTAssertTrue(verifier.acceptsByteRangeFixture([0, 40, 60, 40], documentSize: 100))
    }

    func testUnreadableMalformedPDFFailsClosed() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("PdfChefSignatureMalformed-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("%PDF-1.7\n/ByteRange [0 40 20 10]\n/SubFilter /adbe.pkcs7.sha1\n/Contents <00>\n%%EOF".utf8)
            .write(to: url, options: .atomic)

        let reports = await PdfChefSignatureVerifier().verifyDocument(at: url)

        XCTAssertEqual(reports.count, 1)
        XCTAssertEqual(reports.first?.integrity.status, .invalid)
        XCTAssertEqual(reports.first?.integrity.detail, "The signature structure is malformed.")
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testProtectedPDFRequiresExactTransientPassword() async throws {
        let password = "local-only-password"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("PdfChefSignatureProtected-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: url) }

        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData) else {
            return XCTFail("Could not create a PDF data consumer")
        }
        var mediaBox = CGRect(x: 0, y: 0, width: 100, height: 100)
        let options = [
            kCGPDFContextUserPassword as String: password,
            kCGPDFContextOwnerPassword as String: "owner-password",
        ] as CFDictionary
        guard let context = CGContext(consumer: consumer, mediaBox: &mediaBox, options) else {
            return XCTFail("Could not create a protected PDF")
        }
        context.beginPDFPage(nil)
        context.endPDFPage()
        context.closePDF()
        try (data as Data).write(to: url, options: .atomic)

        let missing = await PdfChefSignatureVerifier().verifyDocument(at: url)
        XCTAssertEqual(missing.first?.integrity.detail, "The PDF password is required or incorrect.")
        let wrong = await PdfChefSignatureVerifier().verifyDocument(at: url, password: "wrong")
        XCTAssertEqual(wrong.first?.integrity.detail, "The PDF password is required or incorrect.")
        let unlocked = await PdfChefSignatureVerifier().verifyDocument(at: url, password: password)
        XCTAssertTrue(unlocked.isEmpty)
        XCTAssertNil((data as Data).range(of: Data(password.utf8)))
    }

    // Synthetic e-Aadhaar-shaped fixtures from scripts/generate-signature-fixtures.mjs.
    private static let fixturePassword = "fixture-user"
    private static let fixtureNow = ISO8601DateFormatter().date(from: "2027-01-01T00:00:00Z")!

    func testEncryptedDetachedSignatureVerifiesAgainstBundledRoot() async throws {
        let verifier = PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])

        let reports = await verifier.verifyDocument(
            at: try Self.fixtureURL("detached-sha256-rc4"),
            password: Self.fixturePassword,
            now: Self.fixtureNow
        )

        XCTAssertEqual(reports.count, 1)
        let report = try XCTUnwrap(reports.first)
        XCTAssertEqual(report.signerName, "DS PDF Chef Test Signer 01")
        XCTAssertEqual(report.integrity.status, .valid)
        XCTAssertEqual(report.integrity.detail, "The signed byte range matches the complete document.")
        XCTAssertEqual(report.trust.status, .trusted)
        XCTAssertEqual(report.trust.detail, "The signer certificate chains to a root bundled with PDF Chef.")
        XCTAssertEqual(report.certificateValidity.status, .valid)
        XCTAssertEqual(report.revocation.status, .offline)
        XCTAssertEqual(report.warnings, [])
    }

    func testEmbeddedRootIsNotTrustedWithoutAnAnchor() async throws {
        let reports = await PdfChefSignatureVerifier().verifyDocument(
            at: try Self.fixtureURL("detached-sha256-rc4"),
            password: Self.fixturePassword,
            now: Self.fixtureNow
        )

        XCTAssertEqual(reports.first?.integrity.status, .valid)
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testEncryptedDetachedSignatureNeedsThePassword() async throws {
        let reports = await PdfChefSignatureVerifier().verifyDocument(at: try Self.fixtureURL("detached-sha256-rc4"))

        XCTAssertEqual(reports.first?.integrity.detail, "The PDF password is required or incorrect.")
    }

    func testCAdESDetachedSignatureVerifies() async throws {
        let verifier = PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])

        let reports = await verifier.verifyDocument(at: try Self.fixtureURL("cades-sha256-plain"), now: Self.fixtureNow)

        XCTAssertEqual(reports.first?.integrity.status, .valid)
        XCTAssertEqual(reports.first?.trust.status, .trusted)
        XCTAssertEqual(reports.first?.warnings, [])
    }

    func testChangedSignedByteFailsDetachedVerification() async throws {
        var document = try Data(contentsOf: try Self.fixtureURL("cades-sha256-plain"))
        let drawing = try XCTUnwrap(document.range(of: Data("0.1 0.4 0.8 rg".utf8)))
        document[drawing.lowerBound + 2] = UInt8(ascii: "9")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("PdfChefSignatureChanged-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: url) }
        try document.write(to: url, options: .atomic)

        let reports = await PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])
            .verifyDocument(at: url, now: Self.fixtureNow)

        XCTAssertEqual(reports.first?.integrity.status, .invalid)
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testEncryptedShadowGapIsNotTheSignature() async throws {
        // The gap holds a CMS that verifies over the signed ranges, but the signature
        // dictionary's own /Contents is elsewhere, so the gap could be visible content.
        let reports = await PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()]).verifyDocument(
            at: try Self.fixtureURL("shadow-gap-rc4"),
            password: Self.fixturePassword,
            now: Self.fixtureNow
        )

        XCTAssertEqual(reports.count, 1)
        XCTAssertEqual(reports.first?.integrity.status, .invalid)
        XCTAssertEqual(reports.first?.integrity.detail, "The signature container does not match the signed byte range.")
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testShadowGapBehindAnUnsignedUpdateIsRejected() async throws {
        // An unsigned update gives the dictionary a /Contents equal to the excluded string,
        // but the signed revision's dictionary never held it.
        let reports = await PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])
            .verifyDocument(at: try Self.fixtureURL("shadow-update-plain"), now: Self.fixtureNow)

        XCTAssertEqual(reports.first?.integrity.status, .invalid)
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testLongTermValidationDataIsReportedAsPresentButUnchecked() async throws {
        let cms = try XCTUnwrap(Data(base64Encoded: Self.realFixtureCMS))
        let digest = try XCTUnwrap(Data(hex: "2446237d77be93ad786752b4844ec0b9bb9dcb96"))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-09-09T00:00:00Z"))

        let report = await fixtureReport(cmsData: cms, signedContentDigest: digest, now: now, hasDSS: true)

        XCTAssertEqual(report.timestampAndLTV.status, .unsupported)
    }

    func testUnsignedGapBeyondContentsIsRejected() async throws {
        // The CMS is genuine, but the gap also leaves the dictionary's /M entry unsigned.
        let reports = await PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])
            .verifyDocument(at: try Self.fixtureURL("wide-gap-plain"), now: Self.fixtureNow)

        XCTAssertEqual(reports.first?.integrity.status, .invalid)
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testIndirectContentsBehindACommentIsRejected() async throws {
        // `/Contents 7 0 R` points at a string preceded by `% /Contents`, which only looks like
        // the key. The PDF format requires the signature value to be direct.
        let reports = await PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])
            .verifyDocument(at: try Self.fixtureURL("indirect-comment-plain"), now: Self.fixtureNow)

        XCTAssertEqual(reports.first?.integrity.status, .invalid)
        XCTAssertEqual(reports.first?.trust.status, .indeterminate)
    }

    func testBundledCCAIndiaRootMatchesItsPin() throws {
        let anchor = try XCTUnwrap(PdfChefSignatureVerifier.bundledAnchors.first)

        XCTAssertEqual(PdfChefSignatureVerifier.bundledAnchors.count, 1)
        XCTAssertEqual(SecCertificateCopySubjectSummary(anchor) as String?, "CCA India 2022")
    }

    func testVerifiedCopyShowsTheValidLayersAndKeepsThePassword() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("VerifiedCopy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = try Self.fixtureURL("layered-appearance-rc4")
        let original = try Data(contentsOf: source)

        let copy = try PdfChefVerifiedCopy.create(
            from: source,
            password: Self.fixturePassword,
            displayName: "Aadhaar.pdf",
            checkedAt: Self.fixtureNow,
            in: directory
        )

        XCTAssertEqual(copy.lastPathComponent, "Aadhaar (verified copy).pdf")
        XCTAssertEqual(try Data(contentsOf: source), original, "the signed original is never modified")
        let document = try XCTUnwrap(PDFDocument(url: copy))
        XCTAssertTrue(document.isLocked, "the copy keeps the original's password")
        XCTAssertTrue(document.unlock(withPassword: Self.fixturePassword))
        let page = try XCTUnwrap(document.page(at: 0))
        let text = page.string ?? ""
        XCTAssertTrue(text.contains("Signature valid"))
        XCTAssertTrue(text.contains("Digitally signed by DS PDF Chef"))
        XCTAssertFalse(text.contains("Signature Not Verified"))
        XCTAssertFalse(page.annotations.contains { $0.widgetFieldType == .signature }, "no viewer can repaint its own status")
        XCTAssertGreaterThan(Self.greenPixels(in: page), 40, "the check mark is drawn in the signature box")
        // The note records when the report checked the signature, not when the copy was made.
        let provenance = try XCTUnwrap(
            document.documentAttributes?[PDFDocumentAttribute.subjectAttribute] as? String
        )
        XCTAssertEqual(provenance, PdfChefVerifiedCopy.provenanceNote(checkedAt: Self.fixtureNow))
        XCTAssertTrue(provenance.contains("Revocation was not checked"))
    }

    func testOwnerOnlyProtectedCopyKeepsItsEmptyOpenPassword() throws {
        // An owner-only PDF opens without asking, so the sheet has no password to pass on.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("VerifiedCopy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        let copy = try PdfChefVerifiedCopy.create(
            from: try Self.fixtureURL("layered-owner-only-rc4"),
            password: nil,
            displayName: "Owner only.pdf",
            checkedAt: Self.fixtureNow,
            in: directory
        )

        let document = try XCTUnwrap(PDFDocument(url: copy))
        XCTAssertTrue(document.isEncrypted, "the copy keeps the original's protection")
        XCTAssertFalse(document.isLocked, "and still opens without a password")
        XCTAssertTrue(document.page(at: 0)?.string?.contains("Signature valid") == true)
    }

    func testAnUnrenderableSignatureBoxOnAMarkedPageStopsTheCopy() throws {
        // The unsigned box's state-keyed appearance cannot be redrawn, and leaving it out
        // would silently drop a box the original shows.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("VerifiedCopy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertThrowsError(try PdfChefVerifiedCopy.render(
            from: try Self.fixtureURL("layered-state-box-rc4"),
            password: Self.fixturePassword,
            protected: false,
            checkedAt: Self.fixtureNow
        )) { error in
            XCTAssertEqual(error as? PdfChefVerifiedCopyError, .unsupportedSignatureBox)
        }
    }

    func testVerifiedCopyNeedsAVisibleSignatureBox() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("VerifiedCopy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertThrowsError(try PdfChefVerifiedCopy.create(
            from: try Self.fixtureURL("cades-sha256-plain"),
            password: nil,
            displayName: "Plain.pdf",
            checkedAt: Self.fixtureNow,
            in: directory
        )) { error in
            XCTAssertEqual(error as? PdfChefVerifiedCopyError, .noSignatureBox)
        }
    }

    func testStatusLayerReadsSignatureValid() throws {
        let layer = Data("BT\n1 0 0 1 2 23.3 Tm\n/F1 4.7 Tf\n(Signature Not Verified)Tj\nET\n".utf8)

        let valid = try XCTUnwrap(PdfChefVerifiedCopy.validStatusLayer(from: layer))

        XCTAssertEqual(
            String(data: valid, encoding: .isoLatin1),
            "BT\n0.13 0.5 0.25 rg\n\n1 0 0 1 2 23.3 Tm\n/F1 4.7 Tf\n(Signature valid)Tj\nET\n"
        )
    }

    func testStatusLayerIgnoresCommentsAndRefusesHexStrings() {
        let commented = Data("% BT (comment)Tj\nBT (Signature Not Verified)Tj ET\n".utf8)
        XCTAssertEqual(
            PdfChefVerifiedCopy.validStatusLayer(from: commented).flatMap { String(data: $0, encoding: .isoLatin1) },
            "% BT (comment)Tj\nBT\n0.13 0.5 0.25 rg\n (Signature valid)Tj ET\n"
        )
        XCTAssertNil(PdfChefVerifiedCopy.validStatusLayer(from: Data("BT <5369676e6174757265>Tj ET".utf8)))
    }

    func testOnlyTheVerifiedSignatureBoxIsMarkedOnAnOffsetPage() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("VerifiedCopy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        let copy = try PdfChefVerifiedCopy.create(
            from: try Self.fixtureURL("layered-mixed-offset-rc4"),
            password: Self.fixturePassword,
            displayName: "Mixed.pdf",
            checkedAt: Self.fixtureNow,
            in: directory
        )

        let document = try XCTUnwrap(PDFDocument(url: copy))
        XCTAssertTrue(document.unlock(withPassword: Self.fixturePassword))
        let page = try XCTUnwrap(document.page(at: 0))
        let text = page.string ?? ""
        XCTAssertEqual(text.components(separatedBy: "Signature valid").count - 1, 1, "only the signed box says valid")
        XCTAssertEqual(text.components(separatedBy: "Signature Not Verified").count - 1, 1, "the unsigned box is unchanged")
        // Page space starts at (100, 100): the signed box is on the left half, the unsigned one on the right.
        XCTAssertGreaterThan(Self.greenPixels(in: page, columns: 0..<190), 40)
        XCTAssertEqual(Self.greenPixels(in: page, columns: 210..<400), 0)
    }

    func testAVerifiedBoxThatCannotBeRewrittenStopsTheCopy() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("VerifiedCopy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertThrowsError(try PdfChefVerifiedCopy.create(
            from: try Self.fixtureURL("layered-hex-status-rc4"),
            password: Self.fixturePassword,
            displayName: "Hex.pdf",
            checkedAt: Self.fixtureNow,
            in: directory
        )) { error in
            XCTAssertEqual(error as? PdfChefVerifiedCopyError, .unsupportedSignatureBox)
        }
    }

    func testSharedCopiesKeepOnlyPasswordsBothWritersPreserve() {
        XCTAssertTrue(PdfChefVerifiedCopy.canPreserve(password: "ABCD1234"))
        XCTAssertFalse(PdfChefVerifiedCopy.canPreserve(password: "pässwörd"))
        XCTAssertFalse(PdfChefVerifiedCopy.canPreserve(password: String(repeating: "a", count: 33)))
    }

    func testVerifiedCopyIsOfferedOnlyWhenEveryCheckPasses() async throws {
        let url = try Self.fixtureURL("layered-appearance-rc4")
        let trusted = await PdfChefSignatureVerifier(additionalAnchors: [try Self.fixtureRoot()])
            .verifyDocument(at: url, password: Self.fixturePassword, now: Self.fixtureNow)
        let untrusted = await PdfChefSignatureVerifier()
            .verifyDocument(at: url, password: Self.fixturePassword, now: Self.fixtureNow)

        XCTAssertTrue(PdfChefSignatureReportViewController.isFullyVerified(trusted))
        XCTAssertFalse(PdfChefSignatureReportViewController.isFullyVerified(untrusted))
        XCTAssertFalse(PdfChefSignatureReportViewController.isFullyVerified([]))
    }

    private static func greenPixels(in page: PDFPage, columns: Range<Int> = 0..<Int.max) -> Int {
        let image = page.thumbnail(of: CGSize(width: 400, height: 400), for: .mediaBox)
        guard let cgImage = image.cgImage,
              let context = CGContext(
                data: nil,
                width: cgImage.width,
                height: cgImage.height,
                bitsPerComponent: 8,
                bytesPerRow: cgImage.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return 0 }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return 0 }
        var count = 0
        for index in stride(from: 0, to: cgImage.width * cgImage.height * 4, by: 4) {
            guard columns.contains((index / 4) % cgImage.width) else { continue }
            let red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2]
            if green > 120, red < 90, blue < 110 { count += 1 }
        }
        return count
    }

    private static func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle(for: PdfChefSignatureVerifierTests.self).url(forResource: name, withExtension: "pdf"))
    }

    private static func fixtureRoot() throws -> SecCertificate {
        let url = try XCTUnwrap(Bundle(for: PdfChefSignatureVerifierTests.self).url(forResource: "test-root", withExtension: "der"))
        return try XCTUnwrap(SecCertificateCreateWithData(nil, try Data(contentsOf: url) as CFData))
    }

    private func fixtureReport(
        cmsData: Data,
        signedContentDigest: Data,
        now: Date,
        coversWholeDocument: Bool = true,
        hasDSS: Bool = false
    ) async -> PdfChefSignatureReport {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: PdfChefSignatureVerifier().verifyCMSFixture(
                    cmsData: cmsData,
                    signedContentDigest: signedContentDigest,
                    now: now,
                    coversWholeDocument: coversWholeDocument,
                    hasDSS: hasDSS
                ))
            }
        }
    }

    private static let realFixtureCMS = """
    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
    """
}

private extension Data {
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var result = Data()
        var cursor = hex.startIndex
        while cursor < hex.endIndex {
            let next = hex.index(cursor, offsetBy: 2)
            guard let byte = UInt8(hex[cursor..<next], radix: 16) else { return nil }
            result.append(byte)
            cursor = next
        }
        self = result
    }
}
