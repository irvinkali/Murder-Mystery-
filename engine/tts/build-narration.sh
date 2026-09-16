#!/bin/sh
# Render this pack's narration to mp3 during the Netlify build.
#
# The room screen prefers a real audio file per line and falls back to the
# browser's own speech synthesis when one is missing, so this script must never
# fail the build: if the renderer cannot run, the site still deploys and the
# evening still has a voice, just a worse one. It exits 0 on every path.
#
# The files land in engine/public/assets/narration, which is git-ignored, so
# reveal audio (which speaks the killer) is published and never committed.

set -u
here=$(dirname "$0")

if ! command -v edge-tts >/dev/null 2>&1; then
  python3 -m pip install --quiet --user edge-tts >/dev/null 2>&1 \
    || pip3 install --quiet --user edge-tts >/dev/null 2>&1 \
    || echo "narration: could not install edge-tts; the room screen will use the browser voice"
  PATH="$HOME/.local/bin:$PATH"
  export PATH
fi

if command -v edge-tts >/dev/null 2>&1; then
  node "$here/generate.js" || echo "narration: renderer failed; the room screen will use the browser voice"
else
  echo "narration: edge-tts unavailable; the room screen will use the browser voice"
fi

exit 0
