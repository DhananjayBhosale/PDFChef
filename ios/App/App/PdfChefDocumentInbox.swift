import Foundation
import UniformTypeIdentifiers

extension Notification.Name {
    static let pdfChefPendingImportReady = Notification.Name("PdfChefPendingImportReady")
}

/// Handles Open In before the provider URL can disappear, then queues only an opaque ref.
final class PdfChefDocumentInbox {
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
        var committed = false
        coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { coordinatedURL in
            do {
                let type = UTType(filenameExtension: coordinatedURL.pathExtension)
                guard type?.conforms(to: .pdf) == true else { return }
                _ = try storeProvider().copyIn(
                    url: coordinatedURL,
                    name: coordinatedURL.lastPathComponent,
                    mimeType: type?.preferredMIMEType,
                    enqueuePending: true
                )
                committed = true
            } catch {
                operationError = error
            }
        }
        if coordinationError != nil || operationError != nil {
            // Never log provider URLs, filenames, bookmarks, or other document metadata.
            NSLog("PDF Chef could not retain an incoming document.")
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
