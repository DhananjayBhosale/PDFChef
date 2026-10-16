import XCTest
@testable import App

final class PdfChefAppUpdatePolicyTests: XCTestCase {
    func testOffersOnlyANewerStoreVersion() {
        XCTAssertTrue(offer(store: "1.4", installed: "1.3"))
        XCTAssertTrue(offer(store: "1.10", installed: "1.9"))
        XCTAssertTrue(offer(store: "2.0", installed: "1.9.9"))
        XCTAssertFalse(offer(store: "1.3", installed: "1.3"))
        XCTAssertFalse(offer(store: "1.3.0", installed: "1.3"))
        XCTAssertFalse(offer(store: "1.2", installed: "1.3"))
    }

    func testDoesNotOfferAVersionThisIOSCannotInstall() {
        XCTAssertFalse(offer(store: "1.4", installed: "1.3", minimumOS: "28.0", system: "27.0.1"))
        XCTAssertTrue(offer(store: "1.4", installed: "1.3", minimumOS: "27.0", system: "27.0.1"))
        XCTAssertTrue(offer(store: "1.4", installed: "1.3", minimumOS: nil, system: "15.0.0"))
        XCTAssertTrue(offer(store: "1.4", installed: "1.3", minimumOS: "", system: "15.0.0"))
    }

    private func offer(store: String, installed: String, minimumOS: String? = "15.0", system: String = "27.0.0") -> Bool {
        PdfChefAppUpdatePolicy.shouldOffer(
            storeVersion: store,
            storeMinimumOS: minimumOS,
            installedVersion: installed,
            systemVersion: system)
    }
}
