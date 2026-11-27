#ifndef PLAYERCOMPONENT_H
#define PLAYERCOMPONENT_H

#include <QObject>
#include <QtCore/qglobal.h>
#include <QVariant>
#include <QSet>
#include <QList>
#include <QQuickWindow>
#include <QTimer>
#include <QPointer>
#include <QJsonObject>
#include <QHash>
#include <QTextStream>

#include <functional>
#include <memory>
#include <QElapsedTimer>
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
#include "interpolation/InterpolationPolicy.h"
namespace rife {class FrameInterpolationController;class MpvPollAccess;}
#endif
#ifdef Q_OS_WIN
namespace rife {class RifeRuntimeManager;class RifePlaybackCoordinator;class RifeExtensionManager;}
class QFileDialog;
class WindowsHdrSwitch;
class SystemLoad;
#endif
#ifdef Q_OS_MAC
class SystemLoad;
#endif

#include "ComponentManager.h"
#include "QtHelper.h"
#include "MpvConfDocument.h"

#include <mpv/client.h>

class MpvController;
class AlbumArtProvider;

///////////////////////////////////////////////////////////////////////////////////////////////////
class PlayerComponent : public ComponentBase
{
  Q_OBJECT
  DEFINE_SINGLETON(PlayerComponent);

public:
  const char* componentName() override { return "player"; }
  bool componentExport() override { return true; }
  bool componentInitialize() override;
  void componentPostInitialize() override;
  
  explicit PlayerComponent(QObject* parent = nullptr);
  ~PlayerComponent() override;
#ifdef Q_OS_WIN
  // Native-only: caller supplies a catalog-approved root and must wait for
  // windowsRifeReady before constructing any QML MpvVideoItem/mpv handle.
  bool prepareWindowsRife(const QString& runtime,const QString& cache,const QString& monitor,const QString& script,bool extensionVerified=false);
  // Production startup always uses the playback bridge shipped with this app.
  bool prepareBundledWindowsRife(const QString& runtime,const QString& cache,bool extensionVerified=false);
  QVariantMap windowsRifeStatus() const;
  bool selectWindowsRifeModel(const QString& model,int targetFps);
  // Both arguments originate in native startup code, never WebChannel.
  void initializeWindowsRife(const QString& extensionRoot,const QJsonObject& catalog);
  Q_INVOKABLE QVariantMap rifeExtensionStatus() const;
  Q_INVOKABLE bool downloadRifeExtension(const QString& packageId);
  Q_INVOKABLE bool importRifeExtension();
  Q_INVOKABLE void cancelRifeExtensionOperation();
  Q_INVOKABLE bool removeRifeExtension();
#endif

  // Replace an active item atomically, or append-and-play when mpv is idle.
  // Returns false if mpv rejects the selected load command synchronously.
  Q_INVOKABLE bool load(const QString& url, const QVariantMap& options, const QVariantMap& metadata, const QVariant& audioStream = QVariant(), const QVariant& subtitleStream = QVariant());

  // Append a media item to the internal playlist. If nothing is played yet, the
  // newly appended item will start playing immediately.
  // options:
  //  - startMilliseconds: start playback at this time (in ms)
  //  - autoplay: if false, start playback paused; if true, start normally
  Q_INVOKABLE void queueMedia(const QString& url, const QVariantMap& options, const QVariantMap &metadata, const QVariant& audioStream, const QVariant& subtitleStream);

  // This clears all items queued with queueMedia().
  // It explicitly excludes the currently playing item. The main use of this function
  // is updating the next item that should be played (for the purpose of gapless audio).
  // If you want to wipe everything, use stop().
  Q_INVOKABLE void clearQueue();

  Q_INVOKABLE virtual void seekTo(qint64 ms);
  // Seeks to a keyframe: the first one at or after ms, or the one before it.
  // With frame interpolation its frame is there in a quarter of a second; a
  // seek to the millisecond decodes the whole run up to it (0.85 s per second
  // of distance from the keyframe, measured with TensorRT RIFE). The landing
  // position is reported by keyframeSeekLanded.
  Q_INVOKABLE void seekToKeyframe(qint64 ms, bool after);

  // Stop playback and clear all queued items.
  Q_INVOKABLE virtual void stop();
#ifdef Q_OS_WIN
  // Keep the Qt/native host windows alive until mpv releases its video output.
  void requestApplicationQuit();
  bool isShuttingDown() const { return m_shuttingDown; }
#endif
  // A video is loaded, playing or paused.
  bool inPlayback() const { return m_inPlayback; }
  void updateDanmakuAuthorization(const QString& path, const QString& generation);
#ifdef Q_OS_MAC
  // Drain native VO teardown on the Cocoa main thread before QML destroys mpv.
  bool prepareForShutdown();
#endif

