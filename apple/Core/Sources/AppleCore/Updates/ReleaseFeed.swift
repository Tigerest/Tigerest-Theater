import CryptoKit
import Foundation

/// The community server's signed copy of the GitHub release list. Same checks,
/// order and failure reasons as the desktop `ReleaseFeed`; any failure means the
/// caller asks GitHub instead. HTTPS does not replace the signature: trust comes
/// only from the Ed25519 signature over the decoded payload.
public enum ReleaseFeed {
    public static let productionURL = URL(string: TigerestService.remoteOrigin + "/api/tigerest/v1/app/releases")!
    /// keyId → 32-byte raw public key. A rotation adds a key next to the old one.
    public static let productionKeys: [String: Data] = ["tg-release-1": Data(base64Encoded: "zIJjQTCdN1PbiNIUyVNJmPZys/Pdar/YRvzKYd/knBA=")!]
    public static let maximumEnvelopeBytes = 2 * 1024 * 1024
    static let maximumPayloadBytes = 1024 * 1024
    static let maximumReleases = 30
    static let futureAllowance: TimeInterval = 10 * 60
    static let maximumAge: TimeInterval = 72 * 3600

    public struct Rejected: Error, Equatable, CustomStringConvertible {
        public let reason: String
        public var description: String { reason }
    }

    /// The GitHub-shaped release array inside a valid envelope.
    public static func releases(envelope: Data, keys: [String: Data] = productionKeys, now: Date = Date()) throws -> [JSONValue] {
        func reject(_ reason: String) -> Rejected { Rejected(reason: reason) }
        guard envelope.count <= maximumEnvelopeBytes else { throw reject("envelope over 2 MiB") }
        let outer = (try? JSONDecoder().decode(JSONValue.self, from: envelope)) ?? .null
        guard let keyID = outer["keyId"].string, let key = keys[keyID] else { throw reject("unknown keyId") }
        guard let payload = strictBase64(outer["payload"].string), let signature = strictBase64(outer["signature"].string) else {
            throw reject("payload or signature missing or not base64")
        }
        guard payload.count <= maximumPayloadBytes else { throw reject("payload over 1 MiB") }
        guard verify(signature: signature, message: payload, publicKey: key) else { throw reject("bad signature") }
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: payload), body.object != nil else {
            throw reject("payload is not an object")
        }
        guard case .number(let schema) = body["schema"], schema == 1,
              body["repository"].string == "Tigerest/Tigerest-Theater" else { throw reject("unexpected schema or repository") }
        guard let issued = timestamp(body["issuedAt"].string), let fetched = timestamp(body["fetchedAt"].string) else {
            throw reject("bad timestamps")
        }
        guard fetched <= issued else { throw reject("fetchedAt after issuedAt") }
        guard issued <= now.addingTimeInterval(futureAllowance) else { throw reject("issuedAt in the future") }
        guard fetched >= now.addingTimeInterval(-maximumAge) else { throw reject("release list older than 72 hours") }
        guard let releases = body["releases"].array else { throw reject("releases missing") }
        guard releases.count <= maximumReleases else { throw reject("more than 30 releases") }
        return releases
    }

    /// Ed25519 through the system (CryptoKit). Malformed keys or signatures are invalid.
    public static func verify(signature: Data, message: Data, publicKey: Data) -> Bool {
        guard signature.count == 64, let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    /// Standard, padded base64 that re-encodes to the same text, and is not empty.
    private static func strictBase64(_ text: String?) -> Data? {
        guard let text, let data = Data(base64Encoded: text), !data.isEmpty, data.base64EncodedString() == text else { return nil }
        return data
    }

    /// Exactly YYYY-MM-DDTHH:mm:ssZ, no fractional seconds.
    private static func timestamp(_ text: String?) -> Date? {
        guard let text, text.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"#, options: .regularExpression) != nil else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}
