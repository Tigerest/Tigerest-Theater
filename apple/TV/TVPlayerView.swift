import SwiftUI

private struct TVVideoSurface: UIViewRepresentable {
    let player: TVPlaybackController
    func makeUIView(context: Context) -> MetalSurface { player.surface }
    func updateUIView(_ view: MetalSurface, context: Context) {}
}

struct TVPlayerView: View {
    @ObservedObject var player: TVPlaybackController
    @ObservedObject var model: TVAppModel
    @State private var controlsVisible = true
    @State private var interaction = 0
    @State private var showingDanmaku = false
    @State private var showingSubtitles = false
    @State private var showingEpisodes = false
    @State private var panelDismissedAt = Date.distantPast
    @FocusState private var focused: Bool
    private func reveal() { controlsVisible = true; interaction += 1 }
    private var panelVisible: Bool { showingSubtitles || showingDanmaku || showingEpisodes }
    private func time(_ value: Double) -> String {
        let s = value.isFinite ? Int(min(1_000_000_000, max(0, value))) : 0; return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            TVVideoSurface(player: player).ignoresSafeArea()
            if let repository = player.danmaku { DanmakuOverlay(repository: repository, player: player).ignoresSafeArea().allowsHitTesting(false) }
            if player.buffering { ProgressView("正在缓冲").frame(maxWidth: .infinity, maxHeight: .infinity) }
            if controlsVisible {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 30) {
                        Text(player.title).font(.title2).lineLimit(2).accessibilityIdentifier("tv.player.title")
                        Spacer()
                        Text(time(player.position) + " / " + time(player.duration)).monospacedDigit().accessibilityIdentifier("tv.player.position")
                    }
                    if model.currentEpisodeID != nil {
                        HStack(spacing: 24) {
                            Button("上一集") { Task { await model.playPreviousEpisode(); reveal() } }
                                .disabled(!model.canPlayPreviousEpisode || model.busy || model.episodeLoading)
                                .accessibilityIdentifier("tv.player.previous")
                            Button("选集") { showingEpisodes = true; reveal() }.accessibilityIdentifier("tv.player.episodes")
                            Button("下一集") { Task { await model.playNextEpisode(); reveal() } }
                                .disabled(!model.canPlayNextEpisode || model.busy || model.episodeLoading)
                                .accessibilityIdentifier("tv.player.next")
                            if model.busy || model.episodeLoading { ProgressView("正在准备剧集…") }
                            Spacer()
                        }
                        if let error = model.episodeError { Text(error).font(.callout).foregroundStyle(.yellow) }
                    }
                    ProgressView(value: min(player.position, max(player.duration, 1)), total: max(player.duration, 1))
                    HStack(spacing: 24) {
                        Button { player.seek(by: -10); reveal() } label: { Label("后退 10 秒", systemImage: "gobackward.10") }.accessibilityIdentifier("tv.player.back")
                        Button { player.togglePause(); reveal() } label: { Label(player.paused ? "播放" : "暂停", systemImage: player.paused ? "play.fill" : "pause.fill") }.focused($focused).accessibilityIdentifier("tv.player.pause")
                        Button { player.seek(by: 10); reveal() } label: { Label("前进 10 秒", systemImage: "goforward.10") }.accessibilityIdentifier("tv.player.forward")
                        Spacer()
                        Button("字幕") { showingSubtitles = true; reveal() }.accessibilityIdentifier("tv.player.subtitles")
                        if player.danmaku != nil { Button("弹幕") { showingDanmaku = true; reveal() }.accessibilityIdentifier("tv.player.danmaku") }
                        Button("退出播放") { player.stop() }.accessibilityIdentifier("tv.player.close")
                    }
                    if let error = player.error { Text(error).font(.callout).foregroundStyle(.yellow) }
                    if let notice = player.notice { Text(notice).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("tv.player.notice") }
                }
                .padding(50).background(.black.opacity(0.78))
            } else {
                Button("显示播放控制") { reveal(); focused = true }
                    .opacity(0.015).accessibilityLabel("显示播放控制").accessibilityIdentifier("tv.player.reveal")
            }
        }
        .onPlayPauseCommand { guard !panelVisible else { return }; player.togglePause(); reveal() }
        .onMoveCommand { direction in
            guard !panelVisible else { return }
            if !controlsVisible {
                if direction == .left { player.seek(by: -10) }
                if direction == .right { player.seek(by: 10) }
                reveal(); focused = true
            } else { reveal() }
        }
        .onExitCommand {
            // A Menu event that dismissed a presented panel must not also
            // leave playback if SwiftUI forwards it during that transition.
            guard !panelVisible, Date().timeIntervalSince(panelDismissedAt) > 0.5 else { return }
            // Back first hides the playback controls; only a bare video leaves.
            if controlsVisible { controlsVisible = false; return }
            player.stop()
        }
        // Pausing (remote, route loss or a room) shows the controls; they stay
        // until Back hides them because the timer below skips paused playback.
        .onChange(of: player.paused) { _, paused in if paused { reveal() } }
        // A new playback notice (settings, interpolation) shows with the controls.
        .onChange(of: player.notice) { _, notice in if notice != nil { reveal() } }
        .task(id: interaction) {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, !player.paused, !player.buffering, !model.busy, !panelVisible else { return }
            controlsVisible = false
        }
        .onAppear { focused = true }
        .fullScreenCover(isPresented: $showingDanmaku, onDismiss: { panelDismissedAt = Date(); reveal(); focused = true }) {
            if let repository = player.danmaku { TVDanmakuControls(repository: repository) }
        }
        .fullScreenCover(isPresented: $showingSubtitles, onDismiss: { panelDismissedAt = Date(); reveal(); focused = true }) {
            TVSubtitleControls(subtitles: player.subtitles)
        }
        .fullScreenCover(isPresented: $showingEpisodes, onDismiss: { panelDismissedAt = Date(); reveal(); focused = true }) {
            TVEpisodeControls(model: model)
        }
    }
}
