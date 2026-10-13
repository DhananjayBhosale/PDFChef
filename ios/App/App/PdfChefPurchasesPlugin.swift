import Capacitor
import Foundation
import StoreKit
import UIKit

@objc(PdfChefPurchasesPlugin)
final class PdfChefPurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PdfChefPurchasesPlugin"
    let jsName = "PdfChefPurchases"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordFreeJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise)
    ]

    static let lifetimeProductID = "com.dhananjaytech.pdfchef.pro.lifetime"
    static let monthlyProductID = "com.dhananjaytech.pdfchef.pro.monthly"
    private static let productIDs: Set<String> = [lifetimeProductID, monthlyProductID]

    private let freeJobQuota = PdfChefFreeJobQuota()
    private var transactionUpdatesTask: Task<Void, Never>?

    @MainActor private var productsByID: [String: Product] = [:]
    @MainActor private var entitlementState = PdfChefEntitlementState()

    @objc override func load() {
        transactionUpdatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                await self.handleTransactionUpdate(result)
            }
        }
        Task { @MainActor [weak self] in
            await self?.refreshEntitlements(notify: false)
        }
    }

    deinit {
        transactionUpdatesTask?.cancel()
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let products = try await self.loadProducts()
                let payload = products
                    .filter { Self.productIDs.contains($0.id) }
                    .sorted { $0.id < $1.id }
                    .map(Self.productDictionary)
                call.resolve(["products": payload])
            } catch {
                self.reject(call, message: "Products could not be loaded.", code: "PRODUCTS_UNAVAILABLE", error: error)
            }
        }
    }

    @objc func getAccessState(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.refreshEntitlements(notify: false)
            call.resolve(self.accessDictionary())
        }
    }

    @objc func recordFreeJob(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let operationID = call.getString("operationId")?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !operationID.isEmpty,
                  operationID.utf8.count <= 256 else {
                call.reject("operationId must be a non-empty value up to 256 bytes.", "INVALID_OPERATION_ID")
                return
            }

            let result = await self.recordGeneratedJob(operationID: operationID)
            call.resolve(["status": result.rawValue, "access": self.accessDictionary()])
        }
    }

    /// The single entitlement and free-job decision for a generated result, whether the web
    /// layer or native code (such as split parts) produced it. Idempotent per operation ID.
    @MainActor func recordGeneratedJob(operationID: String) async -> PdfChefFreeJobStatus {
        await refreshEntitlements(notify: false)
        let result = Self.generatedJobStatus(
            entitled: entitlementState.lifetimeOwned || entitlementState.monthlyActive,
            quota: freeJobQuota,
            operationID: operationID
        )
        notifyListeners("accessChanged", data: accessDictionary())
        return result
    }

    static func generatedJobStatus(
        entitled: Bool,
        quota: PdfChefFreeJobQuota,
        operationID: String,
        now: Date = Date()
    ) -> PdfChefFreeJobStatus {
        entitled ? .allowed : quota.record(operationID: operationID, now: now)
    }

    /// Native processing reserves capacity before producing files, then charges only
    /// after it succeeds. A failed or cancelled attempt releases its own reservation.
    @MainActor func reserveGeneratedJob(operationID: String) async -> PdfChefFreeJobReservationResult {
        await refreshEntitlements(notify: false)
        if entitlementState.lifetimeOwned || entitlementState.monthlyActive { return .allowed(nil) }
        let result = freeJobQuota.reserve(operationID: operationID)
        notifyListeners("accessChanged", data: accessDictionary())
        return result
    }

    @MainActor func finishGeneratedJob(reservation: UUID?, succeeded: Bool) {
        guard let reservation else { return }
        freeJobQuota.finish(reservation: reservation, succeeded: succeeded)
        notifyListeners("accessChanged", data: accessDictionary())
    }

    @objc func purchase(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let productID = call.getString("productId"), Self.productIDs.contains(productID) else {
                call.reject("productId is not a PDF Chef product.", "INVALID_PRODUCT_ID")
                return
            }

            do {
                let product = try await self.product(for: productID)
                switch try await product.purchase() {
                case .success(let result):
                    let transaction = try self.verifiedTransaction(result)
                    guard Self.productIDs.contains(transaction.productID) else {
                        call.reject("The transaction does not belong to PDF Chef.", "INVALID_TRANSACTION")
                        return
                    }
                    await transaction.finish()
                    await self.refreshEntitlements(notify: true)
                    call.resolve(["status": "purchased", "access": self.accessDictionary()])
                case .pending:
                    await self.refreshEntitlements(notify: false)
                    call.resolve(["status": "pending", "access": self.accessDictionary()])
                case .userCancelled:
                    await self.refreshEntitlements(notify: false)
                    call.resolve(["status": "cancelled", "access": self.accessDictionary()])
                @unknown default:
                    await self.refreshEntitlements(notify: false)
                    call.resolve(["status": "cancelled", "access": self.accessDictionary()])
                }
            } catch {
                self.reject(call, message: "Purchase could not be completed.", code: "PURCHASE_FAILED", error: error)
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await AppStore.sync()
                await self.refreshEntitlements(notify: true)
                call.resolve(["access": self.accessDictionary()])
            } catch {
                self.reject(call, message: "Purchases could not be restored.", code: "RESTORE_FAILED", error: error)
            }
        }
    }

    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }) else {
                call.reject("No active window is available to manage subscriptions.", "NO_ACTIVE_WINDOW")
                return
            }
            Task {
                do {
                    try await AppStore.showManageSubscriptions(in: scene)
                    call.resolve()
                } catch {
                    call.reject("Subscriptions could not be opened.", "MANAGE_SUBSCRIPTIONS_FAILED", error)
                }
            }
        }
    }

    @MainActor private func handleTransactionUpdate(_ result: VerificationResult<Transaction>) async {
        do {
            let transaction = try verifiedTransaction(result)
            guard Self.productIDs.contains(transaction.productID) else { return }
            // StoreKit must only be finished after its signature has been verified.
            await transaction.finish()
            await refreshEntitlements(notify: true)
        } catch {
            // An unverified transaction is intentionally left unfinished.
        }
    }

    @MainActor private func product(for productID: String) async throws -> Product {
        if let product = productsByID[productID] { return product }
        _ = try await loadProducts()
        guard let product = productsByID[productID] else {
            throw PdfChefPurchasesError.productUnavailable
        }
        return product
    }

    @MainActor private func loadProducts() async throws -> [Product] {
        let products = try await Product.products(for: Array(Self.productIDs))
        productsByID = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        return products
    }

    @MainActor private func refreshEntitlements(notify: Bool) async {
        var lifetimeOwned = false
        var monthlyExpirationDate: Date?
        let now = Date()

        for await result in Transaction.currentEntitlements {
            guard let transaction = try? verifiedTransaction(result),
                  Self.productIDs.contains(transaction.productID),
                  transaction.revocationDate == nil else {
                continue
            }

            switch transaction.productID {
            case Self.lifetimeProductID:
                lifetimeOwned = true
            case Self.monthlyProductID:
                guard transaction.expirationDate.map({ $0 > now }) ?? true else { continue }
                if let expiration = transaction.expirationDate,
                   monthlyExpirationDate.map({ expiration > $0 }) ?? true {
                    monthlyExpirationDate = expiration
                }
            default:
                break
            }
        }

        let updated = PdfChefEntitlementState(
            lifetimeOwned: lifetimeOwned,
            monthlyExpirationDate: monthlyExpirationDate
        )
        let changed = updated != entitlementState
        entitlementState = updated
        if notify && changed {
            notifyListeners("accessChanged", data: accessDictionary())
        }
    }

    @MainActor private func accessDictionary() -> [String: Any] {
        let quota = freeJobQuota.access()
        let unlocked = entitlementState.lifetimeOwned || entitlementState.monthlyActive
        return [
            "unlocked": unlocked,
            "lifetimeOwned": entitlementState.lifetimeOwned,
            "monthlyActive": entitlementState.monthlyActive,
            "monthlyExpirationDate": entitlementState.monthlyExpirationDate.map(Self.iso8601String) ?? NSNull(),
            "freeJobsRemaining": quota.freeJobsRemaining,
            "freeWindowEndsAt": quota.freeWindowEndsAt.map(Self.iso8601String) ?? NSNull()
        ]
    }

    private func verifiedTransaction(_ result: VerificationResult<Transaction>) throws -> Transaction {
        switch result {
        case .verified(let transaction):
            return transaction
        case .unverified:
            throw PdfChefPurchasesError.unverifiedTransaction
        }
    }

    private static func productDictionary(_ product: Product) -> [String: Any] {
        [
            "productId": product.id,
            "kind": product.id == lifetimeProductID ? "lifetime" : "monthly",
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice
        ]
    }

    private static func iso8601String(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func reject(_ call: CAPPluginCall, message: String, code: String, error: Error) {
        call.reject(message, code, error)
    }
}

