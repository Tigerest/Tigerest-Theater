import Foundation

/// The version the app reports and compares, and the build it was made from.
/// App Store fields allow only three numbers, so a fix release such as 2.9.5.1
/// would keep CFBundleShortVersionString at 2.9.5 and name itself in
/// TigerestVersion; without that key the short version is the whole version.
public enum AppVersion {
    public static func full(_ info: [String: Any]?) -> String {
        let short = info?["CFBundleShortVersionString"] as? String ?? "unknown"
        guard let full = info?["TigerestVersion"] as? String, full.hasPrefix(short + "."),
              full.range(of: #"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.[1-9][0-9]?$"#, options: .regularExpression) != nil else { return short }
        return full
    }
    /// "CFBundleVersion · commit", shown on the update page so a test package can be told apart.
    public static func buildNumber(_ info: [String: Any]?, revision: String?) -> String {
        let commit = revision.flatMap { $0.range(of: "^[0-9a-f]{8,40}$", options: .regularExpression) == nil ? nil : String($0.prefix(8)) }
        return [info?["CFBundleVersion"] as? String, commit].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }
    public static var current: String { full(Bundle.main.infoDictionary) }
}
