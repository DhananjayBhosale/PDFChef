import PDFKit
import UIKit

final class PdfChefSignatureReportViewController: UIViewController {
    private let documentURL: URL
    private let displayName: String
    private let verifier: PdfChefSignatureVerifier
    private let onFinished: () -> Void

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private var verificationFinished = false
    private var verificationStarted = false
    private var closeRequested = false
    private var dismissalFinished = false
    private var finishReported = false
    /// Held only while this sheet is open, so a verified copy can keep the original's password.
    private var verifiedPassword: String?
    private var verifiedAt = Date()
    private var copyInProgress = false
    private lazy var printCopyButton = verifiedCopyButton(
        title: "Print verified copy",
        symbol: "printer.fill",
        hint: "Prints this PDF with the verified check mark in its signature box. Nothing is saved."
    ) { [weak self] in self?.makeVerifiedCopy(forPrinting: true) }
    private lazy var shareCopyButton = verifiedCopyButton(
        title: "Share verified copy",
        symbol: "square.and.arrow.up",
        hint: "Shares a separate copy with the verified check mark, protected with the same password. The original file is not changed."
    ) { [weak self] in self?.makeVerifiedCopy(forPrinting: false) }

    init(
        documentURL: URL,
        displayName: String,
        verifier: PdfChefSignatureVerifier = PdfChefSignatureVerifier(),
        onFinished: @escaping () -> Void
    ) {
        self.documentURL = documentURL
        self.displayName = displayName
        self.verifier = verifier
        self.onFinished = onFinished
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Digital signatures"
        view.backgroundColor = .systemGroupedBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(close)
        )
        isModalInPresentation = true
        configureLayout()
        showLoading()
        prepareDocument()
    }

    private func configureLayout() {
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 14
        contentStack.isLayoutMarginsRelativeArrangement = true
        contentStack.layoutMargins = UIEdgeInsets(top: 20, left: 20, bottom: 32, right: 20)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
        ])
    }

    private func showLoading() {
        clearContent()
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        spinner.accessibilityLabel = "Checking digital signatures"

        let label = UILabel()
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .secondaryLabel
        label.text = "Checking signatures…"

        let row = UIStackView(arrangedSubviews: [spinner, label])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        contentStack.addArrangedSubview(row)
    }

    private func prepareDocument() {
        let documentURL = documentURL
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let document = PDFDocument(url: documentURL)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.closeRequested {
                    self.verificationFinished = true
                    self.finishIfReady()
                    return
                }
                guard let document else {
                    self.verify(password: nil)
                    return
                }
                if document.isLocked {
                    self.requestPassword(for: document, message: nil)
                } else {
                    self.verify(password: nil)
                }
            }
        }
    }

    private func requestPassword(for document: PDFDocument, message: String?) {
        let alert = UIAlertController(title: "Password required", message: message, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "PDF password"
            field.isSecureTextEntry = true
            field.textContentType = nil
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self else { return }
            self.verificationFinished = true
            self.close()
        })
        alert.addAction(UIAlertAction(title: "Verify", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let transientPassword = alert?.textFields?.first?.text ?? ""
            alert?.textFields?.first?.text = nil
            self.showLoading()
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let didUnlock = document.unlock(withPassword: transientPassword)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if self.closeRequested {
                        self.verificationFinished = true
                        self.finishIfReady()
                        return
                    }
                    if didUnlock {
                        self.verify(password: transientPassword)
                    } else {
                        self.requestPassword(for: document, message: "That password did not open this PDF.")
                    }
                }
            }
        })
        present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func verify(password: String?) {
        guard !verificationStarted else { return }
        verificationStarted = true
        verifiedPassword = password
        let checkedAt = Date()
        verifiedAt = checkedAt
        showLoading()
        Task { [self] in
            let reports = await verifier.verifyDocument(at: documentURL, password: password, now: checkedAt)
            await MainActor.run {
                verificationFinished = true
                if !closeRequested {
                    render(reports)
                    UIAccessibility.post(notification: .announcement, argument: "Signature check complete")
                }
                finishIfReady()
            }
        }
    }

    private func render(_ reports: [PdfChefSignatureReport]) {
        clearContent()
        contentStack.addArrangedSubview(headerLabel(displayName, style: .headline, color: .label))

        guard !reports.isEmpty else {
            contentStack.addArrangedSubview(
                messageCard(
                    symbol: "doc.badge.questionmark",
                    title: "No digital signatures found",
                    detail: "This PDF does not contain a supported signature field.",
                    color: .secondaryLabel
                )
            )
            return
        }

        for (index, report) in reports.enumerated() {
            let signer = report.signerName ?? "Unknown signer"
            let sectionTitle = reports.count == 1 ? signer : "Signature \(index + 1) · \(signer)"
            contentStack.addArrangedSubview(headerLabel(sectionTitle, style: .title3, color: .label))

            let checks: [(String, PdfChefSignatureCheck)] = [
                ("Document integrity", report.integrity),
                ("Signer trust", report.trust),
                ("Certificate validity", report.certificateValidity),
                ("Revocation", report.revocation),
                ("Timestamp & long-term validation", report.timestampAndLTV),
            ]
            for check in checks {
                contentStack.addArrangedSubview(checkRow(title: check.0, check: check.1))
            }
            for warning in report.warnings {
                contentStack.addArrangedSubview(
                    messageCard(
                        symbol: "exclamationmark.triangle.fill",
                        title: "Security note",
                        detail: warning,
                        color: .systemOrange
                    )
                )
            }
        }
        if Self.isFullyVerified(reports) {
            contentStack.addArrangedSubview(printCopyButton)
            contentStack.addArrangedSubview(shareCopyButton)
        }
    }

    /// The copy's check mark is only offered when every signature passed every offline check.
    static func isFullyVerified(_ reports: [PdfChefSignatureReport]) -> Bool {
        !reports.isEmpty && reports.allSatisfy {
            $0.integrity.status == .valid && $0.trust.status == .trusted && $0.certificateValidity.status == .valid
        }
    }

    private func verifiedCopyButton(title: String, symbol: String, hint: String, action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.filled()
        configuration.title = title
        configuration.image = UIImage(systemName: symbol)
        configuration.imagePadding = 8
        configuration.buttonSize = .large
        configuration.cornerStyle = .large
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        button.accessibilityHint = hint
        return button
    }

    private func makeVerifiedCopy(forPrinting: Bool) {
        guard !copyInProgress else { return }
        copyInProgress = true
        let button = forPrinting ? printCopyButton : shareCopyButton
        button.configuration?.showsActivityIndicator = true
        let documentURL = documentURL
        let displayName = displayName
        let password = verifiedPassword
        let checkedAt = verifiedAt
        let copies = FileManager.default.temporaryDirectory.appendingPathComponent("PdfChefVerifiedCopies", isDirectory: true)
        // Copies left behind by an interrupted share are removed before a new one is made.
        try? FileManager.default.removeItem(at: copies)
        let directory = copies.appendingPathComponent(UUID().uuidString, isDirectory: true)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result: Result<Any, Error> = Result {
                if forPrinting {
                    return try PdfChefVerifiedCopy.render(from: documentURL, password: password, protected: false, checkedAt: checkedAt)
                }
                return try PdfChefVerifiedCopy.create(
                    from: documentURL, password: password, displayName: displayName, checkedAt: checkedAt, in: directory
                )
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.closeRequested else {
                    try? FileManager.default.removeItem(at: directory)
                    return
                }
                self.copyInProgress = false
                button.configuration?.showsActivityIndicator = false
                switch result {
                case .success(let data as Data):
                    let info = UIPrintInfo.printInfo()
                    info.outputType = .general
                    info.jobName = (PdfChefVerifiedCopy.fileName(for: displayName) as NSString).deletingPathExtension
                    let printer = UIPrintInteractionController.shared
                    printer.printInfo = info
                    printer.printingItem = data
                    printer.present(animated: !UIAccessibility.isReduceMotionEnabled) { controller, _, _ in
                        // The unprotected print rendering lives only for this print job.
                        controller.printingItem = nil
                    }
                case .success(let url as URL):
                    let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                    activity.completionWithItemsHandler = { _, _, _, _ in
                        try? FileManager.default.removeItem(at: directory)
                    }
                    activity.popoverPresentationController?.sourceView = button
                    self.present(activity, animated: !UIAccessibility.isReduceMotionEnabled)
                case .success:
                    break
                case .failure(let error):
                    try? FileManager.default.removeItem(at: directory)
                    let alert = UIAlertController(
                        title: "Couldn’t make a verified copy",
                        message: error.localizedDescription,
                        preferredStyle: .alert
                    )
                    alert.addAction(UIAlertAction(title: "OK", style: .default))
                    self.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
                }
            }
        }
    }

    private func checkRow(title: String, check: PdfChefSignatureCheck) -> UIView {
        let presentation = presentation(for: check.status)
        let icon = UIImageView(image: UIImage(systemName: presentation.symbol))
        icon.tintColor = presentation.color
        icon.contentMode = .scaleAspectFit
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title3)
        icon.translatesAutoresizingMaskIntoConstraints = false
        let iconDimension = UIFontMetrics(forTextStyle: .title3).scaledValue(for: 28)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: iconDimension),
            icon.heightAnchor.constraint(equalToConstant: iconDimension),
        ])

        let titleLabel = headerLabel(title, style: .subheadline, color: .secondaryLabel)
        let statusLabel = headerLabel(presentation.label, style: .headline, color: presentation.color)
        let detailLabel = headerLabel(check.detail, style: .footnote, color: .secondaryLabel)
        detailLabel.numberOfLines = 0

        let labels = UIStackView(arrangedSubviews: [titleLabel, statusLabel, detailLabel])
        labels.axis = .vertical
        labels.spacing = 3
        let row = UIStackView(arrangedSubviews: [icon, labels])
        row.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal
        row.alignment = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .leading : .top
        row.spacing = 12

        let card = UIView()
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 14
        card.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14)
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: card.layoutMarginsGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: card.layoutMarginsGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: card.layoutMarginsGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: card.layoutMarginsGuide.bottomAnchor),
            card.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
        ])
        card.isAccessibilityElement = true
        card.accessibilityLabel = title
        card.accessibilityValue = "\(presentation.label). \(check.detail)"
        card.accessibilityHint = nil
        return card
    }

    private func messageCard(symbol: String, title: String, detail: String, color: UIColor) -> UIView {
        let icon = UIImageView(image: UIImage(systemName: symbol))
        icon.tintColor = color
        icon.contentMode = .scaleAspectFit
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title3)
        icon.translatesAutoresizingMaskIntoConstraints = false
        let iconDimension = UIFontMetrics(forTextStyle: .title3).scaledValue(for: 28)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: iconDimension),
            icon.heightAnchor.constraint(equalToConstant: iconDimension),
        ])
        let titleLabel = headerLabel(title, style: .headline, color: .label)
        let detailLabel = headerLabel(detail, style: .footnote, color: .secondaryLabel)
        let labels = UIStackView(arrangedSubviews: [titleLabel, detailLabel])
        labels.axis = .vertical
        labels.spacing = 4
        let row = UIStackView(arrangedSubviews: [icon, labels])
        row.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal
        row.alignment = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .leading : .top
        row.spacing = 12
        let card = UIView()
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 14
        card.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14)
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: card.layoutMarginsGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: card.layoutMarginsGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: card.layoutMarginsGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: card.layoutMarginsGuide.bottomAnchor),
            card.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
        ])
        card.accessibilityLabel = title
        card.accessibilityValue = detail
        card.accessibilityHint = nil
        card.isAccessibilityElement = true
        return card
    }

    private func headerLabel(_ text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
        let label = UILabel()
        label.font = .preferredFont(forTextStyle: style)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        label.text = text
        return label
    }

    private func clearContent() {
        for view in contentStack.arrangedSubviews {
            contentStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }

    private func presentation(for status: PdfChefSignatureStatus) -> (label: String, symbol: String, color: UIColor) {
        switch status {
        case .valid: return ("Valid", "checkmark.circle.fill", .systemGreen)
        case .invalid: return ("Invalid", "xmark.octagon.fill", .systemRed)
        case .trusted: return ("Trusted", "checkmark.shield.fill", .systemGreen)
        case .untrusted: return ("Not trusted", "xmark.shield.fill", .systemRed)
        case .expired: return ("Expired", "clock.badge.exclamationmark.fill", .systemOrange)
        case .notYetValid: return ("Not yet valid", "clock.badge.exclamationmark.fill", .systemOrange)
        case .revoked: return ("Revoked", "xmark.octagon.fill", .systemRed)
        case .good: return ("No revocation found", "checkmark.circle.fill", .systemGreen)
        case .notPresent: return ("Not present", "minus.circle.fill", .secondaryLabel)
        case .indeterminate: return ("Indeterminate", "questionmark.circle.fill", .systemOrange)
        case .unsupported: return ("Unsupported", "questionmark.circle.fill", .systemOrange)
        case .offline: return ("Not checked", "wifi.slash", .systemOrange)
        }
    }

    @objc private func close() {
        // UIKit ignores a dismissal requested while the sheet is still sliding in.
        // Close once that finishes instead of latching closeRequested on a no-op.
        if let coordinator = transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.close() }
            return
        }
        guard !closeRequested else { return }
        closeRequested = true
        verifiedPassword = nil
        // Nothing has started that would finish later, and this sheet may be released
        // once dismissed, so do not wait on the document load callback.
        if !verificationStarted { verificationFinished = true }
        dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
            guard let self else { return }
            self.dismissalFinished = true
            self.finishIfReady()
        }
    }

    private func finishIfReady() {
        guard verificationFinished, dismissalFinished, !finishReported else { return }
        finishReported = true
        onFinished()
    }
}
