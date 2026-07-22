#!/bin/bash
# Double-click to view the Wats of Chiang Mai map.
# Serves the folder over a local web server (the map's renderer needs http://,
# not file://) and opens it in your browser. Close this window to stop.
cd "$(dirname "$0")" || exit 1

# Rebuild the visual from the latest data if Node is available (harmless if not).
command -v node >/dev/null 2>&1 && node scripts/build-wats-visual.mjs 2>/dev/null

# Find a free port, starting at 8799.
PORT=8799
while lsof -i ":$PORT" >/dev/null 2>&1; do PORT=$((PORT + 1)); done

URL="http://localhost:$PORT/wats.html"
echo ""
echo "  Wats of Chiang Mai"
echo "  Opening $URL"
echo "  Close this window when you're done to stop the server."
echo ""

( sleep 1; open "$URL" ) &
exec python3 -m http.server "$PORT"
