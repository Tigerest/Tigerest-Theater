#include "RifeVsMonitor.h"
#include "RifeSessionMetrics.h"
#include "InterpolationPolicy.h"
#include <limits>
#include <memory>
#include <stdexcept>

namespace {
int64_t integer(const VSAPI* api,const VSMap* props,const char* name,int64_t fallback) {
    int error=0;const auto value=api->mapGetInt(props,name,0,&error);
    return error?fallback:value;
}
struct Monitor {VSNode* input=nullptr;uint64_t session=0,epoch=0;double factor=2;};
const VSFrame* VS_CC monitorFrame(int n,int activation,void* instance,void**,VSFrameContext* context,VSCore*,const VSAPI* api) {
    auto* monitor=static_cast<Monitor*>(instance);
    if(activation==arInitial)api->requestFrameFilter(n,monitor->input,context);
    if(activation!=arAllFramesReady)return nullptr;
    const VSFrame* frame=api->getFrameFilter(n,monitor->input,context);
    if(!frame)return nullptr;
    const auto* props=api->getFramePropertiesRO(frame);
    int error=0;double ms=api->mapGetFloat(props,"_TigerestRifeTimeMs",0,&error);
    if(error)ms=std::numeric_limits<double>::quiet_NaN();
    const char* reason=api->mapGetData(props,"_TigerestRifeReason",0,&error);
    rife::recordFrame(monitor->session,monitor->epoch,n,
        integer(api,props,"_TigerestRifeSynthesized",0)!=0,ms,error?"":reason,
        monitor->factor,integer(api,props,"_TigerestRifeTimingAvailable",1)!=0);
    return frame;
}
void VS_CC monitorFree(void* instance,VSCore*,const VSAPI* api) {
    auto* monitor=static_cast<Monitor*>(instance);api->freeNode(monitor->input);delete monitor;
}
void VS_CC monitorCreate(const VSMap* in,VSMap* out,void*,VSCore* core,const VSAPI* api) {
    auto monitor=std::make_unique<Monitor>();
    try {
        monitor->input=api->mapGetNode(in,"clip",0,nullptr);
        if(!monitor->input)throw std::runtime_error("Monitor requires a clip");
        const auto factor=integer(api,in,"factor",2);
        const auto denominator=integer(api,in,"factor_den",1);
        if((denominator!=1&&denominator!=2)||!rife::validInterpolationMultiplier(double(factor)/denominator))
            throw std::runtime_error("Monitor factor must be a half step from 1.5 to 15 with denominator 1 or 2");
        monitor->factor=double(factor)/denominator;
        monitor->session=uint64_t(integer(api,in,"session",0));
        monitor->epoch=rife::beginInstance(monitor->session);
        VSFilterDependency dependency{monitor->input,rpGeneral};
        // Instance fields are immutable after creation; recordFrame protects
        // the shared counters. Serializing here also serializes upstream RIFE.
        api->createVideoFilter(out,"TigerestRIFEMonitor",api->getVideoInfo(monitor->input),monitorFrame,monitorFree,
            fmParallel,&dependency,1,monitor.get(),core);
        // A rejected filter never calls monitorFree; release its input here.
        if(api->mapGetError(out)){api->freeNode(monitor->input);return;}
        monitor.release();
    } catch(const std::exception& error) {
        if(monitor->input)api->freeNode(monitor->input);
        api->mapSetError(out,error.what());
    }
}
}
namespace rife {
void registerMonitor(VSPlugin* plugin,const VSPLUGINAPI* api) {
    api->registerFunction("Monitor","clip:vnode;session:int;factor:int:opt;factor_den:int:opt;","clip:vnode;",monitorCreate,nullptr,plugin);
}
}
