import Foundation

/// Shares PC's stable-release/package identity rules, but only offers release
/// information. A Personal Team build must be signed and installed by Xcode.
public enum UniversalUpdatePolicy {
    private static let repository="https://github.com/Tigerest/Tigerest-Theater"
    private struct Version {
        let numbers:[Int]
        let prerelease:Bool
        // MAJOR.MINOR.PATCH, plus a fourth number (1-99) for a fix release such as
        // 2.9.5.1. A missing fourth number is 0, so 2.9.5 sorts before 2.9.5.1.
        private static let core=#"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:\.([1-9][0-9]?))?"#
        init?(_ value:String,stable:Bool) {
            let pattern=stable ? "^v"+Self.core+"$" : "^v?"+Self.core+#"(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"#
            guard let match=try! NSRegularExpression(pattern:pattern).firstMatch(in:value,range:NSRange(value.startIndex...,in:value)) else {return nil}
            numbers=(1...4).map{match.range(at:$0).location==NSNotFound ? 0 : Int((value as NSString).substring(with:match.range(at:$0)))!}
            prerelease = !stable && match.range(at:5).location != NSNotFound
        }
    }
    public static func state(releases:[JSONValue],currentVersion:String) -> JSONValue {
        var state:[String:JSONValue]=["currentVersion":.string(currentVersion),"version":.string(""),"checkOnly":.bool(true),"status":.string("unpublished"),"message":.string("当前发布列表中没有 iPad / iPhone 正式版。当前开发版请通过 Mac 上的 Xcode 更新。"),"releaseUrl":.string(repository+"/releases")]
        guard let current=Version(currentVersion,stable:false) else {
            state["status"] = .string("error");state["error"] = .string("无法读取当前版本，请重新安装开发版。");return .object(state)
        }
        let stable=releases.compactMap { value -> (JSONValue,Version)? in
            guard value["draft"].bool==false,value["prerelease"].bool==false,let tag=value["tag_name"].string,let version=Version(tag,stable:true) else {return nil}
            return (value,version)
        }.sorted{$1.1.numbers.lexicographicallyPrecedes($0.1.numbers)}
        if let project=stable.first {
            let tag=project.0["tag_name"].string!
            state["projectVersion"] = .string(String(tag.dropFirst()))
            state["notes"] = .string("项目更新说明（不代表此版本已发布 iPad / iPhone 包）\n\n"+String((project.0["body"].string ?? "").prefix(20000)))
            state["releaseUrl"] = .string(repository+"/releases/tag/"+tag)
        }
        // Releases up to 2.9.3 named the package -ipad.ipa; from 2.9.4 it is -universal.ipa.
        let universal=stable.first { release,_ in
            let tag=release["tag_name"].string!,version=String(tag.dropFirst())
            let names=["universal","ipad"].map{"TigerestTheater-"+version+"-"+$0+".ipa"}
            return (release["assets"].array ?? []).contains {
                guard let name=$0["name"].string,names.contains(name),$0["browser_download_url"].string==repository+"/releases/download/"+tag+"/"+name,
                      let size=$0["size"].number,size>0,size<=2*1024*1024*1024,size.rounded()==size,
                      let digest=$0["digest"].string else {return false}
                return digest.range(of:#"^sha256:[0-9a-fA-F]{64}$"#,options:.regularExpression) != nil
            }
        }
        guard let universal else {return .object(state)}
        let tag=universal.0["tag_name"].string!
        let newer=current.numbers.lexicographicallyPrecedes(universal.1.numbers) || (current.numbers==universal.1.numbers && current.prerelease)
        state["status"] = .string(newer ? "available" : "current")
        state["version"] = .string(newer ? String(tag.dropFirst()) : "")
        state["releaseUrl"] = .string(repository+"/releases/tag/"+tag)
        state["notes"] = .string(String((universal.0["body"].string ?? "").prefix(20000)))
        state["message"] = .string(newer ? "发现新的 iPad / iPhone 版本。当前是开发签名版，请在 Mac 上更新源码并通过 Xcode 重新构建安装。" : "当前没有更新的 iPad / iPhone 正式版。开发签名版通过 Mac 上的 Xcode 更新。")
        return .object(state)
    }
}
