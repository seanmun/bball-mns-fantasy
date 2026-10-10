#!/bin/zsh
# Look at a screen before shipping it: build the preview harness, serve it
# for a moment, screenshot with headless Chrome in BOTH themes at phone
# width (and desktop), then stop. Usage: scripts/preview-shots.sh [screen]
set -e
cd "$(dirname "$0")/.."
SCREEN=${1:-keepers}
OUT=preview-shots; mkdir -p $OUT
VITE_SPORT=${VITE_SPORT:-nba} npx vite build --config vite.preview.config.ts >/dev/null
PORT=8137
(cd preview-dist && python3 -m http.server $PORT >/dev/null 2>&1) & PID=$!
sleep 1
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for theme in light dark; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=4000 --window-size=500,2200 \
    --screenshot="$OUT/$SCREEN-$theme-phone.png" "http://localhost:$PORT/?screen=$SCREEN&theme=$theme&width=400" >/dev/null 2>&1
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=4000 --window-size=1280,1400 \
    --screenshot="$OUT/$SCREEN-$theme-desktop.png" "http://localhost:$PORT/?screen=$SCREEN&theme=$theme" >/dev/null 2>&1
done
kill $PID 2>/dev/null || true
ls -la $OUT | grep "$SCREEN"
