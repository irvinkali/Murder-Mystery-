# Mystery Engine — Project State (SPOILER-SAFE)

Owner: Kali Irvin. Deadline: party in ~3-4 weeks from 2026-07-28.
This file lets any Claude session (chat or Claude Code) resume work. Kali may read this file freely.

## Architecture decision
- **mystery-engine**: reusable platform. Engine is plot-agnostic; each game is a "story pack" (data bundle) in /packs/ or an external repo with the same schema. Story pack #1: last-exhibit.
- Hosting: Netlify (static front-end + Netlify Functions + Netlify Blobs for shared state). Deployed from Kali's GitHub.
- Player phones join via party code + personal code. Account-free "Gallery Screen" mode for iPad→AirPlay (no login, no personal data ever on screen).
- Physical props: 7 items with NFC tags (NTAG213) opening prop URLs; fallback = in-app "I found something" picker + gallery placard numbers. See last-exhibit-props-guide.md (already delivered to Kali).

## Locked design requirements (from Kali)
- 10–20 players, ~2 hours, six phases (see docs/design-doc.md)
- Funny-dark tone; glamorous/spooky/modern setting
- Kali PLAYS; no all-knowing emcee; app is game master
- Hybrid killer: nobody knows until mid-game private unlock
- Randomized solution variant at game start; even Kali/Claude don't know night-of
- Branching via anonymous/public polls (StoryPop-style); idle-player rescue prompts
- Props: few but weighty; every prop genuine in ≥1 variant
- Not predictable; not so complex casual players give up (two-layer design)
- SPOILER PROTOCOL: plot content only in *.b64 files; never decode into chat, docs, commit messages, code comments, or anything Kali-readable; Kali gets validation pass/fail reports only. In this repo, treat all packs/*/**.b64 as radioactive.

## File map
- STATE.md — this file (safe)
- docs/ — safe docs (design doc, props guide copies)
- packs/last-exhibit/plot-bible.md.b64 — SPOILER master document (base64; md5 424fe1e3e0cd2df4010b9a71f6bf9c6c)
- engine/ — app code (not started)

## Progress log
- 2026-07-28: Setting, mechanics, and requirements locked (chat). Design doc + props guide delivered to Kali. Plot bible v0.1 written & encoded: victim, world, 10 core characters, 4 solution variants w/ 6-clue evidence chains, prop meaning matrix (7 props × 4 variants), branching hooks, 7 fairness rules (§7 = validation targets).
- 2026-07-29 (Claude Code): Repo scaffolded. Bible committed as radioactive b64 (md5 verified). `.gitignore` refuses to track any decoded artifact. Safe docs added (design-doc, props guide). **Step 2 done**: `engine/build-pack.js` parses the bible in-memory and emits `packs/last-exhibit/pack.json.b64` (structured pack, encoded — never plaintext). **Step 3 done**: `engine/validate.js` checks all §7 fairness rules across the 4 variants and player counts 10–20; **result: ALL 11 CHECKS PASS**. Rule 5 (prop-genuineness matrix ↔ per-variant bullets) is cross-checked rigorously. NOTE: bible §7 defines **6** numbered fairness rules; STATE previously said "7" — flagged for reconciliation (no plot impact). Step 1 (flex F1–F10) deferred — see next-steps note.
- 2026-07-29 (Claude Code, cont.): **Step 4 foundation done.** Netlify app: static front-end + Functions + Blobs state. `engine/lib/runtime.js` loads the encoded pack, SEALS a random variant server-side, gates the keystone to Phase 4, serves each player only their own brief. Functions: create-game (seals variant, never returns it), join (assigns core cast), state (public + your-own-brief), scan (NFC prop routing, keystone-gated), poll (anon tally), advance (host phases), reveal (host-only, Phase 6 only). Front-end: join, player dossier, Gallery Screen (AirPlay, no personal data), host controls, NFC prop landing (`/prop/<id>`). NEW GUARD: `engine/spoiler-scan.js` derives plot names from the pack and fails if any appear in a Kali-readable file — currently **CLEAN**. `npm run check` runs build+validate+test+scan (all green). Caught & fixed 2 leaks during build (host placeholders, invite artist name).
- 2026-07-29 (Claude Code, cont.): **Hybrid-killer unlock done** (core requirement). From Phase 3, the sealed variant's killer — and ONLY that player, on their own device — privately learns they're the killer, with method text + generic no-acting-skill do/don't guidance. Never on the gallery/host screens; variant still never leaks. Proven by test (hidden pre-Phase-3; exactly one unlocked at Phase 3; it's the right character). **Engine test now 27/27 PASS.** **Step 5 done**: `engine/public/printables.html` — print-to-PDF kit (NFC URL map, prop labels/fold-inserts, Exhibit No. 1–12 placards, invite); all spoiler-free (app carries real meaning). **Step 7 done**: `docs/host-runbook.md` — spoiler-free setup + dress-rehearsal + night-of run sheet + troubleshooting. **Idle-rescue prompts done**: state serves a private, generic (plot-free) nudge when a player goes quiet during an active phase; based on deliberate activity (scans/votes), not passive polling, so it doesn't misfire. Proven by test. **Engine test now 30/30 PASS.**
- 2026-07-29 (Claude Code, cont.): **Local run + Step 6 (software half) done.** `engine/dev-server.js` runs the whole app locally with zero deps/zero install (`node engine/dev-server.js` → localhost:8888; in-memory state). `engine/smoke.js` boots it and tests the real HTTP wiring (static routing + /api functions + reveal gating): **10/10 PASS**. `npm run check` now runs build+validate+test(30/30)+smoke(10/10)+spoiler-scan(CLEAN) — the single pre-commit gate. Runbook + README updated with local-preview instructions.
- 2026-07-29 (Claude Code, cont.): **Flex ENGINE support done (content still blocked).** Parser generalized (`parseRoster` handles `C` and `F`); build/validate/engine now read an OPTIONAL `packs/last-exhibit/flex-characters.md.b64` (radioactive; same `**F1. Name** …persona/secret… [PIECE No. k]` format as the core cast). `join` seats core 1–10 then flex 11–20; `playerBrief` resolves flex; validator adds an honest **CAP** check ("10 seats (core only) — author flex F1–F10 to seat players 11–20"). Proven by pure unit tests (seat order, capacity 20 with flex, honest cap of 10 without). Gate now **fairness 12/12, engine 33/33, smoke 10/10, spoiler CLEAN**. → To reach 11–20 players, drop an authored `flex-characters.md.b64` into the pack; everything else is wired.
- 2026-07-29 (Claude Code, cont.): **Flex + branching CONTENT dropped in and fully wired.** `flex-characters.md.b64` (10 flex) and `branching.md.b64` added to the pack (radioactive; verified by counts only). Seats now cover **10–20** (CAP check green; R2 strengthened to also reject any flex NAME in a solution). **Branching resolver built** (`engine/lib/branching.js`) + endpoints (`poll` benefits/subpoena branch tags, new `alibi` function) + front-end (private drop cards, the 6:40 prompt, host poll-type selector + "resolve 6:40" button, gallery [SCREEN] announcement). Implements branching.md §4 gating EXACTLY: defense Phase-3-once; alibi Phase-3-once only on contradiction (honest "near scene" answer suppresses it — victim name derived from pack, never hard-coded); medical Phase-4 (YES→FULL to all + [SCREEN]; NO→PARTIAL leak to the 3 most-active investigators, delayed ~6 min, surfaces by Phase 5); and **§4.5 ordering** — a killer-complicating drop is served only AFTER the killer unlock has fired for that player, otherwise the DEFAULT text is served and the complicating version suppressed (proven for all 4 variants). New `engine/test-branching.js` (18/18). Spoiler-scan extended to flex full-names; caught & fixed a real victim-name leak in the resolver during the build. Gate: **fairness 12/12, engine 34/34, branching 18/18, smoke 10/10, spoiler CLEAN.**
- 2026-07-29 (Claude Code, cont.): **Spoiler-safe rehearsal mode.** `node engine/dev-server.js` now defaults to a DUMMY test pack (`packs/test/pack.json`, generated by `engine/make-test-pack.js`) so the owner can rehearse AS A PLAYER without ever seeing the real solution — startup prints a green "REHEARSAL MODE" banner; a red warning shows only if the real pack is force-loaded. Runtime honors `MYSTERY_PACK_FILE` (supports `.json` and `.b64`); `USE_REAL_PACK=1` opts back into the real pack (smoke test does this to keep exercising the real path). Netlify functions still load the real pack in production. Gate unchanged & green.
  Remaining — **hardware-only** (can't be done from here): Step 6 live pass — real Netlify deploy + Blobs, physical NFC tags, iPad/AirPlay. Software is fully built and tested locally (dev-server + smoke). Everything authorable is done.

## Next steps (in order)
1. Flex characters F1–F10 (layer-in roles, own secrets, never load-bearing) → append to pack (encoded).
   ⚠️ BLOCKER (spoiler protocol): authoring NEW plot text inside a Claude Code
   session is unsafe — every output channel here (file writes, shell commands,
   chat, visible reasoning) is Kali-readable, so the plaintext would leak.
   The bible was authored in a *chat* session that emitted only encoded output;
   flex characters should be authored the same way, or via a dedicated
   no-echo authoring step. Not load-bearing (fairness rule 2), so it does not
   block Steps 2–7. Deferred pending Kali's chosen authoring route.
2. ✅ DONE — Convert bible → structured pack JSON (encoded: pack.json.b64).
3. ✅ DONE — validate.js: all §7 fairness rules × variants × player counts 10–20 (ALL PASS).
4. Engine build (player view, gallery screen, host tools, NFC routing, Functions/Blobs state).
   Engine code carries NO plot; it loads the encoded pack and decodes server-side only.
5. Printables kit (prop labels/inserts designed for fold-without-reading), invite text.
6. Test passes: every variant, every poll path, every player count; AirPlay/iPad screen test.
7. Dress-rehearsal walkthrough guide for Kali.

## Instructions for Claude Code sessions
Read this file first. Decode b64 pack files only into memory/tmp for build+validation; delete decoded copies; never print their content to the terminal, logs, or commits. Keep all Kali-facing output spoiler-free.
