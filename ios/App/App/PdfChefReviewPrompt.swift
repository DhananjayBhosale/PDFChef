import StoreKit
import UIKit

/// When to ask for the App Store's rating prompt: once, and only to people who have saved work on
/// several different days, the same rule as the Android app. No question comes first, because
/// Apple allows only its own prompt for ratings.
struct PdfChefReviewPolicy: Codable, Equatable {
    static let savesBeforeAsking = 5
    static let daysBeforeAsking = 3

    var saves = 0
    var activeDays = 0
    /// A local calendar day number.
    var lastSaveDay: Int?
    var asked = false

    func afterSave(on day: Int) -> PdfChefReviewPolicy {
        var next = self
        next.saves += 1
        if day != lastSaveDay { next.activeDays += 1 }
        next.lastSaveDay = day
        return next
    }

    var readyToAsk: Bool {
        !asked && saves >= Self.savesBeforeAsking && activeDays >= Self.daysBeforeAsking
    }

    func afterAsk() -> PdfChefReviewPolicy {
        var next = self
        next.asked = true
        return next
    }
}

/// Shows the App Store's own rating prompt to people who keep coming back to save their work.
/// The App Store decides whether it really appears and never says what the person chose, so
/// nothing waits on it and a failure changes nothing for the person.
enum PdfChefReviewPrompt {
    private static let storageKey = "PdfChefReviewPolicy"

    /// Counts a document saved to Files; true means ask now. While the app is not in front, a due
    /// ask waits for a later save instead of being spent.
    static func recordSave(
        inFront: Bool,
        defaults: UserDefaults = .standard,
        today: Int = localDay(of: Date())
    ) -> Bool {
        var policy = (defaults.data(forKey: storageKey)
            .flatMap { try? JSONDecoder().decode(PdfChefReviewPolicy.self, from: $0) }) ?? PdfChefReviewPolicy()
        if policy.asked { return false }
        policy = policy.afterSave(on: today)
        let ask = inFront && policy.readyToAsk
        // Counted as asked even when the App Store shows nothing, so nobody is ever asked twice.
        if ask { policy = policy.afterAsk() }
        if let data = try? JSONEncoder().encode(policy) { defaults.set(data, forKey: storageKey) }
        return ask
    }

    static func localDay(of date: Date, calendar: Calendar = .current) -> Int {
        calendar.ordinality(of: .day, in: .era, for: date) ?? 0
    }

    /// True while the app is active on screen, so the prompt can never land over another app.
    @MainActor
    static func isInFront(_ presenter: UIViewController) -> Bool {
        UIApplication.shared.applicationState == .active
            && presenter.view.window?.windowScene?.activationState == .foregroundActive
    }

    /// Asks the App Store for its rating prompt over the app.
    @MainActor
    static func ask(from presenter: UIViewController) {
        guard isInFront(presenter), let scene = presenter.view.window?.windowScene else { return }
        AppStore.requestReview(in: scene)
    }
}
