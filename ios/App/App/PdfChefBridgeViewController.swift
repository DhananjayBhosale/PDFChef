import Capacitor

final class PdfChefBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PdfChefDocumentsPlugin())
        bridge?.registerPluginInstance(PdfChefPurchasesPlugin())
    }
}
