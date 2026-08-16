#!/usr/bin/env python3
"""Authenticated personal relay for MegaSource on Android/Termux.

The phone performs the upstream request, so CinemaBox sees the phone's ISP/IP.
Endpoints:
  /health?key=...
  /fetch?url=...&key=...   small API responses
  /proxy?url=...&key=...   streaming responses with Range support
"""
import ipaddress
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("RELAY_PORT", "8787"))
KEY = os.environ.get("RELAY_KEY", "")
UA = os.environ.get("RELAY_UA", "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36")
MAX_FETCH = 4 * 1024 * 1024
TIMEOUT = 30


def public_host(host):
    host = (host or "").strip("[]").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        return False
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False
    return True


def target_url(raw):
    p = urllib.parse.urlsplit(raw)
    if p.scheme != "https" or not p.hostname or not public_host(p.hostname):
        raise ValueError("target_not_allowed")
    return p.geturl()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MegaSourceRelay/2.0"

    def log_message(self, fmt, *args):
        print("[relay] " + (fmt % args), flush=True)

    def auth(self, query):
        return bool(KEY) and query.get("key", [""])[0] == KEY

    def do_HEAD(self):
        self.proxy(head_only=True)

    def do_GET(self):
        p = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(p.query)
        if not self.auth(q):
            self.send_error(401, "unauthorized")
            return
        if p.path == "/health":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p.path == "/fetch":
            self.fetch(q)
            return
        if p.path == "/proxy":
            self.proxy(False, q)
            return
        self.send_error(404)

    def fetch(self, q):
        try:
            url = target_url(q.get("url", [""])[0])
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = r.read(MAX_FETCH + 1)
                if len(body) > MAX_FETCH:
                    self.send_error(413, "response too large")
                    return
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code, "upstream HTTP error")
        except Exception as exc:
            self.send_error(502, str(exc)[:200])

    def proxy(self, head_only=False, q=None):
        if q is None:
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        try:
            url = target_url(q.get("url", [""])[0])
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        headers = {"User-Agent": UA, "Accept": "*/*"}
        for name in ("Range", "If-Range", "If-None-Match", "If-Modified-Since"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        req = urllib.request.Request(url, headers=headers, method="HEAD" if head_only else "GET")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                self.send_response(r.status)
                for name in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "Expires"):
                    value = r.headers.get(name)
                    if value:
                        self.send_header(name, value)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                if not head_only:
                    while True:
                        chunk = r.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code, "upstream HTTP error")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send_error(502, str(exc)[:200])


if __name__ == "__main__":
    if not KEY:
        raise SystemExit("Set RELAY_KEY before starting the relay")
    print("MegaSource relay listening on http://127.0.0.1:%d" % PORT, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
