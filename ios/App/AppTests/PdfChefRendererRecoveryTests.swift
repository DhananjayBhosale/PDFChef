import XCTest
@testable import App

final class PdfChefRendererRecoveryTests: XCTestCase {
    private let server = URL(string: "capacitor://localhost")!

    func testReopensTheSamePackagedScreenWithTheFragment() {
        XCTAssertEqual(recovery("capacitor://localhost/merge?from=home"), "capacitor://localhost/merge?from=home#renderer-restarted")
        XCTAssertEqual(recovery("capacitor://localhost/"), "capacitor://localhost/#renderer-restarted")
        XCTAssertEqual(recovery("capacitor://localhost/settings#licenses"), "capacitor://localhost/settings#renderer-restarted")
    }

    func testLeavesOtherPagesAlone() {
        XCTAssertNil(recovery("https://localhost/merge"))
        XCTAssertNil(recovery("capacitor://example.com/merge"))
        XCTAssertNil(PdfChefRendererRecovery.recoveryURL(for: nil, serverURL: server))
    }

    private func recovery(_ url: String) -> String? {
        PdfChefRendererRecovery.recoveryURL(for: URL(string: url), serverURL: server)?.absoluteString
    }
}
