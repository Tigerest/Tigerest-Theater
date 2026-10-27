const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const emby={serverId:'62526c3bf747439c99327ddec5fed4a8',userId:'user',token:'fixture',address:'https://nas.tigerest.top:18445'};
function context(){
 const c={URL,URLSearchParams,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,fetch,addEventListener(){}};c.window=c;
 for(const f of ['communityClient','communitySession','communityPublicClient','communityAccount','communityMessages','communityPlugin'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../native/'+f+'.js'),'utf8'),c);
 return c;
}
const element=()=>({textContent:'',hidden:false,replaceChildren(){this.cleared=true;},setAttribute(){}});
function pluginState(c){
 const p=Object.create(c._communityPlugin.prototype),state={item:{Id:'movie',Type:'Movie'},channel:'public',scope:'work',version:0,drafts:new Map(),pages:new Map(),avatars:new Map(),urls:new Set(),rootIds:new Set(['old']),input:{value:'draft'},reply:null,dialog:element(),list:element(),pagination:element(),status:element(),topicLabel:element(),tabs:[],me:{author:{id:'a'}},topic:{id:'public-topic'},loadedKey:'public:work'};
 p.state=state;p.session=()=>emby;p.valid=s=>s===state;p.privateClient=new c.TigerestCommunityClient();p.publicClient=new c.TigerestCommunityPublicClient({setSession(){},fingerprint:'emby'});p.client=p.publicClient;p.client.setContext(emby,'movie');p.updateComposer=()=>{};p.adminButton=()=>{};
 return {p,state};
}
test('same-item private message selects private transport before resolving focus',()=>{
 const c=context(),{p,state}=pluginState(c);p.applyFocus(state,{channel:'private',scope:'work',topicId:'private-topic'});
 assert.equal(state.channel,'private');assert.equal(p.client,p.privateClient);assert.equal(state.focus.topicId,'private-topic');
});
test('unknown send outcome keeps UUID through scope roundtrip and reload cancellation',async()=>{
 const c=context(),{p,state}=pluginState(c);p.load=()=>{};let attempts=[];
 p.client.request=async(_,o)=>{attempts.push(o.body.clientRequestId);throw Error('lost response');};
 await assert.rejects(p.client.send('public-topic','draft'));p.selectContext(state,'public','episode');p.selectContext(state,'public','work');
 p.client.cancelRequests({preserveSend:true});await assert.rejects(p.client.send('public-topic','draft'));
 assert.equal(attempts.length,2);assert.equal(attempts[1],attempts[0]);
 p.client.clear();assert.equal(p.client.pendingSend,null,'identity/media changes clear retry IDs');
});
test('transient detail reload failure preserves successful content and permissions',async()=>{
 const c=context(),{p,state}=pluginState(c);p.client.me=async()=>{throw Object.assign(Error('unavailable'),{status:503});};
 await p.load(state,true);assert.equal(state.list.cleared,undefined);assert.equal(state.me.author.id,'a');assert.equal(state.topic.id,'public-topic');assert.equal(state.status.textContent,'unavailable');
});
test('mapping capability failure retries after backoff; 404 is the sole legacy signal',async()=>{
 const c=context();let status=503,probes=0,credentials=[];
 c.TigerestCommunityBridge=class{constructor(){this.store={read:async()=>null};this.setEmby=async s=>credentials.push(s);this.transport=async path=>{
  if(path==='/mapping-capabilities'){probes++;return {status,body:JSON.stringify({success:true,writeAuth:['emby-session']})};}
  return {status:200,body:JSON.stringify({data:{enabled:true,auth:['emby-exchange'],embyExchangeServerId:emby.serverId,mediaIdentity:'tmdb-aired'}})};
 };}};
 const api={serverId:()=>emby.serverId,getCurrentUserId:()=>emby.userId,accessToken:()=>emby.token,serverAddress:()=>emby.address};
 const account=c.TigerestCommunityAccount.get({currentApiClient:()=>api});await account.session.discover();await new Promise(r=>setTimeout(r,0));
 assert.equal(probes,1);await account.mappingSession(emby);assert.equal(probes,1,'backoff avoids poll storms');
 status=200;account.mappingRetryAt=0;await account.mappingSession(emby);assert.equal(probes,2);assert.equal(credentials.at(-1)?.token,emby.token);
 await account.mappingSession(null);status=404;await account.mappingSession(emby);assert.equal(credentials.at(-1)?.mappingAuth,'legacy');
 await account.mappingSession(null);status=401;await account.mappingSession(emby);assert.equal(credentials.at(-1),null);
});
test('comment account subscription emits only identity changes',async()=>{
 const c=context();c.TigerestCommunityBridge=class{constructor(){this.store={};this.setEmby=async()=>{};this.transport=async()=>{throw Error('offline');};}};
 const account=c.TigerestCommunityAccount.get({currentApiClient:()=>null}),changes=[];
 assert.equal(typeof account.subscribe,'function');account.subscribe(change=>changes.push(change));
 account.session.tokens={author:{id:'a',name:'A'}};account.session.onChange();account.session.tokens={author:{id:'a',name:'A'},accessToken:'rotated'};account.session.onChange();
 account.session.tokens=null;account.session.onChange();account.session.tokens={author:{id:'b',name:'B'}};account.session.onChange();
 assert.equal(changes.length,3);
});
test('comment identity switch invalidates hidden public drafts while preserving private draft',()=>{
 const c=context(),{p,state}=pluginState(c);state.channel='private';state.drafts.set('public:work',{text:'author A'});state.drafts.set('private:work',{text:'Emby draft'});
 p.commentIdentityChanged();assert.equal(state.drafts.has('public:work'),false);assert.equal(state.drafts.get('private:work').text,'Emby draft');
});
test('old author send completion cannot clear or unlock a new author composer',async()=>{
 const c=context(),{p,state}=pluginState(c);state.send={disabled:false};let done;p.client.send=()=>new Promise(r=>done=r);
 const send=p.submit(state);state.version++;state.input.value='new author draft';state.busy=true;done({});await send;
 assert.equal(state.input.value,'new author draft');assert.equal(state.busy,true);
});

function externalMessages(){
 const c=context();c.document={hidden:true,querySelector:()=>null};
 c.TigerestCommunityBridge=class{constructor(){this.store={};this.setEmby=async()=>{};this.transport=async()=>{throw Error('offline');};}};
 let userId='external-user';
 const api={serverId:()=> 'external-server',getCurrentUserId:()=>userId,accessToken:()=> 'private-external-token',serverAddress:()=> 'http://external.invalid'};
 const connectionManager={currentApiClient:()=>api};
 const account=c.TigerestCommunityAccount.get(connectionManager);
 const messages=new c.TigerestCommunityMessages({connectionManager,account});messages.sync();
 return {account,messages,switchUser:next=>{userId=next;account.sync();messages.sync();}};
}

test('Emby logout blocks message identity callbacks and polls until the external identity changes',()=>{
 const {account,messages,switchUser}=externalMessages();
 assert.ok(messages.client.context);
 account.reset();
 assert.equal(account.session.emby,null,'identity callback must not reattach an Emby session whose logout is pending');
 assert.equal(messages.client.context,null,'message data stays detached during pending Emby logout');
 messages.reset(true);
 for(let poll=0;poll<3;poll++){account.sync();messages.sync();}
 assert.equal(account.session.emby,null,'polling the still-present Emby token must remain blocked');
 assert.equal(messages.client.context,null);
 switchUser('new-external-user');
 assert.equal(account.session.emby.userId,'new-external-user');
 assert.ok(messages.client.context,'a different Emby identity can establish a fresh message context');
 messages.destroy();
});

test('message logout block uses the external session key and explicit sign-in can release it',()=>{
 const {account,messages}=externalMessages();
 messages.reset(true);messages.sync();
 assert.equal(messages.client.context,null,'an external session must be blocked just like a supported private session');
 // Same ordering as the plugin localusersignedin handler.
 account.blockedKey=null;account.sync();messages.reset();messages.sync();
 assert.ok(messages.client.context,'a real sign-in event explicitly releases the message block');
 messages.destroy();
});
