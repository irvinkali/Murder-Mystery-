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
- packs/last-exhibit/plot-bible.md.b64 — SPOILER master document (base64; md5 b5531a15dcbcf9d9d34edf6a4bf3e713)
- packs/reunion-1989/plot-bible.md.b64 — SPOILER master document for story pack #2 (base64; md5 033cec661965dcac5b0513aafed7bd7c)
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
- 2026-07-29 (Claude Code, cont.): **Rehearsal punch list (13 items) implemented + wired `script-lines.md.b64`.** New content parsed into the pack (20 chars × 5 phase lines, 7 find-hints ×2 tiers, fairness disclosure). Engine: phase-transition effects (`lib/phases.js` — per-phase narration to all + gallery, live "Your lines" card served current-phase-only, PH3 find-hints to the 2 least-active as idle rescue, PH4 [SCREEN] hints to gallery); poll scheduler (`lib/pollsched.js` — auto open/close per phase, host open-early/extend/skip, guidance text, aggregate-only anonymous results); mandatory Phase-5 final vote gates the reveal; Phase-6 reveal broadcasts to the gallery; host keeps advance/pause + phase clock. Prop finding is NFC-or-typed **exhibit number** (props = 21–27; internal P-ids never shown); prop picker removed; finds are notifications, no unfound list. Join collects first name; lobby shows first name + character. All private drops (unlock/branching/hints) render as in-world **notes**. Gallery: narrator-card display + optional per-phase ambient audio (`public/assets/audio/`). Test pack regenerated to exercise all of it. **Gate: fairness 12/12, engine 34/34, branching 21/21, smoke 10/10, spoiler CLEAN.**
- 2026-07-29 (Claude Code, cont.): **Spoken narration on the gallery.** `engine/tts/generate.js` (edge-tts, calm "gallery docent" voice) renders EVERY gallery narration line — phase cards, discovery/unveiling, [SCREEN] find-hints, medical announcement, and each variant's full Phase-6 reveal — to opaque **sha256-named** mp3s in `engine/public/assets/narration/` (git-ignored; reveal audio speaks the killer so it is NEVER committed). The script never prints text (writes each line to a temp file, deletes it) → spoiler-scan clean. Server computes the SAME opaque hash (Node/Python parity verified) and sends it per card/moment; the gallery plays the matching file, **ducking ambient while speaking**, and falls back to browser `speechSynthesis` for any missing/failed file or dynamic text. Reveal plays ONLY the active variant's files. Prop IDs never leak (client sees only hashes). Rehearsal needs no setup — the dummy pack's narration is spoken via the browser voice; run `MYSTERY_PACK_FILE=packs/test/pack.json npm run tts` for dummy audio files. Generator verified end-to-end here (CLI detect, 22-item inventory, opaque names); synth needs network (works on a real machine). **Gate: fairness 12/12, engine 37–38/…, branching 21/21, smoke 10/10, spoiler CLEAN.**
- 2026-08-01 (Claude Code): **The Living Narrator (velvet emcee).** Per Kali's direction: fuller theatrical phase monologues (paced with ellipses/beats), plus LIVE interjections — reacts the first time each exhibit is found, names the room's suspect when the benefits vote closes, marks the files verdict and the final ballot, and drops atmospheric asides after ~4 quiet minutes (Phases 2–5, pause-aware). All templates live in `lib/narrator.js` with ZERO plot content — names/props are filled from the pack at runtime, so spoiler-scan stays clean. Because names/props/votes are enumerable, every interjection is pre-renderable in the docent voice (TTS inventory now ~50 lines; default voice en-GB-RyanNeural, slower/lower); browser-voice fallback now performs pauses at ellipses. Gallery speaks only post-connect interjections (no history replay). **Gate: fairness 12/12, engine 45/45, branching 21/21, smoke 10/10, spoiler CLEAN.**
- 2026-08-01 (Claude Code, cont.): **Narrator voice + attention system.** Voice switched to a rich female docent (default en-GB-SoniaNeural; browser fallback now prefers female voices — Sonia/Libby/Aria/Hazel/Zira/Samantha…). MAJOR announcements (phase monologues, vote outcomes, files verdict, final ballot, reveal) now open with a soft two-note gallery bell (WebAudio, no file) + a spoken call — "Your attention, my darlings... if you please." (pre-rendered under key `attention`) — before the line, so a chattering room gets a beat to settle. Ambient lines (finds, asides) stay bell-free. Medical verdict card no longer double-speaks (feed line covers it). **Gate: fairness 12/12, engine 48/48, branching 21/21, smoke 10/10, spoiler CLEAN.**
- 2026-08-02 (Claude Code): **Party-proofing + experience batch** (Kali: "just proceed"). (1) **Resume-a-seat**: every dossier shows its 5-letter seat code; the join page has a "Rejoining?" flow that recovers the same character on a new device/phone. (2) **QR join**: gallery shows a Phase-1 join card (code + QR → prefilled join); printable invite gets a QR (external QR image service with graceful text fallback offline). (3) **Vote-safety**: store rewritten with optimistic concurrency (etag/version CAS + jittered retry; memory backend simulates versions so tests exercise it; degrades to plain write on old Blobs runtimes) — 8 simultaneous votes proven lossless. (5) **Finale**: reveal now computes final-vote counts + narrated awards (Best Detective, Sharpest Eye, Most Suspected Innocent, killer Caught Red-Handed / The Perfect Crime) from live game data; gallery renders bars + honor cards and speaks them (awards.intro pre-renderable). (7) **Secret chime**: player phones vibrate + soft tone when a private note/unlock/line arrives. (6) **Blackout set-piece** (from the design's branching hooks): arms 3 min after the benefits poll closes (Phases 3–4) or host-triggered from the drawer; 60 s of black on every screen (major narrator beat), then "exhibit N is not where it was" aftermath; fires once; all lines pre-renderable. (8) **Generative ambient**: gallery synthesizes a per-phase pad (WebAudio, zero files; file loops still take precedence), with a low rumble during the blackout; ducks under speech. **Gate: fairness 12/12, engine 69/69, branching 21/21, smoke 10/10, spoiler CLEAN.** Not built (offered, pending interest): host casting, keepsake case-file, photo moment.
- 2026-08-02 (Claude Code, cont.): **Final feature batch + invite kit.** (9) **Casting**: join page offers "Choose who you'll be (optional)" — lists unclaimed characters with GAME-PUBLIC personas only (text before SECRETS:, served at runtime; nothing committed, spoiler-scan clean); claim races handled ("just claimed — pick another"); surprise-me default unchanged. (10) **Case File keepsake**: `/api/casefile` (opens ONLY after the reveal) + print-styled `/casefile.html` — verdict, vote table, honors, exhibits-recovered timeline, guest roster; linked from the gallery finale + host drawer. (11) **Photo moment**: host-drawer "Portrait" button → bell + narrator call + gallery card (pre-renderable key `photo`). **Invite kit**: `/invite` — fill-in date/time/place/RSVP → live glamorous card (screenshot/print) + copy-paste short & long messages + sending tips; fully spoiler-free; works locally pre-deploy (fields persist in the browser). Reveal now uses proper cast-name casing. **Gate: fairness 12/12, engine 76-77, branching 21/21, smoke 10/10, spoiler CLEAN.** Feature list from the "what else" brainstorm is now COMPLETE. Remaining: deploy (deliberately deferred by Kali until content settles) + hardware pass.
- 2026-09-13 (Claude Code): **Host-side casting.** Host screen has a "Casting" roster of all 20 characters; the host types a guest name against any of them (any flex, any order — rule 2) and saves it with the party (`game.reservations`, via host-only `POST /api/cast`). `join` gives a guest their reserved character when the name matches (case/spacing ignored); unmatched names are seated from unreserved seats, falling back to a reserved seat only when nothing else is free, so nobody is blocked. Reservations never appear in `/api/state`; reserved seats are hidden from the guest picker. Tested in test-engine §15b.
  Remaining — **hardware-only** (can't be done from here): Step 6 live pass — real Netlify deploy + Blobs, physical NFC tags, iPad/AirPlay, and running the TTS generator (edge-tts + network) to ship docent audio (gallery uses the browser voice otherwise). Software is fully built and tested locally. Everything authorable is done.

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

## Two packs, and where the words live (added 2026-09-13)
The repo now holds **two complete story packs**: `packs/last-exhibit/` and `packs/reunion-1989/`
(a class-of-1989 reunion). Both are radioactive — same spoiler rules, same shape: 10 core
characters, 10 flex, 4 sealed-at-random solutions, 7 props, six phases.

The engine no longer contains any words that belong to a particular story. **Every word a guest
or a host can read now comes from the pack**, not from the code: the narrator's phase speeches
and asides, the prop labels and their numbers, the poll questions, the award names, the phase
names, the invite kit, the printable labels and cue cards — all of it is authored in each pack's
bible and served to the app at runtime. Swapping packs swaps the whole voice of the evening.
The code keeps only the machinery (when a phase turns, when the keystone unlocks, how votes
tally) plus a few neutral placeholder strings that a finished pack never uses.

Practical notes for the owner:
- Pick which pack runs by setting `MYSTERY_PACK_FILE` to that pack's `pack.json.b64`. With
  nothing set, the last-exhibit pack runs, exactly as before.
- The printables and invite pages now generate from whichever pack is loaded, so the labels,
  the numbered cards and the invitation wording always match the game you're actually hosting.
- Each pack has its own spoiler-free props guide in `docs/`, and its own host runbook:
  `docs/last-exhibit-host-runbook.md` (formerly host-runbook.md) and
  `docs/reunion-1989-host-runbook.md`. The reunion one is also published as a Claude
  artifact with a checklist Kali ticks off, which is the copy she actually reads.
- Checksums above are the current ones; `engine/validate.js` pins the last-exhibit bible and
  reports a mismatch if it is edited.

## The look changes with the pack too (added 2026-09-14)
Words were already pack-driven; the palette was not, so both games wore the gallery's dark
gold-and-plum. Each pack now also carries a **plaintext `theme.json`** beside its encoded bible
holding colors, fonts, corner radius and a short list of extra CSS rules. It is presentation
only, never plot, which is why it is the one file in a pack folder that is safe to read.

`engine/functions/theme.js` serves it at `/api/theme.css`, and every page links it right after
`app.css`. It is a real blocking stylesheet rather than something JavaScript applies afterwards,
so the correct palette is on screen at first paint and no guest sees a flash of the other game's
colors. `engine/public/app.css` now expresses every color and both type faces as custom
properties, so a new pack re-skins the entire app without touching a line of engine code.

- `packs/last-exhibit/theme.json` restates the original gallery look exactly; that pack is
  unchanged to the eye.
- `packs/reunion-1989/theme.json` is the yearbook palette: hot pink, cyan and yellow on near-black,
  Archivo Black titles, hard 3px corners, and a four-color band across the top of every screen.
  It matches the printed invitation.
- A third pack with no `theme.json` still runs; it simply keeps the engine's default look.
- `netlify.toml` ships `packs/**/theme.json` with the functions and routes `/api/theme.css`
  ahead of the generic `/api/*` splat.

## The narrator sounds like the pack too (added 2026-09-14)
The narration mp3 files are git-ignored and the Netlify build never renders them, so at a live
party **every spoken line comes from the browser's own speech synthesis on the room screen**, not
from an audio file. That fallback was hardcoded to prefer a British male voice at rate 0.95 and
pitch 0.9 - the gallery docent - whichever game was loaded.

Voice is now part of each pack's `theme.json`, read through the new `engine/lib/theme.js` and
served to the room screen on `/api/kit`:

- `prefer` is a best-first list of voice names or language tags; the first one the device actually
  has installed wins, and a voice the host picks from the dropdown still beats all of it.
- `rate` and `pitch` set the delivery, and `audition` is the line spoken when a voice is tried.
- `edge` names the edge-tts voice, so a future pre-rendered pass matches the live one.
- last-exhibit restates the old British docent exactly; reunion-1989 is an American woman at a
  natural pace, which on an iPad resolves to Ava if present and Samantha otherwise.

## Host controls can move between devices (added 2026-09-14)
The host token was written to localStorage on whichever browser pressed Create party and there
was no way to enter it anywhere else, so host controls were stranded on one device with no
recovery if it died mid-party. Guests already had a seat-code resume; the host had nothing.

The live host card now shows the **host key** behind a disclosure, and the setup card has
"Already started it on another device?" taking the party code and that key. The pair is checked
against a host-only read (`cast` with action `get`) before anything is stored, so a wrong key
fails with a message and changes nothing. Verified across two separate browser profiles: a wrong
key is refused, the right one takes control on a fresh device, and advancing a phase there shows
up on the original device.

## The lobby, and joining is now idempotent (added 2026-09-14)
Kali asked for the thing she liked about StoryPop: an interface you can poke around in as your
character in the weeks before the party. Two parts.

**Joining by name is idempotent.** `join` used to allocate a fresh seat every time, so a guest
who claimed their character early and came back on the night would have found their reserved seat
already taken by their own earlier self and been re-seated from whatever was left. It now returns
the existing seat and its personal code when a name already holds one. That is what makes an early
lobby safe, and it also rescues a guest who lost their five-letter seat code.

**A party opens in the lobby.** `create-game` sets `lobby: true`; the host ends it with
`advance {openDoors: true}`, which is when the phase clock actually starts. While the lobby is up,
`state` returns early with a lobby-shaped response and `scan`, `alibi`, `poll` and every other host
control are refused. A guest gets their character name, the PUBLIC persona (the brief cut at
SECRET, the same text the host posts on the event wall), what to wear, who else has claimed a
character, and the beats that have already landed. There is no path from the lobby response to a
brief, a script line, a drop, a variant or the victim.

`packs/<id>/lobby.json` is plaintext beside the encoded bible, like `theme.json`: copy, per-character
costume notes, and dated beats. A beat writes a character as `{{C1}}` and the name is substituted
when it is served, so no character name is ever written into the plaintext and the scanner stays
clean. A beat dated in the future never leaves the server.

reunion-1989 carries four beats (Oct 17, Oct 31, Nov 14, Nov 20) and costume notes for all twenty.
last-exhibit carries copy only, which exercises the no-beats path.

## The reunion class was recast (added 2026-09-14)
Kali's read on the first cast: too small-town and too androgynous, and her guest list is
overwhelmingly women. The surface of all twenty characters was rewritten. The mystery underneath
is untouched: same ids, same secrets, same implications, same four variants, same evidence chains,
same trigger phrases.

- **12 women, 5 men, 3 unisex**, carried as an explicit pronoun tag at the head of each dossier so
  the count is machine-checkable rather than inferred from prose.
- **Period-correct names.** The first cast was unisex to the point of androgyny (Tandy, Reese,
  Marion, Quinn, Emery). These are the names of people born around 1971.
- **The town is gone.** No more sheriff's deputy, hardware store, diner, shop teacher, local paper
  or only-doctor-for-twenty-miles. It is a large suburban high school and everyone scattered after
  graduation, which is also why nobody has been keeping tabs on anybody for thirty-five years.
- **The archetypes she asked for are in it**: cheer captain, homecoming queen, the one voted most
  likely, the MLM friend, the photographer with four hundred thousand followers, the valedictorian,
  the athletic director, the drama kid.

Downstream: the casting sheet, the guest communications and `lobby.json` were rebuilt from the new
roster. `docs/` carried no character names, so the props guide and both runbooks were unaffected.
Party FMEU was created before the recast but nobody had claimed a character, and character ids did
not move, so it picks up the new cast on deploy with nothing to redo.

Two more men (added 2026-09-14). Her guest list came back needing them, so flex F3 and F10 were
rewritten from women to men: name, pronoun tag, costume note, and the gendered phrasing in their own
lines. Nothing underneath moved. Both are flex, so no variant, evidence chain or prop hung on either
of them, and the ids did not move.

## The party audit, and two gaps it found (added 2026-09-14)
`engine/audit.js` plays 24 real games and answers the three questions that actually decide whether
the night works, rather than restating that the unit tests pass. It prints counts and PASS/FAIL
only, so it is safe to run in front of the owner.

1. **Leaks.** Every endpoint, at every phase, as a player, as a bystander and with a forged seat
   code: 2,520 payloads swept per run for the sealed variant's own text and for the killer named as
   guilty. Zero, across all four variants.
2. **Branching.** Two rooms voting differently end with different private content; finds change the
   room and the narrator reacts; the 6:40 question resolves.
3. **Engagement.** Every character has a line in every played phase, most lines name another guest
   or set a task, the quietest seat at a table of twenty still receives something every phase, and
   something stays locked until Phase 4.

It found two real gaps, both present since the first pack and neither caused by the recast:

- **Variant B had no keystone prop.** A, C and D each hang E6 on a prop that locks before Phase 4
  and opens after it. B hung E6 on nothing, so one night in four had no gated object and Phase 4
  released nothing. Fixed in both packs by promoting a prop B already treated as genuine. New
  validator rule **R4b** now requires every variant to have exactly one keystone prop named by its
  E6, so this cannot ship again.
- **Nobody had a line in Phase 2.** Phase 2 carried a one-line reaction that the parser turned into
  neither a quote nor a prompt, so the moment right after the discovery gave the quiet guests
  nothing. Every character in both packs now has a Phase 2 quote and prompt. New validator rule
  **R7** requires a line for every character in every played phase. Side effect: the share of lines
  that point at another guest or set a task went from 64% to 84% in the reunion.

`packs/last-exhibit/plot-bible.md.b64` changed, so `EXPECTED.md5` in validate.js was re-pinned.

## The cast has relationships now (added 2026-09-14)
The owner asked why a character had married into the class with no spouse present, and said the
cast did not all have to be individuals. Four relationships were built out of existing characters:
a married couple, two business partners, a pair estranged since 1989, and two cousins. Two of the
four are core-to-core so the spine survives a table of ten.

The rule that makes this safe: **a core character may never name a flex character**, because flex
characters are optional and fairness rule 2 says nothing may depend on one. A core half speaks of a
spouse in the abstract; only the flex half names the other person. Verified by script: zero
references to a flex name anywhere in a core brief, secret or script line.

The two retired teachers stay. They now read as what they are, invited guests of honor printed on
the program, rather than as unexplained attendees.

## Instructions for Claude Code sessions
Read this file first. Decode b64 pack files only into memory/tmp for build+validation; delete decoded copies; never print their content to the terminal, logs, or commits. Keep all Kali-facing output spoiler-free.