  // A full reload of the stream is imminent (stop() + load())
  // Used for not resetting display mode with the next stop() call.
  Q_INVOKABLE virtual void streamSwitch();

  Q_INVOKABLE virtual void pause();
  void togglePause();
  Q_INVOKABLE virtual void play();

  // OS media integration notifications (called from JavaScript)
  Q_INVOKABLE void notifyShuffleChange(bool enabled);
  Q_INVOKABLE void notifyRepeatChange(const QString& mode);
  Q_INVOKABLE void notifyFullscreenChange(bool isFullscreen);
  Q_INVOKABLE void notifyRateChange(double rate);
  Q_INVOKABLE void notifyQueueChange(bool canNext, bool canPrevious);
  Q_INVOKABLE void notifyPlaybackStop(bool isNavigating);
  Q_INVOKABLE void notifyDurationChange(qint64 durationMs);
  Q_INVOKABLE void notifyPlaybackState(const QString& state);
  Q_INVOKABLE void notifyPosition(qint64 positionMs);
  Q_INVOKABLE void notifySeek(qint64 positionMs);
  Q_INVOKABLE void notifyMetadata(const QVariantMap& metadata);
  // Web/OS notification ratio: 0=silence and 1=normal.
  Q_INVOKABLE void notifyVolumeChange(double volume);
  // Report an Emby Web managed quality change back to the originating mpv
  // script so UOSC can update its selected state.
  Q_INVOKABLE void notifyStreamingBitrateResult(qint64 bitrate, bool success, const QString& message);

  // MPV software volume in percent: 0=silence and 100=normal.
  // Can be restored before loading a media file.
  Q_INVOKABLE virtual void setVolume(double volume);
  // Returns 0 if MPV is unavailable.
  Q_INVOKABLE virtual double volume();

  // Ignored if no audio output active.
  Q_INVOKABLE virtual void setMuted(bool muted);
  // Returns 0 if no audio output active.
  Q_INVOKABLE virtual bool muted();

  // Returns a QVariant of the following format:
  // QVariantList                   (list of audio device entries)
  //    QVariantMap                 (an audio device entry)
  //      "name" -> QString         (symbolic name/ID of the device)
  //      "description" -> QString  (human readable description intended for display)
  //
  Q_INVOKABLE virtual QVariant getAudioDeviceList();
  // Uses the "name" from the device list.
  Q_INVOKABLE virtual void setAudioDevice(const QString& name);
  
  Q_INVOKABLE virtual void setAudioStream(const QVariant& audioStream);
  Q_INVOKABLE virtual void setSubtitleStream(const QVariant& subtitleStream);

  Q_INVOKABLE virtual void setAudioDelay(qint64 milliseconds);
  Q_INVOKABLE virtual void setSubtitleDelay(qint64 milliseconds);

  // If enabled, hide the web view (whether it's OSD or not), and show video
  // only. If no video is running, render a black background only.
  Q_INVOKABLE virtual void setVideoOnlyMode(bool enable);

  Q_INVOKABLE bool userCommand(QString command);

  // Set the region in which video should be rendered. This uses Qt pixel
  // coordinates (x=0,y=0 is the top/left corner).
  // If the aspect ratio mismatches, the video will be letterboxed or pillarboxed.
  // The lower/right pixel border is always excluded.
  // setVideoRectangle(-1, -1, -1 , -1) will revert to the default and
  // automatically use the whole window. (Same if the rectangle is 0-sized.)
  Q_INVOKABLE void setVideoRectangle(int x, int y, int w, int h);

  Q_INVOKABLE void setPlaybackRate(int rate);

  Q_INVOKABLE qint64 getPosition();
  Q_INVOKABLE qint64 getDuration();
  Q_INVOKABLE QVariantMap mpvDiagnostics();

  // Settings-page mpv.conf editor.
  Q_INVOKABLE QVariantMap mpvConfState();
  Q_INVOKABLE QVariantMap mpvConfAnalyze(const QString& user, const QString& section);
  Q_INVOKABLE QVariantMap mpvConfEdit(const QString& user, const QVariantMap& operation);
  Q_INVOKABLE QVariantMap mpvConfPaste(const QString& text);
  Q_INVOKABLE QVariantMap mpvConfSave(const QString& user, bool force);
  Q_INVOKABLE QVariantMap mpvConfRestoreDefault();
  Q_INVOKABLE void mpvConfAcknowledgeDefault();
  Q_INVOKABLE bool mpvConfOpenShaderFolder();
  Q_INVOKABLE bool mpvConfCopyText(const QString& text);

