import CryptoKit
import Foundation
import XCTest
@testable import App

final class PdfChefDocumentStoreTests: XCTestCase {
    private var rootURL: URL!
    private var store: PdfChefDocumentStore!

    override func setUpWithError() throws {
        rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("PdfChefDocumentStoreTests-\(UUID().uuidString)", isDirectory: true)
        store = try PdfChefDocumentStore(rootURL: rootURL)
    }

    override func tearDownWithError() throws {
        store = nil
        if rootURL != nil { try? FileManager.default.removeItem(at: rootURL) }
        rootURL = nil
    }

    func testChunkedCommitProducesOpaqueRefVerifiedHashAndBoundedReads() throws {
        let first = Data("hello ".utf8)
        let second = Data("world".utf8)
        let session = try store.beginWrite(name: "sample.pdf", mimeType: "application/pdf")
        try store.append(sessionID: session, data: first)
        try store.append(sessionID: session, data: second)

        let document = try store.finishWrite(sessionID: session)

        XCTAssertTrue(document.ref.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
        XCTAssertFalse(document.ref.contains("/"))
        XCTAssertEqual(document.sizeBytes, 11)
        XCTAssertEqual(document.contentHash, SHA256.hash(data: first + second).map { String(format: "%02x", $0) }.joined())
        XCTAssertTrue(store.exists(ref: document.ref))

        let a = try store.readChunk(ref: document.ref, offset: 0, length: 5)
        let b = try store.readChunk(ref: document.ref, offset: a.nextOffset, length: 6)
        XCTAssertEqual(a.data + b.data, first + second)
        XCTAssertFalse(a.done)
        XCTAssertTrue(b.done)
    }

    func testRejectsOversizedChunksTraversalAndInvalidOffsets() throws {
        let session = try store.beginWrite(name: nil, mimeType: nil)
        XCTAssertThrowsError(try store.append(
            sessionID: session,
            data: Data(count: PdfChefDocumentStore.maximumChunkBytes + 1)
        ))
        try store.abortWrite(sessionID: session)

        XCTAssertFalse(store.exists(ref: "../private"))
        XCTAssertFalse(store.exists(ref: "_leading"))
        XCTAssertFalse(store.exists(ref: "-leading"))
        XCTAssertFalse(store.exists(ref: "éxample"))
        XCTAssertThrowsError(try store.stat(ref: String(repeating: "A", count: 129))) { error in
            guard let storeError = error as? PdfChefDocumentStoreError else {
                return XCTFail("Expected a document-store error")
            }
            guard case .documentMissing = storeError else {
                return XCTFail("A long ASCII token must be valid and reach the missing-document check")
            }
        }
        XCTAssertThrowsError(try store.stat(ref: "/absolute/path"))

        let valid = try retain(Data("x".utf8))
        XCTAssertThrowsError(try store.readChunk(ref: valid.ref, offset: -1, length: 1))
        XCTAssertThrowsError(try store.readChunk(ref: valid.ref, offset: 0, length: PdfChefDocumentStore.maximumChunkBytes + 1))
    }

    func testRelaunchRemovesTransientOutputsWithoutRecoveringThemAsSavedResults() throws {
        let permanent = try retain(Data("keep".utf8), name: "saved.pdf")
        let session = try store.beginWrite(name: "temporary.pdf", mimeType: "application/pdf", transient: true)
        try store.append(sessionID: session, data: Data("temporary".utf8))
        let temporary = try store.finishWrite(sessionID: session)
        XCTAssertTrue(store.exists(ref: temporary.ref), "The presenter can access its active copy")
        XCTAssertEqual(try store.listDocuments().map(\.document.ref), [permanent.ref],
                       "A WebView reload must not reconcile transient bytes into Recent")

        store = nil
        store = try PdfChefDocumentStore(rootURL: rootURL)
        XCTAssertFalse(store.exists(ref: temporary.ref))
        XCTAssertTrue(store.exists(ref: permanent.ref))
        XCTAssertEqual(try store.storageInformation().retainedBytes, 4)
        XCTAssertEqual(try store.listDocuments().map(\.document.ref), [permanent.ref])
    }

    func testRenameDeleteClearAndStorageAccounting() throws {
        let first = try retain(Data(repeating: 1, count: 10), name: "first.pdf")
        let second = try retain(Data(repeating: 2, count: 7), name: "second.pdf")
        XCTAssertEqual(try store.storageInformation().retainedBytes, 17)

        let renamed = try store.rename(ref: first.ref, name: "renamed.pdf")
        XCTAssertEqual(renamed.name, "renamed.pdf")
        XCTAssertEqual(try store.stat(ref: first.ref).name, "renamed.pdf")

        try store.delete(ref: first.ref)
        XCTAssertFalse(store.exists(ref: first.ref))
        XCTAssertTrue(store.exists(ref: second.ref))

        try store.clear()
        XCTAssertFalse(store.exists(ref: second.ref))
        XCTAssertEqual(try store.storageInformation().retainedBytes, 0)
    }

    func testListingRetainsMissingMetadataAndMarksPendingDocuments() throws {
        let available = try retain(Data("available".utf8), name: "available.pdf")
        let pending = try retain(Data("pending".utf8), name: "pending.pdf")
        let missing = try retain(Data("missing".utf8), name: "missing.pdf")
        try store.enqueuePending(pending)
        try FileManager.default.removeItem(
            at: rootURL.appendingPathComponent("Documents/\(missing.ref).data")
        )

        let listed = try store.listDocuments()
        let byRef = Dictionary(uniqueKeysWithValues: listed.map { ($0.document.ref, $0) })
        XCTAssertEqual(byRef[available.ref], PdfChefListedDocument(document: available, available: true, pending: false))
        XCTAssertEqual(byRef[pending.ref], PdfChefListedDocument(document: pending, available: true, pending: true))
        XCTAssertEqual(byRef[missing.ref], PdfChefListedDocument(document: missing, available: false, pending: false))
    }

    func testPresentationCopiesPreserveSafeNameAndAreCleanupBounded() throws {
        let retained = try retain(Data("present".utf8), name: "original.pdf")
        let copy = try store.makePresentationCopy(ref: retained.ref, name: "export.pdf")
        XCTAssertEqual(copy.lastPathComponent, "export.pdf")
        XCTAssertEqual(try Data(contentsOf: copy), Data("present".utf8))
        XCTAssertTrue(copy.path.hasPrefix(rootURL.appendingPathComponent("Presentation").path + "/"))

        XCTAssertThrowsError(try store.makePresentationCopy(ref: retained.ref, name: "../escape.pdf"))
        XCTAssertThrowsError(try store.removePresentationCopy(at: rootURL.appendingPathComponent("outside.pdf")))
        try store.removePresentationCopy(at: copy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    }

    func testRelaunchCleansAbandonedPresentationCopiesOnly() throws {
        let retained = try retain(Data("present".utf8))
        let copy = try store.makePresentationCopy(ref: retained.ref, name: "share.pdf")
        XCTAssertTrue(FileManager.default.fileExists(atPath: copy.path))

        store = try PdfChefDocumentStore(rootURL: rootURL)

        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
        XCTAssertTrue(store.exists(ref: retained.ref))
    }

    func testPluginExportsEveryNativeAdapterMethod() {
        let names = Set(PdfChefDocumentsPlugin().pluginMethods.map(\.name))
        XCTAssertTrue([
            "listDocuments", "pickDocuments", "exportDocument", "shareDocument",
            "signalHaptic", "getApplicationMetadata", "takePendingImports",
            "acknowledgePendingImports"
        ].allSatisfy(names.contains))
    }

    func testPendingQueuePersistsIsTakenOnceAndFiltersMissingDocuments() throws {
        let present = try retain(Data("present".utf8), name: "present.pdf")
        let missing = try retain(Data("missing".utf8), name: "missing.pdf")
        try store.enqueuePending(present)
        try store.enqueuePending(missing)
        try FileManager.default.removeItem(
            at: rootURL.appendingPathComponent("Documents/\(missing.ref).data")
        )

        store = try PdfChefDocumentStore(rootURL: rootURL)
        XCTAssertEqual(try store.takePendingImports(), [PdfChefPendingImport(document: present)])
        XCTAssertEqual(try store.takePendingImports(), [PdfChefPendingImport(document: present)])
        try store.acknowledgePendingImports(refs: [present.ref])
        XCTAssertEqual(try store.takePendingImports(), [])
    }

    func testIncomingCopyCommitsBytesAndPersistentQueueBeforeDelivery() throws {
        let source = rootURL.appendingPathComponent("source.pdf")
        try Data("%PDF incoming".utf8).write(to: source)

        let document = try store.copyIn(
            url: source,
            name: "incoming.pdf",
            mimeType: "application/pdf",
            enqueuePending: true
        )
        store = try PdfChefDocumentStore(rootURL: rootURL)

        XCTAssertTrue(store.exists(ref: document.ref))
        XCTAssertEqual(try store.takePendingImports(), [PdfChefPendingImport(document: document)])
    }

    func testRecoveryCompletesIncomingJournalWrittenBeforePartRename() throws {
        let bytes = Data("%PDF crash boundary".utf8)
        let ref = "RECOVERY-\(UUID().uuidString)"
        let sessionID = UUID().uuidString
        let document = PdfChefStoredDocument(
            ref: ref,
            name: "recovered.pdf",
            mimeType: "application/pdf",
            sizeBytes: Int64(bytes.count),
            contentHash: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
            retainedAt: 42
        )
        let part = rootURL.appendingPathComponent("Writes/\(sessionID).part")
        try bytes.write(to: part)
        let journal: [String: Any] = [
            "kind": "incoming",
            "refs": [ref],
            "sessionID": sessionID,
            "document": [
                "ref": document.ref,
                "name": document.name!,
                "mimeType": document.mimeType!,
                "sizeBytes": document.sizeBytes,
                "contentHash": document.contentHash,
                "retainedAt": document.retainedAt
            ]
        ]
        try JSONSerialization.data(withJSONObject: journal)
            .write(to: rootURL.appendingPathComponent("mutation.json"), options: .atomic)

        store = try PdfChefDocumentStore(rootURL: rootURL)

        XCTAssertEqual(try store.stat(ref: ref), document)
        XCTAssertEqual(try store.takePendingImports(), [PdfChefPendingImport(document: document)])
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
    }

    func testBridgeOffsetsRejectNonFiniteFractionalAndOutOfRangeValuesBeforeConversion() throws {
        XCTAssertEqual(try PdfChefDocumentsPlugin.validatedOffset(nil), 0)
        XCTAssertEqual(try PdfChefDocumentsPlugin.validatedOffset(512), 512)
        XCTAssertThrowsError(try PdfChefDocumentsPlugin.validatedOffset(1.5))
        XCTAssertThrowsError(try PdfChefDocumentsPlugin.validatedOffset(.infinity))
        XCTAssertThrowsError(try PdfChefDocumentsPlugin.validatedOffset(.nan))
        XCTAssertThrowsError(try PdfChefDocumentsPlugin.validatedOffset(1e300))
    }

    func testColdInboxCommitsPendingImportBeforeReturning() throws {
        let source = rootURL.appendingPathComponent("cold.pdf")
        try Data("%PDF cold".utf8).write(to: source)
        let inbox = PdfChefDocumentInbox(storeProvider: { self.store })

        XCTAssertTrue(inbox.acceptSynchronously(url: source))
        XCTAssertEqual(try store.takePendingImports().count, 1)
    }

    func testWarmInboxSignalsOnlyAfterPendingImportIsDurable() throws {
        let source = rootURL.appendingPathComponent("warm.pdf")
        try Data("%PDF warm".utf8).write(to: source)
        let inbox = PdfChefDocumentInbox(storeProvider: { self.store })
        let ready = expectation(description: "pending import ready")
        let observer = NotificationCenter.default.addObserver(
            forName: .pdfChefPendingImportReady,
            object: nil,
            queue: .main
        ) { _ in
            ready.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        inbox.accept(url: source)
        wait(for: [ready], timeout: 3)

        XCTAssertEqual(try store.takePendingImports().count, 1)
    }

    func testRecoveryRemovesOnlyAbandonedTempsAndOrphanContent() throws {
        let committed = try retain(Data("committed".utf8))
        let writes = rootURL.appendingPathComponent("Writes", isDirectory: true)
        try Data("partial".utf8).write(to: writes.appendingPathComponent("abandoned.part"))
        try Data("keep".utf8).write(to: writes.appendingPathComponent("diagnostic.keep"))
        let documents = rootURL.appendingPathComponent("Documents", isDirectory: true)
        try Data("orphan".utf8).write(to: documents.appendingPathComponent("ORPHAN.data"))

        store = try PdfChefDocumentStore(rootURL: rootURL)

        XCTAssertTrue(store.exists(ref: committed.ref))
        XCTAssertFalse(FileManager.default.fileExists(atPath: writes.appendingPathComponent("abandoned.part").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: writes.appendingPathComponent("diagnostic.keep").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.appendingPathComponent("ORPHAN.data").path))
    }

    func testRecoveryCompletesJournalledDeleteAndRetainsMissingMetadata() throws {
        let deleting = try retain(Data("delete".utf8))
        let missing = try retain(Data("metadata stays".utf8))
        let missingContent = rootURL.appendingPathComponent("Documents/\(missing.ref).data")
        try FileManager.default.removeItem(at: missingContent)

        let journal = Data("{\"kind\":\"delete\",\"refs\":[\"\(deleting.ref)\"]}".utf8)
        try journal.write(to: rootURL.appendingPathComponent("mutation.json"), options: .atomic)
        store = try PdfChefDocumentStore(rootURL: rootURL)

        XCTAssertFalse(store.exists(ref: deleting.ref))
        XCTAssertFalse(store.exists(ref: missing.ref))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: rootURL.appendingPathComponent("Metadata/\(missing.ref).json").path
        ))
    }

    private func retain(_ data: Data, name: String = "document.pdf") throws -> PdfChefStoredDocument {
        let session = try store.beginWrite(name: name, mimeType: "application/pdf")
        try store.append(sessionID: session, data: data)
        return try store.finishWrite(sessionID: session)
    }
}
