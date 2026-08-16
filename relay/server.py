#!/usr/bin/env python3
import json, os, re, sys, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.getenv('RELAY_HOST', '127.0.0.1')
PORT = int(os.getenv('RELAY_PORT', '8787'))
TOKEN = os.getenv('RELAY_TOKEN', 'change-me')
UA = os.getenv('RELAY_UA', 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36')
API_HOSTS = {'cinema.albox.co', 'api.themoviedb.org'}
STREAM_SUFFIXES = ('.albox.co',)

def host_allowed(url, stream=False):
    try:
        p = urllib.parse.urlparse(url)
        h = (p.hostname or '').lower()
        if p.scheme not in ('http', 'https'):
            return False
        if h in API_HOSTS:
            return True
        return stream and any(h.endswith(s) for s in STREAM_SUFFIXES)
    except Exception:
        return False

def upstream(url, extra=None):
    headers = {'User-Agent': UA, 'Accept': '*/*'}
    if extra: headers.update(extra)
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30)

def public_stream_url(base, url):
    return base + '/stream?url=' + urllib.parse.quote(url, safe='')

def rewrite_playlist(text, source_url, base):
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            def repl(m):
                u = urllib.parse.urljoin(source_url, m.group(1))
                return 'URI="' + public_stream_url(base, u) + '"' if host_allowed(u, True) else m.group(0)
            lines.append(re.sub(r'URI="([^"]+)"', repl, line))
            continue
        if stripped:
            u = urllib.parse.urljoin(source_url, stripped)
            lines.append(public_stream_url(base, u) if host_allowed(u, True) else stripped)
        else:
            lines.append('')
    return '\n'.join(lines) + '\n'

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))
    def json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(data))); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(data)
    def base(self):
        host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host')
        proto = self.headers.get('X-Forwarded-Proto', 'https')
        return proto + '://' + host + '/r/' + TOKEN
    def authorized(self, path): return path.startswith('/r/' + TOKEN + '/')
    def do_GET(self):
        p=urllib.parse.urlparse(self.path)
        if not self.authorized(p.path): self.json(404, {'error':'not found'}); return
        rel=p.path[len('/r/' + TOKEN):]; q=urllib.parse.parse_qs(p.query)
        if rel == '/health': self.json(200, {'ok':True,'relay':'test2-phone-relay'}); return
        url=q.get('url',[''])[0]
        if not url: self.json(400, {'error':'missing url'}); return
        if rel == '/fetch':
            if not host_allowed(url, False): self.json(403, {'error':'API host not allowed'}); return
            try:
                with upstream(url, {'Accept':'application/json, text/plain, */*','Referer':'https://cinema.albox.co/'}) as r:
                    data=r.read(); ctype=r.headers.get('Content-Type','application/json')
                self.send_response(200); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(data))); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(data)
            except Exception as e: self.json(502, {'error':'upstream','detail':str(e)[:300]})
            return
        if rel == '/stream':
            if not host_allowed(url, True): self.json(403, {'error':'stream host not allowed'}); return
            try:
                with upstream(url, {'Accept':'*/*','Referer':'https://cinema.albox.co/'}) as r:
                    ctype=r.headers.get('Content-Type',''); final_url=r.geturl()
                    if 'mpegurl' in ctype.lower() or final_url.lower().split('?',1)[0].endswith('.m3u8'):
                        data=rewrite_playlist(r.read().decode('utf-8',errors='replace'), final_url, self.base()).encode()
                        self.send_response(200); self.send_header('Content-Type','application/vnd.apple.mpegurl'); self.send_header('Content-Length',str(len(data))); self.send_header('Cache-Control','no-store'); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(data)
                    else:
                        self.send_response(200); self.send_header('Content-Type',ctype or 'application/octet-stream')
                        if r.headers.get('Content-Length'): self.send_header('Content-Length',r.headers['Content-Length'])
                        self.send_header('Accept-Ranges','bytes'); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
                        while True:
                            chunk=r.read(262144)
                            if not chunk: break
                            self.wfile.write(chunk); self.wfile.flush()
            except Exception as e:
                try: self.json(502, {'error':'stream','detail':str(e)[:300]})
                except Exception: pass
            return
        self.json(404, {'error':'not found'})

if __name__ == '__main__':
    if TOKEN == 'change-me': raise SystemExit('Set RELAY_TOKEN first')
    print(f'Phone relay listening on {HOST}:{PORT}', flush=True)
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
