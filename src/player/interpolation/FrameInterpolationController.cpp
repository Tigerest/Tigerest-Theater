#include "FrameInterpolationController.h"
#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QDebug>
#include <cmath>
namespace rife {
namespace {
QString optionText(const QVariant& value){
    if(value.metaType().id()==QMetaType::QVariantList){QStringList values;for(const auto& v:value.toList())values<<v.toString();return values.join(',');}
    if(value.metaType().id()==QMetaType::QStringList)return value.toStringList().join(',');
    return value.toString();
}
QString quote(const QString& text){return "%"+QString::number(text.toUtf8().size())+"%"+text;}
bool same(const SourceInfo&a,const SourceInfo&b){return a.width==b.width&&a.height==b.height&&a.fpsNum==b.fpsNum&&a.fpsDen==b.fpsDen&&a.progressive==b.progressive&&a.cfr==b.cfr&&a.hdr==b.hdr&&a.colorKnown==b.colorKnown;}
QString message(const QString& reason,Backend backend=Backend::CoreMLMetal){
    if(reason=="hdr")return QStringLiteral("当前 HDR 视频保持原帧播放");
    if(reason=="system-config")return QStringLiteral("AI 补帧需要使用内置播放配置");
    if(reason=="external-filter")return QStringLiteral("已有外部补帧滤镜，保持当前播放配置");
    if(reason=="unsupported-size")return backend==Backend::TensorRT?QStringLiteral("当前分辨率保持原帧播放（最高 4K）"):QStringLiteral("当前分辨率保持原帧播放（最高 1080p）");
    if(reason=="unsupported-fps")return backend==Backend::TensorRT?QStringLiteral("当前帧率保持原帧播放（最高 60 fps）"):QStringLiteral("当前帧率保持原帧播放（最高 30 fps）");
    if(reason=="engine-preparing")return QStringLiteral("正在准备补帧引擎，完成后自动播放");
    if(reason=="engine-prepare-error")return QStringLiteral("补帧引擎准备失败，已恢复原帧播放");
    if(reason=="dynamic-format")return QStringLiteral("视频格式发生变化，本次保持原帧播放");
    if(reason=="playback-speed")return QStringLiteral("倍速播放保持原帧，恢复正常速度后下次播放可启用补帧");
    if(reason=="vfr")return QStringLiteral("变帧率视频保持原帧播放");
    if(reason=="interlaced")return QStringLiteral("隔行视频保持原帧播放");
    if(reason=="unknown-color")return QStringLiteral("色彩信息不完整，保持原帧播放");
    if(reason=="runtime-missing")return QStringLiteral("补帧组件不可用，保持原帧播放");
    if(reason=="filter-error")return QStringLiteral("补帧滤镜加载或运行失败，已恢复原帧播放");
    return QStringLiteral("补帧已停止，已恢复原帧播放");
}
}
FrameInterpolationController::FrameInterpolationController(MpvAccess a,RuntimePaths p):mpv(std::move(a)),paths(std::move(p)),
    guard(paths.backend==Backend::TensorRT?GuardParameters::windows():GuardParameters{}){}
FrameInterpolationController::~FrameInterpolationController(){closeSession(session);} // mpv may already be destroyed
bool FrameInterpolationController::setRuntimePaths(RuntimePaths replacement){
    if(filterOwned)return false;
    if(replacement.backend==Backend::TensorRT&&
       (!validInterpolationMultiplier(replacement.factor)||replacement.numStreams<1||replacement.numStreams>4||
        !((replacement.implementation==1&&(replacement.alignment==32||replacement.alignment==64||replacement.alignment==128))||
          (replacement.implementation==2&&replacement.alignment==1))))return false;
    paths=std::move(replacement);
    guard=PerformanceGuard(paths.backend==Backend::TensorRT?GuardParameters::windows():GuardParameters{});
    return true;
}
bool FrameInterpolationController::hasFilter(bool requireEnabled)const{
    for(auto v:mpv.read("vf").toList()){
        const auto filter=v.toMap();
        if(filter.value("label")=="tigerest-rife"&&
           (!requireEnabled||!filter.contains("enabled")||filter["enabled"].toBool()))return true;
    }
    return false;
}
bool FrameInterpolationController::conflict()const{
    for(auto v:mpv.read("vf").toList()){
        const auto f=v.toMap();
        if(f.value("label")=="tigerest-rife"&&filterOwned)continue;
        const auto text=(f.value("name").toString()+" "+f.value("label").toString()+" "+QJsonDocument::fromVariant(f.value("params")).toJson()).toLower();
        if(text.contains("vapoursynth")||text.contains("svp")||text.contains("rife")||text.contains("minterpolate"))return true;
    }
    return false;
}
void FrameInterpolationController::detach(){
    closeSession(session);session=0;epoch=0;
    if(filterOwned&&hasFilter(false))mpv.command({"vf","remove","@tigerest-rife"});
    filterOwned=false;
    if(hwdecOwned&&optionText(mpv.read("hwdec"))=="auto-copy")mpv.set("hwdec",oldHwdec);
    restoreVideoSync();
    hwdecOwned=false;guard.reset();displaySyncWatch.reset();preparingSince=-1;
}
void FrameInterpolationController::configureHardwareDecoding(const QString& mode){
    // Settings refreshes and new loads use the same entry point. Remember the
    // latest preference while keeping active interpolation's frames readable.
    const bool active=current==State::Preparing||current==State::Active;
    const bool copy=active&&mode!="no"&&mode!="auto-copy"&&!mode.isEmpty();
    oldHwdec=mode;
    hwdecOwned=copy;
    if(!mpv.set("hwdec",copy?QStringLiteral("auto-copy"):mode)&&active)
        disable("decode-error");
}
void FrameInterpolationController::configureVideoSync(const QString& mode){
    if(!applyVideoSync(mode,filterOwned)&&filterOwned)disable("video-sync-error");
}
bool FrameInterpolationController::asynchronousClock()const{
    return paths.backend==Backend::TensorRT&&mpv.asyncPropertyReplies&&mpv.setAsyncTagged&&mpv.getAsyncTagged;
}
void FrameInterpolationController::requestClock(ClockStep step,const QString& value){
    clockStep=step;clockWriteValue=value;
    if(step==ClockStep::Release&&!clockReleasing){clockReleaseIntent=clockIntent;clockReleasing=true;}
    clockRequest=0x53000000+(++clockSequence&0x00ffffff);
    const int id=clockRequest;
    const bool accepted=step==ClockStep::Read?mpv.getAsyncTagged("video-sync",id):
        mpv.setAsyncTagged(step==ClockStep::Acquire||step==ClockStep::Release?
            QStringLiteral("user-data/tigerest/rife-clock-owned"):QStringLiteral("video-sync"),
            step==ClockStep::Acquire?QVariant(true):step==ClockStep::Release?QVariant(false):QVariant(value),id);
    if(!accepted){
        if(step==ClockStep::Read)onClockReadReply(id,-1,{});
        else onClockSetReply(id,-1);
    }
}
void FrameInterpolationController::advanceClock(){
    if(!asynchronousClock()||clockRequest||clockCleanupFailed)return;
    if(clockMarker){
        if(clockReleaseOnly||(!clockWanted&&!clockRestore))requestClock(ClockStep::Release);
        else requestClock(ClockStep::Read);
    }else if(clockWanted||(clockRestore&&clockExplicit))requestClock(ClockStep::Acquire);
}
void FrameInterpolationController::serviceClock(){
    // Includes cleanup after END_FILE, when the ordinary media poll no longer runs.
    if(asynchronousClock()&&clockCleanupFailed){clockCleanupFailed=false;advanceClock();}
}
void FrameInterpolationController::failClock(){
    clockWanted=false;clockExplicit=false;
    if(current==State::Preparing||current==State::Active)disable("video-sync-error");
    else advanceClock();
}
void FrameInterpolationController::onClockSetReply(uint64_t id,int error){
    if(!clockRequest||id!=uint64_t(clockRequest)||clockStep==ClockStep::Read)return;
    const auto step=clockStep;const auto value=clockWriteValue;const auto intent=clockReleaseIntent;
    clockRequest=0;clockStep=ClockStep::Idle;
    if(error<0){
        if(step==ClockStep::Release){
            // Do not pretend Lua has been released. Retry from the next timer tick.
            clockCleanupFailed=true;clockReleaseOnly=true;videoSyncOwned=false;return;
        }
        if(step==ClockStep::Acquire){clockMarker=false;clockRestore=false;}
        if(step==ClockStep::Restore){
            // The user's preference has not taken effect. Keep Lua excluded and
            // retry from a fresh ownership read on the next timer tick.
            clockWanted=false;clockRestore=true;clockExplicit=false;clockCleanupFailed=true;
            if(current==State::Preparing||current==State::Active)disable("video-sync-error");
            return;
        }
        failClock();return;
    }
    if(step==ClockStep::Acquire)clockMarker=true;
    else if(step==ClockStep::Release){
        const bool newerPreference=!clockWanted&&clockIntent!=intent;
        clockReleasing=false;
        clockMarker=false;videoSyncOwned=false;clockWritten.clear();
        clockRestore=newerPreference;clockExplicit=newerPreference;
        clockReleaseOnly=false;clockCleanupFailed=false;
    }else{
        clockWritten=value;effectiveVideoSync=value;
        if(step==ClockStep::Restore&&!clockWanted&&oldVideoSync==value){clockRestore=false;clockExplicit=false;}
    }
    advanceClock();
}
void FrameInterpolationController::onClockReadReply(uint64_t id,int error,const QVariant& value){
    if(!clockRequest||id!=uint64_t(clockRequest)||clockStep!=ClockStep::Read)return;
    clockRequest=0;clockStep=ClockStep::Idle;
    const auto actual=optionText(value);
    if(error<0||actual.isEmpty()){
        if(!clockWritten.isEmpty()||clockRestore){
            clockWanted=false;clockRestore=true;clockExplicit=false;clockCleanupFailed=true;
            if(current==State::Preparing||current==State::Active)disable("video-sync-error");
            return;
        }
        clockRestore=false;clockReleaseOnly=true;failClock();return;
    }
    effectiveVideoSync=actual;
    const auto expected=clockWritten.isEmpty()?oldVideoSync:clockWritten;
    if(!clockExplicit&&actual!=expected){
        // A read made after SET_PROPERTY_REPLY distinguishes a stale observer
        // notification from an external writer, even if no new event was emitted.
        oldVideoSync=actual;clockWanted=false;clockRestore=false;clockReleaseOnly=true;
        if(clockItem==itemSequence)clockTakenOver=true;
        videoSyncOwned=false;advanceClock();return;
    }
    if(!clockWanted&&!clockRestore){advanceClock();return;}
    const auto target=clockWanted?QStringLiteral("audio"):oldVideoSync;
    if(actual!=target){requestClock(clockWanted?ClockStep::Write:ClockStep::Restore,target);return;}
    if(clockWanted){videoSyncOwned=true;return;}
    clockRestore=false;clockExplicit=false;advanceClock();
}
bool FrameInterpolationController::applyVideoSync(const QString& mode,bool interpolating){
    const bool override=paths.backend==Backend::TensorRT&&interpolating&&mode=="display-resample"&&audioPacing();
    if(asynchronousClock()&&(override||clockMarker||clockRequest)){
        ++clockIntent;oldVideoSync=mode;clockWanted=override;clockRestore=!override;clockExplicit=!override;
        if(override){clockReleaseOnly=false;clockTakenOver=false;clockItem=itemSequence;}
        advanceClock();return true;
    }
    const auto effective=override?QStringLiteral("audio"):mode;
    if(override&&videoSyncOwned&&(videoSyncPending||effectiveVideoSync==effective)){oldVideoSync=mode;return true;}
    if(override&&!videoSyncOwned){
        // Lua must relinquish its clock before it observes our windowed audio mode.
        if(!mpv.set("user-data/tigerest/rife-clock-owned",true))return false;
        videoSyncOwned=true;
    }
    if(override)oldVideoSync=mode;
    if(!effective.isEmpty()&&!mpv.set("video-sync",effective))return false;
    oldVideoSync=mode;
    if(override){
        previousVideoSync=effectiveVideoSync;
        videoSyncPending=effectiveVideoSync!=effective;
    }else{
        // Keep Lua excluded until the user's preference has been restored.
        if(videoSyncOwned)mpv.set("user-data/tigerest/rife-clock-owned",false);
        videoSyncOwned=false;videoSyncPending=false;previousVideoSync.clear();
    }
    if(!effective.isEmpty())effectiveVideoSync=effective;
    return true;
}
void FrameInterpolationController::onVideoSyncChanged(const QString& mode){
    if(mode.isEmpty())return;
    if(asynchronousClock()){
        if(clockMarker||clockRequest)advanceClock();
        else effectiveVideoSync=mode;
        return;
    }
    if(videoSyncOwned){
        // The synchronous adapter can still receive an observer notification
        // queued before its write. Acknowledge the current override first.
        if(mode==effectiveVideoSync){
            videoSyncPending=false;
            if(filterOwned&&!applyVideoSync(oldVideoSync,true))disable("video-sync-error");
            return;
        }
        if(videoSyncPending&&mode==previousVideoSync)return;
        videoSyncOwned=false;videoSyncPending=false;previousVideoSync.clear();
        oldVideoSync=mode;clockTakenOver=true;
        // Property callbacks must not block mpv's VO teardown.
        mpv.setAsync("user-data/tigerest/rife-clock-owned",false);
    }
    effectiveVideoSync=mode;
}
bool FrameInterpolationController::audioPacing()const{return !fullScreen||displaySyncFallback;}
bool FrameInterpolationController::watchesDisplaySync()const{
    // Only the user's own fullscreen display-resample, while this item keeps it.
    return paths.backend==Backend::TensorRT&&filterOwned&&!audioPacing()&&!clockTakenOver&&
           !videoSyncOwned&&!clockMarker&&!clockRequest&&effectiveVideoSync=="display-resample";
}
void FrameInterpolationController::fallBackToAudio(){
    // Pace the rest of this item like windowed playback. The guard starts
    // over, so drops that continue under audio still warn.
    displaySyncFallback=true;displaySyncWatch.reset();guard.reset();
    qInfo()<<"RIFE fullscreen display-resample keeps mistiming frames; pacing this item by audio";
    if(!applyVideoSync(effectiveVideoSync,true))disable("video-sync-error");
}
void FrameInterpolationController::setFullScreen(bool enabled){
    if(fullScreen==enabled)return;
    fullScreen=enabled;displaySyncWatch.reset();
    // A graph still waiting for its engine applies this when it attaches.
    if(paths.backend!=Backend::TensorRT||!filterOwned)return;
    if(!audioPacing()){restoreVideoSync();return;}
    // Never reclaim a clock that an external writer took during this item.
    if(clockTakenOver)return;
    const auto mode=videoSyncOwned||clockMarker||clockRequest?oldVideoSync:effectiveVideoSync;
    if(mode=="display-resample"&&!applyVideoSync(mode,true))disable("video-sync-error");
}
void FrameInterpolationController::restoreVideoSync(bool asynchronous){
    if(asynchronousClock()){
        if(clockMarker||clockRequest){clockWanted=false;clockRestore=!clockReleaseOnly;clockExplicit=false;advanceClock();}
        return;
    }
    if(!videoSyncOwned)return;
    const auto mode=asynchronous?effectiveVideoSync:optionText(mpv.read("video-sync"));
    if(mode==effectiveVideoSync||(videoSyncPending&&mode==previousVideoSync)){
        const bool restored=asynchronous?mpv.setAsync("video-sync",oldVideoSync):mpv.set("video-sync",oldVideoSync);
        if(restored)effectiveVideoSync=oldVideoSync;
    }else effectiveVideoSync=mode;
    if(asynchronous)mpv.setAsync("user-data/tigerest/rife-clock-owned",false);
    else mpv.set("user-data/tigerest/rife-clock-owned",false);
    videoSyncOwned=false;videoSyncPending=false;previousVideoSync.clear();
}
void FrameInterpolationController::stop(){++serial;detach();current=State::Off;reason.clear();source={};latest={};lastFailure.clear();performanceWarning=false;}
void FrameInterpolationController::stopOnEndFile(){
    ++serial;
    closeSession(session);session=0;epoch=0;
    // END_FILE can arrive while macvk's VO thread is synchronously asking the
    // Cocoa main thread to close its window. No mpv property read or blocking
    // command is safe from this event handler until VO teardown finishes.
    if(filterOwned)mpv.commandAsync({"vf","remove","@tigerest-rife"});
    filterOwned=false;
    if(hwdecOwned)mpv.setAsync("hwdec",oldHwdec);
    restoreVideoSync(true);
    hwdecOwned=false;guard.reset();displaySyncWatch.reset();preparingSince=-1;
    current=State::Off;reason.clear();source={};latest={};
}
void FrameInterpolationController::beginItem(bool enabled,bool systemConfig){
    stop();++itemSequence;clockTakenOver=false;displaySyncFallback=false;requested=enabled;notified=false;
    if(!enabled)return;
    if(systemConfig){disable("system-config",true);return;}
    if(!paths.available){disable("runtime-missing",true);return;}
    if(conflict()){disable("external-filter",true);return;}
    current=State::Preparing;
    oldHwdec=optionText(mpv.read("hwdec"));
    // Respect deliberate software decoding; otherwise supply CPU-readable frames.
    if(!oldHwdec.isEmpty()&&oldHwdec!="no"&&oldHwdec!="auto-copy"){
        hwdecOwned=mpv.set("hwdec","auto-copy");
        if(!hwdecOwned)disable("decode-error");
    }
}
void FrameInterpolationController::disable(const QString& why,bool bypass){
    ++serial;detach();reason=why;current=bypass?State::Bypassed:State::DisabledForCurrentItem;
    if(!notified){mpv.command({"show-text",message(why,paths.backend),"4000"});notified=true;}
}
void FrameInterpolationController::onFormatChanged(const SourceInfo& info){
    if(current==State::Off||current==State::DisabledForCurrentItem)return;
    if(current==State::Bypassed)return; // re-evaluate only on the next item
    if(filterOwned&&same(info,source))return;
    if(filterOwned&&paths.backend==Backend::TensorRT){disable("dynamic-format",true);return;}
    // A new item must wait for the previous marker/clock transaction to finish.
    if(asynchronousClock()&&!clockWanted&&(clockMarker||clockRequest))return;
    source=info;
    const auto eligibility=qualify(source,paths.backend==Backend::TensorRT?SourceLimits{3840,2160,60.001}:SourceLimits{});
    if(!eligibility.enabled){disable(QString::fromStdString(eligibility.reason),true);return;}
    if(filterOwned){
        ++serial;closeSession(session);session=0;
        mpv.command({"vf","remove","@tigerest-rife"});filterOwned=false;
        guard.reset();displaySyncWatch.reset();epoch=0;latest={};preparingSince=-1;
        current=State::Preparing;
    }
    if(conflict()){disable("external-filter",true);return;}
    if(!asynchronousClock()||!clockWanted)effectiveVideoSync=optionText(mpv.read("video-sync"));
    if(paths.backend==Backend::TensorRT&&paths.engine.isEmpty()){
        reason="engine-preparing";current=State::Preparing;return;
    }
    if(paths.backend==Backend::TensorRT){
        if(!asynchronousClock()||!clockWanted)oldVideoSync=effectiveVideoSync;
        // DWM composition presents unevenly and display-resample drops frames
        // against it, so windowed playback paces by audio. Fullscreen usually
        // flips directly; keeping display-resample there moves comments every
        // refresh, until mistimed frames show DWM composing it (onMetrics).
        if(audioPacing()&&(!asynchronousClock()||(!clockWanted&&!clockTakenOver))&&effectiveVideoSync=="display-resample"&&!applyVideoSync(effectiveVideoSync,true)){
            disable("video-sync-error");return;
        }
        // Keep the coordinator's synchronous attach contract. Clock requests
        // remain serialized; any later failure detaches this graph via disable().
        if(current==State::DisabledForCurrentItem)return;
    }
    reason.clear();
    session=openSession();
    QJsonObject options{{"model_path",paths.model},{"plugin_path",paths.plugin},
        {"fps_num",double(source.fpsNum)},{"fps_den",double(source.fpsDen)},
        {"pipeline",paths.pipeline},{"compute_policy",paths.compute},
        {"generation",double(serial)},{"session",double(session)},{"streaming",true}};
    if(paths.backend==Backend::TensorRT){
        options.insert("engine_path",paths.engine);options.insert("runtime_path",paths.runtime);
        options.insert("trt_plugin_path",paths.trtPlugin);options.insert("factor",paths.factor);
        options.insert("alignment",paths.alignment);options.insert("implementation",paths.implementation);
        options.insert("num_streams",paths.numStreams);options.insert("device_id",paths.deviceId);
    }
    const QString filter="@tigerest-rife:vapoursynth=file="+quote(paths.script)+
        ":buffered-frames=4:concurrent-frames=2:eof-aware=yes:user-data="+
        quote(QString::fromUtf8(QJsonDocument(options).toJson(QJsonDocument::Compact)));
    filterOwned=mpv.command({"vf","add",filter});
    if(!filterOwned)disable("filter-error");
}
void FrameInterpolationController::onSeek(){
    ++serial;guard.reset();displaySyncWatch.reset();preparingSince=-1;latest={};
    if(filterOwned){current=State::Preparing;}
    // mpv rebuilds its VS graph on seek. A new monitor instance rotates the
    // native epoch and rejects any callback belonging to the previous graph.
    // The graph may already have rebuilt before the client receives SEEK, so
    // do not wait for another epoch relative to this event.
}
void FrameInterpolationController::bypassCurrentItem(const QString& why){
    if(requested&&current!=State::Off&&current!=State::DisabledForCurrentItem&&reason!=why)disable(why,true);
}
void FrameInterpolationController::onPlaybackSpeed(double speed){
    if(!std::isfinite(speed)||std::abs(speed-1.)>1e-6)bypassCurrentItem("playback-speed");
}
void FrameInterpolationController::poll(int64_t now,bool suspended){
    if(!filterOwned)return;
    if(conflict()){disable("external-filter",true);return;}
    if(!hasFilter()){disable("filter-error");return;}
    const auto voDrops=mpv.read("frame-drop-count").toULongLong(),decoderDrops=mpv.read("decoder-frame-drop-count").toULongLong();
    const auto av=mpv.read("avsync");
    onMetrics(serial,readMetrics(session),now,suspended,paths.backend==Backend::TensorRT?voDrops:voDrops+decoderDrops,
              av.isValid()?av.toDouble():std::numeric_limits<double>::quiet_NaN(),decoderDrops,
              mpv.read("mistimed-frame-count").toULongLong());
}
void FrameInterpolationController::onMetrics(uint64_t generation,const Metrics&m,int64_t now,bool suspended,uint64_t drops,
                                             double avsync,uint64_t decoderDrops,uint64_t mistimed){
    if(generation!=serial||!filterOwned)return;
    if(m.epoch!=epoch){epoch=m.epoch;guard.reset();displaySyncWatch.reset();preparingSince=-1;}
    latest=m;
    if(!m.error.empty()){
        const auto why=QString::fromStdString(m.error);
        disable(why,QStringList{"hdr","unknown-color","interlaced","vfr","unsupported-size"}.contains(why));return;
    }
    if(m.pairs)current=State::Active; // includes prepared cut/EOF duplicates
    if(suspended)preparingSince=-1;
    else if(preparingSince<0)preparingSince=now;
    else if(!m.epoch&&now-preparingSince>15000){disable("filter-error");return;}
    // DWM sometimes composes fullscreen video. display-resample then misjudges
    // the refresh interval and mistimes frames until composition ends.
    if(suspended||!watchesDisplaySync())displaySyncWatch.reset();
    else if(displaySyncWatch.update(now,mistimed)){fallBackToAudio();return;}
    const auto display=mpv.read("display-fps");
    const double displayFps=display.isValid()?display.toDouble():std::numeric_limits<double>::quiet_NaN();
    if(!performanceWarning&&guard.update(now,m.predictions,m.pairs,m.p95Ms,drops,double(source.fpsNum)/source.fpsDen,suspended,
                    paths.factor,m.timingAvailable,avsync,decoderDrops,displayFps)){
        // Fullscreen display-resample tries audio pacing before any warning.
        if(watchesDisplaySync()){fallBackToAudio();return;}
        lastFailure={{"voDrops",qulonglong(drops)},{"decoderDrops",qulonglong(decoderDrops)},
            {"avsyncSeconds",std::isfinite(avsync)?QVariant(avsync):QVariant()},
            {"displayFps",std::isfinite(displayFps)?QVariant(displayFps):QVariant()},
            {"processedPairs",qulonglong(m.pairs)},{"factor",paths.factor},{"model",paths.model},
            {"sourceFps",double(source.fpsNum)/source.fpsDen}};
        // A presentation drop is not proof that inference is too slow. Keep the
        // selected graph and frame rate; the user decides whether to reduce load.
        performanceWarning=true;
        qWarning().noquote()<<"RIFE playback warning (interpolation retained):"<<QString::fromUtf8(QJsonDocument::fromVariant(lastFailure).toJson(QJsonDocument::Compact));
        mpv.command({"show-text",QStringLiteral("检测到持续丢帧或音画偏差，按 Ctrl+J 查看详细信息，并考虑降低性能开销"),"7000"});
    }
}
QString FrameInterpolationController::status()const{
    if(current==State::Off)return QStringLiteral("AI 补帧已关闭");
    if(current==State::Preparing)return QStringLiteral("正在准备 AI 补帧");
    if(current==State::Active){const double fps=double(source.fpsNum)/source.fpsDen;return QStringLiteral("补帧中：%1→%2 fps").arg(fps,0,'g',6).arg(fps*paths.factor,0,'g',6);}
    return message(reason,paths.backend);
}
QVariantMap FrameInterpolationController::diagnostics()const{
    // The TRT plugin does not expose GPU inference timing. Core ML samples
    // become available only after the monitor's 30-prediction warmup.
    const bool timingAvailable=paths.backend==Backend::CoreMLMetal&&latest.epoch!=0&&
                               latest.predictions>30&&latest.timingAvailable;
    return {
    {"requestedForItem",requested},{"runtimeAvailable",paths.available},{"state",int(current)},{"status",status()},{"reason",reason},
    {"effectiveSync",effectiveVideoSync},{"savedSync",oldVideoSync},{"ownsVideoSync",videoSyncOwned},{"fullScreen",fullScreen},
    {"displaySyncFallback",displaySyncFallback},
    {"clockRequest",clockRequest},{"clockMarkerOwned",clockMarker},{"clockCleanupFailed",clockCleanupFailed},
    {"generation",qulonglong(serial)},{"epoch",qulonglong(latest.epoch)},
    {"generatedFrames",qulonglong(latest.predictions)},{"cutBypasses",qulonglong(latest.cuts)},
    {"processedPairs",qulonglong(latest.pairs)},
    {"timingAvailable",timingAvailable},
    {"p95Ms",timingAvailable?QVariant(latest.p95Ms):QVariant()},
    {"factor",paths.factor},{"model",paths.model},
    {"performanceWarning",performanceWarning},{"warningMetrics",lastFailure},
    {"pipeline",paths.backend==Backend::TensorRT?QStringLiteral("TensorRT"):QStringLiteral("Core ML + Metal (split)")}};}
SourceInfo sourceInfo(const QVariantMap& p,const QVariantMap& frame,double fps){
    const auto rate=rationalFrameRate(fps);
    const QString transfer=p.value("gamma").toString(),primaries=p.value("primaries").toString(),matrix=p.value("colormatrix").toString(),range=p.value("colorlevels").toString();
    const bool hdr=transfer=="pq"||transfer=="hlg"||p.value("dolby-vision").toBool();
    const bool known=QStringList{"bt.1886","srgb","gamma2.2","gamma2.8"}.contains(transfer)&&
        QStringList{"bt.709","bt.601-525","bt.601-625"}.contains(primaries)&&
        QStringList{"bt.709","bt.601","rgb"}.contains(matrix)&&QStringList{"full","limited"}.contains(range);
    return {p.value("w").toInt(),p.value("h").toInt(),rate.num,rate.den,
        frame.contains("interlaced")&&!frame.value("interlaced").toBool(),rate.num>0,hdr,known};
}
RuntimePaths bundledRuntimePaths(){
    const QDir contents(QCoreApplication::applicationDirPath()+"/..");
    RuntimePaths paths{contents.filePath("Resources/rife/model"),contents.filePath("Frameworks/tigerest-rife-vs.dylib"),contents.filePath("Resources/rife/interpolate.vpy"),false};
#if defined(__aarch64__)
    paths.available=QFileInfo::exists(paths.model+"/manifest.json")&&QFileInfo::exists(paths.plugin)&&QFileInfo::exists(paths.script);
    const QString runtime=qEnvironmentVariable("VSSCRIPT_PATH");
    paths.available=paths.available&&!runtime.isEmpty()&&
        QFileInfo(runtime).canonicalFilePath().startsWith(contents.canonicalPath()+"/Resources/python/");
#endif
    return paths;
}
}
