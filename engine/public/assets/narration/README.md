# Narration audio (generated — do not commit)

This folder holds the spoken narration the Gallery Screen plays: phase cards,
the discovery/unveiling, `[SCREEN]` find-hint lines, and each variant's Phase-6
reveal. Files are named by an opaque hash and are **git-ignored** — the reveal
audio speaks the killer, so it must never live in the repo.

Generate them with edge-tts (needs `pip install edge-tts` and network):

```
# real party audio (from the sealed pack)
node engine/tts/generate.js

# dummy rehearsal audio (safe — fake content)
MYSTERY_PACK_FILE=packs/test/pack.json node engine/tts/generate.js
```

If this folder is empty, the Gallery Screen still narrates everything using the
browser's built-in voice (speechSynthesis) — so rehearsal works with no setup.
See `engine/tts/README.md` for voice options and deployment.
