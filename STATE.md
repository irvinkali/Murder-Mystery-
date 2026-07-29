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
- 2026-07-29 (Claude Code, cont.): **Step 4 foundation done.** Netlify app: static front-end + Functions + Blobs state. `engine/lib/runtime.js` loads the encoded pack, SEALS a random variant server-side, gates the keystone to Phase 4, serves each player only their own brief. Functions: create-game (seals variant, never returns it), join (assigns core cast), state (public + your-own-brief), scan (NFC prop routing, keystone-gated), poll (anon tally), advance (host phases), reveal (host-only, Phase 6 only). Front-end: join, player dossier, Gallery Screen (AirPlay, no personal data), host controls, NFC prop landing (`/prop/<id>`). **Engine test: 24/24 PASS** (incl. per-variant keystone gate, variant never leaks, reveal gating). NEW GUARD: `engine/spoiler-scan.js` derives plot names from the pack and fails if any appear in a Kali-readable file — currently **CLEAN**. `npm run check` runs build+validate+test+scan (all green). Caught & fixed one leak during build (host placeholders). Remaining in Step 4: wire branching-hook consequences + idle-rescue prompts to host tools; live Netlify deploy/Blobs smoke test.

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
