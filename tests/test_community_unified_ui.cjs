// The complete account stack must keep trusted announcement replies on their original topic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const withBrowser=require('./community_browser.cjs');
const files=['communityClient','communityBridge','communitySession','communityPublicClient','communityAvatar','communityAccount','communityMessages','communityPlugin'];
const routes=Object.fromEntries(files.map(f=>['/'+f+'.js',{path:path.join(__dirname,'../native/'+f+'.js')}]));
routes['/']={type:'text/html',body:'<html><meta charset="utf-8"><style>body{margin:32px;background:#151923;color:#e7edf7;font:16px "Microsoft YaHei",sans-serif}.itemView{max-width:1050px;margin:auto}.headerRight{text-align:right}</style><div class="headerRight"></div><div class="itemView"><h1>公告影片</h1><div class="peopleSection"></div></div>'+files.map(f=>'<script src="/'+f+'.js"></script>').join('')+'</html>'};
withBrowser(routes,async({evaluate,call})=>{
 const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+expression);};
 await evaluate(`
 window.requests=[];window.publicCalls=[];window.topicScope='work';let listener;
 window.fixtureAuthor={id:'admin',name:'公告管理员',avatarPath:null};
 window.fixtureRoot={id:'announcement',topicId:'original-topic',rootId:null,state:'visible',body:'公告正文',author:fixtureAuthor,createdAt:'2026-10-01T00:00:00Z',permissions:{canReply:true,canDelete:true,canModerate:true},replies:[],replyCount:1};
 window.fixtureReply={id:'announcement-reply',topicId:'original-topic',rootId:'announcement',replyToId:'announcement',state:'visible',body:'原公告下的回复',author:fixtureAuthor,replyToAuthor:fixtureAuthor,createdAt:'2026-10-01T00:01:00Z',permissions:{canReply:true,canDelete:true,canModerate:true}};
 window.fetch=async(url,options={})=>{
  const parsed=new URL(url),p=parsed.pathname.replace('/community/v1',''),body=options.body?JSON.parse(options.body):null;
  if(!parsed.pathname.startsWith('/community/v1/'))throw Error('Unexpected fixture request');
  requests.push({path:p,search:parsed.search,method:options.method||'GET',body,headers:options.headers});
  let data;
  if(p==='/me')data={author:fixtureAuthor,isCommentAdmin:true,muted:false};
  else if(p==='/topics/resolve'){topicScope=body.scope;data={id:'original-topic',scope:body.scope,title:'公告影片'};}
  else if(p==='/topics/original-topic/comments')data={items:[fixtureRoot],nextCursor:null,rootCount:1};
  else if(p==='/comments/announcement/replies')data=options.method==='POST'?{comment:fixtureReply,replayed:false}:{items:[fixtureReply],nextCursor:null};
  else data={items:[],nextCursor:null,unreadCount:0,readThroughToken:'fixture-read'};
  return new Response(JSON.stringify({data}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 window.api={system:{communityResponse:{connect:f=>listener=f},communityCancel(){},communitySetEmbySession(s,cb){cb(true)},communityCredential(op,k,v,cb){cb({ok:true,value:''})},communityRequest(id,r){
  publicCalls.push(r.path);
  const respond=data=>setTimeout(()=>listener(id,{status:200,body:JSON.stringify({data}),headers:{}}),0);
  if(r.path==='/capabilities'){window.completeCapabilities=()=>respond({enabled:true,auth:['password','emby-exchange'],embyExchangeServerId:'62526c3bf747439c99327ddec5fed4a8',registrationEnabled:true,mediaIdentity:'tmdb-aired'});return;}
  if(r.path.startsWith('/auth/'))respond({accessToken:'fixture-access',refreshToken:'fixture-refresh',tokenType:'Bearer',expiresAt:'2099-01-01T00:00:00Z',refreshExpiresAt:'2099-02-01T00:00:00Z',author:fixtureAuthor});
  else if(r.path==='/me')respond({author:fixtureAuthor,isCommentAdmin:false});
  else respond({items:[],nextCursor:null,unreadCount:0});
 }}};
 window.emby={serverId:()=> '62526c3bf747439c99327ddec5fed4a8',getCurrentUserId:()=> 'fixture-user',accessToken:()=> 'fixture-emby',serverAddress:()=> 'http://nas.tigerest.top:8095'};
 window.plugin=new _communityPlugin({connectionManager:{currentApiClient:()=>emby},appRouter:{show:async route=>{window.lastRoute=route;}}});
 document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow',{bubbles:true,detail:{item:{Id:'announcement-item',Type:'Movie',Name:'公告影片'}}}));
 `);
 await waitFor(`typeof completeCapabilities==='function'`);
 assert.equal(await evaluate(`requests.length`),0,'unverified trust must not issue private requests');
 await evaluate(`completeCapabilities()`);
 await waitFor(`!plugin.state.loading`);
 assert.equal(await evaluate(`plugin.state.topic?.id`),'original-topic','trusted announcements without TMDB metadata keep their original discussion');
 assert.equal(await evaluate(`document.querySelector('#tigerest-community h2').textContent`),'评论区');
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('#tigerest-community button')).some(b=>/切换到.*评论/.test(b.textContent))`),false,'one discussion has no public/private toggle');
 assert.equal(await evaluate(`plugin.state.list.textContent.includes('公告正文')`),true);
 assert.equal(await evaluate(`publicCalls.includes('/topics/resolve')`),false,'trusted details resolve using the Emby item');
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('#tigerest-community button')).some(b=>b.textContent==='管理删除')`),true,'moderation permissions survive automatic routing');
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('#tigerest-community button')).some(b=>b.textContent==='上报问题'&&!b.hidden)`),true,'private report action remains available');
 // v1 no longer accepts posts: the original discussion stays readable, without a composer or replies.
 assert.equal(await evaluate(`plugin.state.composer.hidden&&!plugin.state.readOnlyNote.hidden`),true,'the dedicated discussion is read-only');
 assert.equal(await evaluate(`Array.from(plugin.state.list.querySelectorAll('button')).some(b=>b.textContent==='回复')`),false,'read-only discussions offer no reply');
 assert.equal(await evaluate(`requests.some(r=>r.method==='POST'&&r.path!=='/topics/resolve')`),false);
 await evaluate(`plugin.openDiscussion({availability:'available',location:{embyServerId:emby.serverId(),itemId:'announcement-item',scope:'work',topicId:'original-topic',rootId:'announcement',commentId:'announcement-reply',canNavigate:true}})`);
 await waitFor(`!plugin.state.loading`);
 assert.equal(await evaluate(`document.querySelector('[data-comment-id="announcement-reply"]')?.classList.contains('tc-highlight')`),true,'notification anchors still locate the original reply');
 if(process.env.TIGEREST_COMMUNITY_SCREENSHOT){
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.scrollTo(0,0)`);
  const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  fs.mkdirSync(path.dirname(process.env.TIGEREST_COMMUNITY_SCREENSHOT),{recursive:true});
  fs.writeFileSync(process.env.TIGEREST_COMMUNITY_SCREENSHOT,Buffer.from(screenshot.data,'base64'));
 }
 await evaluate(`Array.from(document.querySelectorAll('#tigerest-community button')).find(b=>b.textContent==='上报问题').click()`);
 await waitFor(`!!document.querySelector('#tigerest-report-form')`);
 assert.equal(await evaluate(`plugin.messages.client.public===true`),false,'report action keeps the private message client');
 await evaluate(`plugin.destroy()`);
 console.log('unified trusted announcement detail, read-only discussion, notification anchor, moderation and report fixture passed');
}).catch(error=>{console.error(error);process.exitCode=1;});
