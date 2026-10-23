import Foundation
import PDFKit

enum PdfChefPdfBatcherError: LocalizedError {
    case cancelled
    case freeJobsExhausted
    case emptyDocument
    case encryptedDocument
    case insufficientSpace(requiredBytes: Int64, availableBytes: Int64)
    case tooManyParts(maximum: Int)
    case oversizedPage(maximumBytes: Int64)
    case pageCopyFailed
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return localized("Preparing smaller PDFs was cancelled.")
        case .freeJobsExhausted:
            return localized("You’ve used this week’s free jobs. Unlock PDF Chef Pro to split large PDFs into smaller parts.")
        case .emptyDocument:
            return localized("This PDF has no pages to prepare.")
        case .encryptedDocument:
            return localized("Encrypted PDFs cannot be split safely in the background. Save an unlocked copy first.")
        case .insufficientSpace(let requiredBytes, let availableBytes):
            let formatter = ByteCountFormatter()
            formatter.countStyle = .file
            return localized(
                "Preparing this PDF needs about %@ of free space. %@ is available.",
                formatter.string(fromByteCount: requiredBytes),
                formatter.string(fromByteCount: availableBytes)
            )
        case .tooManyParts(let maximum):
            return localized("This PDF would need more than %lld smaller parts.", maximum)
        case .oversizedPage(let maximumBytes):
            let formatter = ByteCountFormatter()
            formatter.countStyle = .file
            return localized("One page is larger than the %@ safe processing limit.", formatter.string(fromByteCount: maximumBytes))
        case .pageCopyFailed:
            return localized("A page could not be copied safely.")
        case .writeFailed:
            return localized("A smaller PDF could not be created.")
        }
    }
}

struct PdfChefPdfBatchProgress {
    enum Stage {
        case preparing
        case saving
    }

    let stage: Stage
    let completed: Int
    let total: Int
}

final class PdfChefPdfBatchCancellationToken {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

/// Produces durable, file-backed PDF parts without sending the source PDF over
/// the Capacitor bridge. The original retained document is never modified.
final class PdfChefPdfBatcher {
    struct Configuration {
        let targetBytes: Int64
        let maximumBytes: Int64
        let reserveBytes: Int64
        let maximumParts: Int
        let maximumSplitDepth: Int

        static let production = Configuration(
            targetBytes: 48 * 1024 * 1024,
            maximumBytes: 96 * 1024 * 1024,
            reserveBytes: 256 * 1024 * 1024,
            maximumParts: 64,
            maximumSplitDepth: 4
        )
    }

    private struct TemporaryPart {
        let url: URL
    }

    private let configuration: Configuration
    private let fileManager: FileManager
    private let temporaryBaseURL: URL

    init(
        configuration: Configuration = .production,
        fileManager: FileManager = .default,
        temporaryBaseURL: URL? = nil
    ) {
        self.configuration = configuration
        self.fileManager = fileManager
        self.temporaryBaseURL = temporaryBaseURL
            ?? fileManager.temporaryDirectory.appendingPathComponent("PdfChefPdfBatches", isDirectory: true)
    }

    func split(
        documentURL: URL,
        baseName: String,
        store: PdfChefDocumentStore,
        cancellation: PdfChefPdfBatchCancellationToken,
        progress: @escaping (PdfChefPdfBatchProgress) -> Void
    ) throws -> [PdfChefStoredDocument] {
        try checkConfiguration()
        try checkCancellation(cancellation)

        let sourceValues = try documentURL.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])
        guard sourceValues.isSymbolicLink != true else { throw PdfChefDocumentStoreError.invalidReference }
        let sourceBytes = Int64(sourceValues.fileSize ?? 0)
        let requiredBytes = try requiredFreeSpace(for: sourceBytes)
        if let availableBytes = try store.storageInformation().availableBytes,
           availableBytes < requiredBytes {
            throw PdfChefPdfBatcherError.insufficientSpace(
                requiredBytes: requiredBytes,
                availableBytes: availableBytes
            )
        }

