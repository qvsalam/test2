#!/usr/bin/env python3
"""Small HTTP relay intended to run on Android/Termux.

It does NOT proxy arbitrary URLs. It only proxies requests to hosts listed in
ALLOWED_HOSTS, so the phone's current mobile/ISP IP is used when contacting the
source APIs.

Usage:
  ALLOWED_HOSTS=cinema.albox.co python phone_relay.py

Endpoint:
  GET /proxy?path=/api/v4/shows/search?q=...

The public tunnel should point to this local server on port 8787.
"""

import os
import ssl
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8787"))
SOURCE_SCHEME = os.environ.get("SOURCE_SCHEME", "https")
ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("ALLOWED_HOSTS", "cinema.albox.co").split(",")
    if h.strip()
}

UA = os.environ.get(
    "RELAY_USER_AGENT",
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, content_type="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/health":
            self._send(200, "OK")
            return
        if parsed.path != "/proxy":
            self._send(404, "not found")
            return

        qs = urllib.parse.parse_qs(parsed.query)
        target_path = qs.get("path", [""])[0]
        if not target_path.startswith("/") or target_path.startswith("//"):
            self._send(400, "invalid path")
            return

        # The relay is intentionally host-fixed. It cannot be turned into an
        # arbitrary open proxy by a remote caller.
        host = qs.get("host", ["cinema.albox.co"])[0].lower()
        if host not in ALLOWED_HOSTS:
            self._send(403, "host not allowed")
            return

        # Reconstruct the source query from the `path` parameter itself.
        target = f"{SOURCE_SCHEME}://{host}{target_path}"
        req = urllib.request.Request(
            target,
            headers={
                "Accept": self.headers.get("Accept", "application/json, text/plain, */*"),
                "User-Agent": UA,
            },
        )

        try:
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=25) as r:
                data = r.read()
                content_type = r.headers.get("Content-Type", "application/json; charset=utf-8")
                self._send(r.status, data, content_type)
        except Exception as exc:
            self._send(502, f"relay upstream error: {type(exc).__name__}: {exc}")

    def log_message(self, fmt, *args):
        print("[relay] " + fmt % args, flush=True)


if __name__ == "__main__":
    print(f"Relay listening on http://{HOST}:{PORT}", flush=True)
    print("Allowed hosts:", ", ".join(sorted(ALLOWED_HOSTS)), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
