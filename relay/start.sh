#!/data/data/com.termux/files/usr/bin/bash
set -e

# First run:
#   export RELAY_KEY='put-a-long-random-key-here'
#   ./start.sh
#
# The HTTP relay stays bound to 127.0.0.1:8787, then Cloudflare Tunnel
# exposes only that local port. The relay itself allowlists cinema.albox.co.

: "${RELAY_KEY:?Set RELAY_KEY first, e.g. export RELAY_KEY=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')}"

termux-wake-lock 2>/dev/null || true

python "$(dirname "$0")/relay.py" &
RELAY_PID=$!
trap 'kill "$RELAY_PID" 2>/dev/null || true' EXIT INT TERM

sleep 1
curl -fsS http://127.0.0.1:8787/health
printf '\nStarting Cloudflare Quick Tunnel...\n'
printf 'Keep this terminal/session running. Copy the https://*.trycloudflare.com URL when cloudflared prints it.\n\n'

cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
