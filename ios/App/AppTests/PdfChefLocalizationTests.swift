import XCTest
@testable import App

final class PdfChefLocalizationTests: XCTestCase {
    private var savedLanguage: String?

    override func setUp() {
        savedLanguage = UserDefaults.standard.string(forKey: "PdfChefLanguage")
    }

    override func tearDown() {
        PdfChefLocalization.setLanguage(savedLanguage ?? "en")
        if savedLanguage == nil { UserDefaults.standard.removeObject(forKey: "PdfChefLanguage") }
    }

    func testAppLocalesPickTheirOwnTranslationOrTheirLanguage() {
        let folder = { (language: String?) in PdfChefLocalization.bundle(for: language).bundleURL.lastPathComponent }

        XCTAssertEqual(folder("fr-FR"), "fr.lproj")
        XCTAssertEqual(folder("fr-CA"), "fr-CA.lproj")
        XCTAssertEqual(folder("es-ES"), "es.lproj")
        XCTAssertEqual(folder("es-419"), "es-419.lproj")
        XCTAssertEqual(folder("zh-Hant"), "zh-Hant.lproj")
        XCTAssertEqual(folder("pt-BR"), "pt-BR.lproj")
        XCTAssertEqual(folder("en-US"), "en.lproj")
        XCTAssertEqual(PdfChefLocalization.bundle(for: "xx-YY"), Bundle.main)
        XCTAssertEqual(PdfChefLocalization.bundle(for: nil), Bundle.main)
    }

    func testNativeTextFollowsTheLanguageChosenInTheApp() {
        PdfChefLocalization.setLanguage("de-DE")
        XCTAssertEqual(localized("Close"), "Schließen")
        XCTAssertEqual(localized("Page %lld of %lld", 2, 9), "Seite 2 von 9")

        PdfChefLocalization.setLanguage("en-US")
        XCTAssertEqual(localized("Close"), "Close")
        XCTAssertEqual(localized("%lld matches", 1), "1 match")
        XCTAssertEqual(localized("%lld matches", 4), "4 matches")
    }

    func testArabicChosenInTheAppLaysNativeScreensOutRightToLeft() {
        XCTAssertEqual(PdfChefLocalization.layoutDirection(for: "ar"), .rightToLeft)
        XCTAssertEqual(PdfChefLocalization.layoutDirection(for: "en-US"), .leftToRight)
        XCTAssertEqual(PdfChefLocalization.layoutDirection(for: "zh-Hant"), .leftToRight)
        XCTAssertEqual(PdfChefLocalization.layoutDirection(for: nil), .unspecified)

        PdfChefLocalization.setLanguage("ar")
        XCTAssertEqual(PdfChefLocalization.layoutDirection, .rightToLeft)
        PdfChefLocalization.setLanguage("de-DE")
        XCTAssertEqual(PdfChefLocalization.layoutDirection, .leftToRight)
    }

    func testPluralsUseTheLanguagesOwnForms() {
        PdfChefLocalization.setLanguage("pl-PL")

        XCTAssertEqual(localized("%lld matches", 1), "1 wynik")
        XCTAssertEqual(localized("%lld matches", 2), "2 wyniki")
        XCTAssertEqual(localized("%lld matches", 5), "5 wyników")
    }
}
