import PDFKit
import UIKit

enum PdfChefReaderResult {
    case closed
    case tool(String)
    case batched(Int)
}

/// Native, file-backed PDF reader. PDFKit tiles visible pages instead of copying
/// the complete retained file through the Capacitor bridge.
final class PdfChefReaderViewController: UIViewController, UISearchResultsUpdating, PDFDocumentDelegate {
    private static let maximumHighlightedSearchMatches = 100
    private static let maximumToolHandoffBytes: Int64 = 200 * 1024 * 1024
    private static let tools: [(title: String, path: String)] = [
        ("Compress PDF", "/compress"),
        ("Merge PDF", "/merge"),
        ("Split PDF", "/split"),
        ("Edit PDF", "/edit"),
        ("Make Fillable", "/make-fillable"),
        ("Sign PDF", "/sign"),
        ("Watermark PDF", "/watermark"),
        ("Protect PDF", "/protect"),
        ("Unlock PDF", "/unlock"),
        ("Delete Pages", "/delete-pages"),
        ("Page Numbers", "/page-numbers"),
        ("Reorder Pages", "/reorder"),
        ("Rotate Pages", "/rotate"),
        ("Flatten PDF", "/flatten"),
        ("Extract Pages", "/extract"),
        ("PDF to Image", "/pdf-to-jpg"),
        ("PDF to Word", "/pdf-to-word"),
        ("Extract Text", "/ocr"),
        ("Metadata", "/metadata"),
        ("Repair PDF", "/repair"),
        ("Compare Summary", "/compare")
    ]

    private let documentURL: URL
    private let displayName: String
    private let documentSizeBytes: Int64
    private let shareDocument: (UIViewController) -> Void
    private let canVerifySignatures: Bool
    private let verifySignatures: (UIViewController) -> Void
    private let prepareLargeDocument: (
        PdfChefPdfBatchCancellationToken,
        @escaping (PdfChefPdfBatchProgress) -> Void,
        @escaping (Result<Int, Error>) -> Void
    ) -> Void
    private let onFinished: (PdfChefReaderResult) -> Void

    private let pdfView = PDFView()
    private let pageLabel = UILabel()
    private let previousPageButton = UIButton(type: .system)
    private let nextPageButton = UIButton(type: .system)
    private let statusStack = UIStackView()
    private let statusTitle = UILabel()
    private let statusDetail = UILabel()
    private let statusActivity = UIActivityIndicatorView(style: .medium)
    private let retryButton = UIButton(type: .system)
    private let cancelBatchButton = UIButton(type: .system)
    private let searchController = UISearchController(searchResultsController: nil)
    private var document: PDFDocument?
    private var searchGeneration = 0
    private var searchWorkItem: DispatchWorkItem?
    private var searchMatches: [PDFSelection] = []
    private var searchMatchCount = 0
    private var activeSearchGeneration: Int?
    private let searchStateLock = NSLock()
    private var loadGeneration = 0
    private var finished = false
    private var batchCancellation: PdfChefPdfBatchCancellationToken?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var furthestPreparedPage = 0

