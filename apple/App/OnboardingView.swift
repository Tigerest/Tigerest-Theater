import SwiftUI
import AppleCore
struct OnboardingView: View {
    @ObservedObject var model: AppModel
    @State private var address = ""
    @State private var mode = ""
    @State private var connecting = false
    @State private var failure = ""
    @State private var replacing: String?
    @State private var activeCard: String?
    @State private var removeRecord: ServerHistory.Record?
    @State private var connectionTask: Task<Void, Never>?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "play.rectangle.on.rectangle.fill").font(.system(size: 56)).foregroundStyle(.orange)
                    Text("大河影院").font(.largeTitle.bold())
                    if mode.isEmpty {
                        if !model.rememberedServers.isEmpty {
                            Text("已连接的服务器").font(.title2)
                            ForEach(model.rememberedServers) { record in serverCard(record) }
                            Divider()
                        }
                        Text("添加服务器").font(.title2)
                        Button("连接大河李斯特专属 EMBY 服务器") { choose("tigerest"); beginConnection() }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                        Text("已有大河专属服务器权限，可直接使用服务器账号登录。").foregroundStyle(.secondary)
                        Button("连接自建 Emby / Jellyfin 服务器") { choose("custom") }
                            .buttonStyle(.bordered).controlSize(.large)
                        Text("连接你自己搭建或获授权使用的 Emby 或 Jellyfin 服务器。").foregroundStyle(.secondary)
                    } else {
                        Text(replacing == nil ? (mode == "tigerest" ? "连接大河专属 EMBY" : "连接自建 Emby / Jellyfin 服务器") : "编辑服务器地址").font(.title2)
                        if mode == "custom" {
                            TextField("服务器地址", text: $address)
                                .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .padding(14).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                                .accessibilityIdentifier("服务器地址").disabled(connecting)
                            Text("支持 HTTP、HTTPS、端口和反向代理子路径。登录将在服务器页面中完成。").font(.callout).foregroundStyle(.secondary)
                        }
                        if connecting { ProgressView("正在连接…") }
                        if !failure.isEmpty { Text(failure).foregroundStyle(.orange).accessibilityIdentifier("连接错误") }
                        Button(mode == "tigerest" ? "重新连接" : "连接服务器") { beginConnection() }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(connecting || (mode == "custom" && address.trimmingCharacters(in: .whitespaces).isEmpty))
                        Button("返回选择服务器") { choose("") }
                    }
                    Divider()
                    Button("离线媒体", systemImage: "arrow.down.circle") { cancelConnection(); model.showOffline = true }
                    Button("管理配置档", systemImage: "person.crop.rectangle") { cancelConnection(); model.showProfiles = true }
                    Text("\(UIDevice.current.userInterfaceIdiom == .phone ? "iOS" : "iPadOS") 26+ · \(AppVersion.current)").font(.caption).foregroundStyle(.secondary)
                }.padding(32).frame(maxWidth: 560).frame(maxWidth: .infinity)
            }
            .toolbar { if model.server != nil { Button("取消") { cancelConnection(); model.showConnection = false } } }
            .onAppear { address = model.server?.baseURL.absoluteString ?? "" }
            .onDisappear { cancelConnection() }
            .confirmationDialog("移除服务器记录？", isPresented: Binding(get: { removeRecord != nil }, set: { if !$0 { removeRecord = nil } }), titleVisibility: .visible, presenting: removeRecord) { record in
                Button("确认移除", role: .destructive) {
                    do { try model.forgetServer(record.key) } catch { model.error = error.localizedDescription }
                    removeRecord = nil
                }
                Button("取消", role: .cancel) { removeRecord = nil }
            } message: { _ in Text("只移除列表记录，不会退出服务器账号或删除媒体。") }
            .sheet(isPresented: $model.showOffline) { OfflineLibraryView(coordinator: model.downloads, model: model) }
            .sheet(isPresented: $model.showProfiles) { ProfileManagerView(model: model) }
        }
    }
    private func serverCard(_ record: ServerHistory.Record) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(record.title).font(.headline); Spacer(); if record.key == model.currentServerKey { Text("当前").foregroundStyle(.orange) } }
            Text([record.kind?.capitalized, record.address].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if activeCard == record.key, connecting { ProgressView("正在连接…") }
            if activeCard == record.key, !failure.isEmpty { Text(failure).foregroundStyle(.orange).accessibilityIdentifier("连接错误") }
            HStack {
                Button(activeCard == record.key && !failure.isEmpty ? "重试" : "连接") { beginConnection(record: record) }
                    .accessibilityIdentifier("server.connect." + record.key).disabled(connecting && activeCard == record.key)
                if record.mode == "custom" {
                    Button("编辑地址") { choose("custom"); address = record.address; replacing = record.key }
                        .accessibilityIdentifier("server.edit." + record.key)
                }
                if record.key != model.currentServerKey {
                    Button("移除", role: .destructive) { cancelConnection(); removeRecord = record }
                        .accessibilityIdentifier("server.remove." + record.key)
                }
            }.buttonStyle(.bordered)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
    }
    private func choose(_ next: String) { cancelConnection(); mode = next; failure = ""; activeCard = nil; replacing = nil }
    private func beginConnection(record: ServerHistory.Record? = nil) {
        cancelConnection(); connecting = true; failure = ""; activeCard = record?.key
        // The attempt owns these values even if the user chooses another option.
        let submittedMode = record?.mode ?? mode, submittedAddress = record?.address ?? address, submittedReplacement = replacing
        connectionTask = Task {
            do {
                if submittedMode == "tigerest" { try await model.connectDedicated(replacing: submittedReplacement) }
                else { try await model.connect(submittedAddress, mode: "custom", replacing: submittedReplacement) }
            } catch {
                guard !Task.isCancelled else { return }
                failure = "无法连接服务器，请检查地址、端口和当前网络后重试。"
            }
            if !Task.isCancelled { connecting = false }
        }
    }
    private func cancelConnection() {
        // Cancelling this view must not invalidate a different profile's startup.
        connectionTask?.cancel(); connectionTask = nil; connecting = false
    }
}
