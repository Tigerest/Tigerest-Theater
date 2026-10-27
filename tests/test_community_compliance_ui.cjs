// Trusted users comment through v2: terms consent, reports, blocks, withheld text and deletion.
const assert=require('node:assert/strict'),path=require('node:path');
const withBrowser=require('./community_browser.cjs');
const files=['communityClient','communityBridge','communitySession','communityPublicClient','communityAvatar','communityAccount','communityMessages','communityPlugin'];
const routes=Object.fromEntries(files.map(f=>['/'+f+'.js',{path:path.join(__dirname,'../native/'+f+'.js')}]));
routes['/']={type:'text/html',body:'<html><meta charset="utf-8"><div class="headerRight"></div><div class="itemView"><h1>大河影片</h1><div class="peopleSection"></div></div>'+files.map(f=>'<script src="/'+f+'.js"></script>').join('')+'</html>'};
withBrowser(routes,async({evaluate})=>{
 const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+expression);};
 const click=label=>evaluate(`Array.from(document.querySelectorAll('#tigerest-community button,#tigerest-community-account button')).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`);
 await evaluate(`
 window.calls=[];window.saved={};window.accepted=null;let listener;
 const other={id:'other',name:'路人',avatarPath:null},me={id:'author',name:'大河用户',avatarPath:null};
 const comment=(id,extra)=>({id,topicId:'public-topic',rootId:null,replyToId:null,author:other,replyToAuthor:null,replyToState:null,state:'visible',body:'正文 '+id,createdAt:'2026-10-24T00:00:00Z',replyCount:0,replies:[],repliesNextCursor:null,viewerFlagged:false,permissions:{canDelete:false,canReply:true,canModerate:false},...extra});
 window.items=[
  comment('visible'),
  comment('flagged',{viewerFlagged:true}),
  comment('review',{state:'pending_review',body:null,permissions:{canDelete:false,canReply:false}}),
  comment('blocked',{state:'blocked_by_viewer',body:null,author:null,replies:[comment('reply',{rootId:'blocked',replyToId:'blocked',replyToState:'blocked_by_viewer',body:'回复内容'})]})
 ];
 const caps={enabled:true,auth:['password','emby-exchange'],embyExchangeServerId:'62526c3bf747439c99327ddec5fed4a8',registrationEnabled:true,mediaIdentity:'tmdb-aired',
  moderation:{flagReasons:['spam','harassment','sexual','illegal','other'],blocks:true,accountDeletion:{authKinds:['password','emby']},terms:{version:'2026-10-24',url:'https://nas.tigerest.top:18446/community/v2/terms',contact:'mailto:owner@example.com'}}};
 window.api={system:{communityResponse:{connect:f=>listener=f},communityCancel(){},communitySetEmbySession(s,cb){cb(true)},
  communityCredential(op,k,v,cb){if(op==='write')saved[k]=v;if(op==='remove')delete saved[k];cb({ok:true,value:saved[k]||''})},
  communityRequest(id,r){calls.push(r);const p=r.path,body=r.body?JSON.parse(r.body):null;let status=200,data;
   if(p==='/capabilities')data=caps;
   else if(p.startsWith('/auth/'))data={accessToken:'fixture-access',refreshToken:'fixture-refresh',tokenType:'Bearer',expiresAt:'2099-01-01T00:00:00Z',refreshExpiresAt:'2099-02-01T00:00:00Z',author:me};
   else if(p==='/me')data={author:me,muted:false,termsAcceptedVersion:accepted,account:{authKind:'emby',canChangeDisplayName:false,canChangePassword:false}};
   else if(p==='/me/terms'){accepted=body.version;data={termsAcceptedVersion:accepted};}
   else if(p==='/topics/resolve')data={id:'public-topic',scope:'work'};
   else if(p.startsWith('/topics/public-topic/comments')&&r.method==='POST'){if(accepted!=='2026-10-24'){status=403;data='TERMS_NOT_ACCEPTED';}else data={comment:comment('new',{author:me,body:body.body}),replayed:false};}
   else if(p.startsWith('/topics/public-topic/comments'))data={items,nextCursor:null,rootCount:items.length};
   else if(p==='/comments/visible/flags')data={flag:{id:'flag',commentId:'visible',reason:body.reason,status:'open',createdAt:'2026-10-24T00:00:00Z'},replayed:false};
   else if(p.startsWith('/me/blocks?'))data={items:[{author:other,createdAt:'2026-10-24T00:00:00Z'}],nextCursor:null};
   else if(p.startsWith('/me/blocks/'))data={authorId:'other',blocked:r.method==='PUT'};
   else if(p==='/me/delete')data={deleted:true};
   else data={items:[],nextCursor:null,unreadCount:0};
   setTimeout(()=>listener(id,{status,body:JSON.stringify(status<400?{data}:{error:{code:data}}),headers:{}}),0);}}};
 window.opened=[];window.NativeShell={openUrl:url=>opened.push(url)};
 window.emby={serverId:()=> '62526c3bf747439c99327ddec5fed4a8',getCurrentUserId:()=> 'u1',accessToken:()=> 'EMBY-TOKEN',serverAddress:()=> 'https://nas.tigerest.top:18445'};
 window.plugin=new _communityPlugin({connectionManager:{currentApiClient:()=>emby}});
 document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow',{bubbles:true,detail:{item:{Id:'movie',Type:'Movie',Name:'大河影片',ProviderIds:{Tmdb:'42'}}}}));`);
 await waitFor(`plugin.state?.topic&&!plugin.state.loading`);
 assert.equal(await evaluate(`plugin.state.channel`),'public','trusted users with TMDB media comment through v2');
 assert.equal(await evaluate(`calls.some(c=>c.path==='/auth/emby')`),true,'trusted users join by Emby exchange, without registering');
 // Terms gate: composing waits for the user's own consent.
 assert.equal(await evaluate(`!plugin.state.termsBox.hidden&&plugin.state.input.disabled`),true,'unaccepted terms disable the composer');
 await click('阅读使用条款');
 assert.deepEqual(await evaluate(`opened`),['https://nas.tigerest.top:18446/community/v2/terms']);
 assert.equal(await evaluate(`calls.some(c=>c.path==='/me/terms')`),false,'reading never agrees');
 await click('同意并继续');
 await waitFor(`plugin.state.termsBox.hidden&&!plugin.state.busy`);
 assert.deepEqual(await evaluate(`JSON.parse(calls.find(c=>c.path==='/me/terms').body)`),{version:'2026-10-24'});
 assert.equal(await evaluate(`plugin.state.input.disabled`),false);
 // Withheld text, flagged and blocked placeholders.
 const text=id=>evaluate(`document.querySelector('[data-comment-id="${id}"] .tc-body').textContent`);
 assert.equal(await text('review'),'内容待审核');
 assert.equal(await text('blocked'),'你已屏蔽此用户的评论');
 assert.equal(await evaluate(`document.querySelector('[data-comment-id="blocked"] strong').textContent`),'已屏蔽的用户');
 assert.equal(await text('reply'),'回复已屏蔽用户：\n回复内容');
 assert.equal(await evaluate(`document.querySelector('[data-comment-id="flagged"] .tc-body').hidden`),true,'a reported comment is folded for its reporter');
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-comment-id="blocked"] > .tc-actions button')).length`),0,'placeholders offer no actions');
 // Report with a reason and an optional note.
 await evaluate(`Array.from(document.querySelectorAll('[data-comment-id="visible"] > .tc-actions button')).find(b=>b.textContent==='举报').click()`);
 await evaluate(`const s=document.querySelector('[aria-label="举报原因"]');s.value='harassment';document.querySelector('[aria-label="补充说明"]').value='辱骂他人';`);
 await click('提交举报');
 await waitFor(`!plugin.state.busy&&!plugin.state.loading`);
 const flag=await evaluate(`JSON.parse(calls.find(c=>c.path==='/comments/visible/flags').body)`);
 assert.equal(flag.reason,'harassment');assert.equal(flag.note,'辱骂他人');assert.match(flag.clientRequestId,/^[0-9a-f-]{36}$/);
 assert.match(await evaluate(`plugin.state.status.textContent`),/24 小时/);
 // Block sends no body.
 await evaluate(`Array.from(document.querySelectorAll('[data-comment-id="visible"] > .tc-actions button')).find(b=>b.textContent==='屏蔽').click()`);
 await click('确认屏蔽');
 await waitFor(`calls.some(c=>c.path==='/me/blocks/other')&&!plugin.state.busy`);
 assert.deepEqual(await evaluate(`(({method,body})=>({method,body}))(calls.find(c=>c.path==='/me/blocks/other'))`),{method:'PUT',body:''});
 // Account dialog: block list, contact, deletion without automatic rejoin.
 await click('评论账号');
 await waitFor(`Array.from(document.querySelectorAll('#tigerest-community-account button')).some(b=>b.textContent==='注销评论账号')`);
 assert.equal(await evaluate(`document.querySelector('#tigerest-community-account').textContent.includes('联系我们：owner@example.com')`),true);
 assert.equal(await evaluate(`document.querySelector('#tigerest-community-account').textContent.includes('路人')`),true,'blocked users are listed');
 assert.equal(await evaluate(`document.querySelector('#tigerest-community-account').textContent.includes('不会删除 Emby 账号')`),true);
 assert.equal(await evaluate(`!!document.querySelector('#tigerest-community-account [aria-label="当前密码"]')`),false,'Emby identities confirm without a password');
 await evaluate(`Array.from(document.querySelectorAll('#tigerest-community-account input[type=checkbox]')).forEach(b=>b.checked=true)`);
 await click('注销评论账号');
 await waitFor(`Array.from(document.querySelectorAll('#tigerest-community-account button')).some(b=>b.textContent==='重新加入公共评论')`);
 assert.deepEqual(await evaluate(`JSON.parse(calls.find(c=>c.path==='/me/delete').body)`),{confirm:'DELETE'});
 const exchanges=await evaluate(`calls.filter(c=>c.path==='/auth/emby').length`);
 await new Promise(r=>setTimeout(r,300));
 assert.equal(await evaluate(`calls.filter(c=>c.path==='/auth/emby').length`),exchanges,'deletion never exchanges a new identity by itself');
 assert.match(await evaluate(`plugin.state.status.textContent`),/已注销评论身份/);
 await click('重新加入公共评论');
 await waitFor(`calls.filter(c=>c.path==='/auth/emby').length>${exchanges}`);
 await evaluate(`plugin.destroy()`);
 console.log('trusted v2 terms, report, block, placeholders, block list and deletion fixture passed');
}).catch(error=>{console.error(error);process.exitCode=1;});
