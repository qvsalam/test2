#!/usr/bin/env python3
"""Small authenticated HTTP relay for the CinemaBox MegaSource scraper.

Run this on the Android phone/Termux connection that has the Iraqi ISP/IP.
It is intentionally restricted to CinemaBox so it cannot become an open proxy.
"""

import os
import json
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("RELAY_PORT", "8787"))
RELAY_KEY = os.environ.get("RELAY_KEY", "")
ALLOWED_HOSTS = {"cinema.albox.co"}


def fetch_target(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("target_not_allowed")

    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        body = response.read()
        content_type = response.headers.get("Content-Type", "application/json")
        return response.status, content_type, body


class Handler(BaseHTTPRequestHandler):
    server_version = "CinemaBoxRelay/1.0"

    def _json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "cinemabox-relay"})
            return

        if not RELAY_KEY:
            self._json(503, {"ok": False, "error": "RELAY_KEY_not_configured"})
            return

        supplied = self.headers.get("X-Relay-Key", "")
        if supplied != RELAY_KEY:
            self._json(401, {"ok": False, "error": "unauthorized"})
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/proxy":
            self._json(404, {"ok": False, "error": "not_found"})
            return

        query = urllib.parse.parse_qs(parsed.query)
        target = query.get("url", [""])[0]
        if not target:
            self._json(400, {"ok": False, "error": "missing_url"})
            return

        try:
            status, content_type, body = fetch_target(target)
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except ValueError:
            self._json(403, {"ok": False, "error": "target_not_allowed"})
        except Exception as exc:
            self._json(502, {"ok": False, "error": "upstream_error", "detail": str(exc)[:200]})

    def log_message(self, fmt, *args):
        print("[relay] " + (fmt % args))


if __name__ == "__main__":
    if not RELAY_KEY:
        raise SystemExit("Set RELAY_KEY before starting the relay")
    print(f"CinemaBox relay listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
