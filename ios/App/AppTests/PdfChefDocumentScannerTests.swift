import PDFKit
import UIKit
import XCTest
@testable import App

final class PdfChefDocumentScannerTests: XCTestCase {
    private var rootURL: URL!
    private var store: PdfChefDocumentStore!

    override func setUpWithError() throws {
        rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("PdfChefDocumentScannerTests-\(UUID().uuidString)", isDirectory: true)
        store = try PdfChefDocumentStore(rootURL: rootURL.appendingPathComponent("Store", isDirectory: true))
    }

    override func tearDownWithError() throws {
        store = nil
        if rootURL != nil { try? FileManager.default.removeItem(at: rootURL) }
        rootURL = nil
    }

    func testScanPagesBecomeJpegPagesThatKeepTheirShape() throws {
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        let url = rootURL.appendingPathComponent("scan.pdf")
        let pages = [page(width: 1200, height: 800), page(width: 600, height: 900, orientation: .right)]

        try PdfChefDocumentScanner.writePDF(pageCount: pages.count, to: url) { pages[$0] }

        let pdf = try XCTUnwrap(PDFDocument(url: url))
        XCTAssertEqual(pdf.pageCount, 2)
        let landscape = try XCTUnwrap(pdf.page(at: 0)?.bounds(for: .mediaBox))
        XCTAssertEqual(landscape.width, 842, accuracy: 0.5)
        XCTAssertEqual(landscape.height, 561.3, accuracy: 0.5)
        // The second photo was taken sideways, so it is drawn upright: 900 wide, 600 high.
        let rotated = try XCTUnwrap(pdf.page(at: 1)?.bounds(for: .mediaBox))
        XCTAssertEqual(rotated.width, 842, accuracy: 0.5)
        XCTAssertEqual(rotated.height, 561.3, accuracy: 0.5)
        let bytes = try Data(contentsOf: url)
        XCTAssertNotNil(bytes.range(of: Data("/DCTDecode".utf8)))
    }

    func testAScanIsKeptUnderOneNameAndLeavesNoScratchCopy() throws {
        let scratch = rootURL.appendingPathComponent("Scratch", isDirectory: true)

        let document = try PdfChefDocumentScanner.keep(pageCount: 3, in: store, temporaryDirectory: scratch) { _ in
            self.page(width: 800, height: 1100)
        }

        XCTAssertEqual(document.name, PdfChefDocumentScanner.documentName)
        XCTAssertEqual(document.mimeType, "application/pdf")
        XCTAssertNil(document.transient)
        XCTAssertTrue(store.exists(ref: document.ref))
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.path))
    }

    private func page(width: CGFloat, height: CGFloat, orientation: UIImage.Orientation = .up) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            UIColor.black.setFill()
            context.fill(CGRect(x: width / 4, y: height / 4, width: width / 2, height: height / 8))
        }
        return UIImage(cgImage: image.cgImage!, scale: 1, orientation: orientation)
    }
}
