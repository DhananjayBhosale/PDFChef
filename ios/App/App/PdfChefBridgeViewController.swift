import Capacitor
import WebKit

final class PdfChefBridgeViewController: CAPBridgeViewController {
    private var navigationDelegateProxy: PdfChefNavigationDelegateProxy?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PdfChefDocumentsPlugin())
        bridge?.registerPluginInstance(PdfChefPurchasesPlugin())
        if let webView, let original = webView.navigationDelegate, let serverURL = bridge?.config.serverURL {
            let proxy = PdfChefNavigationDelegateProxy(original: original, serverURL: serverURL)
            navigationDelegateProxy = proxy
            webView.navigationDelegate = proxy
        }
    }
}

/// The fragment added to the screen reopened after the web content process died, so the page
/// can say so once. Mirrored in services/rendererRecovery.ts.
enum PdfChefRendererRecovery {
    static let fragment = "renderer-restarted"

    /// The same packaged route carrying the recovery fragment, or nil for any other URL.
    static func recoveryURL(for url: URL?, serverURL: URL) -> URL? {
        guard let url, url.scheme == serverURL.scheme, url.host == serverURL.host,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.fragment = fragment
        return components.url
    }
}

/// Capacitor's own navigation delegate does the work; this only adds the recovery fragment
/// after it reloads a page whose web content process died.
private final class PdfChefNavigationDelegateProxy: NSObject, WKNavigationDelegate {
    private let original: WKNavigationDelegate
    private let serverURL: URL

    init(original: WKNavigationDelegate, serverURL: URL) {
        self.original = original
        self.serverURL = serverURL
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || original.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        original.responds(to: aSelector) ? original : super.forwardingTarget(for: aSelector)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let recoveryURL = PdfChefRendererRecovery.recoveryURL(for: webView.url, serverURL: serverURL)
        // Capacitor resets the bridge and reloads; the same screen then loads with the fragment.
        original.webViewWebContentProcessDidTerminate?(webView)
        if let recoveryURL { webView.load(URLRequest(url: recoveryURL)) }
    }
}
