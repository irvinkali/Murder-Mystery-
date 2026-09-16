#!/bin/sh
# Render this pack's narration to mp3 during the Netlify build.
#
# The room screen prefers a real audio file per line and falls back to the
# browser's own speech synthesis when one is missing, so this script must never
# fail the build and must never hang it: every step is bounded by a timeout and
# every path exits 0. A silent hang is worse than a browser voice, because it
# burns build minutes and ends in a timed-out deploy.
#
# The files land in engine/public/assets/narration, which is git-ignored, so
# reveal audio (which speaks the killer) is published and never committed.

set -u
here=$(dirname "$0")
echo "narration: starting for pack \"${MYSTERY_PACK:-default}\""

if ! command -v edge-tts >/dev/null 2>&1; then
  echo "narration: installing edge-tts"
  timeout 180 python3 -m pip install --quiet --user edge-tts >/dev/null 2>&1 \
    || timeout 180 pip3 install --quiet --user edge-tts >/dev/null 2>&1 \
    || echo "narration: could not install edge-tts"
  PATH="$HOME/.local/bin:$PATH"
  export PATH
fi

if command -v edge-tts >/dev/null 2>&1; then
  echo "narration: rendering"
  timeout 420 node "$here/generate.js" && echo "narration: done" \
    || echo "narration: renderer failed or took too long; the room screen will use the browser voice"
else
  echo "narration: edge-tts unavailable; the room screen will use the browser voice"
fi

exit 0
