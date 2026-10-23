import ImageIO
import UIKit
import UniformTypeIdentifiers
import VisionKit

enum PdfChefDocumentScanError: Error {
    case busy
    case unavailable
    case interrupted
    case storageFull
    case failed
}

/// Apple's document camera for Create PDF. The pages become one PDF in the document store;
/// nothing leaves the device.
final class PdfChefDocumentScanner: NSObject, VNDocumentCameraViewControllerDelegate {
    enum Outcome: Equatable {
        case cancelled
        case completed(PdfChefStoredDocument, pageCount: Int)
    }

    static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }
    /// Create PDF swaps this name for its dated one.
    static let documentName = "Scanned document.pdf"
    /// A4's long side in points; each page keeps its own shape.
    private static let pageLongSide: CGFloat = 842
    private static let jpegQuality = 0.8

    private let workQueue = DispatchQueue(label: "com.dhananjaytech.pdfchef.document-scanner", qos: .userInitiated)
    private var store: PdfChefDocumentStore?
    private var completion: ((Result<Outcome, Error>) -> Void)?

    func scan(
        from presenter: UIViewController,
        into store: PdfChefDocumentStore,
        completion: @escaping (Result<Outcome, Error>) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard self.completion == nil, presenter.presentedViewController == nil else {
            completion(.failure(PdfChefDocumentScanError.busy))
            return
        }
        guard Self.isAvailable, presenter.viewIfLoaded?.window != nil else {
            completion(.failure(PdfChefDocumentScanError.unavailable))
            return
        }
        self.store = store
        self.completion = completion
        let camera = VNDocumentCameraViewController()
        camera.delegate = self
        presenter.present(camera, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { self.finish(.success(.cancelled)) }
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) {
            self.finish(.failure(PdfChefDocumentScanError.interrupted))
        }
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        controller.dismiss(animated: !UIAccessibility.isReduceMotionEnabled)
        guard scan.pageCount > 0, let store else {
            finish(.success(.cancelled))
            return
        }
        workQueue.async {
            let result = Result {
                let document = try Self.keep(pageCount: scan.pageCount, in: store) { scan.imageOfPage(at: $0) }
                return Outcome.completed(document, pageCount: scan.pageCount)
            }
            DispatchQueue.main.async { self.finish(result) }
        }
    }

    private func finish(_ result: Result<Outcome, Error>) {
        let completion = completion
        self.completion = nil
        store = nil
        completion?(result)
    }

    /// Writes the pages as one PDF in a scratch folder, keeps it in the store, then removes the scratch copy.
    static func keep(
        pageCount: Int,
        in store: PdfChefDocumentStore,
        temporaryDirectory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("PdfChefScans", isDirectory: true),
        page: (Int) -> UIImage
    ) throws -> PdfChefStoredDocument {
        let fileManager = FileManager.default
        // A scan left behind by a crash goes first; it never reached the store.
        try? fileManager.removeItem(at: temporaryDirectory)
        defer { try? fileManager.removeItem(at: temporaryDirectory) }
        do {
            try fileManager.createDirectory(
                at: temporaryDirectory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            let url = temporaryDirectory.appendingPathComponent("scan.pdf")
            try writePDF(pageCount: pageCount, to: url, page: page)
            return try store.copyIn(url: url, name: documentName, mimeType: "application/pdf")
        } catch let error as PdfChefDocumentScanError {
            throw error
        } catch {
            throw isOutOfSpace(error) ? PdfChefDocumentScanError.storageFull : PdfChefDocumentScanError.failed
        }
    }

    /// One JPEG page per image, so a scan stays a few hundred kilobytes a page.
    static func writePDF(pageCount: Int, to url: URL, page: (Int) -> UIImage) throws {
        guard let context = CGContext(url as CFURL, mediaBox: nil, [kCGPDFContextCreator: "PDF Chef"] as CFDictionary) else {
            throw PdfChefDocumentScanError.failed
        }
        for index in 0..<pageCount {
            try autoreleasepool {
                guard let image = jpegImage(page(index)) else { throw PdfChefDocumentScanError.failed }
                let scale = pageLongSide / CGFloat(max(image.width, image.height))
                var box = CGRect(x: 0, y: 0, width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)
                context.beginPage(mediaBox: &box)
                context.draw(image, in: box)
                context.endPage()
            }
        }
        context.closePDF()
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { throw PdfChefDocumentScanError.failed }
    }

    /// A JPEG-backed image, which a PDF context embeds as is instead of as raw pixels.
    private static func jpegImage(_ image: UIImage) -> CGImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        let upright = image.imageOrientation == .up
            ? image
            : UIGraphicsImageRenderer(size: image.size, format: format).image { _ in image.draw(at: .zero) }
        guard let pixels = upright.cgImage else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, pixels, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), let provider = CGDataProvider(data: data) else { return nil }
        return CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    private static func isOutOfSpace(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain && error.code == NSFileWriteOutOfSpaceError)
            || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOSPC))
    }
}
