#!/usr/bin/env python3
import http.server
import json
import os
import re
import socketserver
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.environ.get("RELAY_PORT", "8787"))
TOKEN = os.environ.get("RELAY_TOKEN", "")
ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("RELAY_ALLOWED_HOSTS", "cinema.albox.co").split(",")
    if h.strip()
}
ALLOW_ANY_HOST = os.environ.get("RELAY_ALLOW_ANY_HOST", "0") == "1"
UA = os.environ.get(
    "RELAY_UA",
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/137.0.0.0 Mobile Safari/537.36",
)


def allowed(url):
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    return ALLOW_ANY_HOST or p.hostname.lower() in ALLOWED_HOSTS


def auth(handler):
    if not TOKEN:
        return True
    supplied = handler.headers.get("X-Relay-Token") or urllib.parse.parse_qs(
        urllib.parse.urlparse(handler.path).query
    ).get("token", [""])[0]
    return supplied == TOKEN


def target(handler):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
    return q.get("url", [""])[0]


def fetch(url, method="GET", headers=None):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, method=method)
    return urllib.request.urlopen(req, timeout=30)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "relay": "android"})
            return
        if parsed.path == "/ip":
            try:
                with fetch("https://api.ipify.org") as r:
                    ip = r.read().decode().strip()
                self.send_json(200, {"ip": ip})
            except Exception as exc:
                self.send_json(502, {"error": str(exc)})
            return
        if not auth(self):
            self.send_json(401, {"error": "unauthorized"})
            return
        url = target(self)
        if not allowed(url):
            self.send_json(
                403,
                {"error": "host_not_allowed", "host": urllib.parse.urlparse(url).hostname},
            )
            return
        if parsed.path == "/fetch":
            self.handle_fetch(url)
        elif parsed.path == "/proxy":
            self.handle_proxy(url)
        else:
            self.send_json(404, {"error": "not_found"})

    def do_HEAD(self):
        if not auth(self):
            self.send_response(401)
            self.end_headers()
            return
        url = target(self)
        if not allowed(url):
            self.send_response(403)
            self.end_headers()
            return
        try:
            with fetch(url, "HEAD") as r:
                self.send_response(r.status)
                for key in ("Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"):
                    if r.headers.get(key):
                        self.send_header(key, r.headers[key])
                self.end_headers()
        except Exception:
            self.send_response(502)
            self.end_headers()

    def handle_fetch(self, url):
        try:
            with fetch(url) as r:
                body = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as exc:
            body = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            self.send_json(502, {"error": str(exc)})

    def relay_url(self, absolute):
        value = "/proxy?url=" + urllib.parse.quote(absolute, safe="")
        if TOKEN:
            value += "&token=" + urllib.parse.quote(TOKEN, safe="")
        return value

    def rewrite_hls(self, text, base_url):
        def replace_uri(match):
            return 'URI="' + self.relay_url(urllib.parse.urljoin(base_url, match.group(1))) + '"'

        text = re.sub(r'URI="([^"]+)"', replace_uri, text)
        lines = []
        for line in text.splitlines():
            value = line.strip()
            if value and not value.startswith("#"):
                value = self.relay_url(urllib.parse.urljoin(base_url, value))
            lines.append(value)
        return "\n".join(lines) + "\n"

    def handle_proxy(self, url):
        try:
            headers = {"User-Agent": UA, "Accept": "*/*"}
            for key in ("Range", "If-Range", "If-None-Match", "If-Modified-Since"):
                if self.headers.get(key):
                    headers[key] = self.headers[key]
            with fetch(url, "GET", headers) as r:
                ctype = r.headers.get("Content-Type", "")
                is_hls = "mpegurl" in ctype.lower() or ".m3u8" in url.lower()
                if is_hls:
                    text = r.read().decode("utf-8", errors="replace")
                    data = self.rewrite_hls(text, url).encode()
                    self.send_response(r.status)
                    self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(data)
                    return

                self.send_response(r.status)
                for key in (
                    "Content-Type", "Content-Length", "Content-Range",
                    "Accept-Ranges", "ETag", "Last-Modified",
                ):
                    if r.headers.get(key):
                        self.send_header(key, r.headers[key])
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                while True:
                    chunk = r.read(131072)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as exc:
            self.send_response(exc.code)
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            body = str(exc).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"Relay listening on 0.0.0.0:{PORT}", flush=True)
    print("Allowed hosts:", ", ".join(sorted(ALLOWED_HOSTS)), flush=True)
    print("Allow any host:", ALLOW_ANY_HOST, flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
