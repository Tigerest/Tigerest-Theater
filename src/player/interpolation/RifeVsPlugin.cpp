#include <VapourSynth4.h>
#include "RifeEngine.h"
#include "FrameTiming.h"
#include "RifeVsMonitor.h"
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <numeric>
#include <string>

namespace {
struct Data {
    VSNode* input = nullptr;
    VSVideoInfo info{};
    rife::EngineConfig config;
    rife::Rational fps{};
    rife::CfrTimingTracker timing{{0,1}};
    uint64_t generation = 0;
    bool streaming = false;
    int contentWidth=0,contentHeight=0;
    std::string disabled;
    std::unique_ptr<rife::RifeEngine> engine;
};

int64_t integer(const VSAPI* api, const VSMap* props, const char* key, int64_t fallback = -1) {
    int error = 0;
    const auto value = api->mapGetInt(props,key,0,&error);
    return error ? fallback : value;
}

std::string eligibility(const VSFrame* frame, int index, Data* d, const VSAPI* api) {
    const VSMap* props = api->getFramePropertiesRO(frame);
    if(integer(api,props,"_TigerestColorKnown",1)==0)return "unknown-color";
    const auto transfer = integer(api,props,"_Transfer");
    const auto primaries = integer(api,props,"_Primaries");
    auto range=integer(api,props,"_Range");
    if(range<0) {
        const auto legacy=integer(api,props,"_ColorRange");
        if(legacy==0 || legacy==1)range=1-legacy;
    }
    if (transfer == 16 || transfer == 18) return "hdr";
    if ((transfer != 1 && transfer != 6 && transfer != 13) ||
        (primaries != 1 && primaries != 5 && primaries != 6) ||
        integer(api,props,"_Matrix") != 0 || range != 1)
        return "unknown-color";
    if (integer(api,props,"_FieldBased") != 0) return "interlaced";
    if (!d->timing.accept(index,{integer(api,props,"_DurationNum"),integer(api,props,"_DurationDen")}))
        return "vfr";
    if (d->streaming && integer(api,props,"_TigerestLastFrame") < 0) return "missing-eof-bridge";
    return {};
}

rife::FrameView view(const VSFrame* frame, const VSAPI* api) {
    rife::FrameView out{{},{},api->getFrameWidth(frame,0),api->getFrameHeight(frame,0)};
    for (int c=0;c<3;++c) {
        out.planes[c]=reinterpret_cast<const float*>(api->getReadPtr(frame,c));
        out.strides[c]=api->getStride(frame,c);
    }
    return out;
}

bool sceneCut(const rife::FrameView& a, const rife::FrameView& b, int width, int height) {
    double difference = 0;
    int count = 0;
    for (int y=0;y<height;y+=std::max(1,height/32))
        for (int x=0;x<width;x+=std::max(1,width/48)) {
            double delta = 0;
            for (int c=0;c<3;++c) {
                const auto* ar=reinterpret_cast<const float*>(reinterpret_cast<const char*>(a.planes[c])+y*a.strides[c]);
                const auto* br=reinterpret_cast<const float*>(reinterpret_cast<const char*>(b.planes[c])+y*b.strides[c]);
                delta += std::abs(ar[x]-br[x]);
            }
            difference += delta/3; ++count;
        }
    return difference/count > .25;
}

VSFrame* outputFrame(const VSFrame* first, const rife::FrameBuffer* generated,
                     const std::string& reason, Data* d, VSCore* core, const VSAPI* api) {
    const VSMap* sourceProps=api->getFramePropertiesRO(first);
    int64_t num=d->fps.den, den=d->fps.num;
    // Preserve observed timing while bypassing unsupported input. Qualified
    // CFR uses its rational rate instead of mpv's rounded microseconds.
    if (!reason.empty() && reason!="cut" && reason!="eof") {
        num=integer(api,sourceProps,"_DurationNum",num); den=integer(api,sourceProps,"_DurationDen",den);
        if (num<=0 || den<=0) {num=d->fps.den;den=d->fps.num;}
    }
    auto duration=rife::splitDuration(num,den).first;
    VSFrame* out = generated ? api->newVideoFrame(&d->info.format,d->info.width,d->info.height,first,core)
                            : api->copyFrame(first,core);
    if (!out) throw std::runtime_error("Cannot allocate RIFE output frame");
    if (generated) for (int c=0;c<3;++c) for (int y=0;y<generated->height;++y)
        memcpy(api->getWritePtr(out,c)+y*api->getStride(out,c),
               generated->pixels.data()+(size_t(c)*generated->height+y)*generated->width,
               size_t(generated->width)*sizeof(float));
    VSMap* props=api->getFramePropertiesRW(out);
    api->mapSetInt(props,"_DurationNum",duration.num,maReplace);
    api->mapSetInt(props,"_DurationDen",duration.den,maReplace);
    api->mapSetInt(props,"_TigerestRifeSynthesized",generated?1:0,maReplace);
    api->mapSetFloat(props,"_TigerestRifeTimeMs",generated?generated->inferenceMs:0,maReplace);
    api->mapSetData(props,"_TigerestRifeReason",reason.c_str(),int(reason.size()),dtUtf8,maReplace);
    return out;
}

const VSFrame* VS_CC getFrame(int n, int activation, void* instance, void** state,
                             VSFrameContext* context, VSCore* core, const VSAPI* api) {
    auto* d=static_cast<Data*>(instance);
    const int firstIndex=n/2;
    if (activation==arInitial) { api->requestFrameFilter(firstIndex,d->input,context); return nullptr; }
    if (activation!=arAllFramesReady) return nullptr;
    auto release=[api](const VSFrame* f) {if(f)api->freeFrame(f);};
    std::unique_ptr<const VSFrame,decltype(release)> first(api->getFrameFilter(firstIndex,d->input,context),release);
    if (!first) { api->setFilterError("Missing RIFE source frame",context);return nullptr; }
    try {
        if (d->disabled.empty()) d->disabled=eligibility(first.get(),firstIndex,d,api);
        if (!(n%2) || !d->disabled.empty()) return outputFrame(first.get(),nullptr,d->disabled,d,core,api);
        const bool last = d->streaming ? integer(api,api->getFramePropertiesRO(first.get()),"_TigerestLastFrame")==1
                                       : firstIndex==d->info.numFrames/2-1;
        if (last) return outputFrame(first.get(),nullptr,"eof",d,core,api);
        // First establish that this is not the final frame. Only then request
        // its neighbour; the EOF-aware mpv bridge makes this possible for streams.
        if (!*state) {
            *state=reinterpret_cast<void*>(1);
            api->requestFrameFilter(firstIndex+1,d->input,context); return nullptr;
        }
        std::unique_ptr<const VSFrame,decltype(release)> second(api->getFrameFilter(firstIndex+1,d->input,context),release);
        if (!second) throw std::runtime_error("Missing next RIFE frame");
        d->disabled=eligibility(second.get(),firstIndex+1,d,api);
        if (!d->disabled.empty()) return outputFrame(first.get(),nullptr,d->disabled,d,core,api);
        auto a=view(first.get(),api), b=view(second.get(),api);
        a.identity={d->generation,firstIndex};b.identity={d->generation,firstIndex+1};
        const bool cut=sceneCut(a,b,d->contentWidth,d->contentHeight);
        // Warm once even when the opening pair is a cut. Paused prefetch must
        // be able to finish preparation, but must never display the blend.
        if (cut) {
            if (!d->engine) {
                d->engine=rife::RifeEngine::create(d->config);
                d->engine->interpolate(a,b,.5f);
            }
            return outputFrame(first.get(),nullptr,"cut",d,core,api);
        }
        if (!d->engine) d->engine=rife::RifeEngine::create(d->config);
        auto generated=d->engine->interpolate(a,b,.5f);
        return outputFrame(first.get(),&generated,{},d,core,api);
    } catch (const std::exception&) {
        d->disabled="inference-error";
        // Keep original content/timing available until the controller removes
        // its filter; never turn an inference failure into a playback failure.
        try { return outputFrame(first.get(),nullptr,d->disabled,d,core,api); }
        catch (...) {api->setFilterError("Cannot allocate fallback RIFE frame",context);return nullptr;}
    }
}

void VS_CC freeFilter(void* instance, VSCore*, const VSAPI* api) {
    auto* d=static_cast<Data*>(instance);api->freeNode(d->input);delete d;
}

void VS_CC create(const VSMap* in, VSMap* out, void*, VSCore* core, const VSAPI* api) {
    auto d=std::make_unique<Data>();
    try {
        d->input=api->mapGetNode(in,"clip",0,nullptr);
        if (!d->input) throw std::runtime_error("RIFE requires a clip");
        d->info=*api->getVideoInfo(d->input);
        if (d->info.format.colorFamily!=cfRGB || d->info.format.sampleType!=stFloat ||
            d->info.format.bitsPerSample!=32 || d->info.width<2 || d->info.height<2 ||
            d->info.numFrames<1 || d->info.numFrames>std::numeric_limits<int>::max()/2)
            throw std::runtime_error("RIFE requires constant-size planar RGB float32");
        const auto width=integer(api,in,"content_width",d->info.width);
        const auto height=integer(api,in,"content_height",d->info.height);
        if(width<2||height<2||width>d->info.width||height>d->info.height)
            throw std::runtime_error("Invalid RIFE content rectangle");
        d->contentWidth=int(width);d->contentHeight=int(height);
        d->fps={integer(api,in,"fps_num"),integer(api,in,"fps_den")};
        if (d->fps.num<=0 || d->fps.den<=0 || d->fps.num>1000000 || d->fps.den>1000000 ||
            double(d->fps.num)/d->fps.den>30.001) throw std::runtime_error("Unsupported RIFE frame rate");
        d->timing=rife::CfrTimingTracker(d->fps);
        int error=0;
        const char* path=api->mapGetData(in,"model_path",0,&error);
        if (error || !path) throw std::runtime_error("Missing RIFE model path");
        d->config={path,rife::ComputePolicy::CPUAndGPU,d->info.width,d->info.height};
        const char* compute=api->mapGetData(in,"compute_policy",0,&error);
        if (!error && compute) {
            std::string policy=compute;
            if (policy=="all") d->config.computePolicy=rife::ComputePolicy::All;
            else if (policy=="cpu-ane") d->config.computePolicy=rife::ComputePolicy::CPUAndNeuralEngine;
            else if (policy!="cpu-gpu") throw std::runtime_error("Unknown RIFE compute policy");
        }
        const char* pipeline=api->mapGetData(in,"pipeline",0,&error);
        if (!error && pipeline) {
            std::string name=pipeline;
            if(name=="split-metal")d->config.pipeline=rife::Pipeline::SplitEncoderRefineMetal;
            else if(name=="split-coarse-metal")d->config.pipeline=rife::Pipeline::SplitCoarseMetal;
            else if(name=="split")d->config.pipeline=rife::Pipeline::SplitEncoderRefine;
            else if(name!="monolithic")throw std::runtime_error("Unknown RIFE pipeline");
        }
        d->generation=uint64_t(integer(api,in,"generation",0));
        d->streaming=integer(api,in,"streaming",0)!=0;
        // VapourSynth rejects an unreduced rate. Doubling an even denominator,
        // e.g. 59997/2500 from container-fps 23.9988, would otherwise fail.
        const int64_t outputNum=d->fps.num*2,outputDen=d->fps.den,divisor=std::gcd(outputNum,outputDen);
        d->info.numFrames*=2; d->info.fpsNum=outputNum/divisor; d->info.fpsDen=outputDen/divisor;
        VSFilterDependency dependency{d->input,rpGeneral};
        // The streaming bridge and reused Core ML buffers retain state for one
        // frame request, including its second activation after lookahead.
        api->createVideoFilter(out,"TigerestRIFE",&d->info,getFrame,freeFilter,fmFrameState,&dependency,1,d.get(),core);
        // A rejected filter never calls freeFilter. Keeping its input alive
        // pins mpv's Input node, and mpv asserts when it tears the script down.
        if (api->mapGetError(out)) {api->freeNode(d->input);return;}
        d.release();
    } catch (const std::exception& e) {
        if (d->input) api->freeNode(d->input);
        api->mapSetError(out,e.what());
    }
}

} // namespace

VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin* plugin,const VSPLUGINAPI* api) {
    api->configPlugin("io.github.tigerest.rife","tigerest","Tigerest RIFE",VS_MAKE_VERSION(1,0),VAPOURSYNTH_API_VERSION,0,plugin);
    api->registerFunction("RIFE","clip:vnode;model_path:data;fps_num:int;fps_den:int;compute_policy:data:opt;pipeline:data:opt;generation:int:opt;streaming:int:opt;content_width:int:opt;content_height:int:opt;",
                          "clip:vnode;",create,nullptr,plugin);
    rife::registerMonitor(plugin,api);
}
