# Narration TTS

`generate.js` renders every gallery narration line to an opaque-named mp3 using
[edge-tts](https://github.com/rany2/edge-tts) with a calm, low, slightly formal
"gallery docent" voice.

## Install & run

```
pip install edge-tts            # one time; needs network at generation time

node engine/tts/generate.js                                   # real pack
MYSTERY_PACK_FILE=packs/test/pack.json node engine/tts/generate.js  # dummy pack
node engine/tts/generate.js --force                           # re-render all
```

Voice / tone are configurable:

```
NARRATION_VOICE="en-GB-RyanNeural" NARRATION_RATE="-10%" NARRATION_PITCH="-6Hz" \
  node engine/tts/generate.js
```

Output lands in `engine/public/assets/narration/` (git-ignored). Filenames are
sha256 hashes of a logical key, computed identically here and in the server, so
the Gallery Screen finds each file without a manifest.

## Spoiler safety

- The narration text is never printed and never written to a committed file.
- Reveal audio (which speaks the killer) is git-ignored — it is generated at
  deploy time and served, never committed or browsed.

## Deployment

Real audio is not in git, so a plain git-based deploy ships without it and the
gallery uses the browser voice. To ship the docent audio, either run the
generator as part of your deploy (after `pip install edge-tts`) so the files are
present in the publish directory, or generate locally and upload them with your
deploy tool. Missing or failed files fall back to the browser voice per line.
