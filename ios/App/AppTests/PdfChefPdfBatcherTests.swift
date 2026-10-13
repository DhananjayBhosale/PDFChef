import PDFKit
import UIKit
import XCTest
@testable import App

final class PdfChefPdfBatcherTests: XCTestCase {
    private var rootURL: URL!
    private var store: PdfChefDocumentStore!

    override func setUpWithError() throws {
        rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("PdfChefPdfBatcherTests-\(UUID().uuidString)", isDirectory: true)
        store = try PdfChefDocumentStore(rootURL: rootURL.appendingPathComponent("Store", isDirectory: true))
    }

    override func tearDownWithError() throws {
        store = nil
        if rootURL != nil { try? FileManager.default.removeItem(at: rootURL) }
        rootURL = nil
    }

    func testSplitKeepsEveryPageAndCommitsBoundedDurableParts() throws {
        let sourceURL = rootURL.appendingPathComponent("large-source.pdf")
        let source = try makeImagePdf(pageCount: 8)
        XCTAssertTrue(source.write(to: sourceURL))
        let sourceBytes = Int64(try sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
        XCTAssertGreaterThan(sourceBytes, 0)

        let hardCap = max(Int64(32 * 1024), sourceBytes / 3)
        let batcher = PdfChefPdfBatcher(
            configuration: .init(
                targetBytes: max(1, hardCap / 2),
                maximumBytes: hardCap,
                reserveBytes: 0,
                maximumParts: 64,
                maximumSplitDepth: 4
            ),
            temporaryBaseURL: rootURL.appendingPathComponent("Batches", isDirectory: true)
        )
        let parts = try batcher.split(
            documentURL: sourceURL,
            baseName: "Quarterly Report.pdf",
            store: store,
            cancellation: PdfChefPdfBatchCancellationToken(),
            progress: { _ in }
        )

        XCTAssertGreaterThan(parts.count, 1)
        XCTAssertEqual(
            parts.map(\.ref).sorted(),
            try store.listDocuments().map(\.document.ref).sorted()
        )
        var retainedPageCount = 0
        for (index, part) in parts.enumerated() {
            let retainedURL = try store.readerURL(ref: part.ref)
            retainedPageCount += try XCTUnwrap(PDFDocument(url: retainedURL)).pageCount
            XCTAssertLessThanOrEqual(part.sizeBytes, hardCap)
            XCTAssertTrue(part.name?.hasSuffix(".pdf") == true)
            XCTAssertTrue(part.name?.hasPrefix("Part \(index + 1) of \(parts.count) — ") == true)
        }
        XCTAssertEqual(retainedPageCount, 8)
        XCTAssertGreaterThan(
            try XCTUnwrap(parts.first).retainedAt,
            try XCTUnwrap(parts.last).retainedAt,
            "Part 1 should be newest so it appears first in the default Recent sort"
        )
    }

    func testCancelledSplitDoesNotCommitParts() throws {
        let sourceURL = rootURL.appendingPathComponent("source.pdf")
        XCTAssertTrue(try makeImagePdf(pageCount: 2).write(to: sourceURL))
        let token = PdfChefPdfBatchCancellationToken()
        token.cancel()

        XCTAssertThrowsError(try PdfChefPdfBatcher(
            configuration: .init(
                targetBytes: 64 * 1024,
                maximumBytes: 128 * 1024,
                reserveBytes: 0,
                maximumParts: 64,
                maximumSplitDepth: 4
            ),
            temporaryBaseURL: rootURL.appendingPathComponent("Cancelled", isDirectory: true)
        ).split(
            documentURL: sourceURL,
            baseName: "Cancelled.pdf",
            store: store,
            cancellation: token,
            progress: { _ in }
        )) { error in
            guard let batchError = error as? PdfChefPdfBatcherError,
                  case .cancelled = batchError else {
                return XCTFail("Expected cancellation, got \(error)")
            }
        }
        XCTAssertTrue(try store.listDocuments().isEmpty)
    }

    private func makeImagePdf(pageCount: Int) throws -> PDFDocument {
        let document = PDFDocument()
        for pageIndex in 0..<pageCount {
            let size = CGSize(width: 192, height: 192)
            let image = UIGraphicsImageRenderer(size: size).image { context in
                UIColor(
                    hue: CGFloat(pageIndex) / CGFloat(max(pageCount, 1)),
                    saturation: 0.8,
                    brightness: 0.9,
                    alpha: 1
                ).setFill()
                context.fill(CGRect(origin: .zero, size: size))
                for row in 0..<24 {
                    let shade = CGFloat((row * 31 + pageIndex * 17) % 255) / 255
                    UIColor(white: shade, alpha: 1).setFill()
                    context.fill(CGRect(x: row * 8, y: (row * 13) % 192, width: 8, height: 64))
                }
            }
            guard let page = PDFPage(image: image) else { throw PdfChefPdfBatcherError.pageCopyFailed }
            document.insert(page, at: pageIndex)
        }
        return document
    }
}
