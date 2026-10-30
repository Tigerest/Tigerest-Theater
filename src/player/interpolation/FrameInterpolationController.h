#pragma once
#include "InterpolationPolicy.h"
#include "RifeSessionMetrics.h"
#include <QVariantMap>
#include <QStringList>
#include <functional>
namespace rife {
enum class State {Off,Preparing,Active,Bypassed,DisabledForCurrentItem};
enum class Backend {CoreMLMetal,TensorRT};
struct RuntimePaths {
    QString model,plugin,script;bool available=false;QString pipeline="split-coarse-metal",compute="cpu-ane";
    Backend backend=Backend::CoreMLMetal;
    QString engine,runtime,trtPlugin;
    double factor=2;
    int alignment=128,implementation=1,numStreams=1,deviceId=0;
};
struct MpvAccess {
    std::function<QVariant(const QString&)> read;
    std::function<bool(const QString&,const QVariant&)> set;
    std::function<bool(const QStringList&)> command;
    std::function<bool(const QString&,const QVariant&)> setAsync;
    std::function<bool(const QStringList&)> commandAsync;
    std::function<bool(const QString&,const QVariant&,int)> setAsyncTagged;
    std::function<bool(const QString&,int)> getAsyncTagged;
    bool asyncPropertyReplies=false;
};
class FrameInterpolationController {
public:
    FrameInterpolationController(MpvAccess access,RuntimePaths paths);
    ~FrameInterpolationController();
    bool setRuntimePaths(RuntimePaths paths);
    void beginItem(bool enabled,bool systemConfig);
    void onFormatChanged(const SourceInfo& source);
    void onSeek();
    void onPlaybackSpeed(double speed);
    void bypassCurrentItem(const QString& reason);
    void stop();
    void stopOnEndFile();
    void configureHardwareDecoding(const QString& mode);
    void configureVideoSync(const QString& mode);
    void onVideoSyncChanged(const QString& mode);
    // Windowed TensorRT playback trades display-resample for audio pacing.
    // Fullscreen does too for the rest of an item once DWM composes it.
    void setFullScreen(bool fullScreen);
    void onClockSetReply(uint64_t requestId,int error);
    void onClockReadReply(uint64_t requestId,int error,const QVariant& value);
    void serviceClock();
    void poll(int64_t nowMs,bool suspended);
    void onMetrics(uint64_t generation,const Metrics& metrics,int64_t nowMs,bool suspended,uint64_t drops,
                   double avsync=std::numeric_limits<double>::quiet_NaN(),uint64_t decoderDrops=0,
                   uint64_t mistimed=0);
    State state()const{return current;}
    uint64_t generation()const{return serial;}
    QString status()const;
    QVariantMap diagnostics()const;
    bool ownsDecoding()const{return hwdecOwned;}
    bool ownsFilter()const{return filterOwned;}
private:
    bool conflict()const;
    bool hasFilter(bool requireEnabled=true)const;
    bool applyVideoSync(const QString& mode,bool interpolating);
    bool audioPacing()const;
    bool watchesDisplaySync()const;
    void fallBackToAudio();
    enum class ClockStep {Idle,Acquire,Read,Write,Restore,Release};
    bool asynchronousClock()const;
    void advanceClock();
    void requestClock(ClockStep step,const QString& value={});
    void failClock();
    void restoreVideoSync(bool asynchronous=false);
    void detach();
    void disable(const QString& reason,bool bypass=false);
    MpvAccess mpv;
    RuntimePaths paths;
    State current=State::Off;
    SourceInfo source;
    uint64_t serial=0,session=0,epoch=0;
    bool requested=false,filterOwned=false,hwdecOwned=false,notified=false;
    bool performanceWarning=false,fullScreen=false,displaySyncFallback=false;
    bool videoSyncOwned=false,videoSyncPending=false;
    QString previousVideoSync;
    ClockStep clockStep=ClockStep::Idle;
    int clockRequest=0,clockSequence=0;
    bool clockWanted=false,clockMarker=false,clockRestore=false,clockExplicit=false,clockReleaseOnly=false;
    bool clockCleanupFailed=false,clockTakenOver=false,clockReleasing=false;
    uint64_t clockItem=0,itemSequence=0,clockIntent=0,clockReleaseIntent=0;
    QString clockWritten,clockWriteValue;
    QString oldHwdec,reason;
    QString oldVideoSync,effectiveVideoSync;
    Metrics latest;
    QVariantMap lastFailure;
    PerformanceGuard guard;
    DisplaySyncWatch displaySyncWatch;
    int64_t preparingSince=-1;
};
SourceInfo sourceInfo(const QVariantMap& params,const QVariantMap& frame,double fps);
RuntimePaths bundledRuntimePaths();
}
