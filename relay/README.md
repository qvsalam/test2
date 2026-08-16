# CinemaBox Relay (Android / Termux)

This relay lets the MegaSource scraper make CinemaBox API requests through the phone's current Internet connection. It is deliberately restricted to `cinema.albox.co` and requires `RELAY_KEY`.

## 1. Termux

Install Python:

```sh
pkg update
pkg install python
```

Download `relay.py` from this repository, then set a long private key:

```sh
export RELAY_KEY='CHANGE_THIS_TO_A_LONG_RANDOM_SECRET'
python relay.py
```

The local service listens on `127.0.0.1:8787`.

## 2. Cloudflare Tunnel

Install `cloudflared` for your Android/Termux architecture. Cloudflare documents `cloudflared` downloads and Tunnel setup here:
https://developers.cloudflare.com/tunnel/downloads/

For a quick temporary tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Cloudflare will print a temporary `https://....trycloudflare.com` URL.

Test it from another device:

```sh
curl -H 'X-Relay-Key: CHANGE_THIS_TO_A_LONG_RANDOM_SECRET' 'https://YOUR-TUNNEL.trycloudflare.com/health'
```

You should get `{"ok": true, "service": "cinemabox-relay"}`.

## 3. MegaSource

The MegaSource scraper must use the tunnel URL as its relay endpoint and send the same `X-Relay-Key` header. Do not publish the relay key in a public repository if the repository is public.

The relay only permits HTTPS requests to `cinema.albox.co`, preventing it from becoming a general-purpose open proxy.
