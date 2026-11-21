// The first-run usage tour (native/onboardingTour.js) in the real client, on a
// fixture page shaped like the home gallery and an item page; no Emby account.
// Covers: the native new/upgrade decision, starting once by itself, a new
// user's tour that cannot be skipped, skipping, the re-open entry in the client
// settings, missing parts being skipped, keys, platforms, the light theme, a
// block that leaves the bubble no room beside it, the player pictures (a short
// window or a missing picture keeps the plain text) and a covered window.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const withBrowser=require('./community_browser.cjs');

const page=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;background:#101216;color:#eee;font:16px system-ui}.hide{display:none!important}
.skinHeader{position:fixed;top:0;left:0;right:0;height:56px;display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:0 16px;background:#1a1d22;z-index:5}
body.tg-home-active .skinHeader{display:none}
.tg-home{display:grid;grid-template-columns:280px 1fr;grid-template-rows:1fr 260px;gap:16px;height:100vh;box-sizing:border-box;padding:16px}
.tg-home-nav{grid-row:1/3;display:flex;flex-direction:column;gap:12px}.tg-library{height:90px}
.tg-home-stage{position:relative;border-radius:16px;background:#223}.tg-home-hero{position:absolute;inset:0;width:100%;border:0;border-radius:16px;background:#334;color:#fff}
.tg-home-rail{background:#1b1e24;border-radius:12px}
.itemDetailPage{padding:72px 24px 24px}.mainDetailButtons{display:flex;gap:8px;margin:24px 0}.mainDetailButtons button{height:44px;padding:0 18px}
#tigerest-community{height:1400px;margin-top:900px;background:#191c21}
</style>
<header class="skinHeader"><button id="tigerest-message-entry">消息</button><button id="tigerest-mpv-settings-button">客户端</button></header>
<div id="home" class="view-home-home"><section class="tg-home tg-entered tg-ready">
 <nav class="tg-home-nav"><div><button class="tg-home-window-mode">窗口</button></div><button class="tg-library">动画</button><button class="tg-library">电影</button></nav>
 <div class="tg-home-stage"><button class="tg-home-hero">查看作品</button><div class="tg-home-status" hidden></div></div>
 <section class="tg-home-rail">作品</section></section></div>
<div id="detail" class="itemDetailPage hide"><div class="mainDetailButtons"><button>播放</button><button class="tw-detail-entry">一起看</button></div><div id="tigerest-community">评论区</div></div>
<script src="/fixture.js"></script>`;
// The hero opens the item page as Emby's router would: a history entry, then the page.
const fixture=`
window.fixture={keys:[],opened:0};
document.addEventListener('keydown',event=>fixture.keys.push(event.key));
const showDetail=detail=>{document.body.classList.toggle('tg-home-active',!detail);
 document.getElementById('home').classList.toggle('hide',detail);document.getElementById('detail').classList.toggle('hide',!detail);};
history.replaceState(null,'',location.pathname);showDetail(false);
const hero=document.querySelector('.tg-home-hero');hero.disabled=sessionStorage.getItem('tour-no-works')==='1';
hero.addEventListener('click',()=>{fixture.opened++;history.pushState({detail:true},'','#detail');setTimeout(()=>showDetail(true),150);});
addEventListener('popstate',()=>setTimeout(()=>showDetail(location.hash==='#detail'),150));
if(window.TigerestTour){Object.assign(TigerestTour.debug,{readyMs:300,pollMs:100,stepWaitMs:1000,pageWaitMs:4000});
 TigerestTour.debug.environment={platform:'windows',touch:false,windowControls:true,interpolation:true,rtx:true,vfg:false};}`;
const routes={'/':{type:'text/html',body:page},'/fixture.js':{body:fixture}};
const settingsFile=profile=>{
    const folder=fs.readdirSync(path.join(profile,'profiles')).find(name=>/^[0-9a-f]{32}$/.test(name));
    return path.join(profile,'profiles',folder,['win32','darwin'].includes(process.platform)?'Tigerest Theater.conf':'tigerest-theater.conf');
};
const savedState=profile=>JSON.parse(fs.readFileSync(settingsFile(profile),'utf8')).sections.main.onboardingTour;
const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));

// Qt suspends animation frames for a covered test window: without transitions
// the lit area and the bubble are where the tour put them at once.
const stillMotion=call=>call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
function tools({evaluate,call}){
    const until=async(expression,label=expression,ms=8000)=>{
        const end=Date.now()+ms;
        for(;;){
            // A page that is reloading has no context for a moment.
            const value=await evaluate(expression).catch(()=>null);
            if(value)return value;
            if(Date.now()>end)throw Error('timed out: '+label+'; tour: '+JSON.stringify(await evaluate('window.TigerestTour?.current')));
            await delay(50);
        }
    };
    const codes={ArrowRight:39,ArrowLeft:37,Enter:13,Escape:27,Tab:9,k:75};
    const key=async name=>{
        const text=name==='Enter'?'\r':name.length===1?name:undefined;
        const code=name.length===1?'Key'+name.toUpperCase():name;
        await call('Input.dispatchKeyEvent',{type:text?'keyDown':'rawKeyDown',key:name,code,windowsVirtualKeyCode:codes[name],nativeVirtualKeyCode:codes[name],...(text?{text}:{})});
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:codes[name],nativeVirtualKeyCode:codes[name]});
    };
    const current=()=>evaluate('TigerestTour.current');
    const step=id=>until(`TigerestTour.current?.id===${JSON.stringify(id)}`,'step '+id);
    const reload=async()=>{
        await evaluate('window.reloading=true');await call('Page.reload');
        await until('!window.reloading&&document.readyState==="complete"&&!!window.fixture','page reloaded');
    };
    // The lit area surrounds the part being explained, and the bubble does not cover it.
    const geometry=selector=>evaluate(`(()=>{const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};};
        return {spot:box(document.querySelector('#tigerest-tour .tgt-spot')),target:box(document.querySelector(${JSON.stringify(selector)})),bubble:box(document.querySelector('#tigerest-tour .tgt-bubble'))};})()`);
    // Once the lit area and the bubble stop moving (scrolling, transitions; slower on a cold start).
    const settled=async selector=>{
        let last=null;
        for(let i=0;i<40;i++){
            const now=await geometry(selector);
            if(last&&JSON.stringify(now)===JSON.stringify(last))return now;
            last=now;await delay(100);
        }
        return last;
    };
    return {until,key,current,step,reload,geometry,settled};
}

(async()=>{
    // 1. The native settings decide new and upgraded profiles. The Android
    // fixture keeps the phone's app data, so a fresh install checks it there.
    if(process.env.TIGEREST_ANDROID_FIXTURE)console.log('skip - native new/upgrade decision (Android: fresh install and upgrade by hand)');
    else{
    await withBrowser(routes,async({evaluate})=>{
        assert.equal(await evaluate('api.settings.value("main","onboardingTour")'),'new','a profile without settings is new');
    },{prepareProfile:(profile,folder,file)=>fs.rmSync(file)});
    await withBrowser(routes,async({evaluate,profile})=>{
        assert.equal(await evaluate('api.settings.value("main","onboardingTour")'),'upgrade','settings from before the tour belong to an upgraded user');
        assert.equal(savedState(profile),'upgrade','and that is saved');
    },{prepareProfile:(profile,folder,file)=>{
        const saved=JSON.parse(fs.readFileSync(file,'utf8'));delete saved.sections.main.onboardingTour;fs.writeFileSync(file,JSON.stringify(saved));
    }});
    console.log('ok - native new/upgrade decision');
    }

    // 2. A new user: starts by itself once, cannot be skipped, walks every page.
    await withBrowser(routes,async context=>{
        const {evaluate,profile}=context,t=tools(context);
        await stillMotion(context.call);
        await t.until('window.TigerestTour?.active','starts by itself on the home page',10000);
        await t.step('welcome');
        let c=await t.current();
        assert.equal(await evaluate('TigerestTour.mode'),'new');
        assert.equal(c.close,false,'no × for a new user');
        assert.deepEqual(c.buttons,['开始'],'only 开始 on the first card');
        assert.equal(c.count,'1 / 14');
        assert.ok(!c.body.includes('Esc')&&!c.body.includes('×'),'a new user is not told how to leave');
        assert.equal(c.light,false,'dark bubble on a dark page');
        await t.key('Escape');await delay(250);
        assert.equal((await t.current()).id,'welcome','Esc does nothing on the first card');
        assert.equal(await evaluate('window.tigerestClientMenuBack()'),true,'Android back is taken by the tour');
        assert.equal((await t.current()).id,'welcome');
        await t.key('ArrowRight');await t.step('libraries');
        c=await t.current();
        assert.deepEqual(c.buttons,['上一步','下一步']);assert.equal(c.count,'2 / 14');assert.equal(c.centered,false);
        await t.key('Escape');await t.step('welcome');
        await t.key('Enter');await t.step('libraries');
        const typed=await evaluate('fixture.keys.length');
        await t.key('k');await t.key('ArrowLeft');await t.step('welcome');await t.key('ArrowRight');await t.step('libraries');
        assert.equal(await evaluate('fixture.keys.length'),typed,'keys never reach the page while the tour is open');
        assert.equal(await evaluate('TigerestTour.hostAction("host:fullscreen")'),false,'window actions stay with the host');
        assert.equal(await evaluate('TigerestTour.hostAction("right")'),true);await t.step('hero');
        const lit=await t.settled('.tg-home-stage');
        for(const side of ['left','top'])assert.ok(lit.spot[side]<=lit.target[side]+1&&lit.spot[side]>=lit.target[side]-10,'lit '+side);
        for(const side of ['right','bottom'])assert.ok(lit.spot[side]>=lit.target[side]-1&&lit.spot[side]<=lit.target[side]+10,'lit '+side);
        assert.equal(overlap(lit.bubble,lit.target),0,'the bubble sits beside the poster');
        assert.equal(await evaluate('document.elementFromPoint(innerWidth/2,innerHeight/2).closest("#tigerest-tour")!==null'),true,'the page underneath cannot be clicked');
        for(const id of ['rail','window','detail']){await t.key('ArrowRight');await t.step(id);}
        assert.equal(await evaluate('fixture.opened'),1,'the tour opened the work on the poster');
        assert.equal(await evaluate('document.body.classList.contains("tg-home-active")'),false);
        // Back across the chapter goes home, forward opens the work again.
        await t.key('ArrowLeft');await t.step('window');
        assert.equal(await evaluate('document.body.classList.contains("tg-home-active")'),true,'back on the home page');
        await t.key('ArrowRight');await t.step('detail');
        assert.equal(await evaluate('fixture.opened'),2);
        await t.key('ArrowRight');await t.step('watch');
        await t.key('ArrowRight');await t.step('comments');
        assert.ok(await evaluate('document.scrollingElement.scrollTop>0'),'the comments were scrolled into view');
        // Taller than the window: its top sits under the header and only that part is lit.
        const tall=await t.settled('#tigerest-community'),height=await evaluate('innerHeight');
        assert.ok(tall.target.top>=56&&tall.spot.top>=56,'the comments start below the fixed header');
        assert.ok(tall.spot.bottom-tall.spot.top<=height/2,'only the top of the comments is lit');
        assert.equal(overlap(tall.bubble,tall.spot),0,'the bubble sits beside the lit part');
        // Like the real item page: a little shorter than the window, and no room beside it.
        await evaluate(`document.getElementById('tigerest-community').style.height='600px'`);
        await t.key('ArrowLeft');await t.step('watch');await t.key('ArrowRight');await t.step('comments');
        const block=await t.settled('#tigerest-community');
        assert.equal(overlap(block.bubble,block.spot),0,'the bubble does not cover a block of most of the window');
        assert.ok(block.bubble.top>=block.spot.bottom&&block.spot.bottom-block.spot.top>=120,'it sits under the lit top part: '+JSON.stringify(block));
        await evaluate(`document.getElementById('tigerest-community').style.height=''`);
        await t.key('ArrowRight');await t.step('client');
        assert.equal(await evaluate('document.scrollingElement.scrollTop'),0,'scrolled back to the header');
        assert.match((await t.current()).body,/Ctrl\+,/);
        await t.key('ArrowRight');await t.step('messages');
        await t.key('ArrowRight');await t.step('player');
        c=await t.current();assert.equal(c.centered,true,'the player step has nothing to light');
        // The desktop player steps show a picture of the player; the text refers to its marks.
        // The Android fixture has no pictures: the plain text stays.
        const pictures=!process.env.TIGEREST_ANDROID_FIXTURE;
        const picture=async(name,marks)=>{
            if(!pictures){await t.until('TigerestTour.current&&TigerestTour.current.art===null','no picture: '+name);assert.doesNotMatch((await t.current()).body,/①/);return;}
            await t.until('TigerestTour.current?.art?.loaded','the picture loads: '+name);
            const now=await t.current();
            assert.deepEqual([now.art.name,now.art.marks],[name,marks]);assert.match(now.body,marks===3?/① .*② .*③ /:/① .*② /,'the text refers to the marks');
            const card=await evaluate(`(()=>{const r=document.querySelector('#tigerest-tour .tgt-bubble').getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:innerHeight};})()`);
            assert.ok(card.top>=0&&card.bottom<=card.height&&card.width>600,'a wide card inside the window: '+JSON.stringify(card));
        };
        await picture('player',3);
        await t.key('ArrowRight');await t.step('pro');
        await picture('pro',3);
        if(pictures){
            // A short window has no room for the picture: the plain text instead.
            await context.call('Emulation.setDeviceMetricsOverride',{width:1280,height:400,deviceScaleFactor:0,mobile:false});
            await t.key('ArrowLeft');await t.step('player');await t.key('ArrowRight');await t.step('pro');
            c=await t.current();assert.equal(c.art,null,'no picture on a short window');assert.doesNotMatch(c.body,/①/);
            await context.call('Emulation.clearDeviceMetricsOverride');
            await t.key('ArrowLeft');await t.step('player');await t.key('ArrowRight');await t.step('pro');
            await picture('pro',3);
        }
        await t.key('ArrowRight');await t.step('interpolation');
        await picture('interpolation',2);
        c=await t.current();
        assert.equal(c.title,'补帧与画质增强');assert.match(c.body,/RTX 视频超分辨率/);assert.doesNotMatch(c.body,/VFG/,'no VFG without an RTX 40/50');
        await t.key('ArrowRight');await t.step('end');
        c=await t.current();
        assert.deepEqual(c.buttons,['上一步','完成']);assert.equal(c.count,'14 / 14');assert.equal(c.centered,false,'ends on the client button');
        await t.key('Enter');
        await t.until('!TigerestTour.active','finishes');
        assert.equal(await evaluate('TigerestTour.state'),'done');
        assert.equal(await evaluate('api.settings.value("main","onboardingTour")'),'done');
        if(profile){// the desktop profile's settings file
            for(let i=0;i<40&&savedState(profile)!=='done';i++)await delay(100);
            assert.equal(savedState(profile),'done','saved in the profile');
        }
        await t.reload();await delay(1500);
        assert.equal(await evaluate('TigerestTour.active'),false,'never again by itself');
        console.log('ok - new user tour');
    },{settings:{main:{onboardingTour:'new'}}});

    // 3. Off, the re-open entry, skipping, upgraded users and missing parts.
    await withBrowser(routes,async context=>{
        const {evaluate}=context,t=tools(context);
        await stillMotion(context.call);
        await delay(1500);
        assert.equal(await evaluate('TigerestTour.active'),false,'tests keep the tour off');
        const platforms=await evaluate(`(async()=>{const lists={};
            for(const env of [{platform:'android',touch:true,windowControls:false,interpolation:false},{platform:'ios',touch:true,windowControls:false,interpolation:true},
                {platform:'mac',touch:false,windowControls:true,interpolation:true},{platform:'windows',touch:false,windowControls:true,interpolation:false}]){
                TigerestTour.debug.environment=env;lists[env.platform]=await TigerestTour.steps('new');}
            TigerestTour.debug.environment={platform:'windows',touch:false,windowControls:true,interpolation:true,rtx:true,vfg:true};return lists;})()`);
        const shared=['welcome','libraries','hero','rail'],detail=['detail','watch','comments','client','messages','player'];
        assert.deepEqual(platforms.android,[...shared,...detail,'end']);
        assert.deepEqual(platforms.ios,[...shared,...detail,'interpolation','end']);
        assert.deepEqual(platforms.mac,[...shared,'window',...detail,'pro','interpolation','end']);
        assert.deepEqual(platforms.windows,[...shared,'window',...detail,'pro','end'],'no interpolation step without an NVIDIA card');
        // The 一起看 button is missing (server without it); the page is light.
        await evaluate(`document.querySelector('.tw-detail-entry').remove();document.body.style.background='#f4f1ea';document.body.style.color='#222';`);
        await evaluate(`window.tigerestMountSettings(null,'main')`);
        await t.until(`[...document.querySelectorAll('#tigerest-settings-overlay button')].some(b=>b.textContent==='重新打开引导')`,'re-open entry in the client settings');
        await evaluate(`[...document.querySelectorAll('#tigerest-settings-overlay button')].find(b=>b.textContent==='重新打开引导').click()`);
        await t.step('welcome');
        let c=await t.current();
        assert.equal(await evaluate('document.getElementById("tigerest-settings-overlay")'),null,'the settings closed');
        assert.equal(await evaluate('TigerestTour.mode'),'replay');
        assert.deepEqual(c.buttons,['跳过','开始']);assert.equal(c.close,true);assert.match(c.body,/Esc/);
        assert.equal(c.light,true,'light bubble on a light page');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#tigerest-tour .tgt-primary')).color`),'rgb(29, 25, 18)','dark text on the gold button stays readable');
        for(const id of ['libraries','hero','rail','window','detail','comments']){await t.key('ArrowRight');await t.step(id);}
        assert.equal((await t.current()).count,'7 / 13','the missing 一起看 step left the count');
        await t.key('ArrowRight');await t.step('client');
        // A picture that cannot load leaves the plain text.
        await evaluate(`window.jmpInfo.tourArtPath=location.origin+'/missing-tour-art'`);
        for(const id of ['messages','player']){await t.key('ArrowRight');await t.step(id);}
        await t.until('TigerestTour.current&&TigerestTour.current.art===null','a missing picture is left out');
        assert.doesNotMatch((await t.current()).body,/①/,'and its marks with it');
        // RTX 40: VFG is mentioned.
        for(const id of ['pro','interpolation']){await t.key('ArrowRight');await t.step(id);}
        assert.match((await t.current()).body,/VFG/);
        await t.key('Escape');
        await t.until('!TigerestTour.active','Esc closes a tour that can be skipped');
        assert.equal(await evaluate('TigerestTour.state'),'skipped');
        await t.reload();await delay(1500);
        assert.equal(await evaluate('TigerestTour.active'),false,'a skipped tour does not come back');

        // An upgraded user on a server without works: starts by itself, the item
        // page chapter is left out, an interruption starts it again later.
        await evaluate(`sessionStorage.setItem('tour-no-works','1');api.settings.setValue('main','onboardingTour','upgrade')`);
        await t.reload();
        await t.step('welcome');
        assert.equal(await evaluate('TigerestTour.mode'),'upgrade');
        await t.key('ArrowRight');await t.step('libraries');
        await evaluate(`document.body.classList.remove('tg-home-active')`);
        await t.until('!TigerestTour.active','leaving the home page interrupts the tour');
        assert.equal(await evaluate('api.settings.value("main","onboardingTour")'),'upgrade','an interruption keeps the progress');
        await evaluate(`document.body.classList.add('tg-home-active')`);
        await t.step('welcome');
        for(const id of ['libraries','hero','rail','window','player']){await t.key('ArrowRight');await t.step(id);}
        assert.equal((await t.current()).count,'6 / 9','without works the item page steps are left out');
        assert.equal(await evaluate('fixture.opened'),0);
        assert.equal(await evaluate('window.tigerestClientMenuBack()'),true);
        await t.until('!TigerestTour.active','Android back closes a tour that can be skipped');
        assert.equal(await evaluate('TigerestTour.state'),'skipped');
        // The welcome card's 跳过.
        await evaluate(`api.settings.setValue('main','onboardingTour','upgrade')`);
        await t.reload();await t.step('welcome');
        await evaluate(`document.querySelector('#tigerest-tour .tgt-secondary').click()`);
        await t.until('!TigerestTour.active','跳过 closes the tour');
        assert.equal(await evaluate('api.settings.value("main","onboardingTour")'),'skipped');
        console.log('ok - re-open entry, skipping, upgraded users, missing parts');
    },{settings:{main:{onboardingTour:'off'}}});

    // 4. A covered window (hidden, no animation frames): the tour still starts,
    // and a step that has to scroll still shows its part, in the right place.
    await withBrowser(routes,async context=>{
        const {evaluate}=context,t=tools(context);
        await delay(800);
        await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});window.requestAnimationFrame=()=>0;
            api.settings.setValue('main','onboardingTour','new')`);
        await t.step('welcome');
        for(const id of ['libraries','hero','rail','window','detail','watch','comments']){await t.key('ArrowRight');await t.step(id);}
        assert.equal((await t.current()).count,'8 / 14','the comments step is not skipped');
        const top=await evaluate(`document.querySelector('#tigerest-community').getBoundingClientRect().top`);
        assert.ok(Math.abs(top-72)<=2,'the comments start just under the header: '+top);
        console.log('ok - covered window');
    },{settings:{main:{onboardingTour:'off'}}});
})().catch(error=>{console.error(error);process.exitCode=1;});
