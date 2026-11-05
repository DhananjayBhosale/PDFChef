import XCTest
@testable import App

final class PdfChefReviewPolicyTests: XCTestCase {
    private func savedOn(_ policy: PdfChefReviewPolicy, _ days: Int...) -> PdfChefReviewPolicy {
        days.reduce(policy) { $0.afterSave(on: $1) }
    }

    func testAsksOnlyAfterFiveSavesOnThreeDifferentDays() {
        let fourSaves = savedOn(PdfChefReviewPolicy(), 1, 1, 2, 3)
        XCTAssertFalse(fourSaves.readyToAsk)
        XCTAssertTrue(savedOn(fourSaves, 3).readyToAsk)
        XCTAssertFalse(savedOn(PdfChefReviewPolicy(), 5, 5, 5, 5, 5, 5, 5, 5).readyToAsk)
    }

    func testAsksOnlyOnce() {
        let asked = savedOn(PdfChefReviewPolicy(), 1, 2, 3, 3, 3).afterAsk()
        XCTAssertFalse(asked.readyToAsk)
        XCTAssertFalse(savedOn(asked, 4, 5, 6, 6, 6).readyToAsk)
    }

    func testADueAskWaitsWhileTheAppIsNotInFrontAndIsNeverRepeated() throws {
        let suite = "PdfChefReviewPolicyTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for day in [1, 1, 2, 3] {
            XCTAssertFalse(PdfChefReviewPrompt.recordSave(inFront: true, defaults: defaults, today: day))
        }
        XCTAssertFalse(PdfChefReviewPrompt.recordSave(inFront: false, defaults: defaults, today: 3))
        XCTAssertTrue(PdfChefReviewPrompt.recordSave(inFront: true, defaults: defaults, today: 4))
        XCTAssertFalse(PdfChefReviewPrompt.recordSave(inFront: true, defaults: defaults, today: 5))
    }
}