    init(
        documentURL: URL,
        displayName: String,
        documentSizeBytes: Int64,
        shareDocument: @escaping (UIViewController) -> Void,
        canVerifySignatures: Bool,
        verifySignatures: @escaping (UIViewController) -> Void,
        prepareLargeDocument: @escaping (
            PdfChefPdfBatchCancellationToken,
            @escaping (PdfChefPdfBatchProgress) -> Void,
            @escaping (Result<Int, Error>) -> Void
        ) -> Void,
        onFinished: @escaping (PdfChefReaderResult) -> Void
    ) {
        self.documentURL = documentURL
        self.displayName = displayName
        self.documentSizeBytes = documentSizeBytes
        self.shareDocument = shareDocument
        self.canVerifySignatures = canVerifySignatures
        self.verifySignatures = verifySignatures
        self.prepareLargeDocument = prepareLargeDocument
        self.onFinished = onFinished
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        searchWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = displayName
        view.backgroundColor = .secondarySystemBackground
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "Close",
            style: .plain,
            target: self,
            action: #selector(close)
        )
        let tools = UIBarButtonItem(title: "Tools", style: .done, target: self, action: #selector(showTools))
        tools.accessibilityLabel = "PDF Tools"
        let share = UIBarButtonItem(
            image: UIImage(systemName: "square.and.arrow.up"),
            style: .plain,
            target: self,
            action: #selector(share)
        )
        share.accessibilityLabel = "Share PDF"
        navigationItem.rightBarButtonItems = [tools, share]

        configureReader()
        configurePageBar()
        configureStatus()
        configureSearch()
        loadDocument()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationController?.setToolbarHidden(false, animated: false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateZoomBounds()
    }

    private func configureReader() {
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.displaysPageBreaks = true
        pdfView.pageShadowsEnabled = false
        pdfView.pageBreakMargins = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        pdfView.backgroundColor = .secondarySystemBackground
        view.addSubview(pdfView)
        NSLayoutConstraint.activate([
            pdfView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pdfView.topAnchor.constraint(equalTo: view.topAnchor),
            pdfView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(pageChanged),
            name: .PDFViewPageChanged,
            object: pdfView
        )
    }

    private func configurePageBar() {
        previousPageButton.configuration = .plain()
        previousPageButton.configuration?.image = UIImage(systemName: "chevron.left")
        previousPageButton.configuration?.title = "Previous"
        previousPageButton.addTarget(self, action: #selector(previousPage), for: .touchUpInside)
        previousPageButton.accessibilityLabel = "Previous page"
        previousPageButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        previousPageButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        nextPageButton.configuration = .plain()
        nextPageButton.configuration?.image = UIImage(systemName: "chevron.right")
        nextPageButton.configuration?.imagePlacement = .trailing
        nextPageButton.configuration?.title = "Next"
        nextPageButton.addTarget(self, action: #selector(nextPage), for: .touchUpInside)
        nextPageButton.accessibilityLabel = "Next page"
        nextPageButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        nextPageButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        pageLabel.font = .preferredFont(forTextStyle: .subheadline)
        pageLabel.adjustsFontForContentSizeCategory = true
        pageLabel.textAlignment = .center
        pageLabel.accessibilityTraits.insert(.updatesFrequently)
        toolbarItems = [
            UIBarButtonItem(customView: previousPageButton),
            UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil),
            UIBarButtonItem(customView: pageLabel),
            UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil),
            UIBarButtonItem(customView: nextPageButton)
        ]
    }

    private func configureStatus() {
        statusStack.axis = .vertical
        statusStack.alignment = .center
        statusStack.spacing = 10
        statusStack.isLayoutMarginsRelativeArrangement = true
        statusStack.layoutMargins = UIEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        statusStack.backgroundColor = .secondarySystemGroupedBackground
        statusStack.layer.cornerRadius = 16
        statusStack.translatesAutoresizingMaskIntoConstraints = false
        statusStack.isHidden = true

        statusTitle.font = .preferredFont(forTextStyle: .headline)
        statusTitle.adjustsFontForContentSizeCategory = true
        statusTitle.textAlignment = .center
        statusDetail.font = .preferredFont(forTextStyle: .subheadline)
        statusDetail.adjustsFontForContentSizeCategory = true
        statusDetail.textColor = .secondaryLabel
        statusDetail.textAlignment = .center
        statusDetail.numberOfLines = 0
        retryButton.configuration = .filled()
        retryButton.configuration?.title = "Retry"
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        cancelBatchButton.configuration = .plain()
        cancelBatchButton.configuration?.title = "Cancel"
        cancelBatchButton.addTarget(self, action: #selector(cancelBatch), for: .touchUpInside)
        cancelBatchButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        cancelBatchButton.isHidden = true

        statusActivity.hidesWhenStopped = true
        statusStack.addArrangedSubview(statusTitle)
        statusStack.addArrangedSubview(statusDetail)
        statusStack.addArrangedSubview(statusActivity)
        statusStack.addArrangedSubview(retryButton)
        statusStack.addArrangedSubview(cancelBatchButton)
        view.addSubview(statusStack)
        NSLayoutConstraint.activate([
            statusStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusStack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusStack.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            statusStack.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20)
        ])
    }

    private func configureSearch() {
        searchController.obscuresBackgroundDuringPresentation = false
        searchController.searchResultsUpdater = self
        searchController.searchBar.placeholder = "Search PDF"
        searchController.searchBar.autocapitalizationType = .none
        searchController.searchBar.autocorrectionType = .no
        navigationItem.searchController = searchController
        // Keep search discoverable without requiring a pull-down gesture. The
        // reader still gives the extreme-right navigation position to Tools.
        navigationItem.hidesSearchBarWhenScrolling = false
        definesPresentationContext = true
    }

    private func loadDocument() {
        loadGeneration += 1
        let generation = loadGeneration
        showLoading(title: "Opening PDF", detail: "Large files may take a moment.")
        stopSearch()
        pdfView.document = nil
        document = nil
        let documentURL = documentURL
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let loaded = PDFDocument(url: documentURL)
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.finished, generation == self.loadGeneration else { return }
                guard let loaded else {
                    self.showLoadError()
                    return
                }
                self.document = loaded
                if loaded.isLocked {
                    self.hideLoading()
                    self.requestPassword(for: loaded, message: nil)
                } else {
                    self.display(loaded)
                }
            }
        }
    }

