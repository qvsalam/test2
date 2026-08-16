#!/usr/bin/env python3
"""Personal MegaSource relay for Android/Termux.

The relay runs on the phone, so upstream requests leave through the phone's
current mobile/ISP connection. It exposes three authenticated endpoints:
  /health?token=...
  /fetch?url=...&token=...       JSON/API requests
  /proxy?url=...&token=...       video/subtitle streaming, with Range support

Set RELAY_TOKEN to a long random value. Only HTTPS public hosts are allowed.
"""

import ipaddress
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("RELAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("RELAY_PORT", "8787"))
TOKEN = os.environ.get("RELAY_TOKEN", "")
UA = os.environ.get(
    "RELAY_USER_AGENT",
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
)
FETCH_LIMIT = int(os.environ.get("RELAY_FETCH_LIMIT", str(4 * 1024 * 1024)))
TIMEOUT = int(os.environ.get("RELAY_TIMEOUT", "30"))


def authorized(query):
    return bool(TOKEN) and query.get("token", [""])[0] == TOKEN


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
        if (ip.is_private or ip.is_loopback or ip.is_link_local or
                ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return False
    return True


def validate_target(raw):
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError:
        return None, "invalid URL"
    if parsed.scheme.lower() != "https":
        return None, "only https targets are allowed"
    if not parsed.hostname or not public_host(parsed.hostname):
        return None, "target host is not allowed"
    return parsed, None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MegaSourceRelay/2.0"

    def log_message(self, fmt, *args):
        print("[relay] " + (fmt % args), flush=True)

    def do_HEAD(self):
        self._proxy(True)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if not authorized(query):
            self.send_error(401, "unauthorized")
            return
        if parsed.path == "/health":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/fetch":
            self._fetch(query)
            return
        if parsed.path == "/proxy":
            self._proxy(False, query)
            return
        self.send_error(404, "not found")

    def _fetch(self, query):
        raw = query.get("url", [""])[0]
        target, error = validate_target(raw)
        if error:
            self.send_error(400, error)
            return
        req = urllib.request.Request(
            target.geturl(),
            headers={"Accept": "application/json, text/plain, */*", "User-Agent": UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                body = response.read(FETCH_LIMIT + 1)
                if len(body) > FETCH_LIMIT:
                    self.send_error(413, "response too large")
                    return
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code, "upstream HTTP error")
        except Exception as exc:
            self.send_error(502, "upstream request failed: %s" % str(exc)[:200])

    def _proxy(self, head_only, query=None):
        if query is None:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        raw = query.get("url", [""])[0]
        target, error = validate_target(raw)
        if error:
            self.send_error(400, error)
            return

        headers = {"User-Agent": UA, "Accept": "*/*"}
        for name in ("Range", "If-Range", "If-None-Match", "If-Modified-Since"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        method = "HEAD" if head_only else "GET"
        req = urllib.request.Request(target.geturl(), headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                self.send_response(response.status)
                allowed = {
                    "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges",
                    "ETag", "Last-Modified", "Cache-Control", "Expires",
                }
                for key, value in response.headers.items():
                    if key in allowed:
                        self.send_header(key, value)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                if not head_only:
                    while True:
                        chunk = response.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except urllib.error.HTTPError as exc:
            self.send_error(exc.code, "upstream HTTP error")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send_error(502, "upstream stream failed: %s" % str(exc)[:200])


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("Set RELAY_TOKEN before starting the relay")
    print("MegaSource relay listening on %s:%d" % (HOST, PORT), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
