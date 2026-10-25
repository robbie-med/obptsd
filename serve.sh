#!/usr/bin/env bash
# Local preview for L&D Night. Port 3938 is claimed in ~/Projects/PORTS.md (ob-floor-game, dev).
cd "$(dirname "$0")"
PORT=3938
if ss -ltn | grep -q ":$PORT "; then echo "Port $PORT already in use — is the game already running?"; exit 1; fi
echo "L&D Night → http://127.0.0.1:$PORT  (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