    private func display(_ document: PDFDocument) {
        hideLoading()
        document.delegate = self
        pdfView.document = document
        pdfView.autoScales = true
        updateZoomBounds()
        pageChanged()
        UIAccessibility.post(notification: .screenChanged, argument: pdfView)
    }

    private func updateZoomBounds() {
        guard pdfView.document != nil else { return }
        let fitScale = pdfView.scaleFactorForSizeToFit
        if fitScale > 0 {
            pdfView.minScaleFactor = fitScale
            pdfView.maxScaleFactor = fitScale * 6
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
        alert.addAction(UIAlertAction(title: "Close", style: .cancel) { [weak self] _ in self?.finish(.closed) })
        alert.addAction(UIAlertAction(title: "Open", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let exactPassword = alert?.textFields?.first?.text ?? ""
            alert?.textFields?.first?.text = nil
            self.unlock(document, withPassword: exactPassword)
        })
        present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func unlock(_ document: PDFDocument, withPassword password: String) {
        loadGeneration += 1
        let generation = loadGeneration
        showLoading(title: "Opening PDF", detail: nil)
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak document] in
            let didUnlock = document?.unlock(withPassword: password) ?? false
            DispatchQueue.main.async { [weak self, weak document] in
                guard let self, let document, !self.finished, generation == self.loadGeneration else { return }
                if didUnlock {
                    self.display(document)
                } else {
                    self.hideLoading()
                    self.requestPassword(for: document, message: "That password did not open this PDF.")
                }
            }
        }
    }

    private func showLoading(title: String, detail: String?) {
        pdfView.isHidden = true
        statusTitle.text = title
        statusDetail.text = detail
        statusDetail.isHidden = detail == nil
        retryButton.isHidden = true
        cancelBatchButton.isHidden = true
        statusActivity.startAnimating()
        statusStack.isHidden = false
        previousPageButton.isEnabled = false
        nextPageButton.isEnabled = false
        pageLabel.text = "—"
    }

    private func hideLoading() {
        statusActivity.stopAnimating()
        statusStack.isHidden = true
        statusDetail.isHidden = false
        retryButton.isHidden = false
        cancelBatchButton.isHidden = true
        pdfView.isHidden = false
    }

    private func showLoadError() {
        statusActivity.stopAnimating()
        pdfView.isHidden = true
        statusTitle.text = "Couldn’t open PDF"
        statusDetail.text = "The file may be damaged or use an unsupported PDF feature."
        statusStack.isHidden = false
        statusDetail.isHidden = false
        retryButton.isHidden = false
        cancelBatchButton.isHidden = true
        pageLabel.text = "—"
        previousPageButton.isEnabled = false
        nextPageButton.isEnabled = false
        UIAccessibility.post(notification: .screenChanged, argument: statusTitle)
    }

