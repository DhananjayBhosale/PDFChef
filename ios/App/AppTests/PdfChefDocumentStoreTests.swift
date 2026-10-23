import CryptoKit
import Foundation
import UniformTypeIdentifiers
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
        XCTAssertThrowsError(try store.rename(ref: first.ref, name: "../bad.pdf"))
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
        // The share sheet types a file by its extension.
        XCTAssertEqual(UTType(filenameExtension: copy.pathExtension), .pdf)

        let renamedCopy = try store.makePresentationCopy(ref: retained.ref, name: "renamed.bin")
        XCTAssertEqual(renamedCopy.lastPathComponent, "renamed.bin.pdf")
        XCTAssertEqual(try Data(contentsOf: renamedCopy), Data("present".utf8))

        XCTAssertThrowsError(try store.makePresentationCopy(ref: retained.ref, name: "../escape.pdf"))
        XCTAssertThrowsError(try store.removePresentationCopy(at: rootURL.appendingPathComponent("outside.pdf")))
        try store.removePresentationCopy(at: copy)
        try store.removePresentationCopy(at: renamedCopy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    }

    func testPresentationCopyOfUntypedPdfStillSharesAsPdf() throws {
        let session = try store.beginWrite(name: "Invoice 14.10.2026", mimeType: "application/octet-stream")
        try store.append(sessionID: session, data: Data("%PDF-1.7\n%untyped".utf8))
        let retained = try store.finishWrite(sessionID: session)

        let copy = try store.makePresentationCopy(ref: retained.ref, name: nil)
        XCTAssertEqual(copy.lastPathComponent, "Invoice 14.10.2026.pdf")
        XCTAssertEqual(UTType(filenameExtension: copy.pathExtension), .pdf)
        try store.removePresentationCopy(at: copy)

        let other = try store.beginWrite(name: "notes", mimeType: nil)
        try store.append(sessionID: other, data: Data("plain text".utf8))
        let text = try store.finishWrite(sessionID: other)
        let textCopy = try store.makePresentationCopy(ref: text.ref, name: nil)
        XCTAssertEqual(textCopy.lastPathComponent, "notes")
        try store.removePresentationCopy(at: textCopy)
    }

    func testPresentationCopyShortensNamesTooLongForTheFileSystem() throws {
        // iOS file names hold at most 255 characters; Recent rename has no length limit.
        let longName = String(repeating: "Quarterly report ", count: 20) + ".pdf"
        XCTAssertGreaterThan(longName.utf16.count, 255)
        let retained = try retain(Data("%PDF-1.7 long".utf8), name: longName)

        let copy = try store.makePresentationCopy(ref: retained.ref, name: nil)
        XCTAssertLessThanOrEqual(copy.lastPathComponent.utf16.count, 255)
        XCTAssertTrue(copy.lastPathComponent.hasSuffix(".pdf"))
        XCTAssertTrue(longName.hasPrefix(String(copy.lastPathComponent.dropLast(4))))
        XCTAssertEqual(try Data(contentsOf: copy), Data("%PDF-1.7 long".utf8))
        try store.removePresentationCopy(at: copy)
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
            "acknowledgePendingImports", "documentScannerAvailable", "scanDocument", "setLanguage"
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

    func testInboxRemovesOnlyTheOwnedOpenInCopyAfterDurableImport() throws {
        let inboxDirectory = rootURL.appendingPathComponent("AppDocuments/Inbox", isDirectory: true)
        try FileManager.default.createDirectory(at: inboxDirectory, withIntermediateDirectories: true)
        let ownedSource = inboxDirectory.appendingPathComponent("owned.pdf")
        let providerSource = rootURL.appendingPathComponent("provider.pdf")
        try Data("%PDF owned".utf8).write(to: ownedSource)
        try Data("%PDF provider".utf8).write(to: providerSource)
        let inbox = PdfChefDocumentInbox(
            storeProvider: { self.store },
            inboxDirectoryProvider: { inboxDirectory }
        )

        XCTAssertTrue(inbox.acceptSynchronously(url: ownedSource))
        XCTAssertFalse(FileManager.default.fileExists(atPath: ownedSource.path))
        XCTAssertTrue(inbox.acceptSynchronously(url: providerSource))
        XCTAssertTrue(FileManager.default.fileExists(atPath: providerSource.path))
        XCTAssertEqual(try store.takePendingImports().count, 2)
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

    func testSameFileOpenedTwiceIsKeptOnceAndQueuedAgain() throws {
        let first = rootURL.appendingPathComponent("report.pdf")
        let again = rootURL.appendingPathComponent("report copy.pdf")
        try Data("%PDF same bytes".utf8).write(to: first)
        try Data("%PDF same bytes".utf8).write(to: again)
        let inbox = PdfChefDocumentInbox(storeProvider: { self.store })

        XCTAssertTrue(inbox.acceptSynchronously(url: first))
        let kept = try XCTUnwrap(store.takePendingImports().first?.document)
        try store.acknowledgePendingImports(refs: [kept.ref])
        XCTAssertTrue(inbox.acceptSynchronously(url: again))

        XCTAssertEqual(try store.takePendingImports().map(\.document.ref), [kept.ref])
        XCTAssertEqual(try store.listDocuments().map(\.document.ref), [kept.ref])
    }

    func testInboxSaysWhyAFileThatIsNotAPdfDidNotOpen() throws {
        let source = rootURL.appendingPathComponent("notes.txt")
        try Data("plain text".utf8).write(to: source)
        let inbox = PdfChefDocumentInbox(storeProvider: { self.store })
        let reported = expectation(description: "failure reported")
        inbox.failureHandler = { failure in
            XCTAssertEqual(failure, .notPDF)
            reported.fulfill()
        }

        XCTAssertFalse(inbox.acceptSynchronously(url: source))
        wait(for: [reported], timeout: 3)
        XCTAssertTrue(try store.takePendingImports().isEmpty)
    }

    func testKeptCopyIgnoresTheDocumentItselfAndTransientCopies() throws {
        let original = try retain(Data("%PDF kept".utf8))
        let session = try store.beginWrite(name: "preview.pdf", mimeType: "application/pdf", transient: true)
        try store.append(sessionID: session, data: Data("%PDF kept".utf8))
        let preview = try store.finishWrite(sessionID: session)
        XCTAssertNil(try store.keptCopy(of: original))

        let duplicate = try retain(Data("%PDF kept".utf8))
        XCTAssertEqual(try store.keptCopy(of: duplicate), original)
        XCTAssertEqual(try store.keptCopy(of: preview), original)
        XCTAssertNil(try store.keptCopy(of: retain(Data("%PDF different".utf8))))
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
