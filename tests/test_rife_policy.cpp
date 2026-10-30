#ifdef NDEBUG
#undef NDEBUG
#endif
#include "InterpolationPolicy.h"
#include <cassert>
#include <cmath>
int main() {
    rife::StartupGate startup;
    startup.begin(true,false,100); // autoplay waits for the first generated frame
    assert(startup.waiting()&&startup.waitingToPlay()&&!startup.expired(15099));
    assert(startup.expired(15100));
    assert(startup.finish());assert(!startup.finish()); // resume only once
    startup.begin(true,true,200);assert(!startup.waitingToPlay()&&!startup.finish()); // explicit paused load
    startup.begin(true,false,300);startup.requestPause(true);assert(!startup.finish());
    startup.begin(true,true,400);assert(startup.requestPause(false));assert(startup.finish());
    startup.begin(true,false,500);startup.cancel();assert(!startup.finish()); // stop/replace
    startup.begin(false,false,600);assert(!startup.waiting()&&!startup.requestPause(false));
    startup.begin(true,false,700);
    startup.togglePause();assert(startup.waiting()&&!startup.waitingToPlay());
    startup.togglePause();assert(startup.waitingToPlay());
    startup.togglePause();assert(!startup.finish());
    startup.begin(true,true,800);startup.togglePause();assert(startup.finish());
    startup.begin(true,false,1000);startup.setEnginePreparing(true,1200);
    assert(!startup.expired(901000)); // Engine compilation has its own bounded worker timeout.
    startup.requestPause(true);
    startup.setEnginePreparing(false,901000);
    assert(!startup.expired(915999)&&startup.expired(916000)); // Fresh first-frame deadline.
    assert(!startup.finish()); // User pause is independent of either preparation stage.
    startup.begin(true,false,920000);assert(startup.expired(935000));
    rife::SourceInfo s{1920,1080,30000,1001,true,true,false,true};
    assert(rife::qualify(s).enabled);
    for (int kind=0;kind<7;++kind) {
        auto bad=s;
        switch(kind) {
        case 0:bad.width=3840;break;case 1:bad.fpsNum=60000;break;
        case 2:bad.progressive=false;break;case 3:bad.cfr=false;break;
        case 4:bad.hdr=true;break;case 5:bad.colorKnown=false;break;
        case 6:bad.fpsDen=0;break;
        }
        assert(!rife::qualify(bad).enabled);
    }
    assert(rife::rationalFrameRate(23.976023976).num==24000);
    assert(rife::rationalFrameRate(29.97002997).den==1001);
    assert(!rife::rationalFrameRate(NAN).num);
    rife::PerformanceGuard guard;
    // Thirty calls warm up; two uninterrupted slow windows are required.
    assert(!guard.update(0,30,30,50,0,30,false));
    assert(!guard.update(3000,70,70,50,1,30,false));
    assert(guard.update(6000,110,110,50,2,30,false));
    guard.reset();
    assert(!guard.update(0,30,30,50,0,30,false));
    assert(!guard.update(3000,70,70,50,1,30,false));
    assert(!guard.update(6000,70,70,50,1,30,true)); // pause/buffer/seek clears the streak
    assert(!guard.update(9000,110,110,50,2,30,false));
    assert(!guard.update(12000,150,150,50,3,30,false));
    assert(guard.update(15000,190,190,50,4,30,false));
    guard.reset();
    assert(!guard.update(0,30,30,10,0,30,false));
    assert(!guard.update(3000,70,70,10,0,30,false));
    assert(!guard.update(6000,110,110,10,0,30,false)); // low delivery alone is not inference blame
    guard.reset();
    assert(!guard.update(0,30,30,50,0,30,false));
    assert(!guard.update(3000,120,120,50,0,30,false));
    assert(!guard.update(6000,210,210,50,0,30,false)); // maintained throughput, no fallback
    guard.reset();
    assert(!guard.update(0,30,30,10,0,30,false));
    assert(!guard.update(3000,120,120,10,30,30,false));
    assert(guard.update(6000,210,210,10,60,30,false)); // renderer loses output despite fast model

    rife::ResumePrime prime;
    prime.paused(1000);assert(!prime.resumed(5999,true)); // short pauses resume at once
    assert(!prime.pending());
    prime.paused(10000);assert(!prime.resumed(15000,false)); // no active graph
    prime.paused(20000);assert(prime.resumed(25000,true)&&prime.priming());
    prime.paused(25010); // the hold before the seek
    assert(!prime.expired(27999)&&prime.ready(26000)&&!prime.ready(26001));
    assert(prime.pending()&&!prime.priming());
    assert(!prime.resumed(26020,true)&&!prime.pending()); // our own release edge
    assert(!prime.resumed(90000,true)); // a resume needs an observed pause first
    prime.paused(100000);assert(prime.resumed(110000,true));
    assert(!prime.resumed(110100,true)&&!prime.pending()); // a second toggle plays at once
    prime.paused(120000);assert(prime.resumed(130000,true));
    assert(prime.expired(133000)&&prime.ready(133000)); // a seek that never restarts
    prime.paused(133050);assert(!prime.pending()); // a late hold edge after the release
    assert(!prime.resumed(133100,true)); // ...is only 50 ms of pause
    prime.paused(140000);assert(prime.resumed(150000,true));
    prime.cancel(150100);assert(!prime.pending()&&!prime.ready(150200)); // user pause during the prime
    assert(!prime.resumed(154000,true)&&!prime.pending());
    prime.cancel(160000);assert(prime.resumed(165000,true)); // the pause counts from the cancel
    prime.cancel();prime.paused(170000);prime.cancel();
    assert(!prime.resumed(190000,true)); // startup resume discards the hold

    rife::DisplaySyncWatch watch;
    assert(!watch.update(0,0)&&!watch.update(2999,9)); // warmup ignores startup timing
    assert(!watch.update(3000,9)&&!watch.update(5000,10)&&!watch.update(7000,11)&&!watch.update(9000,12));
    assert(watch.update(11000,13)); // mistimed frames in four windows in a row
    watch.reset();watch.update(0,0);watch.update(3000,0);
    assert(!watch.update(5000,4)&&!watch.update(7000,7)&&!watch.update(9000,7)); // one burst over two windows
    assert(!watch.update(11000,8)&&!watch.update(13000,9)&&!watch.update(15000,10));
    assert(!watch.update(16000,0)&&!watch.update(17000,1)); // mpv restarted its count: warm up again
    assert(!watch.update(19000,2)&&!watch.update(21000,3)&&!watch.update(23000,4)&&!watch.update(25000,5));
    assert(watch.update(27000,6));
}