  // Applies a quality profile from the current mpv.conf (settings page,
  // uosc menu and Alt+1..3). The options are queued to mpv without waiting:
  // each one can make the VO recompile its shaders. Returns false when the
  // profile could not be resolved; rejected options are logged (and shown
  // when announcing) once mpv has answered.
  bool applyQualityProfile(const QString& profile, bool announce);

  Q_INVOKABLE QVariantList getWebPlaylist() const;
  Q_INVOKABLE QString getCurrentWebPlaylistItemId() const;
  Q_INVOKABLE void setWebPlaylist(const QVariantList& playlist, const QString& currentItemId);
  // The playing item's intro for UOSC's skip button: {start, end} in seconds
  // and auto for skipping without the button. Anything else clears it, as
  // does loading an item.
  Q_INVOKABLE void setIntroSkip(const QVariantMap& intro);
  // A watch-together room times every start: all members begin at the same
  // instant. While playback follows one, a resume plays at once and is not
  // held to refill the interpolation graph (Windows). The page sets it for
  // the item that follows the room and clears it when that playback stops.
  Q_INVOKABLE void setRoomTimeline(bool active);

  // Professional mode (Windows, embedded gpu-next with uosc). The video
  // shrinks to the rectangle the page reports, and the page shows tuning
  // panels and live statistics in the space around it. Every change goes to
  // the running player without waiting for it; mpv.conf is written only by
  // mpvConfSave.
  Q_INVOKABLE bool proModeAvailable() const;
  Q_INVOKABLE bool proModeActive() const { return m_proMode; }
  Q_INVOKABLE void setProMode(bool active);
  // The page's video area, in the page's CSS pixels.
  Q_INVOKABLE void setProVideoRect(int x, int y, int w, int h);
  // Gives the keyboard to the video (mpv and uosc) or to the page.
  Q_INVOKABLE void proFocus(bool video);
  // mpv properties whose values the page mirrors while the mode is active.
  Q_INVOKABLE void proWatch(const QStringList& properties);
  // Sets one option the user area of mpv.conf may hold, or one of the
  // values the playback interface adjusts (volume, mute, the two delays).
  // Returns {ok, error}; a value mpv rejects later arrives as proSetFailed.
  Q_INVOKABLE QVariantMap proSet(const QString& key, const QString& value);
  // Replaces the shader chain, in order. Paths are "~~/shaders/...".
  Q_INVOKABLE QVariantMap proSetShaders(const QStringList& shaders);
  Q_INVOKABLE bool proApplyProfile(const QString& profile);
  Q_INVOKABLE void proTogglePause();
#ifdef Q_OS_MAC
  // The playback window was fullscreen when the mode began (the page's
  // window takes it over), and mpv's own fullscreen once the mode ends.
  bool proStartedFullScreen() const { return m_proStartedFullScreen; }
  void restorePlaybackFullScreen(bool fullscreen);
  // Apple-native frame interpolation for the playing item (professional
  // mode, 补帧 page): {setting, target, active, status, …}; changing it
  // replaces the filter at once and does not save the setting.
  Q_INVOKABLE QVariantMap proNativeState();
  Q_INVOKABLE QVariantMap proSetNative(const QString& mode, const QString& target);
#endif
#ifdef Q_OS_WIN
  // NVIDIA Video Frame Generation: a VapourSynth plugin, its script and
  // NVIDIA's runtime installed in vfg/ next to the program ("vfg-test.json"
  // in the data directory can name others for development, see vfgFiles()).
  // It runs as a vapoursynth filter of its own on the private runtime of the
  // RIFE extension and takes RIFE's place for the playing item. Returns
  // {configured, available, reason, mode, factor, effectiveFactor, runtime,
  // setting, settingFactor, computeCapability, gpuSupported}; mode -1 is off,
  // a factor of 0 follows the RIFE target frame rate, gpuSupported is null
  // until the RIFE extension's probe has named the GPU.
  Q_INVOKABLE QVariantMap proVfgState();
  // -1 turns it off; 0, 1 and 2 are NVIDIA's low, medium and high modes.
  // factor is the output rate as a multiple of the source rate in steps of
  // 0.5 from 1.5 to 5; 0 chooses the one nearest the RIFE target frame rate.
  Q_INVOKABLE QVariantMap proSetVfg(int mode, double factor);
  // NVIDIA RTX Video Super Resolution and RTX Video HDR (设置 → 视频), done
  // by the graphics driver inside mpv's d3d11vpp filter "@tigerest-rtx" at the
  // end of the filter chain. Super resolution scales the picture up to the
  // screen's resolution; RTX Video HDR turns an SDR source into HDR while
  // Windows HDR is on. Returns {vsr, hdr, filter, scale, vsrReason, hdrReason,
  // settingVsr, settingHdr, available}: the choices for the playing item, the
  // filter they give, why a choice does nothing for it, and the settings.
  Q_INVOKABLE QVariantMap proRtxState();
  // Changes the choices for the playing item without saving them.
  Q_INVOKABLE QVariantMap proSetRtx(bool vsr, bool hdr);
#endif
  // Font families installed on this computer, for the subtitle font picker.
  Q_INVOKABLE QStringList proFontFamilies();
  // Whether mpv reads the display's ICC profile (设置 → 视频 → 显示器 ICC 色彩
  // 配置): {setting, managed, overridden}. "auto" reads it unless the system
  // already manages colour on the window's display; `managed` says how
  // ("hdr": Windows HDR, whose compositor applies the HDR calibration
  // profile; "acm": Windows Auto Color Management; "edr": an EDR display on
  // macOS), `overridden` that advanced overrides leave the option to mpv.conf.
  Q_INVOKABLE QVariantMap proIccState();
  // Applies "auto", "on" or "off" to the playing item without saving it.
  Q_INVOKABLE QVariantMap proSetIcc(const QString& mode);

