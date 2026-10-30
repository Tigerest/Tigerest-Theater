#pragma once
#include "FrameTiming.h"
#include <string>
#include <limits>
#include <cmath>
namespace rife {
struct SourceInfo {
    int width=0,height=0;
    int64_t fpsNum=0,fpsDen=1;
    bool progressive=false,cfr=false,hdr=false,colorKnown=false;
};
struct Eligibility {bool enabled;std::string reason;};
struct SourceLimits {int width=1920,height=1080;double fps=30.001;};
Eligibility qualify(const SourceInfo& source,SourceLimits limits={});
Rational rationalFrameRate(double fps);
double interpolationMultiplier(Rational source,int targetFps);
inline bool validInterpolationMultiplier(double factor){
    return std::isfinite(factor)&&factor>=1.5&&factor<=15.&&std::floor(factor*2)==factor*2;
}
// Holds the initial audio/video clock while models load. User pause intent is
// independent of the temporary pause used for preparation.
class StartupGate {
public:
    void begin(bool enabled,bool paused,int64_t now) {++serial;pending=enabled;resume=!paused;since=started=now;compiling=false;}
    uint64_t generation()const{return serial;}
    bool waiting()const{return pending;}
    bool waitingToPlay()const{return pending&&resume;}
    bool expired(int64_t now)const{return pending&&!compiling&&now-since>=15000;}
    void setEnginePreparing(bool preparing,int64_t now){
        if(pending&&compiling!=preparing){compiling=preparing;since=now;}
    }
    int64_t elapsed(int64_t now)const{return pending&&now>started?now-started:0;}
    void togglePause(){if(pending)resume=!resume;}
    bool requestPause(bool paused){resume=!paused;return pending||paused;}
    bool finish(){const bool play=pending&&resume;pending=false;compiling=false;return play;}
    void cancel(){++serial;pending=false;resume=false;compiling=false;}
private:
    bool pending=false,resume=false,compiling=false;
    int64_t since=0,started=0;
    uint64_t serial=0;
};
// A TensorRT graph left paused for a few seconds stalls its first frames after
// a resume: video falls 70-150 ms behind and 10-25 frames drop. Holding the
// clock and re-decoding the current position refills the graph first.
class ResumePrime {
public:
    static constexpr int64_t idleMs=5000,timeoutMs=3000;
    // Edges of mpv's pause property. A resume returns true when the caller
    // must pause again, seek to the current position and wait for ready().
    void paused(int64_t now){if(step!=Step::Priming){step=Step::Idle;since=now;}}
    bool resumed(int64_t now,bool eligible){
        const bool prime=step==Step::Idle&&eligible&&since>=0&&now-since>=idleMs;
        step=prime?Step::Priming:Step::Idle;since=-1;started=now;
        return prime;
    }
    // The seek finished or timed out: release the clock once.
    bool ready(int64_t now){if(step!=Step::Priming)return false;step=Step::Releasing;started=now;return true;}
    bool expired(int64_t now)const{return step!=Step::Idle&&now-started>=timeoutMs;}
    bool pending()const{return step!=Step::Idle;}
    bool priming()const{return step==Step::Priming;}
    void cancel(int64_t pausedSince=-1){step=Step::Idle;since=pausedSince;}
private:
    enum class Step {Idle,Priming,Releasing};
    Step step=Step::Idle;
    int64_t since=-1,started=0;
};
// Fullscreen display-resample relies on DWM flipping the video directly. When
// DWM composes it instead, mpv misjudges the refresh interval and mistimes
// frames for as long as composition lasts. A stall mistimes one burst, which
// spans at most two windows; composition mistimes frames in every window.
class DisplaySyncWatch {
public:
    static constexpr int64_t warmupMs=3000,windowMs=2000;
    static constexpr unsigned windows=4;
    void reset(){start=-1;streak=0;warming=true;}
    // True once frames were mistimed in each of the last four windows.
    bool update(int64_t now,uint64_t mistimed){
        if(start<0||now<start||mistimed<first){reset();start=now;first=mistimed;return false;}
        if(now-start<(warming?warmupMs:windowMs))return false;
        if(warming)warming=false;
        else streak=mistimed>first?streak+1:0;
        start=now;first=mistimed;
        return streak>=windows;
    }
private:
    int64_t start=-1;
    uint64_t first=0;
    unsigned streak=0;
    bool warming=true;
};
struct GuardParameters {
    bool windowsBackend=false;
    int64_t warmupMs=5000,windowMs=10000;
    double maxDropRatio=.05,maxAvSyncMs=100.;
    static GuardParameters windows(){GuardParameters p;p.windowsBackend=true;return p;}
};
class PerformanceGuard {
public:
    explicit PerformanceGuard(GuardParameters parameters={}):parameters(parameters){}
    void reset();
    bool update(int64_t nowMs,uint64_t predictions,uint64_t pairs,double p95Ms,
                uint64_t drops,double fps,bool suspended,double factor=2,bool timingAvailable=true,
                double avsync=std::numeric_limits<double>::quiet_NaN(),uint64_t decoderDrops=0,
                double displayFps=std::numeric_limits<double>::quiet_NaN());
private:
    GuardParameters parameters;
    int64_t start=-1;
    int64_t avSince=-1,previousPoll=-1;
    uint64_t firstPairs=0,firstDrops=0,firstDecoderDrops=0;
    double windowDisplayFps=0;
    bool warming=true;
    unsigned slowWindows=0;
};
}