    func updateSearchResults(for searchController: UISearchController) {
        searchGeneration += 1
        let generation = searchGeneration
        searchWorkItem?.cancel()
        stopActiveSearch(document: document)
        let query = searchController.searchBar.text ?? ""
        guard !query.isEmpty, let document else {
            stopSearch()
            return
        }
        let work = DispatchWorkItem { [weak self, weak document] in
            guard let self, let document, generation == self.searchGeneration else { return }
            self.beginSearch(query, generation: generation, document: document)
        }
        searchWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    func didMatchString(_ instance: PDFSelection) {
        searchStateLock.lock()
        defer { searchStateLock.unlock() }
        guard activeSearchGeneration != nil else { return }
        searchMatchCount += 1
        if searchMatches.count < Self.maximumHighlightedSearchMatches {
            searchMatches.append(instance)
        }
    }

    func documentDidEndDocumentFind(_ notification: Notification) {
        searchStateLock.lock()
        let generation = activeSearchGeneration
        let matches = searchMatches
        let matchCount = searchMatchCount
        activeSearchGeneration = nil
        searchStateLock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.finished, generation == self.searchGeneration else { return }
            self.pdfView.highlightedSelections = matches
            if let first = matches.first {
                self.pdfView.currentSelection = first
                self.pdfView.go(to: first)
            }
            self.searchController.searchBar.accessibilityValue = matchCount == 0
                ? "No matches"
                : "\(matchCount) matches"
        }
    }