  QRect videoRectangle() { return m_videoRectangle; }

  AlbumArtProvider* albumArtProvider() const { return m_albumArtProvider; }

  void setMpvController(MpvController* controller) {
    if (!m_mpv)
      m_mpv = controller;
  }
  void setNativeVideoOutput(bool enabled) { m_nativeVideoOutput = enabled; }
  bool usingNativeVideoOutput() const { return m_nativeVideoOutput; }
  void initializeMpv();

  virtual void setWindow(QQuickWindow* window);

  QString videoInformation() const;

  static QStringList AudioCodecsAll() { return { "ac3", "dts", "eac3", "dts-hd", "truehd" }; };
  static QStringList AudioCodecsSPDIF() { return { "ac3", "dts" }; };

  enum class State {
    finished,
    canceled,
    error,
    paused,
    playing,
    buffering,
  };

  enum class MediaType {
    Subtitle,
    Audio,
  };
  
public Q_SLOTS:
  void updateAudioDeviceList();
  void setAudioConfiguration();
  void setSubtitleConfiguration();
  void setVideoConfiguration();
  void setMpvPreset();
  void updateAudioConfiguration();
  void updateSubtitleConfiguration();
  void updateVideoConfiguration();
  void updateConfiguration();
  void updateMpvConfiguration();

private Q_SLOTS:
  void handleMpvEvents();
  void onRestoreDisplay();
  void onRefreshRateChange();
  void updateAudioDevice();
  void checkAudioOutput();

Q_SIGNALS:
  // The following signals correspond to the State enum above.
  void playing();                 // playback is progressing (audio playing, pictures are moving)
  void buffering(float percent);  // temporary state during "playing", or during media loading
  void paused();                  // paused (covers all sub-states)
  void finished();                // playback finished successfully
  void canceled();                // playback was stopped (by user/via API)
  void error(const QString& msg); // playback stopped due to external error
  // To be phased out. Raised on finished() and canceled().
  void stopped();                 // playback finished successfully, or was stopped with stop()
  void stateChanged(State newState, State oldState); // all state changes

  // true if the video (or music) is actually playing
  // false if nothing is loaded, playback is paused, during seeking, or media is being loaded
  void videoPlaybackActive(bool active);
  void windowVisible(bool visible);
  // Raised by the bundled UOSC quality menu. JavaScript deliberately performs
  // the switch through Emby Web so position, track choices and session survive.
  void streamingBitrateRequested(qint64 bitrate);
  // A setting change paused or restored lines of the user's mpv.conf (for
  // example RIFE conflicts); the settings page shows the message.
  void mpvConfMessage(const QString& message);
  // emitted as soon as the duration of the current file is known
  void updateDuration(qint64 milliseconds);
  void playbackRateChanged(double rate);

