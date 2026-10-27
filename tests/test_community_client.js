const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(crypto = require('node:crypto').webcrypto) {
    const context = { URL, URLSearchParams, AbortController, setTimeout, clearTimeout, crypto };
    context.window = context;
    const file = path.join(__dirname, '../native/communityClient.js');
    if (fs.existsSync(file)) vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
    assert.equal(typeof context.TigerestCommunityClient, 'function', 'comment API client must be available');
    return context.TigerestCommunityClient;
}
function session(address = 'https://nas.tigerest.top:18445', token = 'test-only-token') {
    return { serverId: '62526c3bf747439c99327ddec5fed4a8', userId: 'user1', token, address };
}
function ok(data) { return new Response(JSON.stringify({data}), {status: 200}); }

test('trusted server routes LAN and remote on shared HTTP18443; other servers never receive tokens', async () => {
    const Client = load(), calls = [];
    const client = new Client({fetch: async (url, options) => {calls.push({url, options}); return ok({});}});
    client.setContext(session('http://192.168.5.150:8095'), 'item1');
    await client.me();
    assert.equal(calls[0].url, 'http://192.168.5.150:18443/community/v1/me');
    assert.equal(calls[0].options.headers['X-Emby-Token'], 'test-only-token');
    client.setContext(session(), 'item2');
    await client.resolve('episode');
    assert.equal(calls[1].url, 'https://nas.tigerest.top:18446/community/v1/topics/resolve');
    assert.deepEqual(JSON.parse(calls[1].options.body), {itemId:'item2', scope:'episode'});
    assert.equal(client.setContext({...session(), serverId:'other'}, 'item1'), false);
    await assert.rejects(client.me(), /登录/);
    assert.equal(calls.length, 2);
});
test('comments and replies carry item authorization and encode opaque cursors', async () => {
    const Client = load(), calls = [];
    const client = new Client({fetch:async (url, options) => {calls.push({url, options}); return ok({items:[]});}});
    client.setContext(session(), 'a/b');
    await client.comments('topic1', 'a+/=');
    await client.replies('root1', 'opaque cursor');
    await client.remove('comment1');
    for (const call of calls) assert.equal(call.options.headers['X-Tigerest-Item-Id'], 'a/b');
    assert.equal(new URL(calls[0].url).searchParams.get('cursor'), 'a+/=');
    assert.equal(new URL(calls[0].url).searchParams.get('limit'), '10', 'root comment pages are bounded to 10');
    assert.equal(new URL(calls[1].url).searchParams.get('limit'), '20', 'reply pagination keeps its existing batch size');
    assert.equal(calls[2].options.method, 'DELETE');
});
test('lost response retry reuses payload UUID; different text uses a new UUID', async () => {
    const Client = load(), bodies = []; let now = 1000;
    const client = new Client({now:() => now, fetch:async (url, options) => {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) throw new TypeError('network details containing test-only-token');
        return ok({comment:{id:'saved'}});
    }});
    client.setContext(session(), 'item');
    await assert.rejects(client.send('topic', ' 你好 ', null), /网络/);
    await client.send('topic', ' 你好 ', null);
    assert.equal(bodies[0].clientRequestId, bodies[1].clientRequestId);
    assert.match(bodies[0].clientRequestId, /^[0-9a-f-]{36}$/);
    now += 3000;
    await client.send('topic', '另一条', {rootId:'root', id:'reply'});
    assert.notEqual(bodies[2].clientRequestId, bodies[1].clientRequestId);
    assert.equal(bodies[2].replyToId, 'reply');
});
test('account/item change aborts in-flight reads and rejects stale responses', async () => {
    const Client = load(); let release, signal;
    const client = new Client({fetch: (url, options) => {signal=options.signal; return new Promise(r => release=r);}});
    client.setContext(session(), 'old');
    const pending = client.comments('old-topic');
    client.setContext(session(undefined, 'new-token'), 'new');
    assert.equal(signal.aborted, true);
    release(ok({items:[{body:'old private text'}]}));
    await assert.rejects(pending, error => error.name === 'AbortError');
});
test('429 blocks writes until Retry-After and errors do not expose server messages or tokens', async () => {
    const Client = load(); let now = 1000, calls=0;
    const client = new Client({now:() => now, fetch:async () => {
        calls++; return new Response(JSON.stringify({error:{code:'RATE_LIMITED', message:'test-only-token'}}),
            {status:429, headers:{'Retry-After':'5'}});
    }});
    client.setContext(session(), 'item');
    await assert.rejects(client.send('topic', 'text'), error => error.retryAfter===5 && !error.message.includes('test-only-token'));
    await assert.rejects(client.send('topic', 'text'), /5 秒/);
    assert.equal(calls, 1);
    now += 5000;
    await assert.rejects(client.send('topic', 'text'));
    assert.equal(calls, 2);
});
test('avatar paths cannot exfiltrate credentials and plaintext length counts Unicode', async () => {
    const Client = load(); let calls=0;
    const client = new Client({fetch:async () => {calls++; return new Response(new Uint8Array([1]), {headers:{'Content-Type':'image/png'}});}});
    client.setContext(session(), 'item');
    await assert.rejects(client.avatar('https://evil.invalid/avatar'));
    await assert.rejects(client.send('topic', '😀'.repeat(2001)), /2000/);
    assert.equal(calls, 0);
    const blob = await client.avatar('/community/v1/avatars/author?v=123');
    assert.equal(blob.type, 'image/png');
});
test('HTTP pages without randomUUID still generate valid idempotency UUIDs', async () => {
    const webcrypto=require('node:crypto').webcrypto;
    const Client=load({getRandomValues:webcrypto.getRandomValues.bind(webcrypto)});
    let payload;
    const client=new Client({fetch:async (url,options)=>{payload=JSON.parse(options.body);return ok({});}});
    client.setContext(session(),'item');await client.send('topic','HTTP 正文');
    assert.match(payload.clientRequestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('message lists use account context without an item; detail reads still require item authorization', async () => {
    const Client=load(), calls=[];
    const client=new Client({fetch:async(url,options)=>{calls.push({url,options});return ok({items:[]});}});
    assert.equal(client.setSession(session()),true);
    await client.messageSummary();await client.messages('sent','a+/=');await client.messages('replies');
    assert.equal(new URL(calls[0].url).pathname,'/community/v1/me/messages');
    assert.equal(new URL(calls[0].url).searchParams.get('limit'),'1');
    assert.equal(new URL(calls[1].url).pathname,'/community/v1/me/comments');
    assert.equal(new URL(calls[2].url).pathname,'/community/v1/me/messages');
    assert.equal(new URL(calls[1].url).searchParams.get('cursor'),'a+/=');
    for(const call of calls)assert.equal(call.options.headers['X-Tigerest-Item-Id'],undefined);
    await assert.rejects(client.comments('topic'),/详情/);
    await assert.rejects(client.messages('everyone'),/类型/);
    assert.equal(calls.length,3);
    assert.equal(client.setSession({...session(),serverId:'other'}),false);
    await assert.rejects(client.messageSummary(),/登录/);
});

test('read state posts notification IDs or an opaque account snapshot to the deployed endpoint', async () => {
    const Client=load(),calls=[];
    const client=new Client({fetch:async(url,options)=>{calls.push({url,options});return ok({});}});
    client.setSession(session());
    const through='snapshot.opaque+/=not-a-date';
    await client.readMessage('a/b');await client.readAllMessages(through);
    assert.match(calls[0].url,/me\/messages$/);assert.equal(calls[0].options.method,'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body),{messageIds:['a/b']});
    assert.deepEqual(JSON.parse(calls[1].options.body),{readThroughToken:through});
    await assert.rejects(client.readAllMessages(''),/刷新/);
    for(const call of calls)assert.equal(call.options.headers['X-Tigerest-Item-Id'],undefined);
    assert.equal(calls.length,2);
});

test('private report retries preserve their UUID and only send documented diagnostic fields', async () => {
    const Client=load(),calls=[];let fail=true;
    const client=new Client({fetch:async(url,options)=>{
        calls.push({url,options});if(fail){fail=false;throw Error('lost response');}return ok({report:{id:'report1'},replayed:true});
    }});
    client.setSession(session());
    const context={platform:'Android',clientVersion:'2.4.3',positionSeconds:720,token:'never-send',playbackUrl:'never-send'};
    await assert.rejects(client.sendReport('episode','subtitle_error','字幕比声音提前了大约三秒。',context),/网络/);
    await client.sendReport('episode','subtitle_error','字幕比声音提前了大约三秒。',context);
    const first=JSON.parse(calls[0].options.body),retry=JSON.parse(calls[1].options.body);
    assert.deepEqual(first,retry);assert.match(first.clientRequestId,/^[0-9a-f-]{36}$/);
    assert.deepEqual(first.context,{positionSeconds:720,platform:'Android',clientVersion:'2.4.3'});
    assert.equal(calls[0].url,'https://nas.tigerest.top:18446/community/v1/reports');
    assert.equal(calls[0].options.headers['X-Tigerest-Item-Id'],undefined);
    await client.reports('open','cursor+/=');await client.report('report/1');
    assert.equal(new URL(calls[2].url).searchParams.get('status'),'open');
    assert.equal(new URL(calls[2].url).searchParams.get('cursor'),'cursor+/=');
    assert.match(calls[3].url,/me\/reports\/report%2F1$/);
});

test('report validation and throttling do not block comment sends or leak account retry state', async () => {
    const Client=load();let reportCalls=0,commentCalls=0;
    const client=new Client({fetch:async(url)=>{
        if(url.endsWith('/reports')){reportCalls++;return new Response(JSON.stringify({error:{code:'RATE_LIMITED'}}),{status:429,headers:{'Retry-After':'5'}});}
        commentCalls++;return ok({});
    }});
    client.setContext(session(),'movie');
    await assert.rejects(client.sendReport('movie','other',' 太短 '),/3/);
    await assert.rejects(client.sendReport('movie','unknown','说明足够长但问题类型不正确。'),/类型/);
    await assert.rejects(client.sendReport('movie','other','😀'.repeat(2001)),/2000/);
    assert.equal(reportCalls,0);
    await assert.rejects(client.sendReport('movie','playback_error','播放后始终黑屏且没有任何声音。'),error=>error.retryAfter===5);
    await client.send('topic','普通评论');assert.equal(commentCalls,1);
    await assert.rejects(client.sendReport('movie','playback_error','播放后始终黑屏且没有任何声音。'),/5 秒/);
    assert.equal(reportCalls,1);
    client.setSession(session(undefined,'new-account'));assert.equal(client.pendingReport,null);
});

test('reports accept a trimmed three-character description, including Unicode characters', async () => {
    const Client=load(),bodies=[];let now=1000;
    const client=new Client({now:()=>now,fetch:async(_,options)=>{bodies.push(JSON.parse(options.body));return ok({report:{id:'report'}});}});
    client.setContext(session(),'movie');
    await client.sendReport('movie','other',' 没弹幕 ');
    now+=3001;
    await client.sendReport('movie','other',' 😀😀😀 ');
    assert.deepEqual(bodies.map(body=>body.description),['没弹幕','😀😀😀']);
});

test('anchors locate roots and replies with item authorization and never share a query with a cursor', async () => {
    const Client=load(),calls=[];
    const client=new Client({fetch:async(url,options)=>{calls.push({url,options});return ok({items:[]});}});
    client.setContext(session(),'episode');
    await client.comments('topic',null,'root+/=');
    await client.replies('root',null,'reply+/=');
    assert.equal(new URL(calls[0].url).searchParams.get('anchorId'),'root+/=');
    assert.equal(new URL(calls[1].url).searchParams.get('anchorId'),'reply+/=');
    for(const call of calls){assert.equal(call.options.headers['X-Tigerest-Item-Id'],'episode');assert.equal(new URL(call.url).searchParams.has('cursor'),false);}
    await assert.rejects(client.comments('topic','cursor','root'),/分页/);
    await client.messages('replies','opaque',true);
    const url=new URL(calls[2].url);
    assert.equal(url.searchParams.get('unreadOnly'),'true');
    assert.equal(url.searchParams.get('cursor'),'opaque');
    assert.equal(calls[2].options.headers['X-Tigerest-Item-Id'],undefined);
});

test('account-wide requests are aborted when the identity changes or authentication expires', async () => {
    const Client=load();let release,signal;
    const client=new Client({fetch:(url,options)=>{signal=options.signal;return new Promise(r=>release=r);}});
    client.setSession(session());const pending=client.messages('replies');
    client.setSession(session(undefined,'different-token'));assert.equal(signal.aborted,true);
    release(ok({items:[{body:'private old reply'}]}));
    await assert.rejects(pending,error=>error.name==='AbortError');
    const invalid=new Client({fetch:async()=>new Response(JSON.stringify({error:{code:'AUTH_INVALID'}}),{status:401})});
    invalid.setSession(session());await assert.rejects(invalid.messageSummary(),error=>error.status===401);
    assert.equal(invalid.context,null);
});

const diagnosticSnapshot=()=>({capturedAt:'2026-10-09T01:02:03.12Z',truncated:false,logText:'已脱敏的播放错误\n[redacted]'});
test('diagnostics use an immutable exact four-field attachment and upload after the report without item authorization', async()=>{
    const Client=load(),calls=[];
    const client=new Client({fetch:async(url,options)=>{calls.push({url,options});return ok(url.endsWith('/reports')?{report:{id:'report-id'}}:{diagnostics:{id:'attachment-id'}});}});
    client.setContext(session(),'episode');
    const snapshot=diagnosticSnapshot(),payload=client.createReportDiagnostics(snapshot);
    snapshot.logText='later snapshot must not replace the first capture';
    assert.equal(Object.isFrozen(payload),true);
    assert.deepEqual(Object.keys(payload).sort(),['capturedAt','clientRequestId','logText','truncated']);
    const saved=await client.sendReport('episode','playback_error','播放时出现黑屏且没有正常声音。');
    await client.uploadReportDiagnostics(saved.report.id,payload);
    assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.options.method]),[
        ['/community/v1/reports','POST'],['/community/v1/reports/report-id/diagnostics','PUT']]);
    const sent=JSON.parse(calls[1].options.body);
    assert.equal(sent.logText,'已脱敏的播放错误\n[redacted]');
    assert.match(sent.clientRequestId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    assert.equal(calls[1].options.headers['X-Tigerest-Item-Id'],undefined);
    assert.equal(calls[1].options.headers['Content-Type'],'application/json');
});
test('diagnostics reject malformed UTC, controls, Unicode and byte overflow before transport', async()=>{
    const Client=load();let calls=0;
    const client=new Client({fetch:async()=>{calls++;return ok({});}});client.setSession(session());
    const invalid=[{capturedAt:'2026-02-30T01:02:03Z'},{capturedAt:'2026-10-09T01:02:03+00:00'},
        {capturedAt:'2026-10-09T01:02:03.1234Z'},{capturedAt:'2026-10-09T24:02:03Z'},
        {truncated:0},{logText:''},{logText:'abc\0def'},{logText:'abc\u001bdef'},{logText:'abc\u007fdef'},
        {logText:'\ud800'},{logText:'\udfff'},{logText:'😀'.repeat(262145)}];
    for(const change of invalid)assert.throws(()=>client.createReportDiagnostics({...diagnosticSnapshot(),...change}),/日志/);
    const boundary=client.createReportDiagnostics({...diagnosticSnapshot(),logText:'😀'.repeat(262144)});
    await client.uploadReportDiagnostics('report',boundary);assert.equal(calls,1);
    await assert.rejects(client.uploadReportDiagnostics('report',{...boundary,clientRequestId:'invalid'}),/日志/);
    await assert.rejects(client.uploadReportDiagnostics('report',{...boundary,token:'never-send'}),/日志/);
    assert.equal(calls,1);
});
test('attachment retries freeze the payload and have an independent Retry-After cooldown',async()=>{
    const Client=load(),calls=[];let now=1000,attempt=0;
    const client=new Client({now:()=>now,fetch:async(url,options)=>{
        calls.push({url,options});
        if(url.endsWith('/diagnostics')){attempt++;if(attempt===1)throw Error('lost secret response');if(attempt===2)return new Response(JSON.stringify({error:{code:'RATE_LIMITED',message:'private-log-text'}}),{status:429,headers:{'Retry-After':'7'}});}
        return ok(url.endsWith('/reports')?{report:{id:'saved'}}:{diagnostics:{id:'stored'}});
    }});client.setContext(session(),'episode');
    const payload=client.createReportDiagnostics(diagnosticSnapshot());
    await client.sendReport('episode','other','播放时出现黑屏且没有正常声音。');
    await assert.rejects(client.uploadReportDiagnostics('saved',payload),/网络/);
    await assert.rejects(client.uploadReportDiagnostics('saved',payload),e=>e.retryAfter===7&&!e.message.includes('private-log-text'));
    now+=3000;await client.sendReport('episode','other','这一条报错仍可独立提交给管理员。');
    await client.send('topic','评论仍可发送');
    await assert.rejects(client.uploadReportDiagnostics('saved',payload),/4 秒/);
    now+=4000;await client.uploadReportDiagnostics('saved',payload);
    const uploads=calls.filter(c=>c.url.endsWith('/diagnostics'));
    assert.equal(uploads.length,3);assert.equal(new Set(uploads.map(c=>c.options.body)).size,1);
    assert.equal(calls.filter(c=>c.url.endsWith('/reports')).length,2);
});
test('401, conflict, cancellation and account changes stop reuse of a captured attachment',async()=>{
    for(const status of [401,409]){
        const Client=load();let calls=0;
        const client=new Client({fetch:async()=>{calls++;return new Response(JSON.stringify({error:{code:status===401?'AUTH_INVALID':'DIAGNOSTICS_ALREADY_EXISTS',message:'secret backend text'}}),{status});}});
        client.setSession(session());const payload=client.createReportDiagnostics(diagnosticSnapshot());
        await assert.rejects(client.uploadReportDiagnostics('saved',payload),e=>e.status===status&&!e.message.includes('secret'));
        await assert.rejects(client.uploadReportDiagnostics('saved',payload));assert.equal(calls,1);
    }
    const Client=load();let calls=0;
    const client=new Client({fetch:async()=>{calls++;return ok({});}});client.setSession(session());
    let payload=client.createReportDiagnostics(diagnosticSnapshot());client.cancelRequests();
    await assert.rejects(client.uploadReportDiagnostics('saved',payload));
    payload=client.createReportDiagnostics(diagnosticSnapshot());client.setSession(session(undefined,'replacement-account'));
    await assert.rejects(client.uploadReportDiagnostics('saved',payload));assert.equal(calls,0);
});
test('closing a report aborts only report requests and invalidates the captured payload',async()=>{
    const Client=load(),pending=[];
    const client=new Client({fetch:(url,options)=>new Promise(resolve=>pending.push({url,signal:options.signal,resolve}))});
    client.setSession(session());const payload=client.createReportDiagnostics(diagnosticSnapshot());
    const summary=client.messageSummary(),upload=client.uploadReportDiagnostics('saved',payload);
    client.cancelReportRequests();
    assert.equal(pending[0].signal.aborted,false);assert.equal(pending[1].signal.aborted,true);
    pending[0].resolve(ok({unreadCount:3}));pending[1].resolve(ok({diagnostics:{id:'stale'}}));
    assert.equal((await summary).unreadCount,3);await assert.rejects(upload,e=>e.name==='AbortError');
    await assert.rejects(client.uploadReportDiagnostics('saved',payload));assert.equal(pending.length,2);
});
test('non-JSON authentication and rate-limit errors still stop or delay attachment uploads',async()=>{
    for(const status of [401,409,429]){
        const Client=load();let calls=0;
        const client=new Client({now:()=>1000,fetch:async()=>{calls++;return new Response('private gateway error text',{status,headers:{'Retry-After':'8'}});}});
        client.setSession(session());const payload=client.createReportDiagnostics(diagnosticSnapshot());
        await assert.rejects(client.uploadReportDiagnostics('saved',payload),e=>e.status===status&&!e.message.includes('private gateway'));
        await assert.rejects(client.uploadReportDiagnostics('saved',payload));assert.equal(calls,1);
        if(status===401)assert.equal(client.context,null);
        if(status===429)assert.equal(client.diagnosticsCooldownUntil,9000);
    }
});
