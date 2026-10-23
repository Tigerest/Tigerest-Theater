import AppleCore
import SwiftUI

struct TVServerPickerView: View {
    @ObservedObject var model: TVAppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack {
                Text("切换 / 管理服务器").font(.largeTitle.bold())
                Spacer()
                Button("取消") { model.closeServerSettings() }.accessibilityIdentifier("tv.servers.cancel")
            }.focusSection()
            if model.serverMode != nil {
                TVLoginView(model: model)
            } else {
                ScrollView {
                    TVServerListView(model: model)
                    HStack(spacing: 30) {
                        Button("添加自建服务器") { model.selectServer(.selfHosted) }.accessibilityIdentifier("tv.servers.add")
                        if !Distribution.testFlight {
                            Button("专属服务器") { model.selectServer(.dedicated) }.accessibilityIdentifier("tv.servers.dedicated")
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).focusSection().padding(.top, 24)
                }
            }
        }
        .padding(64).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.043, green: 0.051, blue: 0.071)).preferredColorScheme(.dark)
        .onExitCommand { if model.serverMode != nil { model.resetServerSelection() } else { model.closeServerSettings() } }
    }
}

struct TVServerListView: View {
    @ObservedObject var model: TVAppModel
    @State private var removal: ServerHistory.Record?
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if !model.rememberedServers.isEmpty { Text("已连接的服务器").font(.title2) }
            ForEach(model.rememberedServers) { record in
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(record.title).font(.headline)
                        if record.key == model.currentServerKey { Text("当前").font(.callout).foregroundStyle(.orange) }
                    }
                    Text([record.kind?.capitalized, record.address].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    if model.connectingServerKey == record.key {
                        if model.busy { ProgressView("正在连接…") }
                        if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange) }
                    }
                    HStack(spacing: 26) {
                        Button(model.connectingServerKey == record.key && model.error != nil ? "重试" : "连接") {
                            Task { await model.connectRememberedServer(record) }
                        }.accessibilityIdentifier("tv.server.connect." + record.key)
                            .disabled(model.busy && model.connectingServerKey == record.key)
                        if record.mode == "custom" {
                            Button("编辑地址") { model.editServer(record) }.accessibilityIdentifier("tv.server.edit." + record.key)
                        }
                        if record.key != model.currentServerKey {
                            Button("移除", role: .destructive) { removal = record }.accessibilityIdentifier("tv.server.remove." + record.key)
                        }
                    }.padding(.top, 8)
                }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
            }
        }
        .confirmationDialog("移除服务器记录？", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }), titleVisibility: .visible, presenting: removal) { record in
            Button("确认移除", role: .destructive) { model.forgetServer(record.key); removal = nil }
            Button("取消", role: .cancel) { removal = nil }
        } message: { _ in Text("只移除列表项，不退出账号或删除媒体。") }
    }
}