  // current position in ms should be triggered 2 times a second
  // when position updates
  void positionUpdate(quint64);
  // True from a seek until mpv has decoded and shown its frame. The position
  // reads as the target long before that, so the watch-together sync waits
  // for this before it starts a held player.
  void seekingChanged(bool seeking);
  // The frame of a seekToKeyframe is shown: where it is, in milliseconds.
  // Sent before seekingChanged(false) of that seek, and never for the restart
  // of a seek that was still running when seekToKeyframe was called.
  void keyframeSeekLanded(qint64 ms);

  void onVideoRecangleChanged();

  void proModeChanged(bool active);
  // For the window: whether the mode is on and the page's video area.
  void proLayoutChanged(bool active, int x, int y, int w, int h);
  void proFocusRequested(bool video);
  // Published by plugins/tigerest_pro.lua twice a second while the mode is on.
  void proStats(const QVariantMap& stats);
  // The watched properties, whenever one of them changes.
  void proOptions(const QVariantMap& options);
  void proSetFailed(const QString& key, const QString& message);
  // Once a second while the mode is on: processor and graphics-card load
  // (see SystemLoad) and, as "rife", the frame interpolation's diagnostics.
  void proLoad(const QVariantMap& load);

  void onMpvEvents();
#ifdef Q_OS_WIN
  void windowsRifeReady(bool ready,const QString& error);
  void windowsRifeStartupFinished();
  void rifeExtensionStatusChanged(const QVariantMap& status);
#endif

  void onMetaData(const QVariantMap &meta, QUrl baseUrl);

  void webPlaylistChanged(const QVariantList& playlist, const QString& currentItemId);

  // OS media integration signals (for MPRIS, SMTC, etc.)
  void shuffleChanged(bool enabled);
  void repeatChanged(const QString& mode);
  void fullscreenChanged(bool isFullscreen);
  void rateChanged(double rate);
  void queueChanged(bool canNext, bool canPrevious);
  void playbackStopped(bool isNavigating);
  void durationChanged(qint64 durationMs);
  void playbackStateChanged(const QString& state);
  void positionChanged(qint64 positionMs);
  void seekPerformed(qint64 positionMs);
  void metadataChanged(const QVariantMap& metadata);
  // Always mpv percent, whether observed natively or reported by the web UI.
  void volumeChanged(double volume);

