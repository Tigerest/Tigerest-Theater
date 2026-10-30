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

  // Applies a quality profile from the current mpv.conf (settings page,
  // uosc menu and Alt+1..3). Returns false when it did not apply fully.
  bool applyQualityProfile(const QString& profile, bool announce);

  Q_INVOKABLE QVariantList getWebPlaylist() const;
  Q_INVOKABLE QString getCurrentWebPlaylistItemId() const;
  Q_INVOKABLE void setWebPlaylist(const QVariantList& playlist, const QString& currentItemId);

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

  void onVideoRecangleChanged();

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
  void resetMpvConfOption(const QString& key, const QList<MpvConf::Line>& lines);
  // Applies the difference between two user areas to the running player.
  void applyUserConfLive(const QString& previous, const QString& current);
  // Re-renders the managed parts of mpv.conf after a deciding setting changed.
  void refreshMpvConf();
  void publishProfileMenu();
  void storeMpvOptionTable();

private:
  friend class RifePlayerPlayback;
#ifdef Q_OS_WIN
  // Release the installed-version lease after controllers and runtime helpers.
  std::unique_ptr<rife::RifeExtensionManager> m_rifeExtension;
  QPointer<QFileDialog> m_rifeImportDialog;
  bool m_windowsRifeStartupPending=false;
  std::unique_ptr<rife::RifeRuntimeManager> m_windowsRifeRuntime;
  QString m_windowsRifeRoot,m_windowsRifeError;
  bool m_windowsRifeActivated=false;
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
#endif

  State m_state;
  bool m_paused;
  bool m_playbackActive;
  bool m_windowVisible;
  // mpv's last reported vo-configured; END_FILE hides the window without it.
  bool m_voConfigured = false;
  bool m_videoPlaybackActive;
  bool m_inPlayback;
  bool m_nativeVideoReady = false;
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
  QRect m_videoRectangle;
  QStringList m_baseHttpHeaders;

  QVariantList m_webPlaylist;
  QString m_currentWebPlaylistItemId;
  QTimer* m_playlistTimer;
  QVariantList m_queuedItems;

  AlbumArtProvider* m_albumArtProvider;
};

#endif // PLAYERCOMPONENT_H
