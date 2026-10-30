#ifdef NDEBUG
#undef NDEBUG
#endif
#include "FrameInterpolationController.h"
#include <QCoreApplication>
#include <QJsonDocument>
#include <cassert>
#include <cmath>
using namespace rife;
int main(int argc,char**argv){
    QCoreApplication app(argc,argv);
    const SourceLimits windows{3840,2160,60.001};
    SourceInfo source{3840,2160,60000,1001,true,true,false,true};
    assert(qualify(source,windows).enabled);
    assert(!qualify(source).enabled); // Mac's original limits still apply.
    auto bad=source;bad.width=4096;assert(!qualify(bad,windows).enabled);
    bad=source;bad.fpsNum=120000;assert(!qualify(bad,windows).enabled);
    assert(rationalFrameRate(59.94005994).num==60000);
    assert(interpolationMultiplier({24000,1001},120)==5);
    assert(interpolationMultiplier({24000,1001},240)==10);
    assert(interpolationMultiplier({30,1},240)==8);
    assert(interpolationMultiplier({60000,1001},120)==2);
    assert(interpolationMultiplier({24,1},60)==2.5);
    assert(interpolationMultiplier({24000,1001},60)==2.5); // NTSC follows the same nominal preset.
    assert(interpolationMultiplier({24,1},36)==1.5);
    assert(interpolationMultiplier({24,1},84)==3.5);
    assert(interpolationMultiplier({24,1},54)==2.); // Half-step midpoint ties choose the lower step.
    assert(interpolationMultiplier({24000,1001},54)==2.);
    assert(interpolationMultiplier({24,1},55)==2.5);
    assert(interpolationMultiplier({24,1},24)==1.5);
    assert(interpolationMultiplier({24,1},1000)==15.);
    assert(interpolationMultiplier({0,1},240)==0);
    assert(interpolationMultiplier({24,1},0)==0);
    assert(interpolationMultiplier({24,0},60)==0);
    assert(interpolationMultiplier({-24,1},60)==0);
    PerformanceGuard guard(GuardParameters::windows());
    assert(!guard.update(0,90,10,0,0,24,false,10,false,0.));
    assert(!guard.update(5000,1170,130,0,0,24,false,10,false,0.));
    assert(!guard.update(14999,3330,370,0,130,24,false,10,false,0.));
    assert(guard.update(15000,3330,370,0,130,24,false,10,false,0.)); // 130/2400 > 5%.
    guard.reset();
    assert(!guard.update(0,90,10,0,0,24,false,10,false,0.));
    assert(!guard.update(5000,1170,130,0,0,24,false,10,false,.12));
    for(int now=5250;now<15000;now+=250)assert(!guard.update(now,3330,370,0,0,24,false,10,false,.12));
    assert(guard.update(15000,3330,370,0,0,24,false,10,false,.12));
    guard.reset();
    assert(!guard.update(0,90,10,0,0,24,false,10,false,.12));
    assert(!guard.update(5000,1170,130,0,0,24,false,10,false,.12));
    assert(!guard.update(10000,2250,250,0,0,24,true,10,false,.12));
    assert(!guard.update(15000,3330,370,0,0,24,false,10,false,.12));
    assert(!guard.update(20000,4410,490,0,0,24,false,10,false,0.));
    assert(!guard.update(30000,6570,730,0,0,24,false,10,false,0.));
    for(const auto& counts: {std::pair<uint64_t,uint64_t>{0,12},{0,13},{8,12},{120,0},{121,0}}){
        guard.reset();
        assert(!guard.update(0,90,10,0,0,24,false,10,false,0.,0));
        assert(!guard.update(5000,1170,130,0,0,24,false,10,false,0.,0));
        const bool shouldDisable=(double(counts.first)+double(counts.second)*10)/(2400+double(counts.second)*10)>.05;
        assert(guard.update(15000,3330,370,0,counts.first,24,false,10,false,0.,counts.second)==shouldDisable);
    }
    // Exact half-step output opportunities keep the five-percent threshold
    // consistent for the smallest factor and for fractional decoder losses.
    for(double factor:{1.5,2.5,3.5}){
        guard.reset();
        assert(!guard.update(0,0,10,0,0,24,false,factor,false,0.));
        assert(!guard.update(5000,0,130,0,0,24,false,factor,false,0.));
        assert(!guard.update(15000,0,370,0,uint64_t(12*factor),24,false,factor,false,0.));
        assert(guard.update(25000,0,610,0,uint64_t(24*factor)+1,24,false,factor,false,0.));
        guard.reset();
        assert(!guard.update(0,0,10,0,0,24,false,factor,false,0.,0));
        assert(!guard.update(5000,0,130,0,0,24,false,factor,false,0.,0));
        assert(guard.update(15000,0,370,0,0,24,false,factor,false,0.,13));
    }
    for(double invalid:{0.,1.,1.25,2.25,15.5,double(NAN),double(INFINITY)}){
        guard.reset();
        assert(!guard.update(0,0,10,0,0,24,false,2.5,false,0.));
        assert(!guard.update(5000,0,130,0,0,24,false,2.5,false,0.));
        assert(!guard.update(15000,0,370,0,300,24,false,invalid,false,0.));
        assert(!guard.update(25000,0,610,0,600,24,false,2.5,false,0.)); // Invalid factor resets the window.
    }
    QVariantMap properties{{"vf",QVariantList{}},{"hwdec","auto"}};
    QString lastFilter;
    int adds=0;
    auto command=[&](const QStringList& args){
        if(args[0]=="vf"&&args[1]=="add"){
            ++adds;lastFilter=args[2];
            properties["vf"]=QVariantList{QVariantMap{{"label","tigerest-rife"},{"name","vapoursynth"}}};
        }else if(args[0]=="vf"&&args[1]=="remove")properties["vf"]=QVariantList{};
        return true;
    };
    MpvAccess access{[&](const QString&k){return properties.value(k);},
        [&](const QString&k,const QVariant&v){properties[k]=v;return true;},command,
        [&](const QString&k,const QVariant&v){properties[k]=v;return true;},command};
    RuntimePaths paths{"rife-4.25-lite","C:/插件/tigerest-rife-vs.dll","C:/脚本/interpolate_trt.vpy",true};
    paths.backend=Backend::TensorRT;paths.factor=2.5;paths.alignment=1;paths.implementation=2;
    paths.engine="C:/缓存/model.engine";paths.runtime="C:/私有 运行库";paths.trtPlugin="C:/私有 运行库/plugins/vstrt.dll";
    FrameInterpolationController controller(access,paths);
    for(double invalid:{0.,1.,1.25,2.25,15.5,double(NAN),double(INFINITY)}){
        auto invalidPaths=paths;invalidPaths.factor=invalid;
        assert(!controller.setRuntimePaths(invalidPaths));
    }
    for(double factor:{1.5,2.5,3.5,15.}){
        auto validPaths=paths;validPaths.factor=factor;
        assert(controller.setRuntimePaths(validPaths));
    }
    assert(controller.setRuntimePaths(paths));
    controller.beginItem(true,false);controller.onFormatChanged(source);
    assert(!controller.diagnostics()["p95Ms"].isValid()); // No epoch is not zero-cost GPU timing.
    Metrics starting;starting.epoch=1; // Monitor is registered, but no frame has arrived.
    controller.onMetrics(controller.generation(),starting,0,false,0);
    assert(!controller.diagnostics()["timingAvailable"].toBool());
    assert(!controller.diagnostics()["p95Ms"].isValid());
    assert(adds==1&&lastFilter.contains("engine_path")&&lastFilter.contains("runtime_path"));
    const auto options=QJsonDocument::fromJson(lastFilter.mid(lastFilter.indexOf('{')).toUtf8()).toVariant().toMap();
    assert(options["factor"].toDouble()==2.5); // JSON forwards the full factor into the real graph.
    assert(!controller.setRuntimePaths(paths)); // Loaded graph owns its current runtime.
    Metrics metrics;metrics.epoch=1;metrics.pairs=40;metrics.predictions=40;metrics.timingAvailable=false;
    controller.onMetrics(controller.generation(),metrics,0,false,0);
    assert(controller.state()==State::Active);
    assert(controller.status().contains("149.85"));
    const auto diagnostic=controller.diagnostics();
    assert(!diagnostic["timingAvailable"].toBool());
    assert(!diagnostic["p95Ms"].isValid());
    assert(diagnostic["pipeline"].toString()=="TensorRT");
    assert(diagnostic["factor"].toDouble()==2.5);
    bad=source;bad.width=1920;bad.height=1080;
    controller.onFormatChanged(bad);
    assert(controller.state()==State::Bypassed&&adds==1); // Do not rebuild a changing-format item.
    controller.stop();paths.engine.clear();assert(controller.setRuntimePaths(paths));
    controller.beginItem(true,false);controller.onFormatChanged(source);
    assert(adds==1&&controller.diagnostics()["reason"]=="engine-preparing");
    controller.stop();paths.engine="C:/缓存/model.engine";assert(controller.setRuntimePaths(paths));
    controller.beginItem(true,false);controller.onPlaybackSpeed(2.);controller.onFormatChanged(source);
    assert(adds==1&&controller.diagnostics()["reason"]=="playback-speed");
    controller.onPlaybackSpeed(1.);controller.onFormatChanged(source);assert(adds==1);
    controller.beginItem(true,false);controller.onPlaybackSpeed(1.);controller.onFormatChanged(source);assert(adds==2);
    controller.onPlaybackSpeed(1.25);assert(properties["vf"].toList().isEmpty());assert(properties["hwdec"]=="auto");

    // 60 fps output on a 30 Hz screen intentionally discards every other
    // frame. The display cadence alone must not disable an otherwise fast graph.
    properties["display-fps"]=30.;paths.factor=2;
    FrameInterpolationController cadence(access,paths);
    cadence.beginItem(true,false);cadence.onFormatChanged({1920,1080,30,1,true,true,false,true});
    metrics.epoch=80;metrics.pairs=metrics.predictions=30;
    cadence.onMetrics(cadence.generation(),metrics,0,false,0,0.);
    metrics.pairs=metrics.predictions=180;
    cadence.onMetrics(cadence.generation(),metrics,5000,false,150,0.);
    metrics.pairs=metrics.predictions=480;
    cadence.onMetrics(cadence.generation(),metrics,15000,false,450,0.);
    assert(cadence.state()==State::Active);
    // Real losses warn, but never tear down the user's interpolation graph.
    metrics.pairs=metrics.predictions=780;
    cadence.onMetrics(cadence.generation(),metrics,25000,false,810,0.);
    assert(cadence.state()==State::Active&&cadence.ownsFilter());
    assert(cadence.diagnostics()["performanceWarning"].toBool());
    assert(cadence.diagnostics()["warningMetrics"].toMap()["voDrops"].toULongLong()==810);
    cadence.stop();

    // Do not apply a new refresh rate to drops collected at the old rate.
    for (const auto& rates : {std::pair<double,double>{30.,60.},{60.,30.}}) {
        guard.reset();
        const uint64_t oldDrops=rates.first==30.?150:0;
        const uint64_t windowDrops=rates.first==30.?300:0;
        assert(!guard.update(0,30,30,0,0,30,false,2,false,0.,0,rates.first));
        assert(!guard.update(5000,180,180,0,oldDrops,30,false,2,false,0.,0,rates.first));
        assert(!guard.update(15000,480,480,0,oldDrops+windowDrops,30,false,2,false,0.,0,rates.second));
        const uint64_t expected=rates.second==30.?300:0;
        assert(!guard.update(25000,780,780,0,oldDrops+windowDrops+expected,30,false,2,false,0.,0,rates.second));
        // Overload remains visible after the refresh transition.
        assert(guard.update(35000,1080,1080,0,oldDrops+windowDrops+2*expected+60,30,false,2,false,0.,0,rates.second));
    }
    // Windowed TensorRT playback (the default presentation) temporarily uses audio
    // for the default resampling clock, and restores the preference when detached.
    properties["vf"]=QVariantList{};properties["video-sync"]="display-resample";
    FrameInterpolationController sync(access,paths);
    sync.beginItem(true,false);sync.onFormatChanged(source);
    assert(properties["video-sync"]=="audio");
    assert(sync.diagnostics()["ownsVideoSync"].toBool());
    assert(sync.diagnostics()["savedSync"]=="display-resample");
    sync.onVideoSyncChanged("display-resample"); // Queued before the policy write.
    assert(sync.diagnostics()["ownsVideoSync"].toBool());
    assert(sync.diagnostics()["effectiveSync"]=="audio");
    sync.onVideoSyncChanged("audio");
    sync.onSeek();assert(properties["video-sync"]=="audio");
    sync.configureVideoSync("display-resample");
    sync.configureVideoSync("display-resample"); // Routine settings refresh must not save the override.
    assert(properties["video-sync"]=="audio");
    assert(sync.diagnostics()["savedSync"]=="display-resample");
    sync.stop();assert(properties["video-sync"]=="display-resample");
    sync.beginItem(true,false);sync.onFormatChanged(source);
    assert(properties["video-sync"]=="audio");
    sync.configureVideoSync("display-resample-vdrop");
    assert(properties["video-sync"]=="display-resample-vdrop");
    assert(sync.diagnostics()["savedSync"]=="display-resample-vdrop");
    assert(!sync.diagnostics()["ownsVideoSync"].toBool());
    sync.stopOnEndFile();assert(properties["video-sync"]=="display-resample-vdrop");
    sync.configureVideoSync("display-resample");
    sync.beginItem(true,false);sync.onFormatChanged(source);
    sync.configureVideoSync("audio"); // Explicitly selecting the current effective mode releases ownership.
    assert(!sync.diagnostics()["ownsVideoSync"].toBool());
    sync.stopOnEndFile();assert(properties["video-sync"]=="audio");
    sync.configureVideoSync("display-resample");
    sync.beginItem(true,false);sync.onFormatChanged(source);assert(properties["video-sync"]=="audio");
    sync.onPlaybackSpeed(2.);assert(properties["video-sync"]=="display-resample");
    sync.beginItem(true,false);sync.onFormatChanged(source);assert(properties["video-sync"]=="audio");
    Metrics failed;failed.error="filter-error";
    sync.onMetrics(sync.generation(),failed,0,false,0);
    assert(properties["video-sync"]=="display-resample");
    sync.beginItem(true,false);sync.onFormatChanged(source);assert(properties["video-sync"]=="audio");
    sync.beginItem(false,false);sync.onFormatChanged(source);
    assert(properties["video-sync"]=="display-resample");
    sync.beginItem(true,true);sync.onFormatChanged(source);
    assert(properties["video-sync"]=="display-resample");
    sync.beginItem(true,false);auto syncHdr=source;syncHdr.hdr=true;sync.onFormatChanged(syncHdr);
    assert(properties["video-sync"]=="display-resample");
    auto coldPaths=paths;coldPaths.engine.clear();
    sync.stop();assert(sync.setRuntimePaths(coldPaths));sync.beginItem(true,false);sync.onFormatChanged(source);
    assert(properties["video-sync"]=="display-resample"&&sync.state()==State::Preparing);
    sync.stop();assert(properties["video-sync"]=="display-resample");
    assert(sync.setRuntimePaths(paths));
    for(const auto& mode:{"audio","display-vdrop","display-resample-vdrop","desync"}){
        properties["video-sync"]=mode;
        sync.beginItem(true,false);sync.onFormatChanged(source);
        assert(properties["video-sync"]==mode&&!sync.diagnostics()["ownsVideoSync"].toBool());
        sync.stop();assert(properties["video-sync"]==mode);
    }
    properties["video-sync"]="display-resample";
    sync.beginItem(true,false);sync.onFormatChanged(source);
    properties["video-sync"]="display-vdrop"; // An external script or user supersedes the override.
    sync.onVideoSyncChanged("display-vdrop");
    assert(!sync.diagnostics()["ownsVideoSync"].toBool());
    sync.onVideoSyncChanged("audio"); // A late own notification cannot reclaim ownership.
    sync.stopOnEndFile();assert(properties["video-sync"]=="display-vdrop");
    properties["video-sync"]="display-resample";
    sync.beginItem(true,false);sync.onFormatChanged(source);
    properties["video-sync"]="display-vdrop"; // Stop rechecks even without a property notification.
    sync.stop();assert(properties["video-sync"]=="display-vdrop");
    properties["video-sync"]="display-resample";
    auto macPaths=paths;macPaths.backend=Backend::CoreMLMetal;
    FrameInterpolationController mac(access,macPaths);
    mac.beginItem(true,false);mac.onFormatChanged({1920,1080,24,1,true,true,false,true});
    assert(properties["video-sync"]=="display-resample");mac.stop();
}
