// Real Android WebView, isolated fake HTTP/Emby identity; no production writes.
const fs=require('node:fs'),http=require('node:http');
const {connect,run,delay}=require('./cdp.cjs');
module.exports=async function(routes,work,{settings={}}={}){
 const server=http.createServer((req,res)=>{const route=routes[new URL(req.url,'http://fixture').pathname];if(!route){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',route.type||'text/javascript; charset=utf-8');for(const [name,value] of Object.entries(route.headers||{}))res.setHeader(name,value);res.end(route.path?fs.readFileSync(route.path):route.body);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,url='http://127.0.0.1:'+port;let c;
 try{
  run('reverse','tcp:'+port,'tcp:'+port);run('shell','am','force-stop','top.tigerest.theater.debug');
  run('shell','am','start','-n','top.tigerest.theater.debug/top.tigerest.theater.MainActivity','--es','url',url);
  c=await connect();for(let i=0;i<150;i++){if(await c.evaluate('document.readyState==="complete"&&!!window.api'))break;await delay(100);}
  for(const [section,values]of Object.entries(settings))for(const [key,value]of Object.entries(values))await c.evaluate(`api.settings.setValue(${JSON.stringify(section)},${JSON.stringify(key)},${JSON.stringify(value)})`);
  await work({url,call:c.call,evaluate:c.evaluate,webengine:true});
 }finally{c?.close();run('reverse','--remove','tcp:'+port);await new Promise(r=>server.close(r));}
};