  // Buffered ranges from demuxer-cache-state, as list of {start, end} in ticks
  void bufferedRangesUpdated(const QVariantList& ranges);
  void fullscreenRequested(bool fullscreen);

private:
  bool applyMpvConfOption(const QString& key, const QString& value);
  int requestMpvConfOption(const QString& key, const QString& value, uint64_t reply);
  void resetMpvConfOption(const QString& key, const QList<MpvConf::Line>& lines);
  void handleProfileReply(const mpv_event* event);
  // Applies the difference between two user areas to the running player.
  void applyUserConfLive(const QString& previous, const QString& current);
  // Re-renders the managed parts of mpv.conf after a deciding setting changed.
  void refreshMpvConf();
  void ensureScreenshotDirectory();
  void logAudioVideoSync();
  void publishProfileMenu();
  void storeMpvOptionTable();

private:
  friend class RifePlayerPlayback;
  friend class TestPlayerAsyncMpv;
#ifdef Q_OS_WIN
  // Release the installed-version lease after controllers and runtime helpers.
  std::unique_ptr<rife::RifeExtensionManager> m_rifeExtension;
  QPointer<QFileDialog> m_rifeImportDialog;
  bool m_windowsRifeStartupPending=false;
  std::unique_ptr<rife::RifeRuntimeManager> m_windowsRifeRuntime;
  QString m_windowsRifeRoot,m_windowsRifeError;
  bool m_windowsRifeActivated=false;
  // The Python and VapourSynth that vapoursynth filters (NVIDIA frame
  // generation) run on: the RIFE extension's once it is activated, otherwise
  // the copy installed with the player. Empty when neither could be activated.
  QString m_vapoursynthRoot,m_vapoursynthSource,m_vapoursynthError;
  // Ends the startup gate, activating the installed copy before mpv exists.
  void finishWindowsRifeStartup();
  struct WindowsRecoveryLoad {
    QVariantList command,httpHeaders;
    QVariant audioStream,subtitleStream;
    QVariant restoreAudioId,restoreSubtitleId;
    bool recovery=false;
  };
  QHash<qint64,WindowsRecoveryLoad> m_windowsRecoveryLoads;
  WindowsRecoveryLoad m_windowsCurrentLoad;
  qint64 m_windowsCurrentEntryId=-1;
  quint64 m_windowsPlaybackGeneration=0;
  qint64 m_windowsReplacementTargetEntryId=-1;
  bool m_windowsRifeReloaded=false;
  bool m_windowsPreparationOverlayVisible=false;
  bool recoverWindowsRifeError(const mpv_event_end_file& event);
  void updateInterpolationPreparationOverlay();
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  std::unique_ptr<rife::MpvPollAccess> m_rifeAccess;
  std::unique_ptr<rife::FrameInterpolationController> m_rife;
  QTimer m_rifeTimer;
  QElapsedTimer m_rifeClock;
  bool m_rifeSuppressedSvp=false;
  void beginInterpolationItem();
  void pollInterpolation();
#endif
#ifdef Q_OS_MAC
  // Apple-native frame interpolation (设置 → 视频 → 系统原生补帧): the mpv
  // filter of the playing item (empty for none), the hardware decoding it
  // replaced, and the filter's last statistics. It takes RIFE's place.
  QString m_nativeFilter;
  QString m_nativeSavedHwdec;
  bool m_nativeOwnsHwdec = false;
  QVariantMap m_nativeStats;
  QString m_nativeNoticeShown;
  qint64 m_nativeStatsRequestedAt = -1;
  bool beginNativeInterpolation(const QString& mode, const QString& target);
  void endNativeInterpolation(bool asynchronous);
  void requestNativeStats();
  QVariantMap nativeInterpolationState() const;
#endif
#ifdef Q_OS_WIN
  // Destroy the coordinator before the controller and its runtime manager.
  std::unique_ptr<rife::RifePlaybackCoordinator> m_windowsRifePlayback;
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  rife::StartupGate m_rifeStartup;
  uint64_t m_rifeResumeGeneration=0;
  int m_rifeResumeRequest=0,m_rifeResumeSequence=0;
  qint64 m_rifeResumeSince=0;
  bool m_rifePauseBindings=false;
  void publishInterpolationPause();
  void finishInterpolationStartup();
  void checkInterpolationResume(qint64 now);
  void failInterpolationResume();
#endif
#ifdef Q_OS_WIN
  rife::ResumePrime m_rifeResumePrime;
  // Plain playback whose display sync cannot keep audio and video together
  // is paced by the audio clock until the sync mode setting changes.
  rife::DisplaySyncDrift m_displaySyncDrift;
  bool m_displaySyncUnreliable=false;
  QString m_displaySyncFallbackSetting;
  void watchDisplaySync();
  void onInterpolationPauseChanged();
  void releaseInterpolationResumePrime();
  void updateInterpolationPresentation();
#endif
  // this is the function actually implemented in the backends. the variantmap contains
  // a few known keys:
  // * subtitleStreamIndex
  // * subtitleStreamIdentifier
  // * audioStreamIndex
  // * audioStreamIdentifier
  // * viewOffset
  //
  void loadWithOptions(const QVariantMap& options);
  void setQtQuickWindow(QQuickWindow* window);
  void updatePlaybackState();
  void handleMpvEvent(mpv_event *event);
  // Potentially switch the display refresh rate, and return true if the refresh rate
  // was actually changed.
  bool switchDisplayFrameRate();
  // Windows HDR on for HDR media, off for SDR; true if the display changed
  // mode. Also keeps the SDR ICC profile away from an HDR display.
  bool switchDisplayDynamicRange();
#ifdef Q_OS_WIN
  std::unique_ptr<WindowsHdrSwitch> m_hdrSwitch;
  QTimer m_restoreHdrTimer;
  bool m_mediaHdr = false;
#endif
  void checkCurrentAudioDevice(const QSet<QString>& old_devs, const QSet<QString>& new_devs);
  void appendAudioFormat(QTextStream& info, const QString& property) const;
  void updateVideoAspectSettings();
  bool loadMedia(const QString& url, const QVariantMap& options, const QVariantMap& metadata,
                 const QVariant& audioStream, const QVariant& subtitleStream,
                 const QString& loadMode);
  QVariantList findStreamsForURL(const QString &url);
  void reselectStream(const QVariant &streamSelection, MediaType target);
  void selectStream(MediaType target, const QString& streamID, const QString& streamName);
  void holdPreloadedHook(std::function<void()> resume);
  void completeStreamAdd(uint64_t reply, int error);
  void finishPreloadedStreams();
  void startWithoutPendingStreams(quint64 hold);
  void resumePreloadedHook();
  QString sanitizeMediaUrl(const QString& url, bool retainExistingCredential = false);
  void applyMediaAccessToken(const QString& token);

