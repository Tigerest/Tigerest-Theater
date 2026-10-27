// Comment-network compliance (terms, reports, blocks, deletion) against the v2 session.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function load(){
 const c={URL,URLSearchParams,AbortController,setTimeout,clearTimeout,crypto:require("node:crypto").webcrypto,fetch};c.window=c;
 for(const f of ['communityClient','communitySession','communityPublicClient'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../native/'+f+'.js'),'utf8'),c);
 return c;
}
const guid='62526c3bf747439c99327ddec5fed4a8';
const emby={serverId:guid,userId:'u1',token:'EMBY-PRIVATE',address:'https://nas.tigerest.top:18445'};
const terms={version:'2026-10-24',url:'https://nas.tigerest.top:18446/community/v2/terms',contact:'mailto:owner@example.com'};
const moderation={flagReasons:['spam','harassment','sexual','illegal','other'],blocks:true,accountDeletion:{authKinds:['password','emby']},terms};
const caps={enabled:true,auth:['password','emby-exchange'],embyExchangeServerId:guid,registrationEnabled:true,mediaIdentity:'tmdb-aired',moderation};
function tokens(id='1'){return {accessToken:'access'+id,refreshToken:'refresh'+id,tokenType:'Bearer',expiresAt:new Date(9999999999999).toISOString(),refreshExpiresAt:new Date(9999999999999).toISOString(),author:{id:'author',name:'Tester'}};}
function response(data,status=200){return {status,headers:{},body:JSON.stringify(status<400?{data}:{error:{code:data},requestId:'11111111-1111-4111-8111-111111111111'})};}
function harness(handler){
 const c=load(),calls=[],saved=new Map();
 const s=new c.TigerestCommunitySession({transport:async(p,o)=>{calls.push([p,o]);const r=handler?.(p,o);return r||response(p==='/capabilities'?caps:p.startsWith('/auth/')?tokens():{author:{id:'author',name:'Tester'}});},
  store:{read:async k=>saved.get(k)||null,write:async(k,v)=>{saved.set(k,v);return true;},remove:async k=>saved.delete(k)}});
 return {c,s,calls,saved};
}
const external={...emby,serverId:'external'};
const body=call=>call[1].body===undefined?undefined:JSON.parse(call[1].body);

test('registration sends the terms version only after the user agrees',async()=>{
 const {s,calls}=harness();s.setSession(external);
 await assert.rejects(s.register('tester','Tester','valid-password'),/同意使用条款/);
 assert.ok(!calls.some(c=>c[0]==='/auth/register'),'no account is created without consent');
 await s.register('tester','Tester','valid-password','valid-password',terms.version);
 assert.equal(body(calls.find(c=>c[0]==='/auth/register')).acceptedTermsVersion,terms.version);
});

test('an older service without moderation keeps the original registration body',async()=>{
 const {s,calls}=harness(p=>p==='/capabilities'?response({...caps,moderation:undefined}):null);s.setSession(external);
 await s.register('tester','Tester','valid-password');
 assert.equal('acceptedTermsVersion' in body(calls.find(c=>c[0]==='/auth/register')),false);
 assert.equal(s.terms(),null);
});

test('outdated terms refresh capabilities and are never agreed to automatically',async()=>{
 const {s,calls}=harness(p=>p==='/me/terms'?response('TERMS_OUTDATED',409):null);s.setSession(emby);
 await assert.rejects(s.acceptTerms(terms.version),e=>e.code==='TERMS_OUTDATED');
 assert.equal(calls.filter(c=>c[0]==='/me/terms').length,1);
 assert.equal(calls.filter(c=>c[0]==='/capabilities').length,2,'capabilities are read again for the new version');
});

test('reports keep their UUID; blocks send no body',async()=>{
 const {c,s,calls}=harness();s.setSession(emby);
 const client=new c.TigerestCommunityPublicClient(s);client.setContext(emby,'item');
 await client.flag('comment-1','spam','',client.constructor.uuid());
 await client.block('author-2');await client.unblock('author-2');await client.blocks();
 const flag=calls.find(c=>c[0]==='/comments/comment-1/flags');
 assert.equal(flag[1].method,'POST');assert.equal(body(flag).reason,'spam');assert.equal('note' in body(flag),false);
 assert.match(body(flag).clientRequestId,/^[0-9a-f-]{36}$/);
 const put=calls.find(c=>c[0]==='/me/blocks/author-2'&&c[1].method==='PUT');
 assert.equal(put[1].body,undefined,'PUT carries no {}');
 assert.ok(calls.some(c=>c[0]==='/me/blocks/author-2'&&c[1].method==='DELETE'));
 assert.ok(calls.some(c=>c[0].startsWith('/me/blocks?limit=')));
 assert.ok([flag,put].every(c=>c[1].headers.Authorization==='Bearer access1'&&!c[1].headers['X-Emby-Token']));
});

test('deleting an Emby identity never exchanges again until the user rejoins',async()=>{
 const {s,calls,saved}=harness();s.setSession(emby);
 await s.ready();
 assert.equal(await s.deleteAccount(),true);
 const request=calls.find(c=>c[0]==='/me/delete');
 assert.deepEqual(body(request),{confirm:'DELETE'});
 assert.equal(request[1].headers['X-Emby-Token'],undefined);
 assert.deepEqual(JSON.parse(saved.get(s.key)),{left:true});
 const exchanges=calls.filter(c=>c[0]==='/auth/emby').length;
 // A restart reads the marker back from secure storage.
 s.setSession(null);s.setSession(emby);
 await assert.rejects(s.ready(),e=>e.code==='COMMUNITY_LEFT');
 assert.equal(calls.filter(c=>c[0]==='/auth/emby').length,exchanges,'no automatic exchange after deletion');
 await s.rejoin();
 assert.equal(calls.filter(c=>c[0]==='/auth/emby').length,exchanges+1);
 assert.equal(s.left,false);
});

test('a wrong password keeps the account and is never resubmitted',async()=>{
 const {s,calls}=harness(p=>p==='/me/delete'?response('AUTH_INVALID',401):null);s.setSession(external);
 await s.login('tester','valid-password');
 await assert.rejects(s.deleteAccount('wrong-password'),/密码不正确/);
 assert.equal(calls.filter(c=>c[0]==='/me/delete').length,1);
 assert.ok(s.tokens,'the session survives');
 assert.deepEqual(body(calls.find(c=>c[0]==='/me/delete')),{password:'wrong-password',confirm:'DELETE'});
});

test('an ended session during deletion is reported as unknown, not as success',async()=>{
 const {s,calls,saved}=harness(p=>['/me/delete','/me'].includes(p)?response('AUTH_INVALID',401):null);s.setSession(external);
 await s.login('tester','valid-password');
 await assert.rejects(s.deleteAccount('valid-password'),e=>e.code==='AUTH_REQUIRED'&&/无法确认/.test(e.message));
 assert.equal(s.tokens,null);assert.equal(saved.has(s.key),false);
 assert.ok(!calls.some(c=>c[0]==='/auth/refresh'||c[0]==='/auth/register'),'nothing recreates the identity');
});
