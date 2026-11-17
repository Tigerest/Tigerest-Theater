#!/usr/bin/env python3
"""Isolated fixtures; loopback by default, optional LAN binding for device tests."""
import argparse,http.server,json,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=18768);parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--media',type=Path,required=True);args=parser.parse_args()
lifecycle_started=threading.Event()
# Prefixes that accept connections and never answer: an address that does not
# respond, like the home network's address away from home (issue #42).
silent=set()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith(('/silence/','/unsilence/')):
            name=self.path.split('/')[2]
            (silent.add if self.path.startswith('/silence/') else silent.discard)(name)
            data=b'{}';mime='application/json'
        elif self.path.split('/')[1] in silent:
            time.sleep(30);return
        elif self.path == '/selection-hold.png':
            time.sleep(8);data=b'';mime='image/png'
        elif self.path.startswith('/selection-') and self.path.endswith('/System/Info/Public'):
            data=json.dumps({'Id':self.path.split('/')[1],'Version':'10.11.11'}).encode();mime='application/json'
        elif self.path.startswith('/selection-') and '/web/index.html' in self.path:
            if self.path.startswith('/selection-denied/'):
                self.send_error(403);return
            if self.path.startswith('/selection-disconnected/'):
                self.connection.shutdown(2);self.connection.close();return
            data=(ROOT/'Tests/fixtures/server-selection.html').read_bytes();mime='text/html; charset=utf-8'
        elif self.path=='/lifecycle/slow/System/Info/Public':
            lifecycle_started.set();time.sleep(3)
            data=json.dumps({'Id':'delayed-fixture','Version':'4.9'}).encode();mime='application/json'
        elif self.path=='/lifecycle/started':
            data=json.dumps({'started':lifecycle_started.is_set()}).encode();mime='application/json'
        elif self.path.startswith('/api/v2/search/anime'):
            data=json.dumps({'success':True,'animes':[{'type':'tvseries','bangumiId':'123','animeTitle':'弹幕验收作品'}]}).encode();mime='application/json'
        elif self.path.startswith('/api/v2/bangumi/123'):
            data=json.dumps({'success':True,'bangumi':{'episodes':[{'episodeId':1230001,'episodeNumber':'1','episodeTitle':'第1话 开始'}]}}).encode();mime='application/json'
        elif self.path.startswith('/api/v2/comment/1230001'):
            data=json.dumps({'success':True,'comments':[{'p':'0,1,16777215','m':'滚动弹幕验收'},{'p':'1,5,16776960','m':'顶部弹幕验收'},{'p':'1,4,65280','m':'底部弹幕验收'}]},ensure_ascii=False).encode();mime='application/json'
        elif self.path.startswith('/sub/System/Info/Public'):
            data=json.dumps({'Id':'fixture','Version':'4.9'}).encode();mime='application/json'
        elif self.path.startswith('/sub/web/index.html'):
            if 'bridge-reopened=1' not in self.path:lifecycle_started.clear()
            data=(ROOT/'Tests/fixtures/index.html').read_bytes();mime='text/html; charset=utf-8'
        elif self.path=='/fixture.mp4':
            data=args.media.read_bytes();mime='video/mp4'
        else:
            self.send_error(404);return
        start=0;end=len(data)-1;code=200
        raw=self.headers.get('Range','')
        if raw.startswith('bytes='):
            fields=raw[6:].split('-',1)
            try:start=int(fields[0]);end=int(fields[1]) if fields[1] else end
            except ValueError:self.send_error(400);return
            if start>=len(data):self.send_response(416);self.send_header('Content-Range',f'bytes */{len(data)}');self.end_headers();return
            code=206;end=min(end,len(data)-1)
        self.send_response(code);self.send_header('Content-Type',mime);self.send_header('ETag','"fixture-v1"');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
        if code==206:self.send_header('Content-Range',f'bytes {start}-{end}/{len(data)}')
        self.end_headers()
        try:self.wfile.write(data[start:end+1])
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*args):pass
http.server.ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