enum PdfChefPurchasesError: Error {
    case productUnavailable
    case unverifiedTransaction
}

private struct PdfChefEntitlementState: Equatable {
    var lifetimeOwned = false
    var monthlyExpirationDate: Date?

    var monthlyActive: Bool {
        monthlyExpirationDate.map { $0 > Date() } ?? false
    }
}

enum PdfChefFreeJobStatus: String, Equatable {
    case allowed
    case exhausted
}

enum PdfChefFreeJobReservationResult: Equatable {
    /// Nil means this operation is already paid for, or the user is entitled.
    case allowed(UUID?)
    case exhausted
}

struct PdfChefFreeJobQuotaAccess: Equatable {
    let freeJobsRemaining: Int
    let freeWindowEndsAt: Date?
}

final class PdfChefFreeJobQuota {
    static let maximumFreeJobs = 5
    static let windowDuration: TimeInterval = 7 * 24 * 60 * 60

    private struct StoredState: Codable {
        var windowStartedAt: Date?
        var operationIDs: Set<String>
    }

    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()
    private var reservations: [UUID: String] = [:]

    init(defaults: UserDefaults = .standard, key: String = "com.dhananjaytech.pdfchef.free-job-quota") {
        self.defaults = defaults
        self.key = key
    }

    func access(now: Date = Date()) -> PdfChefFreeJobQuotaAccess {
        lock.lock()
        defer { lock.unlock() }
        var state = loadState()
        if normalize(&state, now: now) { save(state) }
        return makeAccess(state, now: now)
    }

