#!/data/data/com.termux/files/usr/bin/bash
set -e

: "${RELAY_KEY:?Set RELAY_KEY first}"

termux-wake-lock 2>/dev/null || true
python "$(dirname "$0")/relay.py" &
RELAY_PID=$!
trap 'kill "$RELAY_PID" 2>/dev/null || true' EXIT INT TERM

sleep 1
curl -fsS "http://127.0.0.1:8787/health?key=${RELAY_KEY}"
printf '\nStarting Cloudflare Quick Tunnel...\n'
printf 'Copy the https://*.trycloudflare.com URL printed by cloudflared.\n\n'
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