    private func beginSearch(_ query: String, generation: Int, document: PDFDocument) {
        guard generation == searchGeneration, !finished else { return }
        if document.isFinding {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak document] in
                guard let self, let document else { return }
                self.beginSearch(query, generation: generation, document: document)
            }
            return
        }
        searchStateLock.lock()
        searchMatches.removeAll(keepingCapacity: true)
        searchMatchCount = 0
        activeSearchGeneration = generation
        searchStateLock.unlock()
        document.delegate = self
        document.beginFindString(query, withOptions: [.caseInsensitive])
    }

    private func stopActiveSearch(document: PDFDocument?) {
        searchStateLock.lock()
        activeSearchGeneration = nil
        searchStateLock.unlock()
        document?.cancelFindString()
    }

    private func stopSearch(resetQueryValue: Bool = true) {
        searchWorkItem?.cancel()
        searchWorkItem = nil
        stopActiveSearch(document: document)
        searchStateLock.lock()
        searchMatches.removeAll(keepingCapacity: false)
        searchMatchCount = 0
        searchStateLock.unlock()
        pdfView.highlightedSelections = nil
        pdfView.currentSelection = nil
        if resetQueryValue {
            searchController.searchBar.accessibilityValue = nil
        }
    }

    @objc private func pageChanged() {
        guard let document, let page = pdfView.currentPage else {
            pageLabel.text = "—"
            return
        }
        let index = document.index(for: page)
        let current = max(0, index) + 1
        pageLabel.text = "\(current) of \(document.pageCount)"
        pageLabel.accessibilityLabel = "Page \(current) of \(document.pageCount)"
        previousPageButton.isEnabled = pdfView.canGoToPreviousPage
        nextPageButton.isEnabled = pdfView.canGoToNextPage
    }

    @objc private func previousPage() { pdfView.goToPreviousPage(nil) }
    @objc private func nextPage() { pdfView.goToNextPage(nil) }
    @objc private func retry() { loadDocument() }
    /// Bar buttons stay tappable while a sheet slides in over them. Presenting or
    /// closing from that moment leaves the new sheet unable to dismiss, so wait it out.
    private var isIdleForBarAction: Bool {
        presentedViewController == nil && transitionCoordinator == nil
    }

    @objc private func share() {
        guard isIdleForBarAction else { return }
        shareDocument(self)
    }

    @objc private func close() {
        guard isIdleForBarAction else { return }
        finish(.closed)
    }

    @objc private func showTools() {
        guard isIdleForBarAction else { return }
        let sheet = UIAlertController(title: "PDF Tools", message: nil, preferredStyle: .actionSheet)
        if canVerifySignatures {
            sheet.addAction(UIAlertAction(title: "Verify PDF Signatures", style: .default) { [weak self] _ in
                guard let self else { return }
                self.verifySignatures(self)
            })
        }
        for tool in Self.tools {
            sheet.addAction(UIAlertAction(title: tool.title, style: .default) { [weak self] _ in
                guard let self else { return }
                if self.documentSizeBytes > Self.maximumToolHandoffBytes {
                    self.showLargeDocumentOptions()
                } else {
                    self.finish(.tool(tool.path))
                }
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItems?.first
        present(sheet, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func showLargeDocumentOptions() {
        if document?.isEncrypted == true || document?.isLocked == true {
            let alert = UIAlertController(
                title: "Unlocked copy needed",
                message: "Save an unlocked copy before preparing this large PDF for tools.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
            return
        }

        let alert = UIAlertController(
            title: "Prepare for tools?",
            message: "PDF Chef will create smaller PDF parts and keep the original unchanged. Each part is a separate file, so forms, signatures, metadata, and page numbering may not carry across parts.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Create Smaller Parts", style: .default) { [weak self] _ in
            self?.startLargeDocumentPreparation()
        })
        present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func startLargeDocumentPreparation() {
        guard batchCancellation == nil else { return }
        stopSearch()
        document?.delegate = nil
        pdfView.document = nil
        document = nil
        let cancellation = PdfChefPdfBatchCancellationToken()
        batchCancellation = cancellation
        furthestPreparedPage = 0
        cancelBatchButton.isEnabled = true
        showBatchProgress(.init(stage: .preparing, completed: 0, total: 0))
        setReaderChromeEnabled(false)
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Prepare large PDF") { [weak self] in
            guard let self else { return }
            self.batchCancellation?.cancel()
            self.endBackgroundTask()
        }
        prepareLargeDocument(
            cancellation,
            { [weak self] progress in
                DispatchQueue.main.async { self?.showBatchProgress(progress) }
            },
            { [weak self] result in
                DispatchQueue.main.async { self?.finishLargeDocumentPreparation(result) }
            }
        )
    }

    private func showBatchProgress(_ progress: PdfChefPdfBatchProgress) {
        guard !finished, batchCancellation != nil else { return }
        pdfView.isHidden = true
        retryButton.isHidden = true
        cancelBatchButton.isHidden = false
        statusActivity.startAnimating()
        statusStack.isHidden = false
        statusDetail.isHidden = false
        switch progress.stage {
        case .preparing:
            furthestPreparedPage = max(furthestPreparedPage, progress.completed)
            statusTitle.text = "Creating smaller PDFs"
            statusDetail.text = progress.total > 0
                ? "Preparing page \(min(furthestPreparedPage, progress.total)) of \(progress.total)"
                : "Preparing pages…"
        case .saving:
            statusTitle.text = "Saving smaller PDFs"
            statusDetail.text = "Saved \(progress.completed) of \(progress.total)"
        }
    }

    private func finishLargeDocumentPreparation(_ result: Result<Int, Error>) {
        guard batchCancellation != nil, !finished else { return }
        batchCancellation = nil
        endBackgroundTask()
        statusActivity.stopAnimating()
        cancelBatchButton.isHidden = true
        setReaderChromeEnabled(true)

        switch result {
        case .success(let partCount):
            let alert = UIAlertController(
                title: "Parts ready",
                message: "Created \(partCount) smaller PDFs. Find them in Recent and open any part with Tools.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Done", style: .default) { [weak self] _ in
                self?.finish(.batched(partCount))
            })
            present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
        case .failure(let error):
            if let batchError = error as? PdfChefPdfBatcherError,
               case .cancelled = batchError {
                loadDocument()
                return
            }
            let alert = UIAlertController(
                title: "Couldn’t create smaller PDFs",
                message: error.localizedDescription,
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
                self?.loadDocument()
            })
            present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
        }
    }

    private func setReaderChromeEnabled(_ enabled: Bool) {
        navigationItem.leftBarButtonItem?.isEnabled = enabled
        navigationItem.rightBarButtonItems?.forEach { $0.isEnabled = enabled }
        previousPageButton.isEnabled = enabled && pdfView.canGoToPreviousPage
        nextPageButton.isEnabled = enabled && pdfView.canGoToNextPage
        searchController.searchBar.isUserInteractionEnabled = enabled
    }

    @objc private func cancelBatch() {
        batchCancellation?.cancel()
        cancelBatchButton.isEnabled = false
        statusDetail.text = "Cancelling…"
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        stopSearch()
    }

    private func finish(_ result: PdfChefReaderResult) {
        guard !finished else { return }
        finished = true
        batchCancellation?.cancel()
        batchCancellation = nil
        endBackgroundTask()
        loadGeneration += 1
        stopSearch()
        document?.delegate = nil
        pdfView.document = nil
        document = nil
        dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [onFinished] in
            onFinished(result)
        }
    }
}