        guard let source = PDFDocument(url: documentURL), source.pageCount > 0 else {
            throw PdfChefPdfBatcherError.emptyDocument
        }
        guard !source.isEncrypted, !source.isLocked else {
            throw PdfChefPdfBatcherError.encryptedDocument
        }

        try resetTemporaryDirectory()
        let operationURL = temporaryBaseURL.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: operationURL, withIntermediateDirectories: false)
        try protect(operationURL)
        defer { try? fileManager.removeItem(at: operationURL) }

        let estimatedPages = max(1, min(
            source.pageCount,
            Int((
                Double(source.pageCount)
                    * Double(configuration.targetBytes)
                    / Double(max(sourceBytes, 1))
            ).rounded(.down))
        ))
        var temporaryParts: [TemporaryPart] = []
        var start = 0
        while start < source.pageCount {
            try checkCancellation(cancellation)
            let end = min(source.pageCount, start + estimatedPages)
            try write(
                pages: start..<end,
                from: source,
                into: operationURL,
                depth: 0,
                cancellation: cancellation,
                progress: progress,
                parts: &temporaryParts
            )
            start = end
        }

        guard !temporaryParts.isEmpty else { throw PdfChefPdfBatcherError.writeFailed }
        let names = partNames(baseName: baseName, count: temporaryParts.count)
        var committedByIndex = Array<PdfChefStoredDocument?>(repeating: nil, count: temporaryParts.count)
        var savedCount = 0
        do {
            // Save in reverse so the default newest-first Recent view presents
            // Part 1 first, while the returned array remains in page order.
            for index in temporaryParts.indices.reversed() {
                try checkCancellation(cancellation)
                progress(.init(stage: .saving, completed: savedCount, total: temporaryParts.count))
                let part = temporaryParts[index]
                let document = try retain(
                    part.url,
                    name: names[index],
                    store: store,
                    cancellation: cancellation
                )
                committedByIndex[index] = document
                savedCount += 1
                try? fileManager.removeItem(at: part.url)
                progress(.init(stage: .saving, completed: savedCount, total: temporaryParts.count))
            }
            return committedByIndex.compactMap { $0 }
        } catch {
            for document in committedByIndex.compactMap({ $0 }) { try? store.delete(ref: document.ref) }
            throw error
        }
    }

    private func write(
        pages: Range<Int>,
        from source: PDFDocument,
        into operationURL: URL,
        depth: Int,
        cancellation: PdfChefPdfBatchCancellationToken,
        progress: @escaping (PdfChefPdfBatchProgress) -> Void,
        parts: inout [TemporaryPart]
    ) throws {
        try checkCancellation(cancellation)
        guard !pages.isEmpty else { return }
        guard parts.count < configuration.maximumParts else {
            throw PdfChefPdfBatcherError.tooManyParts(maximum: configuration.maximumParts)
        }

        let (url, size): (URL, Int64) = try autoreleasepool {
            let output = PDFDocument()
            for (outputIndex, sourceIndex) in pages.enumerated() {
                try checkCancellation(cancellation)
                guard let page = source.page(at: sourceIndex)?.copy() as? PDFPage else {
                    throw PdfChefPdfBatcherError.pageCopyFailed
                }
                output.insert(page, at: outputIndex)
                progress(.init(stage: .preparing, completed: sourceIndex + 1, total: source.pageCount))
            }

            let url = operationURL.appendingPathComponent(UUID().uuidString).appendingPathExtension("pdf")
            guard output.write(to: url) else { throw PdfChefPdfBatcherError.writeFailed }
            try protect(url)
            let size = Int64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            return (url, size)
        }
        if size <= configuration.maximumBytes {
            parts.append(TemporaryPart(url: url))
            guard parts.count <= configuration.maximumParts else {
                throw PdfChefPdfBatcherError.tooManyParts(maximum: configuration.maximumParts)
            }
            return
        }

        try? fileManager.removeItem(at: url)
        guard pages.count > 1 else {
            throw PdfChefPdfBatcherError.oversizedPage(maximumBytes: configuration.maximumBytes)
        }
        guard depth < configuration.maximumSplitDepth else {
            throw PdfChefPdfBatcherError.writeFailed
        }
        let midpoint = pages.lowerBound + (pages.count / 2)
        try write(
            pages: pages.lowerBound..<midpoint,
            from: source,
            into: operationURL,
            depth: depth + 1,
            cancellation: cancellation,
            progress: progress,
            parts: &parts
        )
        try write(
            pages: midpoint..<pages.upperBound,
            from: source,
            into: operationURL,
            depth: depth + 1,
            cancellation: cancellation,
            progress: progress,
            parts: &parts
        )
    }

    private func retain(
        _ url: URL,
        name: String,
        store: PdfChefDocumentStore,
        cancellation: PdfChefPdfBatchCancellationToken
    ) throws -> PdfChefStoredDocument {
        let sessionID = try store.beginWrite(name: name, mimeType: "application/pdf")
        do {
            let input = try FileHandle(forReadingFrom: url)
            defer { try? input.close() }
            while true {
                try checkCancellation(cancellation)
                let data = try input.read(upToCount: PdfChefDocumentStore.maximumChunkBytes) ?? Data()
                if data.isEmpty { break }
                try store.append(sessionID: sessionID, data: data)
            }
            return try store.finishWrite(sessionID: sessionID)
        } catch {
            try? store.abortWrite(sessionID: sessionID)
            throw error
        }
    }

    private func partNames(baseName: String, count: Int) -> [String] {
        let width = String(count).count
        return (1...count).map { index in
            let prefix = "Part \(String(format: "%0*d", width, index)) of \(count) — "
            let suffix = ".pdf"
            return prefix + truncatedBaseName(baseName, prefix: prefix, suffix: suffix) + suffix
        }
    }

    private func truncatedBaseName(_ baseName: String, prefix: String, suffix: String) -> String {
        let withoutExtension = (baseName as NSString).deletingPathExtension
        let cleaned = withoutExtension
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: "\\", with: "-")
            .replacingOccurrences(of: "\0", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let source = cleaned.isEmpty ? "Document" : cleaned
        var result = ""
        for character in source {
            let candidate = result + String(character)
            guard prefix.count + candidate.count + suffix.count <= 180,
                  prefix.utf8.count + candidate.utf8.count + suffix.utf8.count <= 720 else { break }
            result = candidate
        }
        return result.isEmpty ? "Document" : result
    }

    private func requiredFreeSpace(for sourceBytes: Int64) throws -> Int64 {
        let (doubled, overflowed) = sourceBytes.multipliedReportingOverflow(by: 2)
        let (required, additionOverflowed) = doubled.addingReportingOverflow(configuration.reserveBytes)
        guard !overflowed, !additionOverflowed else { throw PdfChefPdfBatcherError.writeFailed }
        return required
    }

    private func checkConfiguration() throws {
        guard configuration.targetBytes > 0,
              configuration.maximumBytes >= configuration.targetBytes,
              configuration.reserveBytes >= 0,
              configuration.maximumParts > 0,
              configuration.maximumSplitDepth >= 0 else {
            throw PdfChefPdfBatcherError.writeFailed
        }
    }

    private func checkCancellation(_ cancellation: PdfChefPdfBatchCancellationToken) throws {
        if cancellation.isCancelled { throw PdfChefPdfBatcherError.cancelled }
    }

    private func resetTemporaryDirectory() throws {
        if fileManager.fileExists(atPath: temporaryBaseURL.path) {
            try fileManager.removeItem(at: temporaryBaseURL)
        }
        try fileManager.createDirectory(at: temporaryBaseURL, withIntermediateDirectories: true)
        try protect(temporaryBaseURL)
    }

    private func protect(_ url: URL) throws {
        #if os(iOS)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        #endif
    }
}
