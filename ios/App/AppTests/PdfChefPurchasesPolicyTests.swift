import Foundation
import XCTest
@testable import App

final class PdfChefPurchasesPolicyTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "PdfChefPurchasesPolicyTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testFirstFreeJobStartsSevenDayWindowAndConsumesOneDelivery() {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let now = Date(timeIntervalSinceReferenceDate: 10_000)

        XCTAssertEqual(quota.access(now: now).freeJobsRemaining, 5)
        XCTAssertNil(quota.access(now: now).freeWindowEndsAt)
        XCTAssertEqual(quota.record(operationID: "job-1", now: now), .allowed)

        let access = quota.access(now: now)
        XCTAssertEqual(access.freeJobsRemaining, 4)
        XCTAssertEqual(access.freeWindowEndsAt, now.addingTimeInterval(PdfChefFreeJobQuota.windowDuration))
    }

    func testOperationIDIsIdempotentAndTheSixthDistinctJobIsExhausted() {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let now = Date(timeIntervalSinceReferenceDate: 20_000)

        XCTAssertEqual(quota.record(operationID: "same-job", now: now), .allowed)
        XCTAssertEqual(quota.record(operationID: "same-job", now: now), .allowed)
        XCTAssertEqual(quota.access(now: now).freeJobsRemaining, 4)
        for number in 2...5 {
            XCTAssertEqual(quota.record(operationID: "job-\(number)", now: now), .allowed)
        }
        XCTAssertEqual(quota.record(operationID: "job-6", now: now), .exhausted)
        XCTAssertEqual(quota.access(now: now).freeJobsRemaining, 0)
    }

    func testAJobAfterTheWindowStartsANewQuota() {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let start = Date(timeIntervalSinceReferenceDate: 30_000)
        XCTAssertEqual(quota.record(operationID: "old-job", now: start), .allowed)

        let nextWindow = start.addingTimeInterval(PdfChefFreeJobQuota.windowDuration + 1)
        XCTAssertEqual(quota.record(operationID: "new-job", now: nextWindow), .allowed)
        XCTAssertEqual(quota.access(now: nextWindow).freeJobsRemaining, 4)
        XCTAssertEqual(
            quota.access(now: nextWindow).freeWindowEndsAt,
            nextWindow.addingTimeInterval(PdfChefFreeJobQuota.windowDuration)
        )
    }

    func testSplitPartsAreRefusedOnceTheFreeAllowanceIsUsed() {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let now = Date(timeIntervalSinceReferenceDate: 40_000)
        XCTAssertEqual(
            PdfChefPurchasesPlugin.generatedJobStatus(entitled: false, quota: quota, operationID: "split:doc", now: now),
            .allowed
        )
        for index in 1...4 {
            XCTAssertEqual(quota.record(operationID: "job-\(index)", now: now), .allowed)
        }

        XCTAssertEqual(
            PdfChefPurchasesPlugin.generatedJobStatus(entitled: false, quota: quota, operationID: "split:other", now: now),
            .exhausted
        )
        XCTAssertEqual(
            PdfChefPurchasesPlugin.generatedJobStatus(entitled: false, quota: quota, operationID: "split:doc", now: now),
            .allowed,
            "Retrying a split already counted this window does not need a second job"
        )
    }

    func testEntitledSplitsDoNotSpendTheFreeAllowance() {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let now = Date(timeIntervalSinceReferenceDate: 50_000)

        XCTAssertEqual(
            PdfChefPurchasesPlugin.generatedJobStatus(entitled: true, quota: quota, operationID: "split:doc", now: now),
            .allowed
        )
        XCTAssertEqual(quota.access(now: now).freeJobsRemaining, PdfChefFreeJobQuota.maximumFreeJobs)
    }

    func testCancelledNativeSplitsReleaseEveryReservation() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try PdfChefDocumentStore(rootURL: root)
        let cancellation = PdfChefPdfBatchCancellationToken()
        cancellation.cancel()

        for index in 0..<5 {
            let token = try reservation(quota, operationID: "cancelled-\(index)")
            XCTAssertThrowsError(try PdfChefPdfBatcher().split(
                documentURL: root.appendingPathComponent("unused.pdf"),
                baseName: "unused.pdf",
                store: store,
                cancellation: cancellation,
                progress: { _ in }
            )) { error in
                guard case PdfChefPdfBatcherError.cancelled = error else {
                    return XCTFail("Expected cancellation, got \(error)")
                }
            }
            quota.finish(reservation: token, succeeded: false)
        }

        XCTAssertEqual(quota.access().freeJobsRemaining, 5)
        XCTAssertNil(quota.access().freeWindowEndsAt)
        XCTAssertTrue(try store.listDocuments().isEmpty)
        XCTAssertEqual(quota.record(operationID: "next-completed-job"), .allowed)
    }

    func testSuccessIsChargedOnceAndAnAlreadyPaidRetryCannotRefundIt() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let token = try reservation(quota, operationID: "split")
        quota.finish(reservation: token, succeeded: true)
        quota.finish(reservation: token, succeeded: false)
        XCTAssertEqual(quota.reserve(operationID: "split"), .allowed(nil))
        XCTAssertEqual(quota.access().freeJobsRemaining, 4)
        XCTAssertEqual(PdfChefFreeJobQuota(defaults: defaults, key: "quota").access().freeJobsRemaining, 4)
    }

    func testReservationsAndCompletedWebJobsShareTheLastSlot() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        for index in 0..<4 { XCTAssertEqual(quota.record(operationID: "web-\(index)"), .allowed) }
        let token = try reservation(quota, operationID: "split")
        XCTAssertEqual(quota.reserve(operationID: "other-split"), .exhausted)
        XCTAssertEqual(quota.record(operationID: "other-web"), .exhausted)
        quota.finish(reservation: token, succeeded: false)
        XCTAssertEqual(quota.record(operationID: "other-web"), .allowed)
    }

    func testOverlappingAttemptsForTheSameOperationKeepIndependentReservations() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let first = try reservation(quota, operationID: "split")
        let second = try reservation(quota, operationID: "split")
        XCTAssertEqual(quota.access().freeJobsRemaining, 4)
        quota.finish(reservation: first, succeeded: false)
        XCTAssertEqual(quota.access().freeJobsRemaining, 4)
        quota.finish(reservation: second, succeeded: true)
        XCTAssertEqual(quota.access().freeJobsRemaining, 4)
    }

    func testFailingAttemptCannotRefundAnotherSuccessfulAttempt() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let first = try reservation(quota, operationID: "split")
        let second = try reservation(quota, operationID: "split")
        quota.finish(reservation: first, succeeded: true)
        quota.finish(reservation: second, succeeded: false)
        XCTAssertEqual(quota.access().freeJobsRemaining, 4)
    }

    func testWebCompletionOfReservedOperationDoesNotSpendTwice() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let token = try reservation(quota, operationID: "split")
        for index in 0..<4 { XCTAssertEqual(quota.record(operationID: "web-\(index)"), .allowed) }
        XCTAssertEqual(quota.record(operationID: "split"), .allowed)
        quota.finish(reservation: token, succeeded: true)
        XCTAssertEqual(quota.access().freeJobsRemaining, 0)
    }

    func testLiveReservationStillCountsWhenThePreviousWindowExpires() throws {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let start = Date(timeIntervalSinceReferenceDate: 100_000)
        XCTAssertEqual(quota.record(operationID: "old-web", now: start), .allowed)
        let token = try reservation(quota, operationID: "split", now: start)
        let nextWindow = start.addingTimeInterval(PdfChefFreeJobQuota.windowDuration + 1)
        XCTAssertEqual(quota.access(now: nextWindow).freeJobsRemaining, 4)
        for index in 0..<4 {
            XCTAssertEqual(quota.record(operationID: "new-web-\(index)", now: nextWindow), .allowed)
        }
        XCTAssertEqual(quota.record(operationID: "extra-web", now: nextWindow), .exhausted)
        quota.finish(reservation: token, succeeded: true, now: nextWindow)
        XCTAssertEqual(quota.access(now: nextWindow).freeJobsRemaining, 0)
    }

    func testConcurrentReservationsCannotOverspend() {
        let quota = PdfChefFreeJobQuota(defaults: defaults, key: "quota")
        let lock = NSLock()
        var tokens: [UUID] = []
        DispatchQueue.concurrentPerform(iterations: 30) { index in
            guard case .allowed(let token) = quota.reserve(operationID: "split-\(index)"), let token else { return }
            lock.lock()
            tokens.append(token)
            lock.unlock()
        }
        XCTAssertEqual(tokens.count, 5)
        XCTAssertEqual(quota.access().freeJobsRemaining, 0)
        for token in tokens { quota.finish(reservation: token, succeeded: false) }
        XCTAssertEqual(quota.access().freeJobsRemaining, 5)
    }

    private func reservation(
        _ quota: PdfChefFreeJobQuota,
        operationID: String,
        now: Date = Date()
    ) throws -> UUID {
        guard case .allowed(let token) = quota.reserve(operationID: operationID, now: now) else {
            XCTFail("Expected an available reservation")
            throw CocoaError(.featureUnsupported)
        }
        return try XCTUnwrap(token)
    }
}
