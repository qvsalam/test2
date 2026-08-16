#!/usr/bin/env python3
"""Small private HTTP relay for MegaSource.

Runs on the user's Android phone (Termux). The relay fetches only approved
API hosts, so MegaSource's server-side scraper can reach region/IP-bound APIs
through the phone's own mobile/ISP connection.

Environment:
  RELAY_TOKEN  required secret
  RELAY_PORT   optional, default 8080
"""

import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("RELAY_TOKEN", "")
PORT = int(os.environ.get("RELAY_PORT", "8080"))

# Only API hosts needed by the current CinemaBox scraper.
ALLOWED_HOSTS = {
    "cinema.albox.co",
    "api.themoviedb.org",
}

UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/137 Mobile Safari/537.36"


def fetch_target(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("target host is not allowed")

    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json, text/plain, */*",
            "User-Agent": UA,
        },
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=25, context=ctx) as r:
            body = r.read()
            return r.status, r.headers.get("Content-Type", "application/json"), body
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, e.headers.get("Content-Type", "application/json"), body


class Handler(BaseHTTPRequestHandler):
    server_version = "MegaSourceRelay/1.0"

    def log_message(self, fmt, *args):
        print("[relay] " + (fmt % args), flush=True)

    def send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "relay": "megasource"})
            return

        if parsed.path != "/fetch":
            self.send_json(404, {"error": "not found"})
            return

        if not TOKEN or self.headers.get("X-Relay-Token") != TOKEN:
            self.send_json(401, {"error": "unauthorized"})
            return

        target = urllib.parse.parse_qs(parsed.query).get("url", [None])[0]
        if not target:
            self.send_json(400, {"error": "missing url"})
            return

        try:
            status, content_type, body = fetch_target(target)
        except ValueError as e:
            self.send_json(403, {"error": str(e)})
            return
        except Exception as e:
            self.send_json(502, {"error": "upstream request failed", "detail": str(e)[:200]})
            return

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("Set RELAY_TOKEN before starting the relay")
    print(f"MegaSource relay listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
