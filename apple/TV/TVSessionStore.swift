import AppleCore
import Foundation
import Security

/// A device-local TV session. Passwords never enter the persistence layer.
struct TVSessionStore {
    private let service: String

    init(service: String = "top.tigerest.theater.tv") {
        self.service = service
    }

    func loadState() throws -> ServerSessionHistory {
        var state: ServerSessionHistory
        if let data = try read(account: "server-state") { state = try JSONDecoder().decode(ServerSessionHistory.self, from: data) }
        else {
            let old = try read(account: "session").map { try JSONDecoder().decode(EmbySession.self, from: $0) }
            let mode = old.flatMap { try? ServerAddress($0.serverURL) }.map {
                ServerPresets.bundled.contains($0) || TigerestService.movedEmby($0.baseURL.absoluteString) != nil ? "tigerest" : "custom"
            } ?? "custom"
            state = ServerSessionHistory(current: old, mode: mode)
        }
        // Saved on the old public address: moved and stored before anything connects.
        if state.moveDedicated() { try writeState(state) }
        return state
    }
    private func writeState(_ state: ServerSessionHistory) throws {
        // One Keychain write commits history and the active session together.
        try write(JSONEncoder().encode(state), account: "server-state")
        SecItemDelete(query(account: "session") as CFDictionary)
    }
    func load() throws -> EmbySession? { try loadState().current }
    func save(_ session: EmbySession) throws {
        var state = try loadState(); state.updateCurrent(session); try writeState(state)
    }
    func commit(_ session: EmbySession, mode: String, replacing: String?, name: String?) throws {
        var state = try loadState()
        try state.commit(session, mode: mode, replacing: replacing, name: name)
        try writeState(state)
    }
    func forget(_ key: String) throws {
        var state = try loadState(); try state.forget(key: key); try writeState(state)
    }
    func clear() throws {
        var state = try loadState(); state.logout(); try writeState(state)
    }

    func deviceID() throws -> String {
        if let data = try read(account: "device-id"),
           let value = String(data: data, encoding: .utf8), !value.isEmpty {
            return value
        }
        let value = UUID().uuidString
        try write(Data(value.utf8), account: "device-id")
        return value
    }

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func read(account: String) throws -> Data? {
        var request = query(account: account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw StoreError(status: status)
        }
        return data
    }

    private func write(_ data: Data, account: String) throws {
        let request = query(account: account)
        let status = SecItemUpdate(request as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var addition = request
            addition[kSecValueData as String] = data
            addition[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addition as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw StoreError(status: addStatus) }
        } else if status != errSecSuccess {
            throw StoreError(status: status)
        }
    }

    private struct StoreError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            "无法读取或保存 Apple TV 的安全登录信息（\(status)），请重试。"
        }
    }
}
