import UIKit
import UniformTypeIdentifiers

enum PdfChefDocumentPresentationError: Error {
    case busy
    case presenterUnavailable
    case presentationFailed
}

/// Owns UIKit delegates and keeps protected presentation copies alive until UI completion.
final class PdfChefDocumentPresentation: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private enum PickerOperation {
        case importing((Result<[URL], Error>) -> Void)
        case exporting((Result<Bool, Error>) -> Void)
    }

    private var pickerOperation: PickerOperation?
    private var sharing = false
    private var reading = false

    func pick(
        from presenter: UIViewController,
        contentTypes: [UTType],
        maximumItems: Int,
        completion: @escaping (Result<[URL], Error>) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard canPresent(from: presenter) else {
            completion(.failure(currentPresentationError(from: presenter)))
            return
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: contentTypes, asCopy: true)
        picker.allowsMultipleSelection = maximumItems > 1
        picker.delegate = self
        picker.presentationController?.delegate = self
        pickerOperation = .importing(completion)
        presenter.present(picker, animated: true)
    }

    func export(
        copyURL: URL,
        from presenter: UIViewController,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard canPresent(from: presenter) else {
            completion(.failure(currentPresentationError(from: presenter)))
            return
        }
        let picker = UIDocumentPickerViewController(forExporting: [copyURL], asCopy: true)
        picker.delegate = self
        picker.presentationController?.delegate = self
        pickerOperation = .exporting(completion)
        presenter.present(picker, animated: true)
    }

    func share(
        copyURL: URL,
        from presenter: UIViewController,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard canPresent(from: presenter) else {
            completion(.failure(currentPresentationError(from: presenter)))
            return
        }
        sharing = true
        // Share the file itself. The copy always ends in ".pdf" for PDFs, so receivers
        // such as WhatsApp get a PDF, and the sheet header shows its name, type and preview.
        let controller = UIActivityViewController(activityItems: [copyURL], applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(
                x: presenter.view.bounds.midX,
                y: presenter.view.bounds.midY,
                width: 1,
                height: 1
            )
            popover.permittedArrowDirections = []
        }
        controller.completionWithItemsHandler = { [weak self] _, completed, _, error in
            guard let self else { return }
            self.sharing = false
            if error != nil {
                completion(.failure(PdfChefDocumentPresentationError.presentationFailed))
            } else {
                completion(.success(completed))
            }
        }
        presenter.present(controller, animated: true)
    }

    func presentSignatureReport(
        documentURL: URL,
        displayName: String,
        from presenter: UIViewController,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard canPresent(from: presenter) else {
            completion(.failure(currentPresentationError(from: presenter)))
            return
        }
        let report = PdfChefSignatureReportViewController(
            documentURL: documentURL,
            displayName: displayName,
            onFinished: { completion(.success(true)) }
        )
        let navigation = UINavigationController(rootViewController: report)
        navigation.modalPresentationStyle = .pageSheet
        navigation.isModalInPresentation = true
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.selectedDetentIdentifier = .large
        }
        presenter.present(navigation, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func presentReader(
        documentURL: URL,
        displayName: String,
        documentSizeBytes: Int64,
        from presenter: UIViewController,
        share: @escaping (UIViewController) -> Void,
        canVerifySignatures: Bool,
        verifySignatures: @escaping (UIViewController) -> Void,
        prepareLargeDocument: @escaping (
            PdfChefPdfBatchCancellationToken,
            @escaping (PdfChefPdfBatchProgress) -> Void,
            @escaping (Result<Int, Error>) -> Void
        ) -> Void,
        completion: @escaping (Result<PdfChefReaderResult, Error>) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !reading, canPresent(from: presenter) else {
            completion(.failure(currentPresentationError(from: presenter)))
            return
        }
        reading = true
        let reader = PdfChefReaderViewController(
            documentURL: documentURL,
            displayName: displayName,
            documentSizeBytes: documentSizeBytes,
            shareDocument: share,
            canVerifySignatures: canVerifySignatures,
            verifySignatures: verifySignatures,
            prepareLargeDocument: prepareLargeDocument,
            onFinished: { [weak self] result in
                self?.reading = false
                completion(.success(result))
            }
        )
        let navigation = UINavigationController(rootViewController: reader)
        navigation.modalPresentationStyle = .fullScreen
        navigation.isModalInPresentation = true
        presenter.present(navigation, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishPicker(urls: urls, completed: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishPicker(urls: [], completed: false)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finishPicker(urls: [], completed: false)
    }

    private func canPresent(from presenter: UIViewController) -> Bool {
        pickerOperation == nil && !sharing && presenter.viewIfLoaded?.window != nil && presenter.presentedViewController == nil
    }

    private func currentPresentationError(from presenter: UIViewController) -> Error {
        if pickerOperation != nil || sharing || reading || presenter.presentedViewController != nil {
            return PdfChefDocumentPresentationError.busy
        }
        return PdfChefDocumentPresentationError.presenterUnavailable
    }

    private func finishPicker(urls: [URL], completed: Bool) {
        guard let operation = pickerOperation else { return }
        pickerOperation = nil
        switch operation {
        case .importing(let callback):
            callback(.success(completed ? urls : []))
        case .exporting(let callback):
            callback(.success(completed))
        }
    }
}
