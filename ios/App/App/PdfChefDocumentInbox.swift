import Foundation
import UniformTypeIdentifiers

extension Notification.Name {
    static let pdfChefPendingImportReady = Notification.Name("PdfChefPendingImportReady")
}

/// Handles Open In before the provider URL can disappear, then queues only an opaque ref.
final class PdfChefDocumentInbox {
    /// Why a file from another app did not open.
    enum Failure: Equatable {
        case notPDF
        case notKept

        var message: String {
            switch self {
            case .notPDF: return localized("PDF Chef opens PDF files only.")
            case .notKept: return localized("This file could not be opened. Please try again.")
            }
        }
    }

    /// Called on the main queue, so the scene can say why a file did not open.
    var failureHandler: ((Failure) -> Void)?
    private let workQueue = DispatchQueue(label: "com.dhananjaytech.pdfchef.document-inbox", qos: .userInitiated)
    private let storeProvider: () throws -> PdfChefDocumentStore
    private let inboxDirectoryProvider: () -> URL?

    init(storeProvider: @escaping () throws -> PdfChefDocumentStore = {
        try PdfChefDocumentStore.sharedResult.get()
    }, inboxDirectoryProvider: @escaping () -> URL? = {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("Inbox", isDirectory: true)
    }) {
        self.storeProvider = storeProvider
        self.inboxDirectoryProvider = inboxDirectoryProvider
    }

    func accept(url: URL) {
        guard url.isFileURL else { return }
        workQueue.async {
            if self.retain(url: url) {
                // Warm imports are signalled only after their durable queue commit.
                NotificationCenter.default.post(name: .pdfChefPendingImportReady, object: nil)
            }
        }
    }

    /// Cold-start imports use this before the bridge is created, guaranteeing that
    /// the first JavaScript pending-import read sees the committed queue entry.
    @discardableResult
    func acceptSynchronously(url: URL) -> Bool {
        guard url.isFileURL else { return false }
        return retain(url: url)
    }

    private func retain(url: URL) -> Bool {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var operationError: Error?
        var notPDF = false
        var committed = false
        coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { coordinatedURL in
            do {
                let type = UTType(filenameExtension: coordinatedURL.pathExtension)
                guard type?.conforms(to: .pdf) == true else {
                    notPDF = true
                    return
                }
                let store = try storeProvider()
                let kept = try store.copyIn(
                    url: coordinatedURL,
                    name: coordinatedURL.lastPathComponent,
                    mimeType: type?.preferredMIMEType,
                    enqueuePending: true
                )
                // The same file opened again reopens the copy already kept. It is queued before
                // the new copy goes, so a crash in between keeps both rather than neither.
                if let earlier = try store.keptCopy(of: kept) {
                    try store.enqueuePending(earlier)
                    try store.delete(ref: kept.ref)
                }
                committed = true
            } catch {
                operationError = error
            }
        }
        if coordinationError != nil || operationError != nil {
            // Never log provider URLs, filenames, bookmarks, or other document metadata.
            NSLog("PDF Chef could not retain an incoming document.")
        }
        if !committed {
            let failure: Failure = notPDF ? .notPDF : .notKept
            DispatchQueue.main.async { self.failureHandler?(failure) }
        }
        if committed {
            removeOwnedInboxSourceIfNeeded(url)
        }
        return committed
    }

    /// When iOS gives an app a copied Open-In document, that handoff lives in
    /// Documents/Inbox. The durable store now owns the bytes, so discard only
    /// that app-container copy. Provider files and all other URLs remain owned
    /// by their source and must never be removed here.
    private func removeOwnedInboxSourceIfNeeded(_ url: URL) {
        guard let inboxDirectory = inboxDirectoryProvider() else { return }
        let ownedRoot = inboxDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = url.standardizedFileURL.resolvingSymlinksInPath()
        guard candidate.path.hasPrefix(ownedRoot.path + "/") else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
