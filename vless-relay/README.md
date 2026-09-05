# Iraq VLESS Relay (Render)

Browser-deployable relay for testing the provider APIs through a VLESS WebSocket exit. It is intentionally restricted to an allow-list so it does not become a general open proxy.

## Render setup

1. In Render, choose **New → Blueprint** and connect `qvsalam/test2`.
2. Render will detect the root `render.yaml` and create the `iraq-vless-relay` web service.
3. Set the required environment variable `VLESS_URL` to the full VLESS link.
4. Optional but recommended: set `RELAY_TOKEN` to a random secret. Requests to `/relay` must then send `X-Relay-Token: <secret>` or `?token=<secret>`.
5. Deploy.

No local npm, Wrangler, Termux, or VPS setup is required.

## Endpoints

- `/health` — configuration summary (UUID is masked).
- `/test/ip` — verifies the VLESS exit IP/country/ISP through `ip-api.com`.
- `/test/providers` — connectivity test for VODU, Shashety, Cinemana, and CinemaBox.
- `/relay?url=<encoded-url>` — forwards GET/HEAD/POST through the VLESS tunnel to allow-listed hosts.

Example:

```text
/relay?url=https%3A%2F%2Fcinemana.shabakaty.cc%2Fapi%2Fandroid%2FAdvancedSearch%3FvideoTitle%3DInception%26type%3Dmovies
```

## Supported VLESS shape

This first version supports `type=ws` + `security=tls`, including links where the connection address is an IP while `host`/`sni` are a domain, for example:

```text
vless://UUID@SERVER_IP:443?type=ws&security=tls&path=%2F&host=example.com&sni=example.com
```

The relay connects to `SERVER_IP:443`, sets TLS SNI to `sni`, and sends the WebSocket `Host` header from `host`, matching the important behavior of Android proxy clients.

## Environment variables

- `VLESS_URL` — required full VLESS URL.
- `RELAY_TOKEN` — optional protection for `/relay`.
- `ALLOWED_HOSTS` — optional comma-separated override. Defaults to known Iraq provider hosts.
- `MAX_RESPONSE_BYTES` — optional, default 8 MiB.
- `REQUEST_TIMEOUT_MS` — optional, default 20000.

This relay is aimed at API/playlist/subtitle-sized responses, not large video-file proxying.