  MpvController* m_mpv = nullptr;
  QString m_appliedProfile;
  bool m_nativeVideoOutput = false;
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  bool m_shuttingDown = false;
#endif
#ifdef Q_OS_WIN
  QTimer m_applicationQuitTimer;
  QElapsedTimer m_applicationQuitElapsed;
  bool m_applicationStopAcknowledged = false;
  bool m_applicationQuitQueryPending = false;
  bool m_applicationQuitReady = false;
  void checkApplicationQuit();
  void finishApplicationQuit();
#endif
#ifdef Q_OS_MAC
  struct DeferredMediaLoad {
    QString url;
    QVariantMap options, metadata;
    QVariant audioStream, subtitleStream;
    QString mode;
  };
  bool m_nativeVoTeardownPending = false;
  QList<DeferredMediaLoad> m_deferredMediaLoads;
  void completeNativeVoTransition();
  bool queueDuringNativeTeardown(const QString& property, const QVariant& value);
#endif

  State m_state;
  bool m_paused;
  bool m_playbackActive;
  bool m_windowVisible;
  // mpv's last reported vo-configured; END_FILE hides the window without it.
  bool m_voConfigured = false;
  bool m_videoPlaybackActive;
  bool m_inPlayback;
  bool m_endFileUnreported = false;
  bool m_nativeVideoReady = false;
  bool m_seeking = false;
  void setSeeking(bool seeking);
  bool m_roomTimeline = false;
  // mpv has taken the seek of seekToKeyframe; it has started that seek.
  enum class KeyframeSeek { None, Sent, Running };
  KeyframeSeek m_keyframeSeek = KeyframeSeek::None;
#ifdef Q_OS_MAC
  // Restarted after a keyframe seek; its landing waits for the frame's position.
  bool m_keyframeLandingPending = false;
  QTimer m_keyframeLandingTimer;
  void finishKeyframeLanding();
#endif
  QVariantMap m_decodedVideoParams;
  // Playback-start notice of HDR/SDR output; the same rules and wording as
  // apple/Core/Sources/AppleCore/DynamicRangeSummary.swift.
  QVariantMap m_rangeSource, m_rangeTarget;
  qint64 m_rangeDolbyVisionProfile = 0;
  QString m_rangeToneMapping;
  bool m_rangeReported = false;
  int m_osdWidth = 0, m_osdHeight = 0;
  quint64 m_rangeNoticeGeneration = 0;
  void reportDynamicRange();
  bool m_playbackCanceled;
  bool m_replacementPending = false;
  QString m_playbackError;
  int m_bufferingPercentage;
  int m_lastBufferingPercentage;
  double m_lastPositionUpdate;
  qint64 m_playbackAudioDelay;
  QQuickWindow* m_window;
  float m_mediaFrameRate;
  QTimer m_restoreDisplayTimer;
  QTimer m_reloadAudioTimer;
  QTimer m_audioOutputWarningTimer;
  bool m_audioOutputWarningShown = false;
  QSet<QString> m_audioDevices;
  bool m_streamSwitchImminent;
  bool m_doAc3Transcoding;
  QStringList m_passthroughCodecs;
  QVariantMap m_serverMediaInfo;
  QVariant m_currentSubtitleStream;
  QVariant m_currentAudioStream;
  // External sub-add/audio-add requests awaiting mpv's reply. A stale entry
  // belongs to an item that has ended; its reply only releases the hook.
  struct PendingStreamAdd {
    MediaType target;
    QVariant selection;
    QString streamID;
    QString streamName;
    bool stale = false;
    // Playback started without waiting for this add any longer.
    bool late = false;
  };
  QHash<uint64_t, PendingStreamAdd> m_pendingStreamAdds;
  uint32_t m_streamAddSerial = 0;
  // Continues the on_preloaded hook once the item's stream adds have answered.
  std::function<void()> m_preloadedResume;
  // How long on_preloaded waits for those answers. Emby extracts an embedded
  // subtitle of a large file for minutes; the item starts without the track
  // after this and takes it when it arrives.
  int m_preloadedStreamWaitMs = 10000;
  quint64 m_preloadedHold = 0;
  // Quality profiles queued to mpv. Requests run in order, so the shader
  // count read last in a batch answers after all of its options.
  struct ProfileApplication {
    QString title;
    bool announce = false;
    int expectedShaders = 0;
    QStringList failed;
  };
  struct ProfileRequest {
    uint32_t batch = 0;
    QString key;
    bool shaderCount = false;
  };
  QHash<uint32_t, ProfileApplication> m_profileApplications;
  QHash<uint64_t, ProfileRequest> m_profileRequests;
  // Options a profile switch puts back to mpv's default, awaiting that default.
  QHash<uint64_t, QString> m_profileResets;
  uint32_t m_profileBatchSerial = 0;
  uint32_t m_profileRequestSerial = 0;
  bool m_proMode = false;
#ifdef Q_OS_MAC
  class SystemLoad* m_proLoadSampler = nullptr;
  bool m_mpvFullscreen = false;
  bool m_proStartedFullScreen = false;
  // mpv's window options while its window is a part of the page's window.
  QVariant m_proSavedAutoResize, m_proSavedKeepAspect;
#endif
  // Who manages colour on the window's display, as of the last load.
  QString m_systemColor;
  bool iccWanted(const QString& mode) const;
  // The setting's choice for mpv's icc-profile-auto; nothing with advanced overrides.
  void applyIccSetting(bool wait);
  uint32_t m_proStatsSeen = 0;
#ifdef Q_OS_WIN
  // The signal to the window's display, added to the statistics: mpv does not
  // report it. Read again every two seconds; the window can change displays.
  QVariantMap m_proDisplaySignal;
  QElapsedTimer m_proDisplayChecked;
  void addDisplaySignal(QVariantMap& stats);
#endif
  QRect m_proVideoRect;
  bool m_videoOnlyMode = false;
  void updateWebVisibility();
#ifdef Q_OS_WIN
  class SystemLoad* m_proLoadSampler = nullptr;
  int m_proVfgMode = -1;
  // The factor asked for (0 follows the target frame rate) and the one in use.
  double m_proVfgFactor = 0;
  double m_proVfgEffectiveFactor = 0;
  // The script writes its counters here twice a second.
  QString m_vfgStatsPath;
  void startConfiguredVfg();
  bool m_vfgStartPending = false;
  // Why frame generation cannot run (files, RIFE runtime, GPU), empty if it can.
  QString vfgUnavailable() const;
  QString vfgComputeCapability() const;
  // RTX video (proRtxState): the choices for the playing item, the settings
  // they were read from (bits 1 and 2, -1 before the first read), the filter
  // text in the chain ("" for none) and why a choice adds nothing.
  bool m_rtxVsr = false, m_rtxHdr = false;
  int m_rtxSettings = -1;
  QString m_rtxFilter, m_rtxVsrReason, m_rtxHdrReason;
  double m_rtxScale = 0;
  // A filter text mpv refused for this item, and what the driver turned down.
  QString m_rtxRefused, m_rtxDriverVsr, m_rtxDriverHdr;
  // Filter commands in flight, the last add's reply id, moves for this item,
  // and how often a filter mpv disabled was put back.
  int m_rtxCommands = 0, m_rtxMoves = 0, m_rtxRetries = 0;
  bool m_rtxRetryPending = false;
  uint32_t m_rtxSerial = 0;
  uint64_t m_rtxAddReply = 0;
  void readRtxSettings(bool force);
  QString rtxFilterText(QString* vsrReason, QString* hdrReason, double* scale) const;
  uint64_t sendRtxCommand(const QStringList& command);
  void updateRtx();
  void keepRtxLast(const QVariantList& chain);
  // Runs add (a "vf add" of RIFE or VFG) with the RTX filter taken off the
  // chain, then puts that back at the end. Returns what add returned.
  bool addBeforeRtx(const std::function<bool()>& add);
  static bool addsInterpolation(const QStringList& command);
#endif
  // Requests of proSet and proSetShaders awaiting mpv's answer, by reply id.
  QHash<uint64_t, QString> m_proRequests;
  uint32_t m_proRequestSerial = 0;
  QRect m_videoRectangle;
  QStringList m_baseHttpHeaders;

  QVariantList m_webPlaylist;
  QString m_currentWebPlaylistItemId;
  // JSON for user-data/tigerest/intro-skip; empty until the page has
  // published the marker of the item it loaded last.
  QString m_introSkip;
  QTimer* m_playlistTimer;
  QVariantList m_queuedItems;

  AlbumArtProvider* m_albumArtProvider;
};

#endif // PLAYERCOMPONENT_H
