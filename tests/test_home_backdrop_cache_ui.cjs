const assert=require('node:assert/strict'),path=require('node:path'),withBrowser=require('./community_browser.cjs');
const embedded=process.argv.includes('--webengine');
const art=color=>`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="${color}"/></svg>`;
const routes={
 '/':{type:'text/html',body:'<style>body{margin:0}#art{position:fixed;inset:0}#art img{width:100%;height:100%;object-fit:cover}</style><div id="art"></div>'+(embedded?'':'<script src="/backdrop.js"></script>')},
 '/backdrop.js':{path:path.join(__dirname,'../native/homeBackdrop.js')},
 '/Items/work/Images/Primary':{type:'image/svg+xml',body:art('#f02010')},
 '/shared/home-art/anime.svg':{type:'image/svg+xml',body:art('#20a040')}
};
withBrowser(routes,async({evaluate})=>{
 await evaluate(`window.TigerestHomeTransitions?.dispose?.();
  window.decodeCount=0;window.nativeBitmap=createImageBitmap;
  window.createImageBitmap=(source,...args)=>{if(source instanceof HTMLImageElement)decodeCount++;return nativeBitmap(source,...args);};
  window.sample=async(tag,fraction=1)=>{
   const img=new Image();img.src='/Items/work/Images/Primary?tag='+tag;await img.decode();
   const root=document.querySelector('#art');root.replaceChildren(img);img.style.width=(fraction*100)+"%";
   const result=await TigerestHomeBackdrop.build(root,new AbortController().signal);
   if(!result)throw Error('backdrop build failed');
   const canvas=document.createElement('canvas');canvas.width=result.width;canvas.height=result.height;
   const ctx=canvas.getContext('2d');ctx.drawImage(result.bitmap,0,0);result.bitmap.close();
   return {decodes:decodeCount,color:Array.from(ctx.getImageData(Math.floor(canvas.width*fraction/2),canvas.height>>1,1,1).data)};
  };true;`);
 const first=await evaluate('sample("one")');
 assert.deepEqual(first,{decodes:1,color:[240,32,16,255]});
 const repeated=await evaluate('sample("one")');
 assert.deepEqual(repeated,{decodes:1,color:first.color},'fresh controls reuse pixels after the previous worker has closed its own inputs');
 assert.deepEqual(await evaluate('sample("one",.5)'),{decodes:1,color:first.color},'the smaller panel reuses and rescales a retained larger backdrop');
 routes['/Items/work/Images/Primary'].body=art('#1040e0');
 assert.deepEqual(await evaluate('sample("two")'),{decodes:2,color:[16,64,224,255]},'a changed image version replaces the pixels, not just the cache key');
 // Artwork bundled with the client, under its script path, is immutable too.
 assert.equal(await evaluate(`(async()=>{window.jmpInfo={...window.jmpInfo,scriptPath:location.origin+'/shared'};const before=decodeCount;
  for(let i=0;i<2;i++){const img=new Image();img.src='/shared/home-art/anime.svg';await img.decode();const root=document.querySelector('#art');root.replaceChildren(img);
   const result=await TigerestHomeBackdrop.build(root,new AbortController().signal);if(!result)throw Error('backdrop build failed');result.bitmap.close();}
  return decodeCount-before;})()`),1,'bundled artwork is decoded once');
 await evaluate('TigerestHomeBackdrop.dispose();window.createImageBitmap=nativeBitmap;true');
 console.log('decoded artwork cache: source reuse, transfer ownership and changed-version pixels passed');
},{gpu:true,visible:true}).catch(error=>{console.error(error);process.exitCode=1;});
