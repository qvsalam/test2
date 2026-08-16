#!/data/data/com.termux/files/usr/bin/bash
set -e

PORT="${RELAY_PORT:-8787}"
TOKEN="${RELAY_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "Usage: RELAY_TOKEN='a-long-random-secret' ./start-termux.sh"
  exit 1
fi

cd "$(dirname "$0")"
export RELAY_PORT="$PORT"
export RELAY_TOKEN="$TOKEN"
python server.py
