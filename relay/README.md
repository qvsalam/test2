# CinemaBox Relay (Android / Termux)

This relay lets the MegaSource scraper make CinemaBox API requests through the phone's current Internet connection. That matters when CinemaBox only works from the user's Iraqi ISP/IP.

Architecture:

`MegaSource -> Cloudflare Tunnel -> Termux relay -> cinema.albox.co`

The actual video URL is returned to MegaSource; the phone is used for the source API requests that require the Iraqi IP.

## 1. Termux

Install Termux on the Android phone that has the working Iraqi ISP connection.

```sh
pkg update -y
pkg install python curl -y
```

Download `relay.py` from this repository. Choose a long random relay key and start it:

```sh
export RELAY_KEY='PUT_A_LONG_RANDOM_KEY_HERE'
python relay/relay.py
```

The local relay listens on `127.0.0.1:8787`.

Test locally:

```sh
curl http://127.0.0.1:8787/health
```

## 2. Cloudflare Quick Tunnel

Install `cloudflared` for the phone's CPU architecture using Cloudflare's official downloads.

Then run:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Cloudflare will print a temporary URL similar to:

`https://random-name.trycloudflare.com`

Quick Tunnels are free and do not require a domain or Cloudflare account, but the hostname changes when the tunnel is restarted.

## 3. Configure MegaSource

Edit `relay/relay.json` in the GitHub repository:

```json
{
  "relay_url": "https://random-name.trycloudflare.com/proxy",
  "relay_token": "PUT_THE_SAME_RELAY_KEY_HERE"
}
```

Then use this MegaSource scraper URL:

`https://raw.githubusercontent.com/qvsalam/test2/main/megasource/cinemabox_relay.py`

The scraper reads `relay.json` automatically. You do not need to put the tunnel URL inside the Python file.

## 4. Important

- Keep the phone on the Iraqi ISP/network that is known to work with CinemaBox.
- Keep both Termux processes running: `relay.py` and `cloudflared`.
- If the Quick Tunnel URL changes, update only `relay/relay.json` and re-test the scraper.
- Do not reuse the relay key for other services.
- The relay only permits `cinema.albox.co`; it is not an arbitrary open proxy.
- The current CinemaBox adapter supports the Series path (`ttID:season:episode`) because that is the path implemented by the existing CinemaBox provider in `test2`.
