#include "PlayerComponent.h"
#include <QString>
#include <Qt>
#include <QDir>
#include <QCoreApplication>
#include <QGuiApplication>
#include <QDebug>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QUrlQuery>
#include "display/DisplayComponent.h"
#include "settings/SettingsComponent.h"
#include "system/SystemComponent.h"
#include "system/CommunityBridge.h"
#include "utils/Utils.h"
#include "utils/Log.h"
#ifdef Q_OS_MAC
#include "utils/osx/OSXUtils.h"
#endif
#include "ComponentManager.h"
#include "settings/SettingsSection.h"
#include "core/ProfileManager.h"

#include "MpvVideoItem.h"
#include "PlaybackIdentity.h"
#include "MpvConfigManager.h"
#include "MpvConfEditor.h"
#ifdef Q_OS_WIN
#include "ui/WindowManager.h"
#include "power/PowerComponent.h"
#include "interpolation/windows/RifeRuntimeManager.h"
#include "interpolation/windows/RifeVSScriptRuntime.h"
#include "interpolation/windows/RifePlaybackCoordinator.h"
#include "interpolation/windows/RifePreparationOverlay.h"
#include "interpolation/windows/RifeExtensionManager.h"
#include <QFileDialog>
#include "Version.h"
#include "display/win/WindowsHdr.h"
#include "shared/Paths.h"
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
#include "interpolation/FrameInterpolationController.h"
#include "interpolation/MpvPollAccess.h"
#endif
#include "AlbumArtProvider.h"
#include "input/InputComponent.h"
#include <MpvController>

#include <math.h>
#include <cmath>
#include <string.h>
#include <shared/Paths.h>
#include <QRegularExpression>
#include <QLocalSocket>
#include <QFileInfo>
#include <QThread>
#include <QDesktopServices>
#include <QJsonDocument>
#include <QUrl>

#if !defined(Q_OS_WIN)
#include <unistd.h>
#endif

#ifdef TARGET_RPI
#include <bcm_host.h>
#include <interface/vmcs_host/vcgencmd.h>
#endif

///////////////////////////////////////////////////////////////////////////////////////////////////
static void wakeup_cb(void *context)
{
  auto *player = static_cast<PlayerComponent*>(context);

  emit player->onMpvEvents();
}

// Settle time after Windows switches HDR mode, before the video output opens.
static constexpr int HdrSwitchDelayMs = 1000;

#ifdef Q_OS_WIN
namespace {
constexpr uint64_t ApplicationQuitStop = 0x54000001;
constexpr uint64_t ApplicationQuitIdle = 0x54000002;
constexpr uint64_t ApplicationQuitVo = 0x54000003;
}
#endif

///////////////////////////////////////////////////////////////////////////////////////////////////
PlayerComponent::PlayerComponent(QObject* parent)
  : ComponentBase(parent), m_state(State::finished), m_paused(false), m_playbackActive(false),
  m_windowVisible(false), m_videoPlaybackActive(false), m_inPlayback(false), m_playbackCanceled(false),
  m_bufferingPercentage(100), m_lastBufferingPercentage(-1),
  m_lastPositionUpdate(0.0), m_playbackAudioDelay(0),
  m_window(nullptr), m_mediaFrameRate(0),
  m_restoreDisplayTimer(this), m_reloadAudioTimer(this), m_audioOutputWarningTimer(this),
  m_streamSwitchImminent(false), m_doAc3Transcoding(false),
  m_videoRectangle(-1, 0, 0, 0),
  m_albumArtProvider(new AlbumArtProvider(this))
{
  qmlRegisterType<MpvVideoItem>("Konvergo", 1, 0, "MpvVideo"); // deprecated name
  qmlRegisterType<MpvVideoItem>("Konvergo", 1, 0, "KonvergoVideo");
  qmlRegisterType<MpvVideoItem>("Konvergo", 1, 0, "MpvVideoItem");

  m_restoreDisplayTimer.setSingleShot(true);
#ifdef Q_OS_WIN
  m_applicationQuitTimer.setInterval(100);
  connect(&m_applicationQuitTimer, &QTimer::timeout, this, &PlayerComponent::checkApplicationQuit);
  m_hdrSwitch = std::make_unique<WindowsHdrSwitch>(Paths::globalDataDir("windows-hdr-restore.txt"));
  m_hdrSwitch->recover();
  // Next-episode autoplay loads within seconds; turning HDR off and on again
  // in between would blank the screen twice.
  m_restoreHdrTimer.setSingleShot(true);
  m_restoreHdrTimer.setInterval(8000);
  connect(&m_restoreHdrTimer, &QTimer::timeout, this, [this]() {
    if (!m_shuttingDown && !m_inPlayback && m_mpv && m_mpv->getProperty("idle-active").toBool())
      m_hdrSwitch->restore();
  });
  connect(qApp, &QCoreApplication::aboutToQuit, this, [this]() {
    m_restoreHdrTimer.stop();
    m_hdrSwitch->restore();
  });
#endif
  connect(&m_restoreDisplayTimer, &QTimer::timeout, this, &PlayerComponent::onRestoreDisplay);

  connect(&DisplayComponent::Get(), &DisplayComponent::refreshRateChanged, this, &PlayerComponent::onRefreshRateChange);

  m_reloadAudioTimer.setSingleShot(true);
  connect(&m_reloadAudioTimer, &QTimer::timeout, this, &PlayerComponent::updateAudioDevice);

  m_audioOutputWarningTimer.setSingleShot(true);
  m_audioOutputWarningTimer.setInterval(1800);
  connect(&m_audioOutputWarningTimer, &QTimer::timeout, this, &PlayerComponent::checkAudioOutput);
#ifdef Q_OS_WIN
  m_windowsRifeRuntime=std::make_unique<rife::RifeRuntimeManager>();
  connect(m_windowsRifeRuntime.get(),&rife::RifeRuntimeManager::runtimeReady,this,[this](bool ready,const QString& error){
    m_windowsRifeError=error;
    if(ready&&m_mpv){ready=false;m_windowsRifeError=QStringLiteral("RIFE runtime requires restart before mpv creation");}
    if(ready)ready=rife::activateVSScriptRuntime(m_windowsRifeRoot,&m_windowsRifeError);
    m_windowsRifeActivated=ready;
    emit windowsRifeReady(ready,m_windowsRifeError);
    emit rifeExtensionStatusChanged(rifeExtensionStatus());
    if(m_windowsRifeStartupPending){m_windowsRifeStartupPending=false;emit windowsRifeStartupFinished();}
  });
#endif
}

