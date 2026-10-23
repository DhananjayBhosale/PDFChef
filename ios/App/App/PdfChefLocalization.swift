import UIKit

/// Native screens speak the language chosen in the app, which the web layer sends when it
/// starts and whenever it changes. Until then they use the last language sent, or the system's.
/// Text comes from Localizable.xcstrings, keyed by its English wording, which is the fallback.
enum PdfChefLocalization {
    private static let languageKey = "PdfChefLanguage"
    private static let lock = NSLock()
    private static var current = Selection(UserDefaults.standard.string(forKey: languageKey))

    private struct Selection {
        let bundle: Bundle
        let locale: Locale
        let layoutDirection: UITraitEnvironmentLayoutDirection

        init(_ language: String?) {
            bundle = PdfChefLocalization.bundle(for: language)
            locale = language.map { Locale(identifier: $0) } ?? .current
            layoutDirection = PdfChefLocalization.layoutDirection(for: language)
        }
    }

    /// UIKit mirrors only for the system language, so native screens take this from the app's.
    static var layoutDirection: UITraitEnvironmentLayoutDirection { lock.withLock { current.layoutDirection } }

    static func layoutDirection(for language: String?) -> UITraitEnvironmentLayoutDirection {
        guard let language else { return .unspecified }
        return Locale.Language(identifier: language).characterDirection == .rightToLeft ? .rightToLeft : .leftToRight
    }

    static func setLanguage(_ language: String) {
        UserDefaults.standard.set(language, forKey: languageKey)
        let selection = Selection(language)
        lock.withLock { current = selection }
    }

    /// The `.lproj` bundle for an app locale such as "fr-FR", "es-419" or "zh-Hant": the exact
    /// localization when there is one, else its language, else the system's choice.
    static func bundle(for language: String?, in main: Bundle = .main) -> Bundle {
        guard let language else { return main }
        let baseLanguage = language.split(separator: "-").first.map(String.init)
        for candidate in [language, baseLanguage].compactMap({ $0 }) {
            if let path = main.path(forResource: candidate, ofType: "lproj"), let bundle = Bundle(path: path) {
                return bundle
            }
        }
        return main
    }

    fileprivate static func text(_ key: String, _ arguments: [CVarArg]) -> String {
        let selection = lock.withLock { current }
        let format = selection.bundle.localizedString(forKey: key, value: key, table: nil)
        return arguments.isEmpty ? format : String(format: format, locale: selection.locale, arguments: arguments)
    }
}

/// The text for `key`, its English wording, in the app's language. Arguments fill its
/// `%@` and `%lld` placeholders.
func localized(_ key: String, _ arguments: CVarArg...) -> String {
    PdfChefLocalization.text(key, arguments)
}
