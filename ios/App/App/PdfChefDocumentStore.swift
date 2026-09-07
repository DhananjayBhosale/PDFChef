import CryptoKit
import Foundation

enum PdfChefDocumentStoreError: LocalizedError {
    case invalidReference
    case invalidSession
    case chunkTooLarge(maximum: Int)
    case invalidOffset
    case documentMissing
    case invalidPresentationName

    var errorDescription: String? {
        switch self {
        case .invalidReference: return "The document reference is invalid."
        case .invalidSession: return "The write session is invalid or has expired."
        case .chunkTooLarge(let maximum): return "The chunk exceeds the \(maximum)-byte limit."
        case .invalidOffset: return "The read offset is invalid."
        case .documentMissing: return "The retained document is missing."
        case .invalidPresentationName: return "The presentation filename is invalid."
        }
    }
}

struct PdfChefStoredDocument: Codable, Equatable {
    let ref: String
    var name: String?
    var mimeType: String?
    let sizeBytes: Int64
    let contentHash: String
    let retainedAt: Int64
    // Optional for compatibility with documents written before transient staging.
    var transient: Bool? = nil
}

struct PdfChefPendingImport: Codable, Equatable {
    let document: PdfChefStoredDocument
}

struct PdfChefReadChunk: Equatable {
    let data: Data
    let nextOffset: Int64
    let done: Bool
}

struct PdfChefStorageInformation: Equatable {
    let retainedBytes: Int64
    let availableBytes: Int64?
    let capacityBytes: Int64?
}

struct PdfChefListedDocument: Equatable {
    let document: PdfChefStoredDocument
    let available: Bool
    let pending: Bool
}

/// Durable, offline-only storage. Callers receive opaque references, never URLs.
final class PdfChefDocumentStore {
    static let maximumChunkBytes = 512 * 1024
    static let sharedResult: Result<PdfChefDocumentStore, Error> = Result { try PdfChefDocumentStore() }

    private struct WriteSession {
        let url: URL
        let handle: FileHandle
        let name: String?
        let mimeType: String?
        let transient: Bool
        var sizeBytes: Int64
        var hasher: SHA256
    }

    private struct MutationJournal: Codable {
        enum Kind: String, Codable { case delete, clear, incoming }
        let kind: Kind
        let refs: [String]
        let document: PdfChefStoredDocument?
        let sessionID: String?

        init(kind: Kind, refs: [String], document: PdfChefStoredDocument? = nil, sessionID: String? = nil) {
            self.kind = kind
            self.refs = refs
            self.document = document
            self.sessionID = sessionID
        }
    }

    private let fileManager: FileManager
    private let rootURL: URL
    private let documentsURL: URL
    private let metadataURL: URL
    private let writesURL: URL
    private let presentationURL: URL
    private let pendingURL: URL
    private let mutationURL: URL
    private let queue = DispatchQueue(label: "com.dhananjaytech.pdfchef.document-store")
    private var sessions: [String: WriteSession] = [:]

    init(rootURL: URL? = nil, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        if let rootURL {
            self.rootURL = rootURL
        } else {
            let applicationSupport = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            self.rootURL = applicationSupport
                .appendingPathComponent("PDFChef", isDirectory: true)
        }
        documentsURL = self.rootURL.appendingPathComponent("Documents", isDirectory: true)
        metadataURL = self.rootURL.appendingPathComponent("Metadata", isDirectory: true)
        writesURL = self.rootURL.appendingPathComponent("Writes", isDirectory: true)
        presentationURL = self.rootURL.appendingPathComponent("Presentation", isDirectory: true)
        pendingURL = self.rootURL.appendingPathComponent("pending-imports.json", isDirectory: false)
        mutationURL = self.rootURL.appendingPathComponent("mutation.json", isDirectory: false)

        try [self.rootURL, documentsURL, metadataURL, writesURL, presentationURL].forEach {
            try fileManager.createDirectory(at: $0, withIntermediateDirectories: true)
            let values = try $0.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw CocoaError(.fileReadInvalidFileName)
            }
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = self.rootURL
        try mutableRoot.setResourceValues(values)
        try protect(self.rootURL)
        try protect(documentsURL)
        try protect(metadataURL)
        try protect(writesURL)
        try protect(presentationURL)
        try recoverMutation()
        try removeAbandonedTransientDocuments()
        try removeAbandonedWrites()
        try removeAbandonedPresentationCopies()
        try garbageCollectOrphanedContent()
    }