#ifdef Q_OS_WIN
bool PlayerComponent::prepareBundledWindowsRife(const QString& runtime,const QString& cache,bool extensionVerified)
{
  if(m_mpv){m_windowsRifeError=QStringLiteral("RIFE runtime requires restart before mpv creation");return false;}
  const auto playback=rife::bundledWindowsRifePaths(QCoreApplication::applicationDirPath(),&m_windowsRifeError);
  if(!playback.available){m_windowsRifeActivated=false;return false;}
  return prepareWindowsRife(runtime,cache,playback.plugin,playback.script,extensionVerified);
}
bool PlayerComponent::prepareWindowsRife(const QString& runtime,const QString& cache,const QString& monitor,const QString& script,bool extensionVerified)
{
#ifndef TIGEREST_MPVQT_HAS_EVENT_HANDOFF
  m_windowsRifeError=QStringLiteral("Windows RIFE requires Tigerest's bundled MpvQt event handoff");
  return false;
#endif
  if(m_mpv){m_windowsRifeError=QStringLiteral("RIFE runtime requires restart before mpv creation");return false;}
  m_windowsRifeActivated=false;m_windowsRifeError.clear();
  m_windowsRifeRoot=QFileInfo(runtime).canonicalFilePath();
  if(m_windowsRifeRuntime->configure(runtime,cache,monitor,script,extensionVerified))return true;
  m_windowsRifeError=QStringLiteral("Invalid or missing verified RIFE extension");
  return false;
}
QVariantMap PlayerComponent::windowsRifeStatus() const
{
  auto status=m_windowsRifeRuntime->diagnostics();
  status["activated"]=m_windowsRifeActivated;status["error"]=m_windowsRifeError;
  if(m_rife)status["playback"]=m_rife->diagnostics();
  if(m_windowsRifePlayback){
    status["itemGeneration"]=qulonglong(m_windowsRifePlayback->generation());
    status["playbackError"]=m_windowsRifePlayback->activationError();
    status["engineCacheHitForItem"]=m_windowsRifePlayback->engineCacheHitForItem();
    status["preparingForItem"]=m_windowsRifePlayback->preparingEngine();
  }
  status["startupWaiting"]=m_rifeStartup.waiting();
  status["startupWantsPlay"]=m_rifeStartup.waitingToPlay();
  status["preparationElapsedMs"]=qlonglong(m_rifeStartup.elapsed(m_rifeClock.isValid()?m_rifeClock.elapsed():0));
  return status;
}
bool PlayerComponent::selectWindowsRifeModel(const QString& model,int targetFps)
{
  // Selection is applied before the next item; never mutate an active graph.
  if(m_inPlayback||!m_windowsRifeRuntime->select(model,targetFps))return false;
  SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO,"aiRifeModel",model);
  SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO,"aiRifeTarget",targetFps);
  return true;
}
void PlayerComponent::initializeWindowsRife(const QString& extensionRoot,const QJsonObject& catalog)
{
  if(m_rifeExtension||m_mpv)return;
  m_windowsRifeStartupPending=true;
  m_rifeExtension=std::make_unique<rife::RifeExtensionManager>(extensionRoot,catalog,Version::GetCanonicalVersionString());
  connect(m_rifeExtension.get(),&rife::RifeExtensionManager::statusChanged,this,[this]{
    emit rifeExtensionStatusChanged(rifeExtensionStatus());
  });
  connect(m_rifeExtension.get(),&rife::RifeExtensionManager::operationFinished,this,[this](bool ok,const QString& error){
    if(!m_windowsRifeStartupPending)return;
    const auto paths=m_rifeExtension->runtimePaths();
    if(ok&&!paths.isEmpty()&&prepareBundledWindowsRife(paths["runtime"].toString(),
        ProfileManager::activeProfile().cacheDir("rife/engines"),true)) {
      // configure() may complete synchronously on a failed helper launch.
      if(m_windowsRifeStartupPending)m_windowsRifeRuntime->select(
          SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRifeModel").toString(),
          SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRifeTarget").toInt());
      return;
    }
    if(!ok)m_windowsRifeError=error;
    m_windowsRifeStartupPending=false;
    emit rifeExtensionStatusChanged(rifeExtensionStatus());
    emit windowsRifeStartupFinished();
  });
  m_rifeExtension->initialize();
}
QVariantMap PlayerComponent::rifeExtensionStatus() const
{
  auto status=m_rifeExtension?m_rifeExtension->status():QVariantMap{{"state","notInstalled"},{"busy",false},{"packages",QVariantList{}}};
  status["runtime"]=windowsRifeStatus();
  return status;
}
bool PlayerComponent::downloadRifeExtension(const QString& packageId)
{
  if(!m_rifeExtension||m_rifeExtension->status()["busy"].toBool())return false;
  m_rifeExtension->download(packageId);return true;
}
bool PlayerComponent::importRifeExtension()
{
  if(!m_rifeExtension||m_rifeExtension->status()["busy"].toBool()||m_rifeImportDialog)return false;
  auto* dialog=new QFileDialog(nullptr,QStringLiteral("导入 RIFE 扩展包"),QString(),QStringLiteral("RIFE 扩展包 (*.zip)"));
  m_rifeImportDialog=dialog;dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setFileMode(QFileDialog::ExistingFile);
  connect(dialog,&QFileDialog::accepted,this,[this,dialog]{
    const auto files=dialog->selectedFiles();
    if(!files.isEmpty()&&!m_rifeExtension->status()["busy"].toBool())m_rifeExtension->importPackage(files.first());
  });
  dialog->open();return true;
}
void PlayerComponent::cancelRifeExtensionOperation(){if(m_rifeExtension)m_rifeExtension->cancel();}
bool PlayerComponent::removeRifeExtension()
{
  if(!m_rifeExtension||m_rifeExtension->status()["busy"].toBool())return false;
  const auto key=m_rifeExtension->status()["installedVersion"].toString();if(key.isEmpty())return false;
  m_rifeExtension->scheduleRemoval(key);return true;
}
bool PlayerComponent::recoverWindowsRifeError(const mpv_event_end_file& event)
{
  if(event.reason!=MPV_END_FILE_REASON_ERROR||event.playlist_entry_id!=m_windowsCurrentEntryId||
     m_replacementPending||m_windowsRifeReloaded||
     m_windowsCurrentLoad.command.isEmpty()||!m_rife||!m_rife->ownsFilter()||
     (m_rife->state()!=rife::State::Preparing&&m_rife->state()!=rife::State::Active))return false;
  const auto position=m_rifeAccess?m_rifeAccess->value("playback-time"):QVariant();
  const double seconds=position.toDouble();
  if(!position.isValid()||!std::isfinite(seconds)||seconds<0)return false;
  auto snapshot=m_windowsCurrentLoad;
  snapshot.recovery=true;
  if(m_rifeAccess) {
    snapshot.restoreAudioId=m_rifeAccess->value("aid");
    snapshot.restoreSubtitleId=m_rifeAccess->value("sid");
  }
  auto command=snapshot.command;
  auto options=command.last().toMap();
  options["start"]=QStringLiteral("+")+QString::number(seconds,'f',3);
  const bool requestedPause=m_rifeStartup.waiting()?!m_rifeStartup.waitingToPlay():m_paused;
  options["pause"]=requestedPause?QStringLiteral("yes"):QStringLiteral("no");
  command.last()=options;
  snapshot.command=command;
  const auto entryId=m_windowsCurrentEntryId;
  m_windowsRifeReloaded=true;
  if(m_windowsRifePlayback)m_windowsRifePlayback->endItem(); // asynchronous owned-filter cleanup
  m_rifeStartup.cancel();publishInterpolationPause();
  const auto generation=++m_windowsPlaybackGeneration;
  // Let mpv finish the failed graph/VO before issuing the one bounded reload.
  // A stop, new load or queued item's START_FILE invalidates this callback.
  QTimer::singleShot(0,this,[this,generation,snapshot,entryId]{
    if(generation!=m_windowsPlaybackGeneration||!m_inPlayback||m_replacementPending)return;
    const auto fail=[this]{
      m_windowsReplacementTargetEntryId=-1;
      m_replacementPending=false;m_inPlayback=false;m_windowVisible=false;
      m_playbackError=QStringLiteral("补帧滤镜失败，恢复原帧播放失败");
      emit windowVisible(false);updatePlaybackState();
    };
    const auto playlist=m_mpv->getProperty("playlist").toList();
    int index=-1;
    for(int i=0;i<playlist.size();++i)if(playlist[i].toMap()["id"].toLongLong()==entryId){index=i;break;}
    if(index<0){fail();return;}
    auto command=snapshot.command;
    // insert-at-play only starts playback when the playlist is idle. Select
    // the inserted entry explicitly before removing the failed current item;
    // otherwise mpv advances to the next queued item instead of the recovery.
    command[2]=QStringLiteral("insert-at");command[3]=index;
    m_currentAudioStream=snapshot.audioStream;m_currentSubtitleStream=snapshot.subtitleStream;
    if(m_mpv->setProperty("http-header-fields",snapshot.httpHeaders)<0){fail();return;}
    m_replacementPending=true;
    const auto result=m_mpv->command(command);
    if(result.metaType()==QMetaType::fromType<ErrorReturn>()) {
      fail();return;
    }
    const auto loaded=result.toMap();
    if(!loaded.contains("playlist_entry_id")){fail();return;}
    m_windowsRecoveryLoads.insert(loaded["playlist_entry_id"].toLongLong(),snapshot);
    m_windowsReplacementTargetEntryId=loaded["playlist_entry_id"].toLongLong();
    const auto play=m_mpv->command(QStringList{"playlist-play-index",QString::number(index)});
    if(play.metaType()==QMetaType::fromType<ErrorReturn>()){fail();return;}
    const auto updated=m_mpv->getProperty("playlist").toList();
    for(int i=0;i<updated.size();++i)if(updated[i].toMap()["id"].toLongLong()==entryId){
      m_mpv->command(QStringList{"playlist-remove",QString::number(i)});break;
    }
  });
  return true;
}
#endif

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::componentPostInitialize()
{
  InputComponent::Get().registerHostCommand("player", this, "userCommand");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
PlayerComponent::~PlayerComponent()
{
  // m_mpv is owned by MpvVideoItem, don't access it here as it may be destroyed
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::componentInitialize()
{
  // Defer mpv creation until setQtQuickWindow() where we get MpvQt's handle
  // m_mpv will be set via setMpvHandle() called from MpvVideoItem::initMpv()
  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::initializeMpv()
{
  if (!m_mpv)
    throw FatalException(tr("Failed to load mpv."));

  // MpvQt already called mpv_initialize(), so mpv is ready
  // Properties that needed to be set before init were set in MpvVideoItem constructor

  mpv_request_log_messages(m_mpv->mpv(), "terminal-default");
  m_mpv->setProperty("msg-level", "all=v");

#ifdef TIGEREST_MPVQT_HAS_EVENT_HANDOFF
  // Complete the handoff on MpvQt's worker thread before adding observations.
  // Otherwise an old queued wakeup can steal never-changing initial values.
  const auto handoff=[this]{m_mpv->handoffEvents(wakeup_cb,this);};
  if(m_mpv->thread()==QThread::currentThread())handoff();
  else QMetaObject::invokeMethod(m_mpv,handoff,Qt::BlockingQueuedConnection);
#else
  // System MpvQt retains its existing host API; Windows RIFE is unavailable
  // there because it needs exclusive ownership of initial observations.
  mpv_set_wakeup_callback(m_mpv->mpv(),wakeup_cb,this);
#endif

  // Native gpu-next owns a child window. Keep it closed while idle so the
  // Emby library remains visible; the Render API can keep its in-scene target.
  m_mpv->setProperty("force-window", !m_nativeVideoOutput);

  // Disable native OSD if mpv_command_string() is used.
  m_mpv->setProperty("osd-level", "0");

  // This forces the player not to rebase playback time to 0 with mkv. We
  // require this, because mkv transcoding lets files start at times other
  // than 0, and web-client expects that we return these times unchanged.
  m_mpv->setProperty( "demuxer-mkv-probe-start-time", false);

  // "auto" (upstream default) skips avformat_find_stream_info() only for MP4 and
  // Matroska, whose headers already describe every stream; HLS and MPEG-TS are
  // still probed. Forcing it for a network MP4 (2.4.1 report) cost about 120
  // HTTP range requests between audio and video samples, and startup hit the
  // 30 s timeout before the first frame.
  m_mpv->setProperty( "demuxer-lavf-probe-info", "auto");

  // Just discard audio output if no audio device could be opened. This gives
  // us better flexibility how to react to such errors (instead of just
  // aborting playback immediately).
  m_mpv->setProperty( "audio-fallback-to-null", "yes");

  // Do not let the decoder downmix (better customization for us).
  m_mpv->setProperty( "ad-lavc-downmix", false);

  // User-visible application name used by some audio APIs (at least PulseAudio).
  m_mpv->setProperty( "audio-client-name", QCoreApplication::applicationName());

  // User-visible stream title used by some audio APIs (at least PulseAudio and wasapi).
  m_mpv->setProperty( "title", QCoreApplication::applicationName());

  // See: https://github.com/plexinc/plex-media-player/issues/736
  m_mpv->setProperty( "cache-seek-min", 5000);

  // Disable ytdl
  m_mpv->setProperty( "ytdl", false);

  if (SettingsComponent::Get().ignoreSSLErrors()) {
    m_mpv->setProperty( "tls-ca-file", "");
    m_mpv->setProperty( "tls-verify", "no");
  } else {
#if !defined(Q_OS_WIN) && !defined(Q_OS_MAC)
    if (SettingsComponent::Get().autodetectCertBundle()) {
      QString certPath = SettingsComponent::Get().detectCertBundlePath();
      if (!certPath.isEmpty()) {
        m_mpv->setProperty("tls-ca-file", certPath);
        m_mpv->setProperty("tls-verify", QString("yes"));
      } else {
        throw FatalException(tr("Failed to locate CA bundle."));
      }
    } else {
      m_mpv->setProperty( "tls-verify", "yes");
    }
#else
    // We need to not use Shinchiro's personal CA file...
    m_mpv->setProperty( "tls-ca-file", "");
#endif
  }

  // Apply some low-memory settings on RPI, which is relatively memory-constrained.
#ifdef TARGET_RPI
  // The backbuffer makes seeking back faster (without having to do a HTTP-level seek)
  m_mpv->setProperty( "cache-backbuffer", 10 * 1024); // KB
  // The demuxer queue is used for the readahead, and also for dealing with badly
  // interlaved audio/video. Setting it too low increases sensitivity to network
  // issues, and could cause playback failure with "bad" files.
  m_mpv->setProperty( "demuxer-max-bytes", 50 * 1024 * 1024); // bytes
  // Specifically for enabling mpeg4.
  m_mpv->setProperty( "hwdec-codecs", "all");
  // Do not use exact seeks by default. (This affects the start position in the "loadfile"
  // command in particular. We override the seek mode for normal "seek" commands.)
  m_mpv->setProperty( "hr-seek", "no");
  // Force vo_rpi to fullscreen.
  m_mpv->setProperty( "fullscreen", true);
#endif

  // MpvQt already called mpv_initialize() - don't call it again
  // if (mpv_initialize(m_mpv) < 0)
  //   throw FatalException(tr("Failed to initialize mpv."));

  mpv_observe_property(m_mpv->mpv(), 0, "pause", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "volume", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "core-idle", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "cache-buffering-state", MPV_FORMAT_INT64);
  mpv_observe_property(m_mpv->mpv(), 0, "playback-time", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "vo-configured", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "duration", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "audio-device-list", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "current-ao", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "video-dec-params", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "demuxer-cache-state", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "fullscreen", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "vo", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "gpu-api", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "gpu-context", MPV_FORMAT_STRING);
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  mpv_observe_property(m_mpv->mpv(), 0, "vf", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "hwdec", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "video-params", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "video-target-params", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "current-tracks/video/dolby-vision-profile", MPV_FORMAT_INT64);
  mpv_observe_property(m_mpv->mpv(), 0, "tone-mapping", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "osd-dimensions", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "video-frame-info", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "container-fps", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "seeking", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "paused-for-cache", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "frame-drop-count", MPV_FORMAT_INT64);
  mpv_observe_property(m_mpv->mpv(), 0, "decoder-frame-drop-count", MPV_FORMAT_INT64);
  mpv_observe_property(m_mpv->mpv(), 0, "glsl-shaders", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "current-gpu-context", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "current-vo", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "hwdec-current", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "scale", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "cscale", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "dscale", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "tscale", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "interpolation", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "deband", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "scripts", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "load-scripts", MPV_FORMAT_FLAG);
  mpv_observe_property(m_mpv->mpv(), 0, "video-out-params", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "aid", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "sid", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "audio-params", MPV_FORMAT_NODE);
  mpv_observe_property(m_mpv->mpv(), 0, "audio-device", MPV_FORMAT_STRING);
  mpv_observe_property(m_mpv->mpv(), 0, "video-sync", MPV_FORMAT_STRING);
#ifdef Q_OS_WIN
  mpv_observe_property(m_mpv->mpv(), 0, "avsync", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "display-fps", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "speed", MPV_FORMAT_DOUBLE);
  mpv_observe_property(m_mpv->mpv(), 0, "mistimed-frame-count", MPV_FORMAT_INT64);
#endif
  m_rifeAccess=std::make_unique<rife::MpvPollAccess>(rife::MpvAccess{
    [this](const QString& key){return m_mpv->getProperty(key);},
    [this](const QString& key,const QVariant& value){return m_mpv->setProperty(key,value)>=0;},
    [this](const QStringList& arguments){
      QList<QByteArray> storage;QList<const char*> command;
      for(const auto& argument:arguments)storage.append(argument.toUtf8());
      for(const auto& argument:storage)command.append(argument.constData());
      command.append(nullptr);return mpv_command(m_mpv->mpv(),command.data())>=0;
    },
    [this](const QString& key,const QVariant& value){return m_mpv->setPropertyAsync(key,value)>=0;},
    [this](const QStringList& arguments){return m_mpv->commandAsync(arguments)>=0;},
    [this](const QString& key,const QVariant& value,int id){return m_mpv->setPropertyAsync(key,value,id)>=0;},
    [this](const QString& key,int id){return mpv_get_property_async(m_mpv->mpv(),uint64_t(id),key.toUtf8().constData(),MPV_FORMAT_NODE)>=0;},
    true
  });
#ifdef Q_OS_WIN
  m_rife=std::make_unique<rife::FrameInterpolationController>(
      m_rifeAccess->interface(),m_windowsRifeRuntime->pathsFor({}));
  m_windowsRifePlayback=std::make_unique<rife::RifePlaybackCoordinator>(*m_windowsRifeRuntime,*m_rife);
  // Windowed and fullscreen presentation pace TensorRT playback differently.
  connect(&WindowManager::Get(),&WindowManager::fullScreenSwitched,this,
          &PlayerComponent::updateInterpolationPresentation,Qt::UniqueConnection);
#else
  m_rife=std::make_unique<rife::FrameInterpolationController>(
      m_rifeAccess->interface(),rife::bundledRuntimePaths());
#endif
  m_rifeClock.start();m_rifeTimer.setInterval(250);
  m_rifeSuppressedSvp=MpvConfigManager::ownsDefaultSvpIpc()&&SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRife").toBool();
  connect(&m_rifeTimer,&QTimer::timeout,this,&PlayerComponent::pollInterpolation);
  m_rifeTimer.start();
#endif

  // Setup a hook with the ID 1, which is run during the file is loaded.
  // Used to delay playback start for display framerate switching.
  // (See handler in handleMpvEvent() for details.)
  // Setup a hook with the ID 2, which is run at a certain stage during loading.
  // We use it to initialize stream selections and to probe the codecs.
#if MPV_CLIENT_API_VERSION < MPV_MAKE_VERSION(1, 100)
  m_mpv->command( QStringList() << "hook-add" << "on_load" << "1" << "0");
  m_mpv->command( QStringList() << "hook-add" << "on_preloaded" << "2" << "0");
#else
  mpv_hook_add(m_mpv->mpv(), 1, "on_load", 0);
  mpv_hook_add(m_mpv->mpv(), 2, "on_preloaded", 0);
#endif

  updateAudioDeviceList();
  setAudioConfiguration();
  setVideoConfiguration();
  setSubtitleConfiguration();
  setMpvPreset();
  publishProfileMenu();
  if (qEnvironmentVariableIsSet("TIGEREST_MPV_CONFIG_FALLBACK_USED"))
    MpvConfigManager::addNotice(QStringLiteral("fallback"), QStringLiteral("mpv 配置没能加载"),
                                QStringLiteral("mpv 无法用你的 mpv.conf 启动，本次已改用默认配置。请到「设置 → MPV 画质与插件」检查编辑器里标红的行。"));
  // The editor checks option names and values against this player's own
  // option table; refresh the cached copy after the event loop starts.
  QTimer::singleShot(0, this, &PlayerComponent::storeMpvOptionTable);

  // Preserve non-authentication headers supplied by the active mpv config.
  // Per-stream Emby credentials are appended at load time and never placed in
  // the URL, where stats.lua and verbose logs can expose them.
  const QVariantList configuredHeaders = m_mpv->getProperty("http-header-fields").toList();
  for (const QVariant& header : configuredHeaders)
    m_baseHttpHeaders.append(header.toString());

  // Host-critical keys are forced in both backends. In native gpu-next the
  // child window receives keyboard input directly, so QML cannot provide
  // these fallbacks itself.
  QString hostBindings = QStringLiteral(
      "F11 cycle fullscreen\n"
      "Ctrl+j script-binding stats/display-stats-toggle\n"
      "Ctrl+Shift+j script-binding stats/display-page-2");
#ifdef Q_OS_WIN
  hostBindings.prepend(QStringLiteral(
      "Alt+F4 script-message tigerest-application-quit\n"
      "CLOSE_WIN script-message tigerest-application-quit\n"));
#endif
#if defined(Q_OS_MAC)
  if (m_nativeVideoOutput)
  {
    // Cocoa emits CLOSE_WIN when the red title-bar button is clicked. mpv's
    // default maps it to quit, which destroys the libmpv core owned by the
    // application. Stop only the current file so the native window closes,
    // Emby receives a cancellation, and the same core can be reused.
    hostBindings.prepend(QStringLiteral(
        "CLOSE_WIN stop\n"
        "ESC stop\n"
        "q stop\n"
        "Q stop\n"));
  }
#endif
  m_mpv->command(QStringList()
                 << "define-section" << "tigerest-host"
                 << hostBindings << "force");
  m_mpv->command(QStringList() << "enable-section" << "tigerest-host");

  if (auto* s = SettingsComponent::Get().getSection(SETTINGS_SECTION_AUDIO))
    connect(s, &SettingsSection::valuesUpdated, this, &PlayerComponent::updateAudioConfiguration);

  if (auto* s = SettingsComponent::Get().getSection(SETTINGS_SECTION_VIDEO))
    connect(s, &SettingsSection::valuesUpdated, this, &PlayerComponent::updateVideoConfiguration);

  if (auto* s = SettingsComponent::Get().getSection(SETTINGS_SECTION_SUBTITLES))
    connect(s, &SettingsSection::valuesUpdated, this, &PlayerComponent::updateSubtitleConfiguration);

  if (auto* s = SettingsComponent::Get().getSection(SETTINGS_SECTION_MPV))
    connect(s, &SettingsSection::valuesUpdated, this, &PlayerComponent::updateMpvConfiguration);

  connect(this, &PlayerComponent::onMpvEvents, this, &PlayerComponent::handleMpvEvents, Qt::QueuedConnection);
  emit onMpvEvents();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setVideoRectangle(int x, int y, int w, int h)
{
  QRect rc(x, y, w, h);
  if (rc != m_videoRectangle)
  {
    m_videoRectangle = rc;
    emit onVideoRecangleChanged();
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setQtQuickWindow(QQuickWindow* window)
{
  qDebug() << "PlayerComponent::setQtQuickWindow called";
  MpvVideoItem* video = window->findChild<MpvVideoItem*>("video");
  if (!video) {
    qCritical() << "Failed to find MpvVideoItem with objectName 'video'";
    throw FatalException(tr("Failed to load video element."));
  }

  qDebug() << "Found MpvVideoItem, calling setPlayerComponent";
  video->setPlayerComponent(this);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setWindow(QQuickWindow* window)
{
  QString vo = "libmpv";

#ifdef TARGET_RPI
  window->setFlags(Qt::FramelessWindowHint);
  vo = "rpi";
#endif

  m_window = window;
  if (!window)
    return;

  QString forceVo = SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "debug.force_vo").toString();
  if (forceVo.size())
    vo = forceVo;

  // MpvQt sets vo=libmpv in MpvVideoItem constructor
  // Don't set it here since m_mpv may be null (MpvQt not ready yet)

  // Both Render API and native gpu-next reuse the same mpv controller item.
  setQtQuickWindow(window);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::load(const QString& url, const QVariantMap& options, const QVariantMap &metadata, const QVariant& audioStream , const QVariant& subtitleStream)
{
  // Replace atomically while a file is active, but append-and-play from mpv's
  // idle/EOF state.  libmpv accepts loadfile=replace immediately after EOF yet
  // can leave the replacement dormant in the finished playlist; append-play
  // is the documented operation that starts a newly appended idle item.  This
  // avoids both that EOF stall and the old stop()+append-play race.
  const QString loadMode = m_inPlayback ? QStringLiteral("replace")
                                        : QStringLiteral("append-play");
  qInfo() << "Primary media load mode:" << loadMode
          << "active playback:" << m_inPlayback;
  return loadMedia(url, options, metadata, audioStream, subtitleStream,
                   loadMode);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::queueMedia(const QString& url, const QVariantMap& options, const QVariantMap &metadata, const QVariant& audioStream, const QVariant& subtitleStream)
{
  loadMedia(url, options, metadata, audioStream, subtitleStream,
            QStringLiteral("append-play"));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////
static QString rangePrimaries(const QString& name)
{
  static const QHash<QString, QString> names{{"bt.709", "BT.709"}, {"bt.2020", "BT.2020"}, {"display-p3", "Display P3"},
      {"dci-p3", "DCI-P3"}, {"bt.601-525", "BT.601"}, {"bt.601-625", "BT.601"}, {"apple", "Apple RGB"}, {"adobe", "Adobe RGB"}};
  return names.value(name, name.isEmpty() ? QStringLiteral("未知") : name.toUpper());
}

static QString rangeTransfer(const QString& name)
{
  static const QHash<QString, QString> names{{"pq", "PQ"}, {"hlg", "HLG"}, {"srgb", "sRGB"}, {"bt.1886", "BT.1886"},
      {"gamma2.2", "Gamma 2.2"}, {"gamma2.4", "Gamma 2.4"}, {"linear", QStringLiteral("线性")}};
  return names.value(name, name.isEmpty() ? QStringLiteral("未知") : name);
}

static QString rangeColorspace(const QVariantMap& params)
{
  return rangePrimaries(params.value("primaries").toString()) + " / " + rangeTransfer(params.value("gamma").toString());
}

static int rangeNits(const QVariant& value)
{
  // Mastering peaks are coded with small offsets (1000.6); report 10-nit steps.
  const double nits = value.toDouble();
  return std::isfinite(nits) && nits > 0 ? qRound(nits / 10) * 10 : 0;
}

// Once per file, after the VO reports its target: is the display receiving
// HDR or SDR, and from what source.
void PlayerComponent::reportDynamicRange()
{
#ifndef Q_OS_MAC
  // Introduced for the Apple clients; Windows/Linux behaviour is the PC side's call.
  return;
#endif
  const QString sourceGamma = m_rangeSource.value("gamma").toString(), targetGamma = m_rangeTarget.value("gamma").toString();
  if (m_rangeReported || sourceGamma.isEmpty() || targetGamma.isEmpty())
    return;
  m_rangeReported = true;
  const QStringList hdr{"pq", "hlg"};
  const bool sourceHdr = hdr.contains(sourceGamma), targetHdr = hdr.contains(targetGamma);
  const QString format = m_rangeDolbyVisionProfile > 0 ? QStringLiteral("杜比视界 Profile %1").arg(m_rangeDolbyVisionProfile)
      : sourceGamma == "hlg" ? QStringLiteral("HLG") : QStringLiteral("HDR10");
  const QString mode = targetHdr ? QStringLiteral("HDR 输出 · ") + format
      : sourceHdr ? QStringLiteral("SDR 输出 · %1 已色调映射（%2）").arg(format, m_rangeToneMapping.isEmpty() ? QStringLiteral("自动") : m_rangeToneMapping)
      : QStringLiteral("SDR 播放");
  QStringList input;
  const int width = m_rangeSource.value("w").toInt(), height = m_rangeSource.value("h").toInt();
  if (width > 0 && height > 0)
    input << QStringLiteral("%1×%2").arg(width).arg(height);
  input << rangeColorspace(m_rangeSource);
  if (sourceHdr && rangeNits(m_rangeSource.value("max-luma")))
    input << QStringLiteral("母版 %1 nits").arg(rangeNits(m_rangeSource.value("max-luma")));
  // A PQ target's max-luma is the signal's 10000-nit ceiling, not the screen;
  // macOS maps HDR to the display's current EDR headroom.
  QStringList output{rangeColorspace(m_rangeTarget)};
  if (targetHdr)
    output << QStringLiteral("由系统按屏幕能力映射亮度");
  const QString text = mode + QStringLiteral("\n片源 ") + input.join(QStringLiteral(" · ")) + QStringLiteral("\n输出 ") + output.join(QStringLiteral(" · "));
  qInfo() << "Dynamic range:" << QString(text).replace('\n', QStringLiteral(" | "));
  // A separate overlay at the top right: show-text shares mpv's one message
  // slot, and the danmaku script's notices use their own top-left overlay.
  const int osdHeight = m_osdHeight > 0 ? m_osdHeight : 1080, osdWidth = m_osdWidth > 0 ? m_osdWidth : osdHeight * 16 / 9;
  const int margin = qMax(16, osdHeight / 30), size = qMax(14, osdHeight / 40);
  // Fixed wording and mpv enum names only: no ASS braces or backslashes.
  QString ass = text;
  ass.replace('\n', QStringLiteral("\\N"));
  const QString data = QStringLiteral("{\\an9\\pos(%1,%2)\\fs%3\\bord%4\\shad0\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&}%5")
      .arg(osdWidth - margin).arg(margin).arg(size).arg(qMax(2, size / 12)).arg(ass);
  static const QString id = QStringLiteral("47");
  m_mpv->commandAsync(QStringList() << QStringLiteral("osd-overlay") << id << QStringLiteral("ass-events") << data
      << QString::number(osdWidth) << QString::number(osdHeight) << QStringLiteral("10"));
  const quint64 generation = ++m_rangeNoticeGeneration;
  QTimer::singleShot(4000, this, [this, generation]() {
    if (generation == m_rangeNoticeGeneration && m_mpv)
      m_mpv->commandAsync(QStringList() << QStringLiteral("osd-overlay") << id << QStringLiteral("none") << QString());
  });
}

bool PlayerComponent::loadMedia(const QString& url, const QVariantMap& options,
                                const QVariantMap& metadata, const QVariant& audioStream,
                                const QVariant& subtitleStream, const QString& loadMode)
{
  if (!m_mpv) {
    qWarning() << "PlayerComponent::loadMedia: mpv not initialized yet";
    return false;
  }

#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  if (m_shuttingDown)
    return false;
#endif
#ifdef Q_OS_MAC
  if (m_nativeVideoOutput && m_nativeVoTeardownPending)
  {
    // mpv can report idle before macvk has finished closing its Cocoa window.
    // A synchronous property write here would wait on the mpv core while its
    // VO thread waits on this Qt main thread.
    m_deferredMediaLoads.append({url, options, metadata, audioStream, subtitleStream, loadMode});
    return true;
  }
#endif

  InputComponent::Get().cancelAutoRepeat();

#if defined(Q_OS_MAC)
  if (m_nativeVideoOutput)
  {
    // The Cocoa window is recreated whenever gpu-next configures a new VO.
    // Set fullscreen before load so it opens directly on the target Space
    // without briefly flashing a normal-sized window.
    m_mpv->setProperty("fullscreen", true);
    m_mpv->setProperty("force-window", false);
    // The profile's automatic ICC profile describes an SDR display. On an EDR
    // display it became the colorspace hint target, so HDR and Dolby Vision
    // got an SDR P3 swapchain without highlights; there macOS ColorSync maps
    // the hinted layer colorspace itself. SDR displays keep libplacebo's
    // ICC-managed tone mapping. Explicit advanced overrides are respected.
    if (!SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "advancedProfileOverrides").toBool())
      m_mpv->setProperty("icc-profile-auto", !OSXUtils::ScreenSupportsEDR(m_window ? m_window->screen() : nullptr));
  }
#endif

  m_mediaFrameRate = metadata["frameRate"].toFloat(); // returns 0 on failure
  m_serverMediaInfo = metadata["media"].toMap();
#ifdef Q_OS_WIN
  // Dolby Vision without an HDR10 base layer is still HDR once libplacebo applies it.
  const QString dynamicRange = metadata["dynamicRange"].toString();
  m_mediaHdr = dynamicRange == QLatin1String("hdr") || dynamicRange == QLatin1String("dovi");
#endif

  updateVideoConfiguration();

  QUrl qurl = sanitizeMediaUrl(url);
  QString host = qurl.host();

  QVariantList command;
  command << QStringLiteral("loadfile") << qurl.toString(QUrl::FullyEncoded);
  command << loadMode;

#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 3)
  command << -1; // insert_at_idx
#endif

  QVariantMap fileOptions;

  quint64 startMilliseconds = options["startMilliseconds"].toLongLong();
  if (startMilliseconds != 0)
    fileOptions.insert(QStringLiteral("start"),
                       QStringLiteral("+") + QString::number(startMilliseconds / 1000.0));

  // we're going to select these streams later, in the preloaded hook
  fileOptions.insert(QStringLiteral("aid"), QStringLiteral("no"));
  fileOptions.insert(QStringLiteral("sid"), QStringLiteral("no"));

  // A local file has no server stream choice: mpv picks the tracks, including
  // subtitles beside the file.
  const bool localPlayback = metadata.value(QStringLiteral("localPlayback")).toBool();
  const QVariant selectedSubtitle = localPlayback ? QVariant(QStringLiteral("auto")) : subtitleStream;
  const QVariant selectedAudio = localPlayback ? QVariant(QStringLiteral("auto")) : audioStream;
  m_currentSubtitleStream = selectedSubtitle;
  m_currentAudioStream = selectedAudio;

  if (metadata["type"] == "music")
    fileOptions.insert(QStringLiteral("vid"), QStringLiteral("no"));

  QString pause = options["autoplay"].toBool() ? "no" : "yes";
  fileOptions.insert(QStringLiteral("pause"), pause);

  QString userAgent = metadata["headers"].toMap()["User-Agent"].toString();
  if (userAgent.size())
    fileOptions.insert(QStringLiteral("user-agent"), userAgent);

  // Make sure the list of requested codecs is reset.
  fileOptions.insert(QStringLiteral("ad"), QString());
  fileOptions.insert(QStringLiteral("vd"), QString());

  const QVariantMap jellyfinMetadata = metadata["metadata"].toMap();
  const Tigerest::PlaybackIdentity playbackIdentity =
    Tigerest::makePlaybackIdentity(jellyfinMetadata);
  if (!playbackIdentity.mediaTitle.isEmpty())
    fileOptions.insert(QStringLiteral("force-media-title"), playbackIdentity.mediaTitle);

  const auto setIdentityProperty = [this](const QString& name, const QVariant& value) {
    const int result = m_mpv->setProperty(name, value);
    if (result < 0)
      qWarning() << "Unable to publish MPV playback identity property" << name
                 << mpv_error_string(result);
    return result >= 0;
  };

  const QString identityRoot = QStringLiteral("user-data/tigerest/emby/");
  auto& settings = SettingsComponent::Get();
  // Only a private filename is published; the credential is never an MPV option,
  // setting, log field or web/bootstrap property. Absence enables read-only mapping.
  updateDanmakuAuthorization(SystemComponent::Get().communityMappingAuthFile(),
                            SystemComponent::Get().communityAuthGeneration());
  setIdentityProperty(QStringLiteral("user-data/tigerest/danmaku/api-server"),
    MpvConfigManager::danmakuApiServer(
      settings.value(SETTINGS_SECTION_MAIN, "userWebClient").toString(),
      settings.value(SETTINGS_SECTION_MAIN, "serverConnectionMode").toString()));
  // The script sends these only to our own danmaku service.
  setIdentityProperty(QStringLiteral("user-data/tigerest/danmaku/client-headers"),
                      CommunityBridge::clientHeaders());
  setIdentityProperty(identityRoot + QStringLiteral("valid"), false);
  // Local playback uses no online service; the danmaku script stays idle.
  setIdentityProperty(QStringLiteral("user-data/tigerest/local-playback"), localPlayback);
  bool identityReady = true;
  identityReady = setIdentityProperty(identityRoot + QStringLiteral("item-id"),
                                      playbackIdentity.itemId) && identityReady;
  identityReady = setIdentityProperty(identityRoot + QStringLiteral("series-name"),
                                      playbackIdentity.seriesName) && identityReady;
  identityReady = setIdentityProperty(identityRoot + QStringLiteral("episode-name"),
                                      playbackIdentity.episodeName) && identityReady;
  identityReady = setIdentityProperty(identityRoot + QStringLiteral("premiere-date"),
                                      jellyfinMetadata.value(QStringLiteral("PremiereDate")).toString()) && identityReady;
  identityReady = setIdentityProperty(identityRoot + QStringLiteral("season-number"),
                                      playbackIdentity.seasonNumber) && identityReady;
  identityReady = setIdentityProperty(identityRoot + QStringLiteral("episode-number"),
                                      playbackIdentity.episodeNumber) && identityReady;
  if (playbackIdentity.validEpisode && identityReady)
    setIdentityProperty(identityRoot + QStringLiteral("valid"), true);

  command << fileOptions;

  const QVariant commandResult = m_mpv->command(command);
  if (commandResult.metaType() == QMetaType::fromType<ErrorReturn>())
  {
    const ErrorReturn error = commandResult.value<ErrorReturn>();
    qWarning() << "Unable to load media with mode" << loadMode
               << ":" << m_mpv->getError(error.error);
    return false;
  }

  m_playbackCanceled = false;
  m_playbackError.clear();
  m_lastPositionUpdate = 0.0;
  m_replacementPending = loadMode == QStringLiteral("replace") && m_inPlayback;
#ifdef Q_OS_WIN
  if(loadMode==QStringLiteral("replace")) {
    if(m_windowsRifePlayback)m_windowsRifePlayback->endItem();
    m_rifeStartup.cancel();publishInterpolationPause();
    ++m_windowsPlaybackGeneration;m_windowsReplacementTargetEntryId=-1;m_windowsRifeReloaded=false;
    m_windowsRecoveryLoads.clear();
  }
  const auto loaded=commandResult.toMap();
  if(loadMode==QStringLiteral("replace")&&loaded.contains("playlist_entry_id")) {
    m_replacementPending=true;
    m_windowsReplacementTargetEntryId=loaded["playlist_entry_id"].toLongLong();
  }
  if(loaded.contains("playlist_entry_id"))
    m_windowsRecoveryLoads.insert(loaded["playlist_entry_id"].toLongLong(),
        WindowsRecoveryLoad{command,m_mpv->getProperty("http-header-fields").toList(),selectedAudio,selectedSubtitle});
  if(loadMode==QStringLiteral("append-play")&&m_inPlayback&&!m_windowsCurrentLoad.command.isEmpty()) {
    m_currentAudioStream=m_windowsCurrentLoad.audioStream;m_currentSubtitleStream=m_windowsCurrentLoad.subtitleStream;
    m_mpv->setProperty("http-header-fields",m_windowsCurrentLoad.httpHeaders);
  }
#endif

  QUrl jellyfinBaseUrl = qurl.adjusted(QUrl::RemovePath | QUrl::RemoveQuery);
  emit onMetaData(jellyfinMetadata, jellyfinBaseUrl);

  // Request album art from the provider
  if (m_albumArtProvider)
    m_albumArtProvider->requestArtwork(jellyfinMetadata, jellyfinBaseUrl);

  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString PlayerComponent::sanitizeMediaUrl(const QString& url, bool retainExistingCredential)
{
  QUrl sanitized(url);
  QUrlQuery query(sanitized);
  QUrlQuery retained;
  QString accessToken;

  const auto items = query.queryItems(QUrl::FullyDecoded);
  for (const auto& item : items)
  {
    const QString key = item.first.toLower();
    const bool isCredential = key == "api_key" || key == "apikey" ||
                              key == "x-emby-token" || key == "x-mediabrowser-token";
    if (isCredential)
    {
      if (accessToken.isEmpty())
        accessToken = item.second;
      continue;
    }
    retained.addQueryItem(item.first, item.second);
  }

  sanitized.setQuery(retained);
  if (!accessToken.isEmpty() || !retainExistingCredential)
    applyMediaAccessToken(accessToken);
  return sanitized.toString(QUrl::FullyEncoded);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::applyMediaAccessToken(const QString& token)
{
  QVariantList headers;
  for (const QString& header : m_baseHttpHeaders)
    headers.append(header);

  // libcurl drops a custom Authorization header when a redirect leaves the
  // original host, port or scheme, so a 302 to a CDN never receives the Emby
  // token. X-Emby-Token would be forwarded to every redirect target.
  if (!token.isEmpty())
    headers.append(QString("Authorization: MediaBrowser Token=\"%1\"").arg(token));

  m_mpv->setProperty("http-header-fields", headers);
}

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::streamSwitch()
{
  m_streamSwitchImminent = true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::switchDisplayFrameRate()
{
  qDebug() << "Video framerate:" << m_mediaFrameRate << "fps";

  if (!SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "refreshrate.auto_switch").toBool())
  {
    qDebug() << "Not switching refresh-rate (disabled by settings).";
    return false;
  }

  bool fs = SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "fullscreen").toBool();
#ifdef KONVERGO_OPENELEC
  fs = true;
#endif
  if (!fs)
  {
    qDebug() << "Not switching refresh-rate (not in fullscreen mode).";
    return false;
  }

  if (m_mediaFrameRate < 1)
  {
    qDebug() << "Not switching refresh-rate (no known video framerate).";
    return false;
  }

  // Make sure a timer started by the previous file ending isn't accidentally
  // still in-flight. It could switch the display back after we've switched.
  m_restoreDisplayTimer.stop();

  DisplayComponent* display = &DisplayComponent::Get();
  if (!display->switchToBestVideoMode(m_mediaFrameRate))
  {
    qDebug() << "Switching refresh-rate failed or unnecessary.";
    return false;
  }

  // Make sure settings dependent on the display refresh rate are updated properly.
  updateVideoConfiguration();
  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::switchDisplayDynamicRange()
{
#ifdef Q_OS_WIN
  m_restoreHdrTimer.stop();
  // The libmpv Render API draws into Qt's SDR OpenGL scene, which cannot carry HDR.
  const bool allowed = m_nativeVideoOutput &&
      SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "hdr.auto_switch").toBool();
  const auto result = m_hdrSwitch->prepare(m_window ? m_window->winId() : 0, m_mediaHdr, allowed);
  // In HDR mode Windows reports the HDR calibration (MHC2) profile, which the
  // compositor already applies. As mpv's ICC target it turned HDR into a
  // 416-nit SDR image on an SDR swapchain; without it mpv hints HDR10 and
  // tone maps to the display's own peak. Explicit advanced overrides win.
  if (!SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "advancedProfileOverrides").toBool())
    m_mpv->setProperty("icc-profile-auto", !result.hdrActive);
  // The D3D11 context reads the output's colour space once, when it opens. A
  // replacement keeps the previous item's video output, so reopen it.
  const QString vo = m_mpv->getProperty("current-vo").toString();
  if (result.switched && m_nativeVideoOutput && !vo.isEmpty())
  {
    qInfo() << "Reopening video output" << vo << "for the new display mode";
    m_mpv->setProperty("vo", "null");
    m_mpv->setProperty("vo", vo);
  }
  return result.switched;
#else
  return false;
#endif
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::onRestoreDisplay()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
#if defined(Q_OS_MAC)
  if (m_nativeVideoOutput)
  {
    // Cocoa closes the native mpv window on the main thread. Querying an mpv
    // property from the zero-delay END_FILE timer can then wait for VO teardown,
    // while that teardown is itself waiting for the close action to return.
    // END_FILE already cleared m_inPlayback, and replace transitions never arm
    // this timer, so the local state is sufficient on this macOS-only path.
    if (!m_inPlayback)
      DisplayComponent::Get().restorePreviousVideoMode();
    return;
  }
#endif

  // If the player will in fact start another file (or is playing one), don't restore.
  if (m_mpv->getProperty( "idle-active").toBool())
    DisplayComponent::Get().restorePreviousVideoMode();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::onRefreshRateChange()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
#if defined(Q_OS_MAC)
  if (m_nativeVideoOutput && (!m_inPlayback || m_nativeVoTeardownPending || m_shuttingDown))
  {
    // Restoring the display after a native Cocoa close emits this signal from
    // the close button's nested run loop. Avoid synchronous mpv_set_property()
    // calls until that VO teardown has returned. The next load reapplies the
    // video configuration after its own display-mode decision.
    return;
  }
#endif

  // Make sure settings dependent on the display refresh rate are updated properly.
  updateVideoConfiguration();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updatePlaybackState()
{
  State newState = m_state;

  if (m_inPlayback) {
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
    if(m_rifeStartup.waitingToPlay())
      newState=State::buffering;
    else
#endif
#ifdef Q_OS_WIN
    // Resuming: mpv is held while the interpolation graph refills.
    if(m_rifeResumePrime.pending())
      newState=State::buffering;
    else
#endif
    if (m_paused)
    {
      newState = State::paused;
    }
    else if (m_playbackActive)
    {
      newState = State::playing;
    }
    else
    {
      // Playback not active, but also not buffering means we're in some "other"
      // waiting state. Pretend to web-client that we're buffering.
      if (m_bufferingPercentage == 100)
        m_bufferingPercentage = 0;
      newState = State::buffering;
    }
  }
  else
  {
    if (!m_playbackError.isEmpty())
      newState = State::error;
    else if (m_playbackCanceled)
      newState = State::canceled;
    else
      newState = State::finished;
  }

  if (newState != m_state)
  {
    switch (newState) {
    case State::paused:
      qInfo() << "Entering state: paused";
      emit paused();
      break;
    case State::playing:
      qInfo() << "Entering state: playing";
      emit playing();
      break;
    case State::buffering:
      qInfo() << "Entering state: buffering";
      m_lastBufferingPercentage = -1; /* force update below */
      break;
    case State::finished:
      qInfo() << "Entering state: finished";
      emit finished();
      emit stopped();
      break;
    case State::canceled:
      qInfo() << "Entering state: canceled";
      emit canceled();
      emit stopped();
      break;
    case State::error:
      qInfo() << ("Entering state: error (" + m_playbackError + ")");
      emit error(m_playbackError);
      break;
    }
    emit stateChanged(newState, m_state);
    m_state = newState;
  }

  if (m_state == State::buffering && m_lastBufferingPercentage != m_bufferingPercentage)
    emit buffering(m_bufferingPercentage);
  m_lastBufferingPercentage = m_bufferingPercentage;

  bool is_videoPlaybackActive = m_state == State::playing && m_windowVisible;
  if (m_videoPlaybackActive != is_videoPlaybackActive)
  {
    m_videoPlaybackActive = is_videoPlaybackActive;
    emit videoPlaybackActive(m_videoPlaybackActive);
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::handleMpvEvent(mpv_event *event)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown && event->event_id != MPV_EVENT_LOG_MESSAGE) {
    // Do not run normal playback callbacks while the native VO is being
    // removed: several of them synchronously enter mpv from the GUI thread.
    if (event->event_id == MPV_EVENT_COMMAND_REPLY && event->reply_userdata == ApplicationQuitStop) {
      m_applicationStopAcknowledged = event->error >= 0;
      if (event->error < 0) qWarning() << "Application shutdown stop failed:" << mpv_error_string(event->error);
      checkApplicationQuit();
    } else if (event->event_id == MPV_EVENT_GET_PROPERTY_REPLY && event->reply_userdata == ApplicationQuitIdle) {
      m_applicationQuitQueryPending = false;
      const auto* property = static_cast<mpv_event_property*>(event->data);
      if (event->error >= 0 && property && property->format == MPV_FORMAT_FLAG &&
          property->data && *static_cast<int*>(property->data)) {
        m_applicationQuitQueryPending = mpv_get_property_async(m_mpv->mpv(), ApplicationQuitVo,
                                                               "current-vo", MPV_FORMAT_STRING) >= 0;
      }
    } else if (event->event_id == MPV_EVENT_GET_PROPERTY_REPLY && event->reply_userdata == ApplicationQuitVo) {
      m_applicationQuitQueryPending = false;
      // idle-active alone can precede VO teardown. current-vo is unavailable
      // only after uninit_video_out has returned, including already-idle exits.
      if (event->error == MPV_ERROR_PROPERTY_UNAVAILABLE)
        finishApplicationQuit();
    } else if (event->event_id == MPV_EVENT_IDLE) {
      checkApplicationQuit();
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(1, 100)
    } else if (event->event_id == MPV_EVENT_HOOK) {
      const auto* hook = static_cast<mpv_event_hook*>(event->data);
      mpv_hook_continue(m_mpv->mpv(), hook->id);
#endif
    } else if (event->event_id == MPV_EVENT_CLIENT_MESSAGE) {
      const auto* message = static_cast<mpv_event_client_message*>(event->data);
      if (message->num_args >= 1 && !strcmp(message->args[0], "tigerest-application-quit"))
        requestApplicationQuit();
      else if (message->num_args >= 3 && !strcmp(message->args[0], "hook_run"))
        m_mpv->commandAsync(QStringList() << "hook-ack" << QString::fromUtf8(message->args[2]));
    }
    return;
  }
#endif
  switch (event->event_id)
  {
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
    case MPV_EVENT_SET_PROPERTY_REPLY:
      if(m_rifeAccess)m_rifeAccess->completeTaggedSet(int(event->reply_userdata),event->error);
      if(m_rife&&m_rifeAccess){
        auto polling=m_rifeAccess->enterPolling();
        m_rife->onClockSetReply(event->reply_userdata,event->error);
      }
      if(m_rifeResumeRequest&&event->reply_userdata==uint64_t(m_rifeResumeRequest)&&
          m_rifeStartup.waiting()&&m_rifeResumeGeneration==m_rifeStartup.generation()){
        if(event->error<0){failInterpolationResume();break;}
        m_rifeResumeRequest=0;
        m_rifeStartup.finish();publishInterpolationPause();
      }
      break;
    case MPV_EVENT_GET_PROPERTY_REPLY:
      if(m_rife&&m_rifeAccess){
        auto *property=static_cast<mpv_event_property*>(event->data);
        QVariant value;
        if(event->error>=0&&property&&property->format==MPV_FORMAT_NODE&&property->data)
          value=mpv::qt::node_to_variant(static_cast<mpv_node*>(property->data));
        auto polling=m_rifeAccess->enterPolling();
        m_rife->onClockReadReply(event->reply_userdata,event->error,value);
      }
      break;
#endif
    case MPV_EVENT_START_FILE:
    {
      m_rangeReported = false; m_rangeSource.clear(); m_rangeTarget.clear(); m_rangeDolbyVisionProfile = 0;
#ifdef Q_OS_WIN
      ++m_windowsPlaybackGeneration;
      m_windowsCurrentEntryId=static_cast<mpv_event_start_file*>(event->data)->playlist_entry_id;
      m_windowsCurrentLoad=m_windowsRecoveryLoads.take(m_windowsCurrentEntryId);
      if(!m_windowsCurrentLoad.command.isEmpty()) {
        m_currentAudioStream=m_windowsCurrentLoad.audioStream;m_currentSubtitleStream=m_windowsCurrentLoad.subtitleStream;
        m_mpv->setProperty("http-header-fields",m_windowsCurrentLoad.httpHeaders);
      }
      m_windowsRifeReloaded=m_windowsCurrentLoad.recovery;
      if(m_windowsCurrentEntryId==m_windowsReplacementTargetEntryId)m_windowsReplacementTargetEntryId=-1;
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
      if(m_rifeAccess)m_rifeAccess->clearMedia();
#endif
#ifdef Q_OS_WIN
      if(m_windowsReplacementTargetEntryId<0)m_replacementPending=false;
#else
      m_replacementPending=false;
#endif
      m_inPlayback = true;
      m_nativeVideoReady = false;
#ifdef Q_OS_MAC
      // A queued playlist item can start without entering mpv's idle loop.
      // The previous VO has been released or is being reused by this point.
      completeNativeVoTransition();
#endif
      m_playbackCanceled = false;
      m_playbackError.clear();
      m_lastPositionUpdate = 0.0;
      m_audioOutputWarningShown = false;
      // A file mpv switches to by itself (a uosc directory entry, a dropped
      // file) follows an END_FILE that hid the window, and a VO kept across
      // the switch reports no vo-configured change to show it again.
      m_windowVisible = m_voConfigured;
      // An in-scene Render API target must be visible before VO reconfigure
      // can finish; native windows can wait for the actual VO readiness.
      emit windowVisible(!m_nativeVideoOutput || m_windowVisible);
      break;
    }
    case MPV_EVENT_END_FILE:
    {
      m_nativeVideoReady = false;
#ifdef Q_OS_WIN
      if(recoverWindowsRifeError(*static_cast<mpv_event_end_file*>(event->data)))break;
      if(m_windowsRifePlayback)m_windowsRifePlayback->endItem();
      m_rifeStartup.cancel();publishInterpolationPause();
      m_rifeResumePrime.cancel();
#endif
#ifdef Q_OS_MAC
      if(m_rife)m_rife->stopOnEndFile();
      m_rifeStartup.cancel();
      publishInterpolationPause();
      // mpv sends END_FILE before releasing the native VO. MPV_EVENT_IDLE is
      // sent after handle_force_window() has destroyed it.
      if(m_nativeVideoOutput && !m_replacementPending)
        m_nativeVoTeardownPending=true;
#endif
      auto *endFile = static_cast<mpv_event_end_file*>(event->data);

      // loadfile=replace ends the old entry before START_FILE for the new one.
      // That transition belongs to one logical web playback session and must
      // not emit a terminal state or briefly reveal WebEngine in between.
      if (m_replacementPending)
      {
        qDebug() << "Ignoring terminal state for atomically replaced media";
        break;
      }

      m_inPlayback = false;
      m_audioOutputWarningTimer.stop();
      m_audioOutputWarningShown = false;
      m_windowVisible = false;
      emit windowVisible(false);
      m_playbackCanceled = false;
      m_playbackError = "";

      switch (endFile->reason)
      {
        case MPV_END_FILE_REASON_ERROR:
        {
          m_playbackError = mpv_error_string(endFile->error);
          break;
        }
        case MPV_END_FILE_REASON_STOP:
        {
          m_playbackCanceled = true;
          break;
        }
        case MPV_END_FILE_REASON_QUIT:
        {
          // A quit request is a user cancellation in an embedded player, not
          // natural EOF. Treating it as finished makes Emby auto-start the
          // next queue item against an mpv core that is already shutting down,
          // which leaves the web UI spinning until its startup watchdog fires.
          qWarning() << "Embedded mpv received quit; treating playback as canceled";
          m_playbackCanceled = true;
          break;
        }
        case MPV_END_FILE_REASON_EOF:
        case MPV_END_FILE_REASON_REDIRECT:
          break;
      }

      if (!m_streamSwitchImminent)
        m_restoreDisplayTimer.start(0);
      m_streamSwitchImminent = false;
      break;
    }
    case MPV_EVENT_PROPERTY_CHANGE:
    {
      auto *prop = static_cast<mpv_event_property*>(event->data);
      {
        const bool source = strcmp(prop->name, "video-params") == 0, target = strcmp(prop->name, "video-target-params") == 0;
        if (source || target)
        {
          (source ? m_rangeSource : m_rangeTarget) = prop->format == MPV_FORMAT_NODE
            ? mpv::qt::node_to_variant(static_cast<mpv_node*>(prop->data)).toMap() : QVariantMap();
          reportDynamicRange();
        }
        else if (strcmp(prop->name, "current-tracks/video/dolby-vision-profile") == 0)
          m_rangeDolbyVisionProfile = prop->format == MPV_FORMAT_INT64 ? *static_cast<int64_t*>(prop->data) : 0;
        else if (strcmp(prop->name, "tone-mapping") == 0 && prop->format == MPV_FORMAT_STRING)
          m_rangeToneMapping = QString::fromUtf8(*static_cast<char**>(prop->data));
        else if (strcmp(prop->name, "osd-dimensions") == 0 && prop->format == MPV_FORMAT_NODE)
        {
          const QVariantMap size = mpv::qt::node_to_variant(static_cast<mpv_node*>(prop->data)).toMap();
          m_osdWidth = size.value("w").toInt(); m_osdHeight = size.value("h").toInt();
        }
      }
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
      if(m_rifeAccess) {
        static const QSet<QByteArray> watched={"vf","hwdec","video-params",
            "video-frame-info","container-fps","seeking","paused-for-cache",
            "frame-drop-count","decoder-frame-drop-count","glsl-shaders",
            "current-gpu-context","current-vo","hwdec-current","scale",
            "cscale","dscale","tscale","interpolation","deband",
            "scripts","load-scripts","video-out-params","aid","sid",
            "audio-params","audio-device","audio-device-list","current-ao","gpu-api",
            "vo","fullscreen","playback-time","duration","avsync","speed","display-fps","video-sync",
            "mistimed-frame-count"};
        if(watched.contains(prop->name)) {
          QVariant value;
          switch(prop->format) {
          case MPV_FORMAT_NODE:
            value=mpv::qt::node_to_variant(static_cast<mpv_node*>(prop->data));break;
          case MPV_FORMAT_FLAG:
            value=!!*static_cast<int*>(prop->data);break;
          case MPV_FORMAT_INT64:
            value=qlonglong(*static_cast<int64_t*>(prop->data));break;
          case MPV_FORMAT_DOUBLE:
            value=*static_cast<double*>(prop->data);break;
          case MPV_FORMAT_STRING: {
            auto **raw=static_cast<char**>(prop->data);
            value=raw&&*raw?QString::fromUtf8(*raw):QString();break;
          }
          default:break;
          }
          m_rifeAccess->observe(QString::fromUtf8(prop->name),value);
          if(m_rife&&strcmp(prop->name,"video-sync")==0) {
            auto polling=m_rifeAccess->enterPolling();
            m_rife->onVideoSyncChanged(value.toString());
          }
        }
      }
#endif
      if (strcmp(prop->name, "pause") == 0 && prop->format == MPV_FORMAT_FLAG)
      {
        const bool wasPaused = m_paused;
        m_paused = !!*static_cast<int*>(prop->data);
#ifdef Q_OS_WIN
        if (m_paused != wasPaused) onInterpolationPauseChanged();
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
        if(!m_paused&&m_rifeStartup.waiting()&&
            (!m_rifeResumeRequest||m_rifeResumeGeneration!=m_rifeStartup.generation())) {
          // Intent comes from dedicated controls, never from a racing physical
          // pause edge. External changes cannot release an unfinished graph.
          if(m_rifeAccess)m_rifeAccess->interface().setAsync("pause",true);
          else if(m_mpv)m_mpv->setPropertyAsync("pause",true);
        }
#endif
      }
      else if (strcmp(prop->name, "volume") == 0 && prop->format == MPV_FORMAT_DOUBLE && prop->data)
      {
        emit volumeChanged(*static_cast<double*>(prop->data));
      }
      else if (strcmp(prop->name, "core-idle") == 0 && prop->format == MPV_FORMAT_FLAG)
      {
        m_playbackActive = !*static_cast<int*>(prop->data);
      }
      else if (strcmp(prop->name, "cache-buffering-state") == 0)
      {
        m_bufferingPercentage = prop->format == MPV_FORMAT_INT64 ? static_cast<int>(*static_cast<int64_t*>(prop->data)) : 100;
      }
      else if (strcmp(prop->name, "playback-time") == 0 && prop->format == MPV_FORMAT_DOUBLE)
      {
        double pos = *static_cast<double*>(prop->data);
        if (fabs(pos - m_lastPositionUpdate) > 0.015)
        {
          quint64 ms = static_cast<quint64>(qMax(pos * 1000.0, 0.0));
          emit positionUpdate(ms);
          m_lastPositionUpdate = pos;
        }
      }
      else if (strcmp(prop->name, "vo-configured") == 0)
      {
        int state = prop->format == MPV_FORMAT_FLAG ? *static_cast<int*>(prop->data) : 0;
        m_voConfigured = state;
        m_windowVisible = state;
        emit windowVisible(m_inPlayback && (!m_nativeVideoOutput || m_windowVisible));
      }
      else if (strcmp(prop->name, "duration") == 0)
      {
        if (prop->format == MPV_FORMAT_DOUBLE)
          emit updateDuration(*static_cast<double*>(prop->data) * 1000.0);
      }
      else if (strcmp(prop->name, "audio-device-list") == 0)
      {
        updateAudioDeviceList();
      }
      else if (strcmp(prop->name, "current-ao") == 0)
      {
        auto **raw = prop->format == MPV_FORMAT_STRING ? static_cast<char**>(prop->data) : nullptr;
        const QString currentAo = raw && *raw ? QString::fromUtf8(*raw) : QString();
        if (currentAo == QStringLiteral("null"))
          m_audioOutputWarningTimer.start();
        else if (!currentAo.isEmpty())
        {
          m_audioOutputWarningTimer.stop();
          m_audioOutputWarningShown = false;
        }
      }
      else if (strcmp(prop->name, "demuxer-cache-state") == 0 && prop->format == MPV_FORMAT_NODE)
      {
        constexpr double ticksPerSecond = 10000000.0; // 100ns ticks (Jellyfin's internal unit)
        auto *node = static_cast<mpv_node*>(prop->data);
        QVariantMap cacheState = mpv::qt::node_to_variant(node).toMap();
        QVariantList seekableRanges = cacheState[QStringLiteral("seekable-ranges")].toList();
        QVariantList ranges;
        for (const QVariant &entry : seekableRanges)
        {
          QVariantMap rangeMap = entry.toMap();
          QVariantMap r;
          r[QStringLiteral("start")] = static_cast<qint64>(rangeMap[QStringLiteral("start")].toDouble() * ticksPerSecond);
          r[QStringLiteral("end")] = static_cast<qint64>(rangeMap[QStringLiteral("end")].toDouble() * ticksPerSecond);
          ranges.append(r);
        }
        emit bufferedRangesUpdated(ranges);
      }
      else if (strcmp(prop->name, "video-dec-params") == 0)
      {
        m_decodedVideoParams = prop->format == MPV_FORMAT_NODE
          ? mpv::qt::node_to_variant(static_cast<mpv_node*>(prop->data)).toMap() : QVariantMap();
        // Aspect might be known now (or it changed during playback), so update settings
        // dependent on the aspect ratio.
        updateVideoAspectSettings();
      }
      else if (strcmp(prop->name, "fullscreen") == 0 && prop->format == MPV_FORMAT_FLAG)
      {
        emit fullscreenRequested(!!*static_cast<int*>(prop->data));
      }
      else if (!m_nativeVideoOutput && strcmp(prop->name, "vo") == 0 &&
               prop->format == MPV_FORMAT_STRING)
      {
        auto **raw = static_cast<char**>(prop->data);
        const QString vo = raw && *raw ? QString::fromUtf8(*raw) : QString();
        if (vo != QStringLiteral("libmpv"))
        {
          qWarning() << "Rejected MPV profile attempt to leave the Render API:" << vo;
          m_mpv->setProperty("vo", "libmpv");
        }
      }
      else if (!m_nativeVideoOutput && strcmp(prop->name, "gpu-api") == 0 &&
               prop->format == MPV_FORMAT_STRING)
      {
        auto **raw = static_cast<char**>(prop->data);
        const QString api = raw && *raw ? QString::fromUtf8(*raw) : QString();
        if (api != QStringLiteral("opengl"))
          m_mpv->setProperty("gpu-api", "opengl");
      }
      else if (!m_nativeVideoOutput && strcmp(prop->name, "gpu-context") == 0 &&
               prop->format == MPV_FORMAT_STRING)
      {
        auto **raw = static_cast<char**>(prop->data);
        const QString context = raw && *raw ? QString::fromUtf8(*raw) : QString();
        if (!context.isEmpty() && context != QStringLiteral("auto"))
          m_mpv->setProperty("gpu-context", "auto");
      }
      break;
    }
    case MPV_EVENT_LOG_MESSAGE:
    {
      auto *msg = static_cast<mpv_event_log_message*>(event->data);
#ifdef Q_OS_WIN
      // mpv can disable a failed VS graph without updating the configured vf
      // list's enabled flag. Its pinned frame-error notification is the native
      // failure signal; do not keep reporting stale monitor frames as Active.
      if(m_rife&&m_rife->ownsFilter()&&msg->log_level<=MPV_LOG_LEVEL_ERROR&&
         strcmp(msg->prefix,"vapoursynth")==0&&strncmp(msg->text,"Filter error at frame ",22)==0) {
        const auto generation=m_windowsPlaybackGeneration;
        QTimer::singleShot(0,this,[this,generation]{
          if(generation==m_windowsPlaybackGeneration&&m_inPlayback&&m_rife&&m_rife->ownsFilter())
            m_rife->bypassCurrentItem("filter-error");
        });
      }
#endif
      // Strip the trailing '\n'
      size_t len = strlen(msg->text);
      if (len > 0 && msg->text[len - 1] == '\n')
        len -= 1;
      QString logline = QString::fromUtf8(msg->prefix) + ": " + QString::fromUtf8(msg->text, static_cast<int>(len));
      if (msg->log_level >= MPV_LOG_LEVEL_V)
        qDebug() << qPrintable(logline);
      else if (msg->log_level >= MPV_LOG_LEVEL_INFO)
        qInfo() << qPrintable(logline);
      else if (msg->log_level >= MPV_LOG_LEVEL_WARN)
        qWarning() << qPrintable(logline);
      else
        qCritical() << qPrintable(logline);
      break;
    }
    case MPV_EVENT_CLIENT_MESSAGE:
    {
      auto *msg = static_cast<mpv_event_client_message*>(event->data);
#ifdef Q_OS_WIN
      if (msg->num_args >= 1 && !strcmp(msg->args[0], "tigerest-application-quit")) {
        requestApplicationQuit();
        break;
      }
#endif
      if (msg->num_args == 2 && strcmp(msg->args[0], "tigerest-apply-profile") == 0)
      {
        applyQualityProfile(QString::fromUtf8(msg->args[1]), true);
        break;
      }
      if (msg->num_args == 2 && strcmp(msg->args[0], "tigerest-playlist-item") == 0)
      {
        const QString itemId = QString::fromUtf8(msg->args[1]);
        // Use the queue identity, not the media Id: one episode can occur more
        // than once in an Emby queue. Reject selections from an outdated menu.
        if (!itemId.isEmpty() && itemId != m_currentWebPlaylistItemId)
        {
          for (const auto& item : m_webPlaylist)
          {
            if (item.toMap().value(QStringLiteral("PlaylistItemId")).toString() == itemId)
            {
              InputComponent::Get().sendAction(QStringLiteral("playlist-item:") + itemId);
              break;
            }
          }
        }
        break;
      }
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
      if(msg->num_args>=1&&strcmp(msg->args[0],"tigerest-rife-toggle-pause")==0) {
        togglePause();
        break;
      }
#endif
      if (msg->num_args >= 2 && strcmp(msg->args[0], "tigerest-stream-quality") == 0)
      {
        bool valid = false;
        const qint64 bitrate = QString::fromUtf8(msg->args[1]).toLongLong(&valid);
        // Emby accepts bits per second. Zero requests its automatic bandwidth
        // detector; the upper bound keeps malformed script messages harmless.
        if (valid && bitrate >= 0 && bitrate <= 1000000000LL)
        {
          qInfo() << "UOSC requested Emby streaming bitrate:" << bitrate;
          emit streamingBitrateRequested(bitrate);
        }
        else
        {
          qWarning() << "Rejected invalid UOSC streaming bitrate:" << msg->args[1];
          notifyStreamingBitrateResult(0, false, QStringLiteral("无效的码率档位"));
        }
        break;
      }
      if (msg->num_args < 3 || strcmp(msg->args[0], "hook_run") != 0)
        break;
      QString resumeId = QString::fromUtf8(msg->args[2]);
      // Start "on_load" hook.
      // This happens when the player is about to load the file, but no actual loading has taken part yet.
      // We use this to block loading until we explicitly tell it to continue.
      if (!strcmp(msg->args[1], "1"))
      {
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
        beginInterpolationItem();
#endif
        // Calling this lambda will instruct mpv to continue loading the file.
        auto resume = [=] {
          qInfo() << "resuming loading";
          m_mpv->commandAsync(QStringList() << "hook-ack" << resumeId);
        };
        const bool rangeSwitched = switchDisplayDynamicRange();
        const bool rateSwitched = switchDisplayFrameRate();
        if (rateSwitched || rangeSwitched)
        {
          // Now wait for some time for mode change - this is needed because mode changing can take some
          // time, during which the screen is black, and initializing hardware decoding could fail due
          // to various strange OS-related reasons.
          // (Better hope the user doesn't try to exit Konvergo during mode change.)
          int pause = rateSwitched ? SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "refreshrate.delay").toInt() * 1000
                                   : HdrSwitchDelayMs;
          qInfo() << "waiting" << pause << "msec after display mode switch before loading";
          QTimer::singleShot(pause, resume);
        }
        else
        {
          resume();
        }
        break;
      }
      // Start "on_preloaded" hook.
      // Used to initialize stream selections.
      if (!strcmp(msg->args[1], "2"))
      {
        reselectStream(m_currentSubtitleStream, MediaType::Subtitle);
        reselectStream(m_currentAudioStream, MediaType::Audio);
#ifdef Q_OS_WIN
        if(m_windowsRifeReloaded) {
          if(m_windowsCurrentLoad.restoreAudioId.isValid())m_mpv->setProperty("aid",m_windowsCurrentLoad.restoreAudioId);
          if(m_windowsCurrentLoad.restoreSubtitleId.isValid())m_mpv->setProperty("sid",m_windowsCurrentLoad.restoreSubtitleId);
        }
#endif
        m_mpv->command( QStringList() << "hook-ack" << resumeId);
        break;
      }
      break;
    }
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(1, 100)
    case MPV_EVENT_HOOK:
    {
      auto *hook = static_cast<mpv_event_hook*>(event->data);
      uint64_t id = hook->id;

      if (!strcmp(hook->name, "on_load"))
      {
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
        beginInterpolationItem();
#endif
        // Calling this lambda will instruct mpv to continue loading the file.
        auto resume = [=] {
          qInfo() << "resuming loading";
          mpv_hook_continue(m_mpv->mpv(), id);
        };
        const bool rangeSwitched = switchDisplayDynamicRange();
        const bool rateSwitched = switchDisplayFrameRate();
        if (rateSwitched || rangeSwitched)
        {
          // Now wait for some time for mode change - this is needed because mode changing can take some
          // time, during which the screen is black, and initializing hardware decoding could fail due
          // to various strange OS-related reasons.
          // (Better hope the user doesn't try to exit Konvergo during mode change.)
          int pause = rateSwitched ? SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "refreshrate.delay").toInt() * 1000
                                   : HdrSwitchDelayMs;
          qInfo() << "waiting" << pause << "msec after display mode switch before loading";
          QTimer::singleShot(pause, resume);
        }
        else
        {
          resume();
        }
        break;
      }
      if (!strcmp(hook->name, "on_preloaded"))
      {
        reselectStream(m_currentSubtitleStream, MediaType::Subtitle);
        reselectStream(m_currentAudioStream, MediaType::Audio);
#ifdef Q_OS_WIN
        if(m_windowsRifeReloaded) {
          if(m_windowsCurrentLoad.restoreAudioId.isValid())m_mpv->setProperty("aid",m_windowsCurrentLoad.restoreAudioId);
          if(m_windowsCurrentLoad.restoreSubtitleId.isValid())m_mpv->setProperty("sid",m_windowsCurrentLoad.restoreSubtitleId);
        }
#endif
        mpv_hook_continue(m_mpv->mpv(), id);
        break;
      }
      break;
    }
#endif

    case MPV_EVENT_PLAYBACK_RESTART:
#ifdef Q_OS_MAC
      m_nativeVideoReady = m_inPlayback && !m_nativeVoTeardownPending;
#else
      m_nativeVideoReady = m_inPlayback;
#endif
#ifdef Q_OS_WIN
      releaseInterpolationResumePrime();
#endif
      break;
#ifdef Q_OS_MAC
    case MPV_EVENT_IDLE:
      completeNativeVoTransition();
      break;
#endif
#ifdef Q_OS_WIN
    case MPV_EVENT_IDLE:
      // Counted from idle, not END_FILE: Windows replaces items internally,
      // and an earlier END_FILE would cut the grace short. An idle event
      // queued behind the next START_FILE is stale.
      if (!m_inPlayback)
      {
        qDebug() << "Idle; Windows HDR restore in" << m_restoreHdrTimer.interval() << "ms if still idle";
        m_restoreHdrTimer.start();
      }
      break;
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
    case MPV_EVENT_SEEK:
      m_nativeVideoReady = false;
#ifdef Q_OS_WIN
      if(m_windowsRifePlayback)m_windowsRifePlayback->onSeek();
#else
      if(m_rife)m_rife->onSeek();
#endif
      break;
#endif
    default:; /* ignore */
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::handleMpvEvents()
{
  // Process all events, until the event queue is empty.
  while (1)
  {
    mpv_event *event = mpv_wait_event(m_mpv->mpv(), 0);
    if (event->event_id == MPV_EVENT_NONE)
      break;
    handleMpvEvent(event);
  }
  // Once we got all status updates, determine the new canonical state.
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  updatePlaybackState();
}

#ifdef Q_OS_WIN
void PlayerComponent::updateInterpolationPreparationOverlay()
{
  if(!m_rifeAccess)return;
  const auto elapsed=m_rifeStartup.elapsed(m_rifeClock.elapsed());
  const bool visible=m_inPlayback&&m_rifeStartup.waiting()&&elapsed>=350;
  if(!visible&&!m_windowsPreparationOverlayVisible)return;
  const bool compiling=m_windowsRifePlayback&&m_windowsRifePlayback->preparingEngine();
  m_rifeAccess->interface().commandAsync(rife::preparationOverlay(visible,compiling,m_rifeStartup.waitingToPlay(),elapsed));
  m_windowsPreparationOverlayVisible=visible;
}
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
void PlayerComponent::publishInterpolationPause()
{
  const bool waiting=m_rifeStartup.waiting();
  if(!waiting||m_rifeResumeGeneration!=m_rifeStartup.generation())m_rifeResumeRequest=0;
  if(m_rifeAccess&&waiting!=m_rifePauseBindings){
    const auto mpv=m_rifeAccess->interface();
    if(waiting){
      mpv.commandAsync({"define-section","tigerest-rife-startup",
          "SPACE script-message tigerest-rife-toggle-pause\np script-message tigerest-rife-toggle-pause","force"});
      mpv.commandAsync({"enable-section","tigerest-rife-startup"});
    }else mpv.commandAsync({"disable-section","tigerest-rife-startup"});
    m_rifePauseBindings=waiting;
  }
  const auto value=m_rifeStartup.waiting()?QVariant(!m_rifeStartup.waitingToPlay()):QVariant(QString());
  if(m_rifeAccess)m_rifeAccess->interface().setAsync("user-data/tigerest/rife-startup-pause",value);
  else if(m_mpv)m_mpv->setPropertyAsync("user-data/tigerest/rife-startup-pause",value);
#ifdef Q_OS_WIN
  updateInterpolationPreparationOverlay();
#endif
}
void PlayerComponent::finishInterpolationStartup()
{
  if(!m_rifeStartup.waiting())return;
#ifdef Q_OS_WIN
  // The startup hold kept the graph busy; only a later user pause can idle it.
  const qint64 now=m_rifeClock.isValid()?m_rifeClock.elapsed():0;
  m_rifeResumePrime.cancel(m_rifeStartup.waitingToPlay()?-1:now);
#endif
  if(!m_rifeStartup.waitingToPlay()){
    m_rifeStartup.finish();publishInterpolationPause();return;
  }
  if(m_rifeResumeRequest&&m_rifeResumeGeneration==m_rifeStartup.generation())return;
  m_rifeResumeGeneration=m_rifeStartup.generation();
  m_rifeResumeRequest=0x52000000+(++m_rifeResumeSequence&0x00ffffff);
  m_rifeResumeSince=m_rifeClock.isValid()?m_rifeClock.elapsed():0;
  bool accepted=false;
  if(m_rifeAccess)accepted=m_rifeAccess->interface().setAsyncTagged("pause",false,m_rifeResumeRequest);
  else if(m_mpv)accepted=m_mpv->setPropertyAsync("pause",false,m_rifeResumeRequest)>=0;
  if(!accepted){failInterpolationResume();return;}
  publishInterpolationPause();
}
void PlayerComponent::checkInterpolationResume(qint64 now)
{
  if(m_rifeResumeRequest&&m_rifeStartup.waiting()&&m_rifeResumeGeneration==m_rifeStartup.generation()&&
      now-m_rifeResumeSince>=5000)failInterpolationResume();
}
void PlayerComponent::failInterpolationResume()
{
  m_rifeResumeRequest=0;m_rifeStartup.cancel();publishInterpolationPause();
  if(m_rifeAccess)m_rifeAccess->interface().commandAsync({"stop"});
  else if(m_mpv)m_mpv->commandAsync({"stop"});
  m_playbackError=QStringLiteral("补帧准备完成，但播放器恢复播放失败，请重新播放");
  m_inPlayback=false;updatePlaybackState();
}
#endif
#ifdef Q_OS_WIN
void PlayerComponent::onInterpolationPauseChanged()
{
  const qint64 now=m_rifeClock.isValid()?m_rifeClock.elapsed():0;
  if(m_paused){m_rifeResumePrime.paused(now);return;}
  // Every resume passes here, including mpv's own SPACE binding.
  const bool eligible=m_inPlayback&&m_rife&&m_rifeAccess&&m_rife->state()==rife::State::Active&&
      !m_rifeStartup.waiting()&&!m_rifeResumeRequest;
  if(!m_rifeResumePrime.resumed(now,eligible))return;
  qInfo() << "Resuming interpolation after a long pause: refilling the graph first";
  const auto mpv=m_rifeAccess->interface();
  mpv.setAsync("pause",true);
  mpv.commandAsync({"no-osd","seek","0","relative+exact"});
}
void PlayerComponent::updateInterpolationPresentation()
{
  if(m_shuttingDown||!m_rife||!m_rifeAccess)return;
  // The window is changing state; queue mpv writes instead of waiting on them.
  auto polling=m_rifeAccess->enterPolling();
  m_rife->setFullScreen(WindowManager::Get().isFullScreen());
}
void PlayerComponent::releaseInterpolationResumePrime()
{
  if(!m_rifeResumePrime.ready(m_rifeClock.isValid()?m_rifeClock.elapsed():0))return;
  if(m_rifeAccess)m_rifeAccess->interface().setAsync("pause",false);
  else if(m_mpv)m_mpv->setPropertyAsync("pause",false);
}
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
void PlayerComponent::beginInterpolationItem()
{
  if(!m_rife)return;
  const bool enabled=SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRife").toBool();
  if(MpvConfigManager::ownsDefaultSvpIpc()) {
    const auto endpoint=m_mpv->getProperty("input-ipc-server").toString();
#ifdef Q_OS_WIN
    const QString managedEndpoint=QStringLiteral("mpvpipe");
    if(enabled&&endpoint==managedEndpoint) {
      m_rifeSuppressedSvp=m_mpv->setProperty("input-ipc-server",QString())>=0;
    } else if(!enabled&&m_rifeSuppressedSvp&&endpoint.isEmpty()) {
      QLocalSocket existing;existing.connectToServer(managedEndpoint);
      if(!existing.waitForConnected(100))m_mpv->setProperty("input-ipc-server",managedEndpoint);
      m_rifeSuppressedSvp=false;
    }
#else
    if(enabled&&endpoint=="/tmp/mpvsocket") {
      m_rifeSuppressedSvp=m_mpv->setProperty("input-ipc-server",QString())>=0;
    } else if(!enabled&&m_rifeSuppressedSvp&&endpoint.isEmpty()) {
      QLocalSocket existing;existing.connectToServer("/tmp/mpvsocket");
      const QFileInfo file("/tmp/mpvsocket");
      if(!existing.waitForConnected(100)&&!file.isFile()&&!file.isDir())
        m_mpv->setProperty("input-ipc-server","/tmp/mpvsocket");
      m_rifeSuppressedSvp=false;
    }
#endif
  }
#ifdef Q_OS_WIN
  m_windowsRifeRuntime->select(SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRifeModel").toString(),
      SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRifeTarget").toInt());
  if(m_windowsRifePlayback)m_windowsRifePlayback->beginItem(enabled,false,
      m_mpv->getProperty("speed").toDouble());
  // A window restored as fullscreen at startup emits no switch.
  m_rife->setFullScreen(WindowManager::Get().isFullScreen());
  if(m_windowsRifeReloaded)m_rife->bypassCurrentItem("filter-error");
#else
  m_rife->beginItem(enabled,false);
#endif
  const bool prepare=m_rife->state()==rife::State::Preparing&&
      m_mpv->getProperty("vid").toString()!="no";
#ifdef Q_OS_WIN
  m_rifeResumePrime.cancel();
#endif
  m_rifeStartup.begin(prepare,m_mpv->getProperty("pause").toBool(),m_rifeClock.elapsed());
  if(prepare&&m_mpv->setProperty("pause",true)<0)m_rifeStartup.cancel();
  publishInterpolationPause();
}
void PlayerComponent::pollInterpolation()
{
  if(m_rife)m_rife->serviceClock();
  checkInterpolationResume(m_rifeClock.isValid()?m_rifeClock.elapsed():0);
#ifdef Q_OS_WIN
  if(m_rifeResumePrime.expired(m_rifeClock.elapsed())){
    // The seek never restarted playback: play without the prime. A release
    // whose edge never arrived leaves mpv's pause state as it is.
    if(m_rifeResumePrime.priming())releaseInterpolationResumePrime();
    else{m_rifeResumePrime.cancel(m_paused?m_rifeClock.elapsed():-1);updatePlaybackState();}
  }
  m_rifeStartup.setEnginePreparing(m_windowsRifePlayback&&m_windowsRifePlayback->preparingEngine(),m_rifeClock.elapsed());
  updateInterpolationPreparationOverlay();
#endif
  // This path must stay asynchronous even while Cocoa creates the VO. An
  // audio-only/failed load must never be left paused waiting for video metrics.
  if(m_mpv&&!m_rifeResumeRequest&&m_rifeStartup.expired(m_rifeClock.elapsed())) {
#ifdef Q_OS_WIN
    // A first-frame timeout must also remove a pending graph; otherwise a
    // late callback could attach interpolation after the hold was released.
    if(m_rife&&m_rifeAccess){auto polling=m_rifeAccess->enterPolling();m_rife->bypassCurrentItem("filter-error");}
#endif
    finishInterpolationStartup();
  }
  // macvk can synchronously dispatch window setup to the main thread while
  // mpv's core waits for its VO. Querying that core here would deadlock both.
  // Render API also reports provisional color metadata during a replacement;
  // wait for its first ready frame before fixing this item's source identity.
  if(!m_rife||!m_mpv||!m_rifeAccess||!m_inPlayback||!m_nativeVideoReady)return;
  // Property-change events are delivered by libmpv without waiting for its
  // core. The timer must never use mpv_get_property or mpv_command while
  // macvk can be waiting for this same Cocoa main thread to remove its VO.
  if(!m_rifeAccess->value("vf").isValid()||
      !m_rifeAccess->value("video-params").isValid()||
      !m_rifeAccess->value("video-frame-info").isValid()||
      !m_rifeAccess->value("container-fps").isValid())return;
  auto polling=m_rifeAccess->enterPolling();
#ifdef Q_OS_WIN
  // Speed is a global mpv property. Wait for its observed value rather than
  // making a blocking request from this timer, including during VO transitions.
  if(!m_rifeAccess->value("speed").isValid()||!m_rifeAccess->value("video-sync").isValid())return;
  m_windowsRifePlayback->onPlaybackSpeed(m_rifeAccess->value("speed").toDouble());
#endif
  const auto params=m_rifeAccess->value("video-params").toMap();
  const auto frame=m_rifeAccess->value("video-frame-info").toMap();
  const double fps=m_rifeAccess->value("container-fps").toDouble();
  if(!params.isEmpty()&&frame.contains("interlaced")&&fps>0){
#ifdef Q_OS_WIN
    m_windowsRifePlayback->onFormatChanged(rife::sourceInfo(params,frame,fps));
#else
    m_rife->onFormatChanged(rife::sourceInfo(params,frame,fps));
#endif
  }
  // A busy video filter can make the core idle between frames. That is part
  // of the work being measured, not evidence of a user/network suspension.
  // updatePlaybackState may set the UI buffering percentage to zero when a
  // busy filter makes core-idle true. That isn't a real cache pause and must
  // not continuously reset Windows' performance guard.
  const bool suspended=m_paused||
#ifdef Q_OS_MAC
      m_bufferingPercentage<100||
#endif
      m_rifeAccess->value("seeking").toBool()||m_rifeAccess->value("paused-for-cache").toBool();
  m_rife->poll(m_rifeClock.elapsed(),suspended);
#ifdef Q_OS_WIN
  m_rifeStartup.setEnginePreparing(m_windowsRifePlayback&&m_windowsRifePlayback->preparingEngine(),m_rifeClock.elapsed());
#endif
  if(m_rifeStartup.waiting()&&m_rife->state()!=rife::State::Preparing) {
    finishInterpolationStartup();
  }
}
#endif

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setVideoOnlyMode(bool enable)
{
  if (m_window)
  {
    QQuickItem *web = m_window->findChild<QQuickItem *>("web");
    if (web)
      web->setVisible(!enable);
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::play()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  if(m_rifeStartup.requestPause(false)){publishInterpolationPause();return;}
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::play: mpv not initialized yet";
    return;
  }
  QStringList args = (QStringList() << "set" << "pause" << "no");
  m_mpv->command( args);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyShuffleChange(bool enabled)
{
  emit shuffleChanged(enabled);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyRepeatChange(const QString& mode)
{
  emit repeatChanged(mode);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyFullscreenChange(bool isFullscreen)
{
  emit fullscreenChanged(isFullscreen);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyRateChange(double rate)
{
  emit rateChanged(rate);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyQueueChange(bool canNext, bool canPrevious)
{
  emit queueChanged(canNext, canPrevious);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyPlaybackStop(bool isNavigating)
{
  emit playbackStopped(isNavigating);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyDurationChange(qint64 durationMs)
{
  emit durationChanged(durationMs);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyPlaybackState(const QString& state)
{
  emit playbackStateChanged(state);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyPosition(qint64 positionMs)
{
  emit positionChanged(positionMs);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifySeek(qint64 positionMs)
{
  emit seekPerformed(positionMs);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyMetadata(const QVariantMap& metadata)
{
  emit metadataChanged(metadata);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyVolumeChange(double volume)
{
  // Web media notifications use a ratio; mpv observations and web player
  // consumers share this signal in percent. Mixing units feeds the saved
  // volume back through inputPlugin at 1/100 on every notification.
  emit volumeChanged(volume * 100.0);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::notifyStreamingBitrateResult(qint64 bitrate, bool success, const QString& message)
{
  if (!m_mpv)
    return;

  const QStringList args = {QStringLiteral("script-message-to"),
                            QStringLiteral("emby_quality"),
                            QStringLiteral("tigerest-stream-quality-result"),
                            QString::number(bitrate),
                            success ? QStringLiteral("yes") : QStringLiteral("no"),
                            message};
  m_mpv->commandAsync(args);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::stop()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
  ++m_windowsPlaybackGeneration;m_windowsReplacementTargetEntryId=-1;
  m_replacementPending=false;m_windowsRecoveryLoads.clear();
  if(m_windowsRifePlayback)m_windowsRifePlayback->endItem();
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  m_rifeStartup.cancel();
  publishInterpolationPause();
#endif
#ifdef Q_OS_MAC
  if (m_nativeVideoOutput && m_inPlayback) {
    // The stop command returns before END_FILE is delivered. Block main-thread
    // mpv queries as soon as teardown is requested, not when its event arrives.
    m_nativeVoTeardownPending = true;
    m_nativeVideoReady = false;
    m_audioOutputWarningTimer.stop();
    m_reloadAudioTimer.stop();
  }
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::stop: mpv not initialized yet";
    return;
  }
  QStringList args("stop");
#if defined(Q_OS_MAC)
  if (m_nativeVideoOutput)
  {
    // Native macOS CLOSE_WIN/keyboard stop can synchronously deliver END_FILE.
    // Web cleanup may request stop again from that signal; queueing the command
    // prevents Qt's main thread from waiting on mpv while its VO is tearing down.
    m_mpv->commandAsync(args);
  }
  else
#endif
  {
    m_mpv->command(args);
  }
}

#ifdef Q_OS_WIN
void PlayerComponent::requestApplicationQuit()
{
  if (m_applicationQuitReady || (m_shuttingDown && m_applicationQuitTimer.isActive())) return;
  qInfo() << "Application shutdown requested; waiting for native video output";
  m_shuttingDown = true;
  m_nativeVideoReady = false;
  m_applicationStopAcknowledged = false;
  m_applicationQuitQueryPending = false;
  m_applicationQuitElapsed.start();
  m_rifeTimer.stop();
  m_restoreDisplayTimer.stop();
  m_restoreHdrTimer.stop();
  m_reloadAudioTimer.stop();
  m_audioOutputWarningTimer.stop();
  InputComponent::Get().cancelAutoRepeat();
  ++m_windowsPlaybackGeneration;
  m_windowsReplacementTargetEntryId = -1;
  m_replacementPending = false;
  m_windowsRecoveryLoads.clear();
  if (m_windowsRifePlayback) m_windowsRifePlayback->endItem();
  m_rifeStartup.cancel();
  publishInterpolationPause();
  if (!m_mpv) {
    finishApplicationQuit();
    return;
  }
  // Keep the main HWND and its event loop alive while mpv's Windows VO thread
  // removes the embedded window. Never synchronously wait for the core here.
  m_mpv->setPropertyAsync("force-window", false);
  const int result = m_mpv->commandAsync(QStringList() << "stop", ApplicationQuitStop);
  if (result < 0) qWarning() << "Unable to queue application shutdown stop:" << mpv_error_string(result);
  m_applicationQuitTimer.start();
}

void PlayerComponent::checkApplicationQuit()
{
  if (!m_shuttingDown || m_applicationQuitReady) return;
  if (m_applicationQuitElapsed.elapsed() >= 10000) {
    // A hung driver must not destroy the live host HWND. Leave the application
    // responsive and permit another exit attempt instead of freezing Qt.
    m_applicationQuitTimer.stop();
    m_applicationQuitQueryPending = false;
    qWarning() << "Application shutdown timed out waiting for native video output";
    return;
  }
  if (!m_applicationStopAcknowledged || m_applicationQuitQueryPending) return;
  m_applicationQuitQueryPending = mpv_get_property_async(m_mpv->mpv(), ApplicationQuitIdle,
                                                        "idle-active", MPV_FORMAT_FLAG) >= 0;
}

void PlayerComponent::finishApplicationQuit()
{
  if (!m_shuttingDown || m_applicationQuitReady) return;
  m_applicationQuitReady = true;
  m_applicationQuitTimer.stop();
  m_applicationQuitQueryPending = false;
  m_inPlayback = false;
  m_windowVisible = false;
  emit windowVisible(false);
  DisplayComponent::Get().restorePreviousVideoMode();
  WindowManager::Get().endPlaybackSession();
  PowerComponent::Get().setScreensaverEnabled(true);
  qInfo() << "Native video output released; exiting application";
  // quit() sends another close request, which the tray/async close handler can
  // veto. VO teardown is complete now, so end the event loop directly.
  QTimer::singleShot(0, qApp, [] { QCoreApplication::exit(0); });
}
#endif

#ifdef Q_OS_MAC
void PlayerComponent::completeNativeVoTransition()
{
  if (!m_nativeVideoOutput || !m_nativeVoTeardownPending)
    return;
  m_nativeVoTeardownPending = false;
  QList<DeferredMediaLoad> pending;
  pending.swap(m_deferredMediaLoads);
  for (const auto& request : pending)
    loadMedia(request.url, request.options, request.metadata,
              request.audioStream, request.subtitleStream, request.mode);
}

bool PlayerComponent::prepareForShutdown()
{
  if (!m_mpv || !m_nativeVideoOutput)
    return true;

  m_shuttingDown = true;
  m_deferredMediaLoads.clear();
  m_rifeTimer.stop();
  m_reloadAudioTimer.stop();
  m_audioOutputWarningTimer.stop();
  if (m_inPlayback)
    stop();

  // mpv's macvk destructor synchronously dispatches window removal to Cocoa.
  // Keep the main queue running until MPV_EVENT_IDLE confirms that the native
  // VO has been released; then QML can safely destroy MpvVideoItem.
  QElapsedTimer elapsed;
  elapsed.start();
  while ((m_inPlayback || m_nativeVoTeardownPending) && elapsed.elapsed() < 10000) {
    QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
    QThread::msleep(2);
  }
  if (m_inPlayback || m_nativeVoTeardownPending) {
    qCritical() << "Timed out waiting for native video output before shutdown";
    return false;
  }
  return true;
}
#endif

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::clearQueue()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::clearQueue: mpv not initialized yet";
    return;
  }
  QStringList args("playlist_clear");
  const auto result=m_mpv->command(args);
#ifdef Q_OS_WIN
  if(result.metaType()!=QMetaType::fromType<ErrorReturn>()) {
    QSet<qint64> retained;
    for(const auto& item:m_mpv->getProperty("playlist").toList())retained.insert(item.toMap()["id"].toLongLong());
    for(auto it=m_windowsRecoveryLoads.begin();it!=m_windowsRecoveryLoads.end();)
      if(retained.contains(it.key()))++it;else it=m_windowsRecoveryLoads.erase(it);
    if(m_windowsReplacementTargetEntryId>=0&&!retained.contains(m_windowsReplacementTargetEntryId)) {
      m_windowsReplacementTargetEntryId=-1;m_replacementPending=false;
    }
  }
#endif
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::togglePause()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  if(m_rifeStartup.waiting()){
    if(m_rifeStartup.waitingToPlay())pause();else play();
    return;
  }
  // A queued input message may arrive just after the startup reply. Let the
  // core toggle its current state; the last pause observation can be stale.
  if(m_rifeAccess){m_rifeAccess->interface().commandAsync({"cycle","pause"});return;}
#endif
  if(m_mpv)m_mpv->commandAsync(QStringList{"cycle","pause"});
}

void PlayerComponent::pause()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  m_rifeResumeRequest=0;
  m_rifeStartup.requestPause(true);
  publishInterpolationPause();
#ifdef Q_OS_WIN
  if(m_rifeResumePrime.pending()){
    // mpv is still held for the prime; the pause starts now.
    m_rifeResumePrime.cancel(m_rifeClock.elapsed());
    updatePlaybackState();
  }
#endif
  if(m_rifeStartup.waiting()) {
    if(m_rifeAccess)m_rifeAccess->interface().setAsync("pause",true);
    else if(m_mpv)m_mpv->setPropertyAsync("pause",true);
    return;
  }
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::pause: mpv not initialized yet";
    return;
  }
  QStringList args = (QStringList() << "set" << "pause" << "yes");
  m_mpv->command( args);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::seekTo(qint64 ms)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::seekTo: mpv not initialized yet";
    return;
  }
  double timeSecs = ms / 1000.0;
  QStringList args = (QStringList() << "seek" << QString::number(timeSecs) << "absolute+exact");
  m_mpv->command( args);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariant PlayerComponent::getAudioDeviceList()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return {};
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::getAudioDeviceList: mpv not initialized yet";
    return QVariant();
  }
#ifdef Q_OS_MAC
  if(m_nativeVideoOutput)
    return m_rifeAccess?m_rifeAccess->value("audio-device-list"):QVariant();
#endif
  return m_mpv->getProperty( "audio-device-list");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setAudioDevice(const QString& name)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::setAudioDevice: mpv not initialized yet";
    return;
  }
  m_mpv->setProperty( "audio-device", name);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setVolume(double volume)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::setVolume: mpv not initialized yet";
    return;
  }
  m_mpv->setProperty( "volume", volume);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
double PlayerComponent::volume()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return 0;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::volume: mpv not initialized yet";
    return 0;
  }
  QVariant volume = m_mpv->getProperty( "volume");
  if (volume.isValid())
    return volume.toDouble();
  return 0;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setMuted(bool muted)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::setMuted: mpv not initialized yet";
    return;
  }
  // Will fail if no audio output opened (i.e. no file playing)
  m_mpv->setProperty( "mute", muted);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::muted()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return false;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::muted: mpv not initialized yet";
    return false;
  }
  QVariant mute = m_mpv->getProperty( "mute");
  if (mute.isValid())
    return mute.toBool();
  return false;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantList PlayerComponent::findStreamsForURL(const QString &url)
{
  if (!m_mpv) {
    qWarning() << "PlayerComponent::findStreamsForURL: mpv not initialized yet";
    return QVariantList();
  }
  bool isExternal = !url.isEmpty();
  QVariantList res;

  auto tracks = m_mpv->getProperty( "track-list");
  for (auto track : tracks.toList())
  {
    QVariantMap map = track.toMap();

    if (map["external"].toBool() != isExternal)
      continue;

    if (!isExternal || map["external-filename"].toString() == url)
      res += map;
  }

  return res;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::reselectStream(const QVariant &streamSelection, MediaType target)
{
  if (!m_mpv) {
    qWarning() << "PlayerComponent::reselectStream: mpv not initialized yet";
    return;
  }

  QString streamIdPropertyName;
  QString streamAddCommandName;
  QString mpvStreamTypeName;

  switch (target)
  {
  case MediaType::Subtitle:
    mpvStreamTypeName = "sub";
    streamIdPropertyName = "sid";
    streamAddCommandName = "sub-add";
    break;
  case MediaType::Audio:
    mpvStreamTypeName = "audio";
    streamIdPropertyName = "aid";
    streamAddCommandName = "audio-add";
    break;
  }

  // Check for string format first (handles "#,URL" and "#index")
  QString streamSelectionStr = streamSelection.toString();
  if (streamSelectionStr == QLatin1String("auto"))
  {
    m_mpv->setProperty(streamIdPropertyName, "auto");
    return;
  }
  bool isStringFormat = streamSelectionStr.startsWith("#") || !streamSelection.canConvert<int>();

  // Handle integer Jellyfin stream index (new format)
  if (!isStringFormat && streamSelection.canConvert<int>()) {
    int index = streamSelection.toInt();
    if (index < 0) {
      m_mpv->setProperty(streamIdPropertyName, "no");
    } else {
      // Jellyfin stream index is the MPV track ID (already 1-based)
      m_mpv->setProperty(streamIdPropertyName, index);
    }
    return;
  }

  // Handle legacy string format "#1" or "#,http://..."
  QString streamName;
  QString streamID;

  if (streamSelectionStr.startsWith("#"))
  {
    qsizetype splitPos = streamSelectionStr.indexOf(",");
    if (splitPos < 0)
    {
      // Stream from the main file
      streamID = streamSelectionStr.mid(1);
      streamName = "";
    }
    else
    {
      // Stream from an external file
      streamID = streamSelectionStr.mid(1, splitPos - 1);
      streamName = streamSelectionStr.mid(splitPos + 1);
    }
  }
  else if (streamSelectionStr.isEmpty() || !streamSelection.isValid())
  {
    m_mpv->setProperty( streamIdPropertyName, "no");
    return;
  }

  if (!streamName.isEmpty())
  {
    streamName = sanitizeMediaUrl(streamName, true);
    auto streams = findStreamsForURL(streamName);
    if (streams.isEmpty())
    {
      QStringList args = (QStringList() << streamAddCommandName << streamName);
      m_mpv->command( args);
    }
  }

  QString selection = "no";

  if (!streamID.isEmpty())
  {
    selection = streamID;
  } else {
    for (auto stream : findStreamsForURL(streamName))
    {
      auto map = stream.toMap();

      if (map["type"].toString() != mpvStreamTypeName)
      {
        continue;
      } else if (map["external-filename"].toString() == streamName) {
        selection = map["id"].toString();
        break;
      }
    }
  }

  // Fallback to the first stream if none could be found.
  // Useful if web-client uses wrong stream IDs when e.g. transcoding.
  if ((target == MediaType::Audio || !streamID.isEmpty()) && selection == "no")
    selection = "1";

  m_mpv->setProperty( streamIdPropertyName, selection);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setSubtitleStream(const QVariant &subtitleStream)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  m_currentSubtitleStream = subtitleStream;
#ifdef Q_OS_WIN
  m_windowsCurrentLoad.subtitleStream=subtitleStream;
#endif
  reselectStream(m_currentSubtitleStream, MediaType::Subtitle);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setAudioStream(const QVariant &audioStream)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  m_currentAudioStream = audioStream;
#ifdef Q_OS_WIN
  m_windowsCurrentLoad.audioStream=audioStream;
#endif
  reselectStream(m_currentAudioStream, MediaType::Audio);
}

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setAudioDelay(qint64 milliseconds)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  m_playbackAudioDelay = milliseconds;

  double displayFps = DisplayComponent::Get().currentRefreshRate();
  const char *audioDelaySetting = "audio_delay.normal";
  if (fabs(displayFps - 24) < 0.5) // cover 24Hz, 23.976Hz, and values very close
    audioDelaySetting = "audio_delay.24hz";
  else if (fabs(displayFps - 25) < 0.5)
    audioDelaySetting = "audio_delay.25hz";
  else if (fabs(displayFps - 50) < 0.5)
    audioDelaySetting = "audio_delay.50hz";

  double fixedDelay = SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, audioDelaySetting).toFloat();
  m_mpv->setProperty( "audio-delay", (fixedDelay + m_playbackAudioDelay) / 1000.0);
}

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setSubtitleDelay(qint64 milliseconds)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::setSubtitleDelay: mpv not initialized yet";
    return;
  }
  m_mpv->setProperty( "sub-delay", milliseconds / 1000.0);
}

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setPlaybackRate(int rate)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::setPlaybackRate: mpv not initialized yet";
    return;
  }
  double speed = rate / 1000.0;
  m_mpv->setProperty( "speed", speed);
  emit playbackRateChanged(speed);
}

/////////////////////////////////////////////////////////////////////////////////////////
qint64 PlayerComponent::getPosition()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return 0;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::getPosition: mpv not initialized yet";
    return 0;
  }
#ifdef Q_OS_MAC
  if (m_nativeVideoOutput)
  {
    const QVariant time=m_rifeAccess?m_rifeAccess->value("playback-time"):QVariant();
    return time.canConvert<double>()
      ? static_cast<qint64>(qMax(time.toDouble()*1000.0,0.0)) : 0;
  }
#endif
  QVariant time = m_mpv->getProperty( "playback-time");
  if (time.canConvert<double>())
    return static_cast<qint64>(qMax(time.toDouble() * 1000.0, 0.0));
  return 0;
}

/////////////////////////////////////////////////////////////////////////////////////////
qint64 PlayerComponent::getDuration()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return 0;
#endif
  if (!m_mpv) {
    qWarning() << "PlayerComponent::getDuration: mpv not initialized yet";
    return 0;
  }
#ifdef Q_OS_MAC
  if (m_nativeVideoOutput)
  {
    const QVariant time=m_rifeAccess?m_rifeAccess->value("duration"):QVariant();
    return time.canConvert<double>()
      ? static_cast<qint64>(qMax(time.toDouble()*1000.0,0.0)) : 0;
  }
#endif
  QVariant time = m_mpv->getProperty( "duration");
  if (time.canConvert<double>())
    return static_cast<qint64>(qMax(time.toDouble() * 1000.0, 0.0));
  return 0;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::checkAudioOutput()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv || !m_inPlayback || m_audioOutputWarningShown)
    return;
#ifdef Q_OS_MAC
  if (m_nativeVideoOutput && m_nativeVoTeardownPending)
    return;
#endif

  const auto read=[this](const QString& key){
#ifdef Q_OS_MAC
    if(m_nativeVideoOutput)return m_rifeAccess?m_rifeAccess->value(key):QVariant();
#endif
    return m_mpv->getProperty(key);
  };
  const QString currentAo = read("current-ao").toString();
  const QString selectedAudio = read("aid").toString();
  const QVariantMap audioParameters = read("audio-params").toMap();
  if (currentAo != QStringLiteral("null") || selectedAudio == QStringLiteral("no") ||
      selectedAudio.isEmpty() || audioParameters.isEmpty())
    return;

  m_audioOutputWarningShown = true;
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  m_rifeStartup.requestPause(true);
  publishInterpolationPause();
#endif
  if(m_nativeVideoOutput)m_mpv->setPropertyAsync("pause",true);
  else m_mpv->setProperty("pause",true);
  const QStringList warningCommand=QStringList()
                 << "show-text"
                 << QStringLiteral("音频设备不可用或正被独占，已暂停播放。请在 UOSC 菜单或 MPV 设置中选择可用的音频设备。")
                 << "8000";
  if(m_nativeVideoOutput)m_mpv->commandAsync(warningCommand);
  else m_mpv->command(warningCommand);
  // UOSC normally filters its device menu by current-ao. When initialization
  // failed current-ao is literally "null", which incorrectly hides every
  // WASAPI/OpenAL device. Build the menu from mpv's unfiltered property so the
  // user can recover without leaving playback. The show-text above remains the
  // fallback for configurations that do not load UOSC's open-menu handler.
  QJsonArray deviceItems;
  const QString configuredDevice = read("audio-device").toString();
  const QVariantList availableDevices = read("audio-device-list").toList();
  for (const QVariant& deviceValue : availableDevices)
  {
    const QVariantMap device = deviceValue.toMap();
    const QString name = device.value("name").toString();
    if (name.isEmpty())
      continue;

    QJsonArray action;
    action.append(QStringLiteral("set"));
    action.append(QStringLiteral("audio-device"));
    action.append(name);

    QJsonObject item;
    item.insert(QStringLiteral("title"), device.value("description").toString());
    item.insert(QStringLiteral("hint"), name == QStringLiteral("auto")
                                       ? QStringLiteral("自动选择") : name);
    item.insert(QStringLiteral("active"), name == configuredDevice);
    item.insert(QStringLiteral("value"), action);
    deviceItems.append(item);
  }

  if (!deviceItems.isEmpty())
  {
    QJsonObject menu;
    menu.insert(QStringLiteral("type"), QStringLiteral("tigerest-audio-recovery"));
    menu.insert(QStringLiteral("title"), QStringLiteral("选择可用音频设备"));
    menu.insert(QStringLiteral("hint"), QStringLiteral("默认设备不可用，选择后会立即重试输出"));
    menu.insert(QStringLiteral("items"), deviceItems);
    const QString menuJson = QString::fromUtf8(QJsonDocument(menu).toJson(QJsonDocument::Compact));
    const QStringList menuCommand=QStringList()
                   << "script-message-to"
                   << "uosc"
                   << "open-menu"
                   << menuJson;
    if(m_nativeVideoOutput)m_mpv->commandAsync(menuCommand);
    else m_mpv->command(menuCommand);
  }
  qWarning() << "Audio output fell back to null; paused playback so the failure is not silent";
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantMap PlayerComponent::mpvDiagnostics()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return {};
#endif
  QVariantMap result;
  const auto read=[this](const QString& key){
#ifdef Q_OS_MAC
    if(m_nativeVideoOutput)return m_rifeAccess?m_rifeAccess->value(key):QVariant();
#endif
    return m_mpv->getProperty(key);
  };
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  if(m_rife)result["rife"]=m_rife->diagnostics();
  result["rifeSetting"]=SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRife");
#endif
  const QString configDir = MpvConfigManager::activeConfigDir();
  result["configDir"] = configDir;
  result["configMode"] = "single";
  result["renderBackend"] = m_nativeVideoOutput ? "gpu-next-native" : "libmpv-render-api";

  const QString configuredProfile = m_appliedProfile.isEmpty()
      ? MpvConfigManager::profileName(SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "shaderPreset").toString())
      : m_appliedProfile;
  result["configuredProfile"] = configuredProfile;

  QStringList shaderFiles;
  if (m_mpv)
  {
    const QVariant shaders = read("glsl-shaders");
    for (const QVariant& shader : shaders.toList())
    {
      const QString shaderPath = shader.toString().trimmed();
      if (!shaderPath.isEmpty())
        shaderFiles << shaderPath;
    }
    if (shaderFiles.isEmpty() && !shaders.toString().trimmed().isEmpty())
      shaderFiles << shaders.toString();

    result["gpuApi"] = read("gpu-api");
    result["gpuContext"] = read("current-gpu-context").toString();
    result["currentVo"] = read("current-vo");
    result["configuredVo"] = read("vo").toString();
    result["hwdecCurrent"] = read("hwdec-current");
    result["scale"] = read("scale").toString();
    result["cscale"] = read("cscale").toString();
    result["dscale"] = read("dscale").toString();
    result["tscale"] = read("tscale").toString();
    result["interpolation"] = read("interpolation").toBool();
    result["deband"] = read("deband").toBool();
    result["fullscreen"] = read("fullscreen").toBool();

    QStringList scriptFiles;
    const QVariant configuredScripts = read("scripts");
    for (const QVariant& entry : configuredScripts.toList())
    {
      const QString file = entry.toString();
      if (!file.isEmpty()) scriptFiles << file;
    }
    if (scriptFiles.isEmpty() && !configuredScripts.toString().isEmpty())
      scriptFiles << configuredScripts.toString();
    result["scriptFiles"] = scriptFiles;
    result["autoScripts"] = read("load-scripts").toBool();

    const QVariantMap videoParams = read("video-params").toMap();
    const QVariantMap outputParams = read("video-out-params").toMap();
    result["sourceWidth"] = videoParams.value("w").toInt();
    result["sourceHeight"] = videoParams.value("h").toInt();
    result["outputWidth"] = outputParams.value("dw").toInt();
    result["outputHeight"] = outputParams.value("dh").toInt();

    // vo-passes contains the exact Fresh/Redraw render pass list consumed by
    // stats.lua page 2. It is populated while video is rendering when the
    // libmpv render context uses advanced control.
    const QVariantMap passes = read("vo-passes").toMap();
    const qsizetype freshPassCount = passes.value("fresh").toList().size();
    const qsizetype redrawPassCount = passes.value("redraw").toList().size();
    result["voPassesAvailable"] = freshPassCount > 0 || redrawPassCount > 0;
    result["freshPassCount"] = freshPassCount;
    result["redrawPassCount"] = redrawPassCount;
  }
  result["shaderFiles"] = shaderFiles;

  // The video filter chain in order, e.g. user filters then @tigerest-rife.
  QStringList videoFilters;
  if (m_mpv)
  {
    for (const QVariant& entry : read("vf").toList())
    {
      const QVariantMap filter = entry.toMap();
      const QString label = filter.value(QStringLiteral("label")).toString();
      videoFilters << (label.isEmpty() ? QString() : QStringLiteral("@%1:").arg(label)) +
                          filter.value(QStringLiteral("name")).toString();
    }
  }
  result["videoFilters"] = videoFilters;
  result["shaderCount"] = shaderFiles.size();
  return result;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// This is called with the set of previous audio devices that were detected, and the set of current
// audio devices. From this we guess whether we should reopen the audio device. If the user-selected
// device went away previously, and now comes back, reinitializing the player's audio output will
// force the player and/or the OS to move audio output back to the user-selected device.
void PlayerComponent::checkCurrentAudioDevice(const QSet<QString>& old_devs, const QSet<QString>& new_devs)
{
  QString userDevice = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "device").toString();

  QSet<QString> removed = old_devs - new_devs;
  QSet<QString> added = new_devs - old_devs;

  qDebug() << "Audio devices removed:" << removed;
  qDebug() << "Audio devices added:" << added;
  qDebug() << "Audio device selected:" << userDevice;

  if (userDevice.length())
  {
    if (added.contains(userDevice) || removed.contains(userDevice))
    {
      // The timer is for debouncing the reload. Several change notifications could
      // come in quick succession. Also, it's possible that trying to open the
      // reappeared audio device immediately can fail.
      m_reloadAudioTimer.start(500);
    }
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateAudioDeviceList()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  QString userDevice = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "device").toString();
  bool userDeviceFound = false;

  QVariantList settingList;
  QVariant list = getAudioDeviceList();
  QSet<QString> devices;
  for(const QVariant& d : list.toList())
  {
    Q_ASSERT(d.typeId() == QMetaType::QVariantMap);
    QVariantMap dmap = d.toMap();

    QString device = dmap["name"].toString();
    QString description = dmap["description"].toString();

    devices.insert(device);

    if (userDevice == device)
      userDeviceFound = true;

    QVariantMap entry;
    entry["value"] = device;
    entry["title"] = description;

    settingList << entry;
  }

  if (!userDeviceFound)
  {
    QVariantMap entry;
    entry["value"] = userDevice;
    entry["title"] = "[Disconnected device: " + userDevice + "]";

    settingList << entry;
  }

  SettingsComponent::Get().updatePossibleValues(SETTINGS_SECTION_AUDIO, "device", settingList);

  checkCurrentAudioDevice(m_audioDevices, devices);
  m_audioDevices = devices;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateAudioDevice()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  QString device = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "device").toString();

  if (!m_audioDevices.contains(device))
  {
    qWarning() << "Not using audio device" << device << "because it's not present.";
    device = "auto";
  }

  // Device-list notifications can fire while macvk waits for the Cocoa main
  // thread. Queue this timer update so it cannot wait on mpv's busy core.
  m_mpv->setPropertyAsync("audio-device",device);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateAudioConfiguration()
{
  setAudioConfiguration();
  refreshMpvConf();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setAudioConfiguration()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  QString deviceType = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "devicetype").toString();

  updateAudioDevice();

  // The audio page decides these options; the managed tail of mpv.conf
  // shows the same values.
  QString passthroughCodecs;
  QVariant layout;
  for (const auto& option : MpvConfigManager::audioOptions())
  {
    m_mpv->setProperty(option.key, option.value);
    if (option.key == QStringLiteral("audio-spdif"))
      passthroughCodecs = option.value.toString();
    else if (option.key == QStringLiteral("audio-channels"))
      layout = option.value;
  }
  m_passthroughCodecs = passthroughCodecs.split(',', Qt::SkipEmptyParts);

  // if the user has indicated that PCM only works for stereo, and that
  // the receiver supports AC3, set this extra option that allows us to transcode
  // 5.1 audio into a usable format, note that we only support AC3
  // here for now. We might need to add support for DTS transcoding
  // if we see user requests for it.
  //
  bool wasAc3Transcoding = m_doAc3Transcoding;
  m_doAc3Transcoding =
  (deviceType == AUDIO_DEVICE_TYPE_SPDIF &&
   SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "passthrough.ac3").toBool());
  if (m_doAc3Transcoding && !wasAc3Transcoding)
  {
    m_mpv->command( QStringList() << "af" << "add" << "@ac3:lavcac3enc");
  }
  else if (!m_doAc3Transcoding && wasAc3Transcoding)
  {
    m_mpv->command( QStringList() << "af" << "remove" << "@ac3");
  }

  QVariant device = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "device");

  // Make a informational log message.
  QString audioConfig = QString(QString("Audio Config - device: %1, ") +
                                        "channel layout: %2, " +
                                        "passthrough codecs: %3, " +
                                        "ac3 transcoding: %4").arg(device.toString(),
                                                                   layout.toString(),
                                                                   passthroughCodecs.isEmpty() ? "none" : passthroughCodecs,
                                                                   m_doAc3Transcoding ? "yes" : "no");
  qInfo() << qPrintable(audioConfig);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateSubtitleConfiguration()
{
  setSubtitleConfiguration();
  refreshMpvConf();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setSubtitleConfiguration()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  // The subtitles page decides these options; the managed tail of mpv.conf
  // shows the same values.
  for (const auto& option : MpvConfigManager::subtitleOptions())
    m_mpv->setProperty(option.key, option.value);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateVideoAspectSettings()
{
  QVariant mode = SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "aspect").toString();
  bool disableScaling = false;
  bool keepAspect = true;
  QString forceAspect = "no";
  double panScan = 0.0;
  if (mode == "custom")
  {
    // in particular, do not restore anything - the intention is not to touch the user's mpv.conf settings, or whatever
    return;
  }
  else if (mode == "zoom")
  {
    panScan = 1.0;
  }
  else if (mode == "force_4_3")
  {
    forceAspect = "4:3";
  }
  else if (mode == "force_16_9")
  {
    forceAspect = "16:9";
  }
  else if (mode == "force_16_9_if_4_3")
  {
    auto aspect = m_decodedVideoParams.value("aspect").toFloat();
    if (fabs(aspect - 4.0/3.0) < 0.1)
      forceAspect = "16:9";
  }
  else if (mode == "stretch")
  {
    keepAspect = false;
  }
  else if (mode == "noscaling")
  {
    disableScaling = true;
  }

  // Decoder notification precedes macvk's window configuration. Keep Cocoa's
  // main thread available while mpv finishes that work.
  m_mpv->setPropertyAsync( "video-unscaled", disableScaling);
  m_mpv->setPropertyAsync( "video-aspect-override", forceAspect);
  m_mpv->setPropertyAsync( "keepaspect", keepAspect);
  m_mpv->setPropertyAsync( "panscan", panScan);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateVideoConfiguration()
{
  setVideoConfiguration();
  refreshMpvConf();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setVideoConfiguration()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv)
    return;

  // The video page decides these options; the managed tail of mpv.conf
  // shows the same values. RIFE owns video-sync and hwdec while active.
  for (const auto& option : MpvConfigManager::videoOptions())
  {
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
    if (m_rife && option.key == QStringLiteral("video-sync"))
    {
      m_rife->configureVideoSync(option.value.toString());
      continue;
    }
    if (m_rife && option.key == QStringLiteral("hwdec"))
    {
      m_rife->configureHardwareDecoding(option.value.toString());
      continue;
    }
#endif
    m_mpv->setProperty(option.key, option.value);
  }

#ifndef TARGET_RPI
  double displayFps = DisplayComponent::Get().currentRefreshRate();
#ifdef Q_OS_WIN
  // DEVMODE has whole hertz only (59 for 59.94, 60 for 59.997). Until mpv
  // trusts its own vsync estimate, display-resample bends audio by that error.
  if (m_window)
  {
    const double exact = WindowsHdr::forWindow(m_window->winId()).refreshRate;
    if (exact > 0 && std::abs(exact - displayFps) < 1)
      displayFps = exact;
  }
#endif
  m_mpv->setProperty( "display-fps-override", displayFps);
#endif

  setAudioDelay(m_playbackAudioDelay);

  updateVideoAspectSettings();
}


///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setMpvPreset()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) return;
  const QString profile = MpvConfigManager::startupProfile(MpvConfigManager::readConfig().user);
  // Settings changes unrelated to the preset must not re-run the profile.
  if (!profile.isEmpty() && profile != m_appliedProfile)
    applyQualityProfile(profile, false);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::applyQualityProfile(const QString& profile, bool announce)
{
  if (!m_mpv)
    return false;
  const QList<MpvConf::Line> lines = MpvConf::parse(MpvConfigManager::readConfig().user);
  QString error;
  const QList<MpvConf::ProfileStep> steps = MpvConf::resolveProfile(lines, profile, &error);
  QString title = profile;
  for (const MpvConf::ProfileInfo& info : MpvConf::profiles(lines))
    if (info.name == profile && !info.description.isEmpty())
      title = info.description;
  if (!error.isEmpty())
  {
    qWarning() << "Unable to apply MPV profile" << profile << error;
    if (announce)
      m_mpv->commandAsync(QStringList{QStringLiteral("show-text"), QStringLiteral("滤镜切换失败: %1").arg(error),
                                      QStringLiteral("3200")});
    return false;
  }

  // The profile comes from the current mpv.conf, so edits made in the
  // settings page apply without restarting. List-valued options accumulate
  // across runtime switches; start from an empty shader list.
  QStringList failed;
  m_mpv->command(QStringList() << "change-list" << "glsl-shaders" << "clr" << "");
  for (const MpvConf::ProfileStep& step : steps)
  {
    if (!applyMpvConfOption(step.builtin ? QStringLiteral("profile") : step.key, step.value))
      failed << step.key;
  }
  int actual = 0;
  for (const QVariant& shader : m_mpv->getProperty("glsl-shaders").toList())
    if (!shader.toString().trimmed().isEmpty())
      ++actual;
  const int expected = MpvConf::shaderCount(steps);
  m_appliedProfile = profile;
  m_mpv->setProperty("user-data/profile_menu/current", profile);
  if (!failed.isEmpty())
    qWarning() << "MPV profile" << profile << "options were rejected:" << failed;

  // Switching in the player (uosc menu, Alt+1..3) also moves the settings
  // page's preset, so the page always edits the profile that is playing.
  const QString preset = MpvConfigManager::presetForProfile(profile);
  if (SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "shaderPreset").toString() != preset)
    SettingsComponent::Get().setValue(SETTINGS_SECTION_MPV, "shaderPreset", preset);

  if (announce)
  {
    const bool ok = actual == expected;
    const QString message = ok
        ? QStringLiteral("已切换滤镜: %1（%2 个 shader）").arg(title).arg(actual)
        : QStringLiteral("滤镜切换失败: %1（预期 %2，实际 %3 个 shader）").arg(title).arg(expected).arg(actual);
    m_mpv->commandAsync(QStringList{QStringLiteral("show-text"), message,
                                    ok ? QStringLiteral("2400") : QStringLiteral("3200")});
  }
  return actual == expected && failed.isEmpty();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::applyMpvConfOption(const QString& key, const QString& value)
{
  static const QStringList listSuffixes = {
    QStringLiteral("-append"), QStringLiteral("-add"), QStringLiteral("-pre"), QStringLiteral("-set"),
    QStringLiteral("-clr"), QStringLiteral("-remove"), QStringLiteral("-del"), QStringLiteral("-toggle")};
  const auto succeeded = [](const QVariant& result) {
    return result.metaType() != QMetaType::fromType<ErrorReturn>();
  };
  if (key == QStringLiteral("profile"))
    return succeeded(m_mpv->command(QStringList() << "apply-profile" << value));
  if (key == QStringLiteral("glsl-shader"))
    return succeeded(m_mpv->command(QStringList() << "change-list" << "glsl-shaders" << "append" << value));
  const QString base = MpvConfigManager::rules().baseKey(key);
  if (base != key)
  {
    if (key == QStringLiteral("no-") + base)
      return m_mpv->setProperty(base, QStringLiteral("no")) >= 0;
    for (const QString& suffix : listSuffixes)
      if (key == base + suffix)
        return succeeded(m_mpv->command(QStringList() << "change-list" << base << suffix.mid(1) << value));
  }
  return m_mpv->setProperty(key, value) >= 0;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::resetMpvConfOption(const QString& key, const QList<MpvConf::Line>& lines)
{
  const QString base = MpvConfigManager::rules().baseKey(key);
  const MpvConf::ResolvedValue global = MpvConf::resolveValue(lines, QStringLiteral("default"), base);
  if (global.found)
  {
    applyMpvConfOption(base, global.value);
    return;
  }
  const QVariant fallback = m_mpv->getProperty(QStringLiteral("option-info/%1/default-value").arg(base));
  if (fallback.isValid() && fallback.metaType() != QMetaType::fromType<ErrorReturn>())
    m_mpv->setProperty(base, fallback);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::applyUserConfLive(const QString& previous, const QString& current)
{
  if (!m_mpv || previous == current)
    return;
  const QList<MpvConf::Line> oldLines = MpvConf::parse(previous);
  const QList<MpvConf::Line> newLines = MpvConf::parse(current);
  const MpvConf::Rules& rules = MpvConfigManager::rules();
  const auto globals = [&rules](const QList<MpvConf::Line>& lines) {
    QMap<QString, QString> values;
    for (const MpvConf::Line& line : lines)
    {
      if (line.kind != MpvConf::Line::Option || line.section != QStringLiteral("default"))
        continue;
      const QString base = rules.baseKey(line.key);
      const bool listOperation = base != line.key && !line.key.startsWith(QStringLiteral("no-"));
      if (MpvConf::isFilterKey(base) || base == QStringLiteral("glsl-shaders") || listOperation)
        continue;
      values.insert(line.key, line.hasValue ? line.value : QStringLiteral("yes"));
    }
    return values;
  };

  // Global options: set what changed, reset what was removed.
  const QMap<QString, QString> before = globals(oldLines);
  const QMap<QString, QString> after = globals(newLines);
  for (auto it = after.begin(); it != after.end(); ++it)
    if (!before.contains(it.key()) || before.value(it.key()) != it.value())
      applyMpvConfOption(it.key(), it.value());
  for (auto it = before.begin(); it != before.end(); ++it)
    if (!after.contains(it.key()))
      resetMpvConfOption(it.key(), newLines);

  // User filters: rebuild the @user- entries at the front of the chain, so
  // they stay ahead of @tigerest-rife and SVP.
  QStringList filters;
  for (const MpvConf::Line& line : newLines)
    if (line.kind == MpvConf::Line::Option && line.section == QStringLiteral("default") &&
        MpvConf::isFilterKey(rules.baseKey(line.key)) && !line.key.endsWith(QStringLiteral("-remove")))
      for (const MpvConf::FilterEntry& filter : MpvConf::parseFilters(line.value))
        filters << filter.text;
  for (const QVariant& entry : m_mpv->getProperty("vf").toList())
  {
    const QString label = entry.toMap().value(QStringLiteral("label")).toString();
    if (label.startsWith(QStringLiteral("user-")))
      m_mpv->command(QStringList() << "vf" << "remove" << QStringLiteral("@") + label);
  }
  for (auto it = filters.crbegin(); it != filters.crend(); ++it)
    m_mpv->command(QStringList() << "change-list" << "vf" << "pre" << *it);

  // The active profile: options it no longer sets fall back to the global
  // value, then the profile runs again from the new text.
  if (!m_appliedProfile.isEmpty())
  {
    QSet<QString> previousKeys;
    for (const MpvConf::ProfileStep& step : MpvConf::resolveProfile(oldLines, m_appliedProfile))
      if (!step.builtin)
        previousKeys.insert(rules.baseKey(step.key));
    QSet<QString> currentKeys;
    for (const MpvConf::ProfileStep& step : MpvConf::resolveProfile(newLines, m_appliedProfile))
      if (!step.builtin)
        currentKeys.insert(rules.baseKey(step.key));
    for (const QString& key : previousKeys - currentKeys)
      if (key != QStringLiteral("glsl-shaders"))
        resetMpvConfOption(key, newLines);
    bool exists = false;
    for (const MpvConf::ProfileInfo& info : MpvConf::profiles(newLines))
      exists = exists || info.name == m_appliedProfile;
    applyQualityProfile(exists ? m_appliedProfile : QStringLiteral("tigerest-default"), false);
  }
  publishProfileMenu();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::refreshMpvConf()
{
  const QString before = MpvConfigManager::readConfig().user;
  const MpvConfigManager::WriteResult result = MpvConfigManager::refresh();
  if (!result.ok)
    return;
  applyUserConfLive(before, result.user);
  if (!result.suspended.isEmpty())
    emit mpvConfMessage(QStringLiteral("RIFE 已开启：你在 mpv.conf 里写的 %1 行冲突配置已暂停执行，关闭 RIFE 后自动恢复。")
                            .arg(result.suspended.size()));
  if (!result.restored.isEmpty())
    emit mpvConfMessage(QStringLiteral("RIFE 已关闭：mpv.conf 里暂停的 %1 行配置已恢复执行。").arg(result.restored.size()));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::publishProfileMenu()
{
  if (!m_mpv)
    return;
  const QList<MpvConf::Line> lines = MpvConf::parse(MpvConfigManager::readConfig().user);
  QVariantList items;
  for (const MpvConf::ProfileInfo& info : MpvConf::profiles(lines))
  {
    // The shared base is an inheritance helper, not a choice.
    if (info.name == QStringLiteral("tigerest-quality-base"))
      continue;
    const int shaders = MpvConf::shaderCount(MpvConf::resolveProfile(lines, info.name));
    items << QVariantMap{{QStringLiteral("profile"), info.name},
                         {QStringLiteral("title"), info.description.isEmpty() ? info.name : info.description},
                         {QStringLiteral("hint"), QStringLiteral("%1 个着色器").arg(shaders)}};
  }
  m_mpv->setProperty("user-data/profile_menu/profiles",
                     QString::fromUtf8(QJsonDocument::fromVariant(items).toJson(QJsonDocument::Compact)));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::storeMpvOptionTable()
{
  if (!m_mpv)
    return;
  const QString version = m_mpv->getProperty("mpv-version").toString();
  if (version.isEmpty() || MpvConfigManager::cachedOptionTableVersion() == version)
    return;
  // Reading option-info of a renamed option logs a deprecation warning for
  // each alias; keep those out of the user's log during the scan.
  m_mpv->setProperty("msg-level", "all=v,cplayer=error");
  const auto restoreLog = qScopeGuard([this] { m_mpv->setProperty("msg-level", "all=v"); });
  QJsonObject options;
  for (const QString& name : m_mpv->getProperty("options").toStringList())
  {
    const QVariantMap info = m_mpv->getProperty(QStringLiteral("option-info/%1").arg(name)).toMap();
    QJsonObject entry{{QStringLiteral("type"), info.value(QStringLiteral("type")).toString()}};
    for (const char* fieldName : {"choices", "min", "max"})
    {
      const QString field = QString::fromLatin1(fieldName);
      if (info.contains(field))
        entry.insert(field, QJsonValue::fromVariant(info.value(field)));
    }
    options.insert(name, entry);
  }
  MpvConfigManager::storeOptionTable(QJsonObject{{QStringLiteral("mpvVersion"), version},
                                                 {QStringLiteral("options"), options}});
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantMap PlayerComponent::mpvConfState()
{
  QString profile = m_appliedProfile;
  if (profile.isEmpty())
    profile = MpvConfigManager::profileName(SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "shaderPreset").toString());
  return MpvConfEditor::state(profile);
}

QVariantMap PlayerComponent::mpvConfAnalyze(const QString& user, const QString& section)
{
  return MpvConfEditor::analyze(user, section);
}

QVariantMap PlayerComponent::mpvConfEdit(const QString& user, const QVariantMap& operation)
{
  return MpvConfEditor::edit(user, operation);
}

QVariantMap PlayerComponent::mpvConfPaste(const QString& text)
{
  return MpvConfEditor::paste(text);
}

QVariantMap PlayerComponent::mpvConfSave(const QString& user, bool force)
{
  const QString section = m_appliedProfile.isEmpty() ? QStringLiteral("tigerest-default") : m_appliedProfile;
  const QVariantMap analysis = MpvConfEditor::analyze(user, section);
  if (!force && analysis.value(QStringLiteral("errors")).toInt() > 0)
    return {{QStringLiteral("saved"), false}, {QStringLiteral("analysis"), analysis}};
  const QString before = MpvConfigManager::readConfig().user;
  const MpvConfigManager::WriteResult result = MpvConfigManager::saveUser(user);
  if (result.ok)
    applyUserConfLive(before, result.user);
  return {{QStringLiteral("saved"), result.ok},
          {QStringLiteral("user"), result.user},
          {QStringLiteral("suspended"), result.suspended.size()},
          {QStringLiteral("ignored"), result.ignored.size()},
          {QStringLiteral("analysis"), MpvConfEditor::analyze(result.user, section)}};
}

QVariantMap PlayerComponent::mpvConfRestoreDefault()
{
  const QString before = MpvConfigManager::readConfig().user;
  const MpvConfigManager::WriteResult result = MpvConfigManager::restoreDefault();
  if (result.ok)
    applyUserConfLive(before, result.user);
  return mpvConfState();
}

void PlayerComponent::mpvConfAcknowledgeDefault()
{
  MpvConfigManager::acknowledgeDefaultUpdate();
}

bool PlayerComponent::mpvConfOpenShaderFolder()
{
  QDir().mkpath(MpvConfigManager::userShaderDir());
  return QDesktopServices::openUrl(QUrl::fromLocalFile(MpvConfigManager::userShaderDir()));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateMpvConfiguration()
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  setMpvPreset();
  refreshMpvConf();
  emit SystemComponent::Get().settingsMessage(
    "MPV",
    "画质档位已应用；uosc、弹幕与控制台开关将在重启后生效");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::updateConfiguration()
{
  setAudioConfiguration();
  setVideoConfiguration();
  setSubtitleConfiguration();
}

/////////////////////////////////////////////////////////////////////////////////////////
bool PlayerComponent::userCommand(QString command)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return false;
#endif
  if (!m_mpv)
    return false;
  QByteArray cmdUtf8 = command.toUtf8();
  return mpv_command_string(m_mpv->mpv(), cmdUtf8.data()) >= 0;
}

/////////////////////////////////////////////////////////////////////////////////////////
static QString get_mpv_osd(mpv_handle *ctx, const QString& property)
{
  char *s = mpv_get_property_osd_string(ctx, property.toUtf8().data());
  if (!s)
    return "-";
  QString r = QString::fromUtf8(s);
  mpv_free(s);
  if (r.size() > 400)
    r = r.mid(0, 400) + "...";
  Log::CensorAuthTokens(r);
  return r;
}

#define MPV_PROPERTY(p) get_mpv_osd(m_mpv->mpv(), p)
#define MPV_PROPERTY_BOOL(p) (m_mpv->getProperty(p).toBool())

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::appendAudioFormat(QTextStream& info, const QString& property) const
{
  // Guess if it's a passthrough format. Don't show the channel layout in this
  // case, because it's confusing.
  QString audioFormat = MPV_PROPERTY(property + "/format");
  if (audioFormat.startsWith("spdif-"))
  {
    info << "passthrough (" << audioFormat.mid(6) << ")";
  }
  else
  {
    QString hr = MPV_PROPERTY(property + "/hr-channels");
    QString full = MPV_PROPERTY(property + "/channels");
    info << hr;
    if (hr != full)
      info << " (" << full << ")";
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
QString PlayerComponent::videoInformation() const
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return {};
#endif
  QString infoStr;
  QTextStream info(&infoStr);

  // check if video is playing
  if (m_mpv->getProperty( "idle-active").toBool())
    return "";

  info << "File:\n";
  info << "URL: " << MPV_PROPERTY("path") << "\n";
  info << "Container: " << MPV_PROPERTY("file-format") << "\n";
  info << "Native seeking: " << ((MPV_PROPERTY_BOOL("seekable") &&
                                  !MPV_PROPERTY_BOOL("partially-seekable"))
                                 ? "yes" : "no") << "\n";
  info << "\n";
  info << "Video:\n";
#if defined(Q_OS_MAC) || defined(Q_OS_WIN)
  if(m_rife)info << m_rife->status() << "\n";
#endif
  info << "Codec: " << MPV_PROPERTY("video-codec") << "\n";
  info << "Size: " << MPV_PROPERTY("video-params/dw") << "x"
                   << MPV_PROPERTY("video-params/dh") << "\n";
  info << "FPS (container): " << MPV_PROPERTY("container-fps") << "\n";
  info << "FPS (filters): " << MPV_PROPERTY("estimated-vf-fps") << "\n";
  info << "Aspect: " << MPV_PROPERTY("video-params/aspect") << "\n";
  info << "Bitrate: " << MPV_PROPERTY("video-bitrate") << "\n";
  double displayFps = DisplayComponent::Get().currentRefreshRate();
  info << "Display FPS: " << MPV_PROPERTY("override-display-fps")
                          << " (" << displayFps << ")" << "\n";
  info << "Hardware Decoding: " << MPV_PROPERTY("hwdec-current")
                                << " (" << MPV_PROPERTY("hwdec-interop") << ")\n";
  info << "\n";
  info << "Audio:\n";
  info << "Codec: " << MPV_PROPERTY("audio-codec") << "\n";
  info << "Bitrate: " << MPV_PROPERTY("audio-bitrate") << "\n";
  info << "Channels: ";
  appendAudioFormat(info, "audio-params");
  info << " -> ";
  appendAudioFormat(info, "audio-out-params");
  info << "\n";
  info << "Output driver: " << MPV_PROPERTY("current-ao") << "\n";
  info << "\n";
  info << "Performance:\n";
  info << "A/V: " << MPV_PROPERTY("avsync") << "\n";
  info << "Dropped frames: " << MPV_PROPERTY("vo-drop-frame-count") << "\n";
  bool dispSync = MPV_PROPERTY_BOOL("display-sync-active");
  info << "Display Sync: ";
  if (!dispSync)
  {
     info << "no\n";
  }
  else
  {
    info << "yes (ratio " << MPV_PROPERTY("vsync-ratio") << ")\n";
    info << "Mistimed frames: " << MPV_PROPERTY("mistimed-frame-count")
                                << "/" << MPV_PROPERTY("vo-delayed-frame-count") << "\n";
    info << "Measured FPS: " << MPV_PROPERTY("estimated-display-fps")
                             << " (" << MPV_PROPERTY("vsync-jitter") << ")\n";
    info << "V. speed corr.: " << MPV_PROPERTY("video-speed-correction") << "\n";
    info << "A. speed corr.: " << MPV_PROPERTY("audio-speed-correction") << "\n";
  }
  info << "\n";
  info << "Cache:\n";
  info << "Seconds: " << MPV_PROPERTY("demuxer-cache-duration") << "\n";
  info << "Extra readahead: " << MPV_PROPERTY("cache-used") << "\n";
  info << "Buffering: " << MPV_PROPERTY("cache-buffering-state") << "\n";
  info << "Speed: " << MPV_PROPERTY("cache-speed") << "\n";
  info << "\n";
  info << "Misc:\n";
  info << "Time: " << MPV_PROPERTY("playback-time") << " / "
                   << MPV_PROPERTY("duration")
                   << " (" << MPV_PROPERTY("percent-pos") << "%)\n";
  info << "State: " << (MPV_PROPERTY_BOOL("pause") ? "paused " : "")
                    << (MPV_PROPERTY_BOOL("paused-for-cache") ? "buffering " : "")
                    << (MPV_PROPERTY_BOOL("core-idle") ? "waiting " : "playing ")
                    << (MPV_PROPERTY_BOOL("seeking") ? "seeking " : "")
                    << "\n";

  info.flush();
  return infoStr;
}

/////////////////////////////////////////////////////////////////////////////////////////
void PlayerComponent::setWebPlaylist(const QVariantList& playlist, const QString& currentItemId)
{
  m_webPlaylist = playlist;
  m_currentWebPlaylistItemId = currentItemId;
  if (m_mpv)
  {
    QJsonArray items;
    for (const auto& entry : playlist)
    {
      const auto item = entry.toMap();
      if (item.value(QStringLiteral("PlaylistItemId")).toString().isEmpty())
        continue;
      QJsonObject lean;
      // UOSC needs names and queue identities, never stream URLs or paths.
      for (const auto& key : {QStringLiteral("PlaylistItemId"), QStringLiteral("Id"),
                             QStringLiteral("Name"), QStringLiteral("IndexNumber"),
                             QStringLiteral("ParentIndexNumber")})
      {
        if (item.contains(key))
          lean.insert(key, QJsonValue::fromVariant(item.value(key)));
      }
      items.append(lean);
    }
    const QJsonObject data{{QStringLiteral("currentItemId"), currentItemId},
                           {QStringLiteral("items"), items}};
    // Queue updates can arrive while the macOS native VO is tearing down.
    // Publish asynchronously so the Qt UI never waits for that transition.
    m_mpv->setPropertyAsync("user-data/tigerest/web-playlist",
                            QString::fromUtf8(QJsonDocument(data).toJson(QJsonDocument::Compact)));
  }
  emit webPlaylistChanged(playlist, currentItemId);
}

/////////////////////////////////////////////////////////////////////////////////////////
QVariantList PlayerComponent::getWebPlaylist() const
{
  return m_webPlaylist;
}

/////////////////////////////////////////////////////////////////////////////////////////
QString PlayerComponent::getCurrentWebPlaylistItemId() const
{
  return m_currentWebPlaylistItemId;
}

void PlayerComponent::updateDanmakuAuthorization(const QString& path, const QString& generation)
{
#ifdef Q_OS_WIN
  if (m_shuttingDown) return;
#endif
  if (!m_mpv) return;
  m_mpv->setProperty(QStringLiteral("user-data/tigerest/danmaku/mapping-auth-file"), path);
  m_mpv->setProperty(QStringLiteral("user-data/tigerest/danmaku/auth-generation"), generation);
}