    func record(operationID: String, now: Date = Date()) -> PdfChefFreeJobStatus {
        lock.lock()
        defer { lock.unlock() }
        var state = loadState()
        _ = normalize(&state, now: now)

        if state.operationIDs.contains(operationID) {
            save(state)
            return .allowed
        }
        guard reservations.values.contains(operationID)
                || occupiedOperations(state).count < Self.maximumFreeJobs else {
            save(state)
            return .exhausted
        }

        if state.windowStartedAt == nil { state.windowStartedAt = now }
        state.operationIDs.insert(operationID)
        save(state)
        return .allowed
    }

    func reserve(operationID: String, now: Date = Date()) -> PdfChefFreeJobReservationResult {
        lock.lock()
        defer { lock.unlock() }
        var state = loadState()
        if normalize(&state, now: now) { save(state) }
        if state.operationIDs.contains(operationID) { return .allowed(nil) }
        guard reservations.values.contains(operationID)
                || occupiedOperations(state).count < Self.maximumFreeJobs else { return .exhausted }
        let token = UUID()
        reservations[token] = operationID
        return .allowed(token)
    }

    func finish(reservation: UUID, succeeded: Bool, now: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        guard let operationID = reservations.removeValue(forKey: reservation) else { return }
        guard succeeded else { return }
        var state = loadState()
        _ = normalize(&state, now: now)
        if state.windowStartedAt == nil { state.windowStartedAt = now }
        state.operationIDs.insert(operationID)
        save(state)
    }

    private func occupiedOperations(_ state: StoredState) -> Set<String> {
        state.operationIDs.union(reservations.values)
    }

    private func loadState() -> StoredState {
        guard let data = defaults.data(forKey: key),
              let state = try? JSONDecoder().decode(StoredState.self, from: data) else {
            return StoredState(windowStartedAt: nil, operationIDs: [])
        }
        return state
    }

    private func save(_ state: StoredState) {
        defaults.set(try? JSONEncoder().encode(state), forKey: key)
    }

    @discardableResult
    private func normalize(_ state: inout StoredState, now: Date) -> Bool {
        guard let startedAt = state.windowStartedAt else { return false }
        guard now >= startedAt.addingTimeInterval(Self.windowDuration) else { return false }
        state = StoredState(windowStartedAt: nil, operationIDs: [])
        return true
    }

    private func makeAccess(_ state: StoredState, now: Date) -> PdfChefFreeJobQuotaAccess {
        let remaining = max(0, Self.maximumFreeJobs - occupiedOperations(state).count)
        let endsAt = state.windowStartedAt.map { $0.addingTimeInterval(Self.windowDuration) }
        return PdfChefFreeJobQuotaAccess(freeJobsRemaining: remaining, freeWindowEndsAt: endsAt)
    }
}
