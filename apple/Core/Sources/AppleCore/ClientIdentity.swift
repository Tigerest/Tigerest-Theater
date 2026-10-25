import Foundation

/// Self-reported client details the comment, danmaku and room services record.
/// They identify the build, never a device or a person.
public enum ClientIdentity {
    public static func headers(platform: String, version: String) -> [String: String] {
        ["X-Tigerest-Client-Name": "Tigerest Theater", "X-Tigerest-Client-Version": clean(version, 40), "X-Tigerest-Client-Platform": clean(platform, 32)]
    }
    static func clean(_ value: String, _ limit: Int) -> String {
        String(String(value.unicodeScalars.filter { $0.isASCII && $0.value >= 32 && $0.value != 127 }).trimmingCharacters(in: .whitespaces).prefix(limit))
    }
}