    deinit {
        for session in sessions.values {
            try? session.handle.close()
        }
    }

    func beginWrite(name: String?, mimeType: String?, transient: Bool = false) throws -> String {
        try queue.sync {
            let sessionID = UUID().uuidString
            let url = writesURL.appendingPathComponent(sessionID).appendingPathExtension("part")
            guard fileManager.createFile(atPath: url.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown)
            }
            let handle = try FileHandle(forWritingTo: url)
            try protect(url)
            sessions[sessionID] = WriteSession(
                url: url,
                handle: handle,
                name: clean(name),
                mimeType: clean(mimeType),
                transient: transient,
                sizeBytes: 0,
                hasher: SHA256()
            )
            return sessionID
        }
    }

    func append(sessionID: String, data: Data) throws {
        try queue.sync {
            guard data.count <= Self.maximumChunkBytes else {
                throw PdfChefDocumentStoreError.chunkTooLarge(maximum: Self.maximumChunkBytes)
            }
            guard var session = sessions[sessionID] else {
                throw PdfChefDocumentStoreError.invalidSession
            }
            try session.handle.write(contentsOf: data)
            session.hasher.update(data: data)
            session.sizeBytes += Int64(data.count)
            sessions[sessionID] = session
        }
    }

    func finishWrite(sessionID: String, enqueuePending: Bool = false) throws -> PdfChefStoredDocument {
        try queue.sync {
            guard let session = sessions.removeValue(forKey: sessionID) else {
                throw PdfChefDocumentStoreError.invalidSession
            }
            do {
                try session.handle.synchronize()
                try session.handle.close()
                let ref = UUID().uuidString
                let finalURL = contentURL(for: ref)
                let verified = try hashAndSize(url: session.url)
                let streamedDigest = session.hasher.finalize().map { String(format: "%02x", $0) }.joined()
                guard verified.size == session.sizeBytes, verified.hash == streamedDigest else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                let document = PdfChefStoredDocument(
                    ref: ref,
                    name: session.name,
                    mimeType: session.mimeType,
                    sizeBytes: session.sizeBytes,
                    contentHash: verified.hash,
                    retainedAt: Int64(Date().timeIntervalSince1970 * 1_000),
                    transient: session.transient ? true : nil
                )
                if enqueuePending {
                    let stagedURL = stagedIncomingURL(for: ref)
                    // Journal the still-present .part before its first rename. Recovery can
                    // therefore finish or roll back every crash boundary deterministically.
                    try writeMutationUnlocked(MutationJournal(
                        kind: .incoming,
                        refs: [ref],
                        document: document,
                        sessionID: sessionID
                    ))
                    try fileManager.moveItem(at: session.url, to: stagedURL)
                    try protect(stagedURL)
                    try commitIncomingUnlocked(document)
                    try removeIfPresent(mutationURL)
                } else {
                    try fileManager.moveItem(at: session.url, to: finalURL)
                    try protect(finalURL)
                    do {
                        try writeMetadata(document)
                    } catch {
                        try? fileManager.removeItem(at: finalURL)
                        throw error
                    }
                }
                return document
            } catch {
                try? session.handle.close()
                try? fileManager.removeItem(at: session.url)
                throw error
            }
        }
    }

    func abortWrite(sessionID: String) throws {
        try queue.sync {
            guard let session = sessions.removeValue(forKey: sessionID) else {
                throw PdfChefDocumentStoreError.invalidSession
            }
            try? session.handle.close()
            try? fileManager.removeItem(at: session.url)
        }
    }

    func copyIn(url: URL, name: String?, mimeType: String?, enqueuePending: Bool = false) throws -> PdfChefStoredDocument {
        let sessionID = try beginWrite(name: name, mimeType: mimeType)
        do {
            let input = try FileHandle(forReadingFrom: url)
            defer { try? input.close() }
            while true {
                let data = try input.read(upToCount: Self.maximumChunkBytes) ?? Data()
                if data.isEmpty { break }
                try append(sessionID: sessionID, data: data)
            }
            return try finishWrite(sessionID: sessionID, enqueuePending: enqueuePending)
        } catch {
            try? abortWrite(sessionID: sessionID)
            throw error
        }
    }

    func readChunk(ref: String, offset: Int64, length: Int) throws -> PdfChefReadChunk {
        try queue.sync {
            try validateReference(ref)
            guard offset >= 0 else { throw PdfChefDocumentStoreError.invalidOffset }
            guard length > 0, length <= Self.maximumChunkBytes else {
                throw PdfChefDocumentStoreError.chunkTooLarge(maximum: Self.maximumChunkBytes)
            }
            let document = try statUnlocked(ref: ref)
            guard offset <= document.sizeBytes else { throw PdfChefDocumentStoreError.invalidOffset }
            let handle = try FileHandle(forReadingFrom: contentURL(for: ref))
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            let data = try handle.read(upToCount: min(length, Int(document.sizeBytes - offset))) ?? Data()
            if offset < document.sizeBytes && data.isEmpty {
                throw CocoaError(.fileReadCorruptFile)
            }
            let nextOffset = offset + Int64(data.count)
            return PdfChefReadChunk(data: data, nextOffset: nextOffset, done: nextOffset >= document.sizeBytes)
        }
    }

    func stat(ref: String) throws -> PdfChefStoredDocument {
        try queue.sync { try statUnlocked(ref: ref) }
    }

    func exists(ref: String) -> Bool {
        queue.sync {
            (try? statUnlocked(ref: ref)) != nil
        }
    }

    func listDocuments() throws -> [PdfChefListedDocument] {
        try queue.sync {
            let pendingRefs = Set(try readPendingUnlocked().map(\.document.ref))
            return try metadataReferencesUnlocked().sorted().map { ref in
                let metadataFile = metadataFileURL(for: ref)
                let document = try JSONDecoder().decode(
                    PdfChefStoredDocument.self,
                    from: Data(contentsOf: metadataFile)
                )
                guard document.ref == ref else { throw PdfChefDocumentStoreError.invalidReference }
                return PdfChefListedDocument(
                    document: document,
                    available: (try? statUnlocked(ref: ref)) != nil,
                    pending: pendingRefs.contains(ref)
                )
            }.filter { $0.document.transient != true }
        }
    }

    /// Creates a protected, crash-cleaned copy for UIKit presentation only.
    /// The returned URL never crosses the JavaScript boundary.
    func makePresentationCopy(ref: String, name: String?) throws -> URL {
        try queue.sync {
            let document = try statUnlocked(ref: ref)
            let filename = try presentationFilename(name ?? document.name, fallback: ref)
            let container = presentationURL.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try fileManager.createDirectory(at: container, withIntermediateDirectories: false)
            try protect(container)
            let temporary = container.appendingPathComponent(UUID().uuidString).appendingPathExtension("part")
            let final = container.appendingPathComponent(filename, isDirectory: false)
            do {
                try fileManager.copyItem(at: contentURL(for: ref), to: temporary)
                try protect(temporary)
                try fileManager.moveItem(at: temporary, to: final)
                try protect(final)
                return final
            } catch {
                try? fileManager.removeItem(at: container)
                throw error
            }
        }
    }

    func removePresentationCopy(at url: URL) throws {
        try queue.sync {
            let rootPath = presentationURL.standardizedFileURL.path
            let candidate = url.standardizedFileURL
            let container = candidate.deletingLastPathComponent()
            guard container.deletingLastPathComponent().path == rootPath,
                  container.path.hasPrefix(rootPath + "/") else {
                throw PdfChefDocumentStoreError.invalidReference
            }
            try removeIfPresent(container)
        }
    }

    func rename(ref: String, name: String) throws -> PdfChefStoredDocument {
        try queue.sync {
            var document = try statUnlocked(ref: ref)
            document.name = clean(name)
            try writeMetadata(document)
            return document
        }
    }

    func delete(ref: String) throws {
        try queue.sync {
            try validateReference(ref)
            let content = contentURL(for: ref)
            let metadata = metadataFileURL(for: ref)
            guard fileManager.fileExists(atPath: content.path) || fileManager.fileExists(atPath: metadata.path) else {
                throw PdfChefDocumentStoreError.documentMissing
            }
            try writeMutationUnlocked(MutationJournal(kind: .delete, refs: [ref]))
            try removeIfPresent(content)
            try removeIfPresent(metadata)
            let filtered = try readPendingUnlocked().filter { $0.document.ref != ref }
            try writePendingUnlocked(filtered)
            try removeIfPresent(mutationURL)
        }
    }

    func clear() throws {
        try queue.sync {
            let refs = try metadataReferencesUnlocked()
            try writeMutationUnlocked(MutationJournal(kind: .clear, refs: refs))
            try replayClearUnlocked(refs: refs)
            try writePendingUnlocked([])
            try removeIfPresent(mutationURL)
        }
    }

    func storageInformation() throws -> PdfChefStorageInformation {
        try queue.sync {
            let documents = try fileManager.contentsOfDirectory(
                at: documentsURL,
                includingPropertiesForKeys: [.fileSizeKey],
                options: [.skipsHiddenFiles]
            )
            let retained = try documents.reduce(Int64(0)) { partial, url in
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                return partial + Int64(size)
            }
            let attributes = try fileManager.attributesOfFileSystem(forPath: rootURL.path)
            let available = (attributes[.systemFreeSize] as? NSNumber)?.int64Value
            let capacity = (attributes[.systemSize] as? NSNumber)?.int64Value
            return PdfChefStorageInformation(retainedBytes: retained, availableBytes: available, capacityBytes: capacity)
        }
    }

    func enqueuePending(_ document: PdfChefStoredDocument) throws {
        try queue.sync {
            guard (try? statUnlocked(ref: document.ref)) == document else {
                throw PdfChefDocumentStoreError.documentMissing
            }
            var pending = try readPendingUnlocked().filter { $0.document.ref != document.ref }
            pending.append(PdfChefPendingImport(document: document))
            try writePendingUnlocked(pending)
        }
    }

    /// Returns existing imports without destructive dequeue. JavaScript acknowledges refs
    /// only after receiving them, so a process death cannot lose a provider delivery.
    func takePendingImports() throws -> [PdfChefPendingImport] {
        try queue.sync {
            let pending = try readPendingUnlocked()
            let existing = pending.filter {
                (try? statUnlocked(ref: $0.document.ref)) == $0.document
            }
            if existing.count != pending.count { try writePendingUnlocked(existing) }
            return existing
        }
    }

    func acknowledgePendingImports(refs: [String]) throws {
        try queue.sync {
            guard refs.allSatisfy(isValidReference) else { throw PdfChefDocumentStoreError.invalidReference }
            let accepted = Set(refs)
            let remaining = try readPendingUnlocked().filter { !accepted.contains($0.document.ref) }
            try writePendingUnlocked(remaining)
        }
    }

    private func statUnlocked(ref: String) throws -> PdfChefStoredDocument {
        try validateReference(ref)
        guard fileManager.fileExists(atPath: contentURL(for: ref).path),
              fileManager.fileExists(atPath: metadataFileURL(for: ref).path) else {
            throw PdfChefDocumentStoreError.documentMissing
        }
        let document = try JSONDecoder().decode(PdfChefStoredDocument.self, from: Data(contentsOf: metadataFileURL(for: ref)))
        guard document.ref == ref else { throw PdfChefDocumentStoreError.invalidReference }
        let contentValues = try contentURL(for: ref).resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])
        let metadataValues = try metadataFileURL(for: ref).resourceValues(forKeys: [.isSymbolicLinkKey])
        guard contentValues.isSymbolicLink != true,
              metadataValues.isSymbolicLink != true,
              Int64(contentValues.fileSize ?? -1) == document.sizeBytes else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return document
    }

    private func writeMetadata(_ document: PdfChefStoredDocument) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let url = metadataFileURL(for: document.ref)
        try encoder.encode(document).write(to: url, options: .atomic)
        try protect(url)
    }

    private func readPendingUnlocked() throws -> [PdfChefPendingImport] {
        guard fileManager.fileExists(atPath: pendingURL.path) else { return [] }
        return try JSONDecoder().decode([PdfChefPendingImport].self, from: Data(contentsOf: pendingURL))
    }

    private func writePendingUnlocked(_ pending: [PdfChefPendingImport]) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(pending).write(to: pendingURL, options: .atomic)
        try protect(pendingURL)
    }

    private func contentURL(for ref: String) -> URL {
        documentsURL.appendingPathComponent(ref).appendingPathExtension("data")
    }

    private func metadataFileURL(for ref: String) -> URL {
        metadataURL.appendingPathComponent(ref).appendingPathExtension("json")
    }

    private func stagedIncomingURL(for ref: String) -> URL {
        writesURL.appendingPathComponent(ref).appendingPathExtension("incoming")
    }

    private func validateReference(_ ref: String) throws {
        guard isValidReference(ref) else { throw PdfChefDocumentStoreError.invalidReference }
    }

    private func isValidReference(_ ref: String) -> Bool {
        guard !ref.isEmpty else { return false }
        guard let first = ref.utf8.first,
              (first >= 48 && first <= 57) || (first >= 65 && first <= 90) || (first >= 97 && first <= 122) else {
            return false
        }
        return ref.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 95 || $0 == 45
        }
    }

    private func clean(_ value: String?) -> String? {
        value
    }

    private func presentationFilename(_ value: String?, fallback: String) throws -> String {
        let candidate = value ?? fallback
        guard !candidate.isEmpty,
              candidate != ".",
              candidate != "..",
              !candidate.contains("/"),
              !candidate.contains("\\"),
              !candidate.contains("\0") else {
            throw PdfChefDocumentStoreError.invalidPresentationName
        }
        return candidate
    }

    private func removeAbandonedWrites() throws {
        for url in try fileManager.contentsOfDirectory(at: writesURL, includingPropertiesForKeys: nil) {
            if url.pathExtension == "part" || url.pathExtension == "incoming" {
                try? fileManager.removeItem(at: url)
            }
        }
    }

    private func removeAbandonedTransientDocuments() throws {
        for ref in try metadataReferencesUnlocked() {
            let metadata = metadataFileURL(for: ref)
            let document = try JSONDecoder().decode(PdfChefStoredDocument.self, from: Data(contentsOf: metadata))
            guard document.ref == ref else { throw PdfChefDocumentStoreError.invalidReference }
            guard document.transient == true else { continue }
            // Delete bytes first: a crash between removals leaves a marked metadata
            // entry that the next launch safely retries, never a recovered result.
            try removeIfPresent(contentURL(for: ref))
            try removeIfPresent(metadata)
        }
    }

    private func removeAbandonedPresentationCopies() throws {
        for url in try fileManager.contentsOfDirectory(at: presentationURL, includingPropertiesForKeys: nil) {
            // A stale presentation artifact must never make durable storage unavailable.
            // Retry it on the next launch if the provider or OS still has it locked.
            try? removeIfPresent(url)
        }
    }

    private func writeMutationUnlocked(_ mutation: MutationJournal) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(mutation).write(to: mutationURL, options: .atomic)
        try protect(mutationURL)
    }

    private func recoverMutation() throws {
        guard fileManager.fileExists(atPath: mutationURL.path) else { return }
        let mutation = try JSONDecoder().decode(MutationJournal.self, from: Data(contentsOf: mutationURL))
        switch mutation.kind {
        case .delete, .clear:
            try replayClearUnlocked(refs: mutation.refs)
        case .incoming:
            if let document = mutation.document {
                try recoverIncomingUnlocked(document, sessionID: mutation.sessionID)
            }
        }
        try removeIfPresent(mutationURL)
    }

    private func replayClearUnlocked(refs: [String]) throws {
        for ref in refs where isValidReference(ref) {
            try removeIfPresent(contentURL(for: ref))
            try removeIfPresent(metadataFileURL(for: ref))
        }
    }

    private func commitIncomingUnlocked(_ document: PdfChefStoredDocument) throws {
        let staged = stagedIncomingURL(for: document.ref)
        let final = contentURL(for: document.ref)
        if fileManager.fileExists(atPath: staged.path) {
            if fileManager.fileExists(atPath: final.path) { try removeIfPresent(staged) }
            else { try fileManager.moveItem(at: staged, to: final) }
        }
        guard fileManager.fileExists(atPath: final.path) else {
            throw PdfChefDocumentStoreError.documentMissing
        }
        try protect(final)
        try writeMetadata(document)
        var pending = try readPendingUnlocked().filter { $0.document.ref != document.ref }
        pending.append(PdfChefPendingImport(document: document))
        try writePendingUnlocked(pending)
    }

    private func recoverIncomingUnlocked(_ document: PdfChefStoredDocument, sessionID: String?) throws {
        let staged = stagedIncomingURL(for: document.ref)
        let final = contentURL(for: document.ref)
        if !fileManager.fileExists(atPath: staged.path),
           !fileManager.fileExists(atPath: final.path),
           let sessionID,
           isValidReference(sessionID) {
            let part = writesURL.appendingPathComponent(sessionID).appendingPathExtension("part")
            if fileManager.fileExists(atPath: part.path) {
                try fileManager.moveItem(at: part, to: staged)
            }
        }

        if fileManager.fileExists(atPath: staged.path) || fileManager.fileExists(atPath: final.path) {
            try commitIncomingUnlocked(document)
        } else {
            // A journal with no staged bytes cannot be completed. Roll back any partial
            // metadata/queue state, retain no false-success import, and let startup proceed.
            try removeIfPresent(metadataFileURL(for: document.ref))
            let pending = try readPendingUnlocked().filter { $0.document.ref != document.ref }
            try writePendingUnlocked(pending)
        }
    }

    /// Content without committed metadata is an interrupted write and is safe to collect.
    /// Metadata without content is deliberately retained so higher layers can show a missing file.
    private func garbageCollectOrphanedContent() throws {
        let metadataRefs = Set(try metadataReferencesUnlocked())
        for url in try fileManager.contentsOfDirectory(at: documentsURL, includingPropertiesForKeys: [.isSymbolicLinkKey]) {
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
            let ref = url.deletingPathExtension().lastPathComponent
            if values.isSymbolicLink == true || !metadataRefs.contains(ref) {
                try removeIfPresent(url)
            }
        }
    }

    private func metadataReferencesUnlocked() throws -> [String] {
        try fileManager.contentsOfDirectory(at: metadataURL, includingPropertiesForKeys: [.isSymbolicLinkKey])
            .compactMap { url in
                let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
                guard values.isSymbolicLink != true, url.pathExtension == "json" else { return nil }
                let ref = url.deletingPathExtension().lastPathComponent
                return isValidReference(ref) ? ref : nil
            }
    }

    private func hashAndSize(url: URL) throws -> (hash: String, size: Int64) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var size: Int64 = 0
        while true {
            let data = try handle.read(upToCount: Self.maximumChunkBytes) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
            size += Int64(data.count)
        }
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), size)
    }

    private func protect(_ url: URL) throws {
        #if os(iOS)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        #endif
    }

    private func removeIfPresent(_ url: URL) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }
}
