import StoreKit
import UIKit

/// Pure decision boundary for offering a newer App Store version.
enum PdfChefAppUpdatePolicy {
    static func shouldOffer(
        storeVersion: String,
        storeMinimumOS: String?,
        installedVersion: String,
        systemVersion: String
    ) -> Bool {
        guard isNewer(storeVersion, than: installedVersion) else { return false }
        guard let storeMinimumOS, !storeMinimumOS.isEmpty else { return true }
        return !isNewer(storeMinimumOS, than: systemVersion)
    }

    /// Compares dotted versions numerically, so 1.10 > 1.9 and 1.3.0 == 1.3.
    static func isNewer(_ version: String, than other: String) -> Bool {
        let left = version.split(separator: ".").map { Int($0) ?? 0 }
        let right = other.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(left.count, right.count) {
            let l = index < left.count ? left[index] : 0
            let r = index < right.count ? right[index] : 0
            if l != r { return l > r }
        }
        return false
    }
}

/// Offers a newer App Store version once per launch, like Android's flexible Play update.
/// Declining is non-fatal; iOS automatic and manual App Store updates remain available.
final class PdfChefAppUpdate: NSObject, SKStoreProductViewControllerDelegate {
    static let shared = PdfChefAppUpdate()

    private struct Lookup: Decodable {
        struct Listing: Decodable {
            let trackId: Int
            let trackViewUrl: String
            let version: String
            let minimumOsVersion: String?
        }
        let results: [Listing]
    }

    private var checked = false
    private var pending: Lookup.Listing?
    private weak var window: UIWindow?

    func sceneDidBecomeActive(_ window: UIWindow?) {
        self.window = window
        if pending != nil { offer(); return }
        guard !checked,
              let bundleID = Bundle.main.bundleIdentifier,
              let installed = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              let url = URL(string: "https://itunes.apple.com/lookup?bundleId=\(bundleID)") else { return }
        checked = true
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let system = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data,
                  let listing = try? JSONDecoder().decode(Lookup.self, from: data).results.first,
                  PdfChefAppUpdatePolicy.shouldOffer(
                      storeVersion: listing.version,
                      storeMinimumOS: listing.minimumOsVersion,
                      installedVersion: installed,
                      systemVersion: system) else { return }
            DispatchQueue.main.async {
                self?.pending = listing
                self?.offer()
            }
        }.resume()
    }

    private func offer() {
        // Wait for the next activation rather than cover a sheet, picker or reader.
        guard let listing = pending,
              UIApplication.shared.applicationState == .active,
              let root = window?.rootViewController,
              root.presentedViewController == nil else { return }
        pending = nil
        let alert = UIAlertController(
            title: "Update available",
            message: "PDF Chef \(listing.version) is ready in the App Store.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Later", style: .cancel))
        let update = UIAlertAction(title: "Update", style: .default) { [weak self, weak root] _ in
            guard let self, let root else { return }
            self.showStorePage(listing, from: root)
        }
        alert.addAction(update)
        alert.preferredAction = update
        root.present(alert, animated: true)
    }

    private func showStorePage(_ listing: Lookup.Listing, from root: UIViewController) {
        let store = SKStoreProductViewController()
        store.delegate = self
        root.present(store, animated: true)
        store.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: listing.trackId]) { loaded, _ in
            guard !loaded else { return }
            store.dismiss(animated: true) {
                if let page = URL(string: listing.trackViewUrl) { UIApplication.shared.open(page) }
            }
        }
    }

    func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
        viewController.dismiss(animated: true)
    }
}
