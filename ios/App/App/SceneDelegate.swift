import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let documentInbox = PdfChefDocumentInbox()
    private var inboxFailure: PdfChefDocumentInbox.Failure?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        documentInbox.failureHandler = { [weak self] failure in
            self?.inboxFailure = failure
            self?.showInboxFailure()
        }

        // Persist cold Open-In bytes and queue entries before JavaScript can make
        // its first pending-import request. This intentionally precedes the bridge.
        for context in connectionOptions.urlContexts {
            documentInbox.acceptSynchronously(url: context.url)
        }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PdfChefBridgeViewController()
        window?.makeKeyAndVisible()

        // Capacitor's URL proxy republishes raw URLs to JavaScript. Document-provider
        // file URLs stay inside the native inbox; non-document launches still use it.
        if !connectionOptions.urlContexts.contains(where: { $0.url.isFileURL }) {
            SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            documentInbox.accept(url: context.url)
        }
        let nonDocumentContexts = Set(URLContexts.filter { !$0.url.isFileURL })
        if !nonDocumentContexts.isEmpty {
            SceneDelegateProxy.shared.scene(scene, openURLContexts: nonDocumentContexts)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        showInboxFailure()
        PdfChefAppUpdate.shared.sceneDidBecomeActive(window)
    }

    /// Says why a file from another app did not open, over whatever is on screen.
    private func showInboxFailure() {
        guard let failure = inboxFailure,
              window?.windowScene?.activationState == .foregroundActive,
              var top = window?.rootViewController else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        inboxFailure = nil
        let alert = UIAlertController(title: localized("Couldn’t open file"), message: failure.message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: localized("OK"), style: .default))
        top.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
    }
}
