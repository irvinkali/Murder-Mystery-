# Mystery Engine

A reusable, plot-agnostic platform for hosting live, phone-driven murder-mystery
parties. The engine knows nothing about any particular story; each game is a
**story pack** (a self-contained data bundle) dropped into `packs/`.

Story pack #1: **The Last Exhibit** (`packs/last-exhibit/`).

## ⚠️ Spoiler protocol (read before touching this repo)

The owner **plays** the game and must never see the solution. Therefore:

- **All plot content lives only in `*.b64` files.** Treat every
  `packs/*/**.b64` file as radioactive.
- **Never** decode a pack file into chat, docs, commit messages, code
  comments, terminal output, logs, or any committed plaintext file.
- Tools decode pack files **only into memory** for build/validation, and emit
  **pass/fail reports only** — never the underlying content.
- `.gitignore` refuses to track any decoded artifact (`*.decoded`, a bare
  `packs/**/*.md`, etc.). Do not override it.

If you need to reason about the plot, do it inside a process — not in a file,
a message, or a commit.

## Layout

```
STATE.md                        Project state (safe to read)
docs/                           Safe, spoiler-free docs
packs/last-exhibit/
  plot-bible.md.b64             SPOILER master document (base64, radioactive)
engine/
  lib/pack.js                   Pack loader/parser (decodes in memory only)
  validate.js                   Fairness-rule validator (prints PASS/FAIL only)
  build-pack.js                 Emits encoded structured pack (b64 out only)
  functions/                    Netlify Functions (runtime state)
  public/                       Static front-end (player view, gallery screen)
```

## Commands

```bash
cd engine
npm run validate     # check §7 fairness rules across variants × player counts
npm run build-pack   # (re)generate packs/last-exhibit/pack.json.b64 (encoded)
```

Both commands are spoiler-safe: they read the radioactive `.b64` inputs, work
in memory, and print only structural / pass-fail results.
