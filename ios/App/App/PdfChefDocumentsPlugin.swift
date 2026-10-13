import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

@objc(PdfChefDocumentsPlugin)
final class PdfChefDocumentsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PdfChefDocumentsPlugin"
    let jsName = "PdfChefDocuments"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "beginWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abortWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDocuments", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storageInformation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePendingImports", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgePendingImports", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickDocuments", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signatureVerificationAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentSignatureReport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openReader", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signalHaptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getApplicationMetadata", returnType: CAPPluginReturnPromise)
    ]

    private let workQueue = DispatchQueue(label: "com.dhananjaytech.pdfchef.documents-plugin", qos: .userInitiated)
    private let batchQueue = DispatchQueue(label: "com.dhananjaytech.pdfchef.pdf-batching", qos: .userInitiated)
    private let presentation = PdfChefDocumentPresentation()
    private static let pickerMimeTypes: Set<String> = [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/heic",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ]
    private var pendingImportObserver: NSObjectProtocol?

    @objc override func load() {
        pendingImportObserver = NotificationCenter.default.addObserver(
            forName: .pdfChefPendingImportReady,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.notifyListeners("pendingImportReady", data: ["available": true])
        }
    }

    deinit {
        if let pendingImportObserver {
            NotificationCenter.default.removeObserver(pendingImportObserver)
        }
    }

    @objc func beginWrite(_ call: CAPPluginCall) {
        perform(call) { store in
            let sessionID = try store.beginWrite(
                name: call.getString("name"),
                mimeType: call.getString("mimeType"),
                transient: call.getBool("transient", false)
            )
            call.resolve(["sessionId": sessionID, "maximumChunkBytes": PdfChefDocumentStore.maximumChunkBytes])
        }
    }

    @objc func appendWrite(_ call: CAPPluginCall) {
        perform(call) { store in
            let sessionID = try Self.requiredString("sessionId", from: call)
            let encoded = try Self.requiredString("data", from: call)
            let maximumEncodedLength = ((PdfChefDocumentStore.maximumChunkBytes + 2) / 3) * 4
            guard encoded.utf8.count <= maximumEncodedLength else {
                throw PluginInputError(message: "data exceeds the bounded chunk limit")
            }
            guard let data = Data(base64Encoded: encoded) else {
                throw PluginInputError(message: "data must be valid base64 for one bounded chunk")
            }
            try store.append(sessionID: sessionID, data: data)
            call.resolve(["acceptedBytes": data.count])
        }
    }

    @objc func finishWrite(_ call: CAPPluginCall) {
        perform(call) { store in
            let document = try store.finishWrite(sessionID: Self.requiredString("sessionId", from: call))
            call.resolve(Self.documentObject(document))
        }
    }

    @objc func abortWrite(_ call: CAPPluginCall) {
        perform(call) { store in
            try store.abortWrite(sessionID: Self.requiredString("sessionId", from: call))
            call.resolve()
        }
    }

    @objc func readChunk(_ call: CAPPluginCall) {
        perform(call) { store in
            let ref = try Self.requiredString("ref", from: call)
            let offset = try Self.validatedOffset(call.getDouble("offset"))
            let length = call.getInt("length", PdfChefDocumentStore.maximumChunkBytes)
            let chunk = try store.readChunk(ref: ref, offset: offset, length: length)
            call.resolve([
                "data": chunk.data.base64EncodedString(),
                "nextOffset": chunk.nextOffset,
                "done": chunk.done
            ])
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        perform(call) { store in
            call.resolve(Self.documentObject(try store.stat(ref: Self.requiredString("ref", from: call))))
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        perform(call) { store in
            let ref = try Self.requiredString("ref", from: call)
            call.resolve(["exists": store.exists(ref: ref)])
        }
    }

    @objc func listDocuments(_ call: CAPPluginCall) {
        perform(call) { store in
            let documents = try store.listDocuments().map { value in
                [
                    "document": Self.documentObject(value.document),
                    "available": value.available,
                    "pending": value.pending
                ] as [String: Any]
            }
            call.resolve(["documents": documents])
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        perform(call) { store in
            let document = try store.rename(
                ref: Self.requiredString("ref", from: call),
                name: Self.requiredString("name", from: call)
            )
            call.resolve(Self.documentObject(document))
        }
    }

    @objc func delete(_ call: CAPPluginCall) {
        perform(call) { store in
            try store.delete(ref: Self.requiredString("ref", from: call))
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        perform(call) { store in
            try store.clear()
            call.resolve()
        }
    }

    @objc func storageInformation(_ call: CAPPluginCall) {
        perform(call) { store in
            let value = try store.storageInformation()
            var result: [String: Any] = ["retainedBytes": value.retainedBytes]
            if let available = value.availableBytes { result["availableBytes"] = available }
            if let capacity = value.capacityBytes { result["capacityBytes"] = capacity }
            call.resolve(result)
        }
    }

    @objc func takePendingImports(_ call: CAPPluginCall) {
        perform(call) { store in
            let imports = try store.takePendingImports().map { ["document": Self.documentObject($0.document)] }
            call.resolve(["imports": imports])
        }
    }

    @objc func acknowledgePendingImports(_ call: CAPPluginCall) {
        perform(call) { store in
            guard let refs = call.getArray("refs", String.self) else {
                throw PluginInputError(message: "refs must be an array of opaque references")
            }
            try store.acknowledgePendingImports(refs: refs)
            call.resolve()
        }
    }

    @objc func pickDocuments(_ call: CAPPluginCall) {
        do {
            guard let mimeTypes = call.getArray("acceptedMimeTypes", String.self), !mimeTypes.isEmpty else {
                throw PluginInputError(message: "acceptedMimeTypes must be a non-empty array")
            }
            guard let maximumItems = call.getInt("maximumItems"),
                  (1...100).contains(maximumItems) else {
                throw PluginInputError(message: "maximumItems must be an integer from 1 through 100")
            }
            let contentTypes = try mimeTypes.map { value -> UTType in
                guard Self.pickerMimeTypes.contains(value), let type = UTType(mimeType: value) else {
                    throw PluginInputError(message: "acceptedMimeTypes contains an invalid MIME type")
                }
                return type
            }
            guard let presenter = bridge?.viewController else {
                reject(call, error: PdfChefDocumentPresentationError.presenterUnavailable)
                return
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.presentation.pick(
                    from: presenter,
                    contentTypes: contentTypes,
                    maximumItems: maximumItems
                ) { result in
                    switch result {
                    case .failure(let error):
                        self.reject(call, error: error)
                    case .success(let urls):
                        guard urls.count <= maximumItems else {
                            self.reject(
                                call,
                                error: PluginInputError(message: "The picker returned too many documents")
                            )
                            return
                        }
                        self.copyPickedDocuments(urls, acceptedTypes: contentTypes, call: call)
                    }
                }
            }
        } catch {
            reject(call, error: error)
        }
    }

    @objc func exportDocument(_ call: CAPPluginCall) {
        presentDocument(call, share: false)
    }

    @objc func shareDocument(_ call: CAPPluginCall) {
        presentDocument(call, share: true)
    }

    @objc func signatureVerificationAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": PdfChefSignatureVerifier.isAvailable])
    }

    @objc func presentSignatureReport(_ call: CAPPluginCall) {
        workQueue.async {
            do {
                guard PdfChefSignatureVerifier.isAvailable else {
                    call.reject("Signature verification is unavailable.", "SIGNATURE_VERIFICATION_UNAVAILABLE")
                    return
                }
                let store = try PdfChefDocumentStore.sharedResult.get()
                let ref = try Self.requiredString("ref", from: call)
                let document = try store.stat(ref: ref)
                let isPDF = document.mimeType?.caseInsensitiveCompare("application/pdf") == .orderedSame
                    || document.name?.lowercased().hasSuffix(".pdf") == true
                guard isPDF else { throw PluginInputError(message: "ref must identify a PDF") }
                guard document.sizeBytes > 0,
                      document.sizeBytes <= PdfChefSignatureVerifier.maximumFileSizeBytes else {
                    throw PluginInputError(message: "ref identifies a PDF that is too large to verify")
                }
                let documentURL = try store.readerURL(ref: ref)
                let displayName = try Self.readerDisplayName(
                    call.getString("name") ?? document.name ?? "Document.pdf"
                )
                DispatchQueue.main.async {
                    guard let presenter = self.bridge?.viewController else {
                        self.reject(call, error: PdfChefDocumentPresentationError.presenterUnavailable)
                        return
                    }
                    self.presentation.presentSignatureReport(
                        documentURL: documentURL,
                        displayName: displayName,
                        from: presenter
                    ) { result in
                        switch result {
                        case .success(let completed): call.resolve(["completed": completed])
                        case .failure(let error): self.reject(call, error: error)
                        }
                    }
                }
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    @objc func openReader(_ call: CAPPluginCall) {
        workQueue.async { [self] in
            do {
                let store = try PdfChefDocumentStore.sharedResult.get()
                let ref = try Self.requiredString("ref", from: call)
                let document = try store.stat(ref: ref)
                let isPDF = document.mimeType?.caseInsensitiveCompare("application/pdf") == .orderedSame
                    || document.name?.lowercased().hasSuffix(".pdf") == true
                guard isPDF else { throw PluginInputError(message: "ref must identify a PDF") }
                let displayName = try Self.readerDisplayName(
                    call.getString("displayName") ?? document.name ?? "Document.pdf"
                )
                let documentURL = try store.readerURL(ref: ref)
                DispatchQueue.main.async {
                    guard let presenter = self.bridge?.viewController else {
                        self.reject(call, error: PdfChefDocumentPresentationError.presenterUnavailable)
                        return
                    }
                    self.presentation.presentReader(
                        documentURL: documentURL,
                        displayName: displayName,
                        documentSizeBytes: document.sizeBytes,
                        from: presenter,
                        share: { [weak self] reader in
                            self?.shareReaderDocument(
                                ref: ref,
                                displayName: displayName,
                                from: reader
                            )
                        },
                        canVerifySignatures: PdfChefSignatureVerifier.isAvailable,
                        verifySignatures: { [weak self] reader in
                            self?.presentation.presentSignatureReport(
                                documentURL: documentURL,
                                displayName: displayName,
                                from: reader,
                                completion: { _ in }
                            )
                        },
                        prepareLargeDocument: { [weak self] cancellation, progress, completion in
                            guard let self else {
                                completion(.failure(PdfChefDocumentPresentationError.presentationFailed))
                                return
                            }
                            self.prepareGeneratedParts(
                                for: ref,
                                documentURL: documentURL,
                                displayName: displayName,
                                store: store,
                                cancellation: cancellation,
                                progress: progress,
                                completion: completion
                            )
                        }
                    ) { result in
                        switch result {
                        case .failure(let error):
                            self.reject(call, error: error)
                        case .success(.closed):
                            call.resolve(["action": "closed"])
                        case .success(.tool(let toolPath)):
                            call.resolve(["action": "tool", "toolPath": toolPath])
                        case .success(.batched(let partCount)):
                            call.resolve(["action": "batched", "partCount": partCount])
                        }
                    }
                }
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    private func prepareGeneratedParts(
        for ref: String,
        documentURL: URL,
        displayName: String,
        store: PdfChefDocumentStore,
        cancellation: PdfChefPdfBatchCancellationToken,
        progress: @escaping (PdfChefPdfBatchProgress) -> Void,
        completion: @escaping (Result<Int, Error>) -> Void
    ) {
        Task { @MainActor [self] in
            guard let purchases = bridge?.plugin(withName: "PdfChefPurchases") as? PdfChefPurchasesPlugin else {
                completion(.failure(PdfChefDocumentPresentationError.presentationFailed))
                return
            }
            let authorization = await purchases.reserveGeneratedJob(operationID: "split:\(ref)")
            guard case .allowed(let reservation) = authorization else {
                completion(.failure(PdfChefPdfBatcherError.freeJobsExhausted))
                return
            }
            let finishReservation: @MainActor @Sendable (Bool) -> Void = { succeeded in
                purchases.finishGeneratedJob(reservation: reservation, succeeded: succeeded)
            }
            batchQueue.async {
                let result: Result<Int, Error> = Result {
                    let parts = try PdfChefPdfBatcher().split(
                        documentURL: documentURL,
                        baseName: displayName,
                        store: store,
                        cancellation: cancellation,
                        progress: progress
                    )
                    if cancellation.isCancelled {
                        for part in parts { try? store.delete(ref: part.ref) }
                        throw PdfChefPdfBatcherError.cancelled
                    }
                    return parts.count
                }
                Task { @MainActor in
                    let succeeded: Bool
                    if case .success = result { succeeded = true } else { succeeded = false }
                    finishReservation(succeeded)
                    completion(result)
                }
            }
        }
    }

    @objc func signalHaptic(_ call: CAPPluginCall) {
        do {
            let signal = try Self.requiredString("signal", from: call)
            guard ["selection", "commit", "warning", "error"].contains(signal) else {
                throw PluginInputError(message: "signal is not supported")
            }
            DispatchQueue.main.async {
                switch signal {
                case "selection":
                    UISelectionFeedbackGenerator().selectionChanged()
                case "commit":
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                case "warning":
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                default:
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
                call.resolve()
            }
        } catch {
            reject(call, error: error)
        }
    }

    @objc func getApplicationMetadata(_ call: CAPPluginCall) {
        let info = Bundle.main.infoDictionary ?? [:]
        let name = (info["CFBundleDisplayName"] as? String)
            ?? (info["CFBundleName"] as? String)
            ?? "PDF Chef"
        let version = (info["CFBundleShortVersionString"] as? String) ?? "0"
        var result: [String: Any] = ["name": name, "version": version]
        if let build = info["CFBundleVersion"] as? String { result["build"] = build }
        call.resolve(result)
    }

    private func copyPickedDocuments(_ urls: [URL], acceptedTypes: [UTType], call: CAPPluginCall) {
        guard !urls.isEmpty else {
            call.resolve(["imports": []])
            return
        }
        let scoped = urls.map { ($0, $0.startAccessingSecurityScopedResource()) }
        workQueue.async {
            defer {
                for (url, accessed) in scoped where accessed { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let store = try PdfChefDocumentStore.sharedResult.get()
                var documents: [PdfChefStoredDocument] = []
                do {
                    for (url, _) in scoped {
                        documents.append(try Self.copyCoordinated(url: url, acceptedTypes: acceptedTypes, into: store))
                    }
                } catch {
                    for document in documents { try? store.delete(ref: document.ref) }
                    throw error
                }
                call.resolve(["imports": documents.map { ["document": Self.documentObject($0)] }])
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    private func shareReaderDocument(ref: String, displayName: String, from presenter: UIViewController) {
        workQueue.async {
            do {
                let store = try PdfChefDocumentStore.sharedResult.get()
                let copyURL = try store.makePresentationCopy(ref: ref, name: displayName)
                DispatchQueue.main.async {
                    self.presentation.share(copyURL: copyURL, from: presenter) { result in
                        self.workQueue.async {
                            try? store.removePresentationCopy(at: copyURL)
                            if case .failure = result {
                                DispatchQueue.main.async {
                                    let alert = UIAlertController(
                                        title: "Couldn’t share PDF",
                                        message: "Please try again.",
                                        preferredStyle: .alert
                                    )
                                    alert.addAction(UIAlertAction(title: "OK", style: .default))
                                    presenter.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
                                }
                            }
                        }
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    let alert = UIAlertController(
                        title: "Couldn’t share PDF",
                        message: "Please try again.",
                        preferredStyle: .alert
                    )
                    alert.addAction(UIAlertAction(title: "OK", style: .default))
                    presenter.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
                }
            }
        }
    }

    private static func copyCoordinated(
        url: URL,
        acceptedTypes: [UTType],
        into store: PdfChefDocumentStore
    ) throws -> PdfChefStoredDocument {
        let values = try? url.resourceValues(forKeys: [.contentTypeKey])
        let contentType = values?.contentType ?? UTType(filenameExtension: url.pathExtension)
        guard let contentType, acceptedTypes.contains(where: { contentType.conforms(to: $0) }) else {
            throw PluginInputError(message: "The selected document type is not accepted")
        }
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var copied: Result<PdfChefStoredDocument, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinatedURL in
            copied = Result {
                try store.copyIn(
                    url: coordinatedURL,
                    name: url.lastPathComponent,
                    mimeType: contentType.preferredMIMEType,
                    enqueuePending: false
                )
            }
        }
        if coordinationError != nil { throw PdfChefDocumentPresentationError.presentationFailed }
        guard let copied else { throw PdfChefDocumentPresentationError.presentationFailed }
        return try copied.get()
    }

    private func presentDocument(_ call: CAPPluginCall, share: Bool) {
        workQueue.async {
            do {
                let store = try PdfChefDocumentStore.sharedResult.get()
                let ref = try Self.requiredString("ref", from: call)
                let copyURL = try store.makePresentationCopy(ref: ref, name: call.getString("name"))
                DispatchQueue.main.async {
                    guard let presenter = self.bridge?.viewController else {
                        self.workQueue.async { try? store.removePresentationCopy(at: copyURL) }
                        self.reject(call, error: PdfChefDocumentPresentationError.presenterUnavailable)
                        return
                    }
                    let completion: (Result<Bool, Error>) -> Void = { result in
                        self.workQueue.async {
                            do {
                                try store.removePresentationCopy(at: copyURL)
                                switch result {
                                case .success(let completed): call.resolve(["completed": completed])
                                case .failure(let error): self.reject(call, error: error)
                                }
                            } catch {
                                self.reject(call, error: error)
                            }
                        }
                    }
                    if share {
                        self.presentation.share(copyURL: copyURL, from: presenter, completion: completion)
                    } else {
                        self.presentation.export(copyURL: copyURL, from: presenter, completion: completion)
                    }
                }
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping (PdfChefDocumentStore) throws -> Void) {
        workQueue.async {
            do {
                let store = try PdfChefDocumentStore.sharedResult.get()
                try operation(store)
            } catch is PluginInputError {
                call.reject("Invalid argument.", "INVALID_ARGUMENT")
            } catch let error as PdfChefDocumentStoreError {
                let rejection = Self.rejection(for: error)
                call.reject(rejection.message, rejection.code)
            } catch {
                // Cocoa errors can embed sandbox or provider paths. Never bridge them to JavaScript.
                call.reject("The document operation could not be completed.", "DOCUMENT_IO_FAILED")
            }
        }
    }

    private static func rejection(for error: PdfChefDocumentStoreError) -> (message: String, code: String) {
        switch error {
        case .invalidReference:
            return ("The document reference is invalid.", "INVALID_REFERENCE")
        case .invalidSession:
            return ("The write session is invalid or expired.", "INVALID_SESSION")
        case .chunkTooLarge:
            return ("The document chunk exceeds the allowed limit.", "CHUNK_TOO_LARGE")
        case .invalidOffset:
            return ("The document read offset is invalid.", "INVALID_OFFSET")
        case .documentMissing:
            return ("The retained document is unavailable.", "DOCUMENT_NOT_FOUND")
        case .invalidPresentationName:
            return ("The presentation filename is invalid.", "INVALID_ARGUMENT")
        }
    }

    private func reject(_ call: CAPPluginCall, error: Error) {
        if let input = error as? PluginInputError {
            _ = input
            call.reject("Invalid argument.", "INVALID_ARGUMENT")
        } else if let storeError = error as? PdfChefDocumentStoreError {
            let rejection = Self.rejection(for: storeError)
            call.reject(rejection.message, rejection.code)
        } else if let presentationError = error as? PdfChefDocumentPresentationError {
            switch presentationError {
            case .busy:
                call.reject("Operation unavailable.", "PRESENTATION_BUSY")
            case .presenterUnavailable:
                call.reject("Operation unavailable.", "PRESENTATION_UNAVAILABLE")
            case .presentationFailed:
                call.reject("Operation failed.", "PRESENTATION_FAILED")
            }
        } else {
            call.reject("The document operation could not be completed.", "DOCUMENT_IO_FAILED")
        }
    }

    private static func requiredString(_ key: String, from call: CAPPluginCall) throws -> String {
        guard let value = call.getString(key), !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PluginInputError(message: "\(key) is required")
        }
        return value
    }

    private static func readerDisplayName(_ value: String) throws -> String {
        guard !value.isEmpty,
              value.count <= 180,
              value.utf8.count <= 720,
              value != ".",
              value != "..",
              !value.contains("/"),
              !value.contains("\\"),
              !value.contains("\0") else {
            throw PluginInputError(message: "displayName is invalid")
        }
        return value
    }

    static func validatedOffset(_ value: Double?) throws -> Int64 {
        let candidate = value ?? 0
        // Convert only after excluding NaN/infinity, fractions, and values whose
        // Double representation falls outside Int64's half-open safe range.
        guard candidate.isFinite,
              candidate.rounded(.towardZero) == candidate,
              candidate >= -9_223_372_036_854_775_808.0,
              candidate < 9_223_372_036_854_775_808.0 else {
            throw PluginInputError(message: "offset must be a finite 64-bit integer")
        }
        return Int64(candidate)
    }

    private static func documentObject(_ document: PdfChefStoredDocument) -> [String: Any] {
        var result: [String: Any] = [
            "ref": document.ref,
            "sizeBytes": document.sizeBytes,
            "contentHash": document.contentHash,
            "retainedAt": document.retainedAt
        ]
        if let name = document.name { result["name"] = name }
        if let mimeType = document.mimeType { result["mimeType"] = mimeType }
        return result
    }

    private struct PluginInputError: Error {
        let message: String
    }
}
