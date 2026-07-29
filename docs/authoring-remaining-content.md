# Authoring the remaining content (spoiler-safe hand-off)

Two pieces of the game still need **new plot content** written. Because you play
the game, that content can't be authored in a session whose output you can read
— it would spoil you. This doc explains how to get it authored **without**
spoiling yourself, and exactly where it plugs in. The doc itself is spoiler-free.

## Why a separate session

The spoiler protocol keeps all plot in encoded `*.b64` files. Authoring new plot
means the plaintext exists somewhere while it's written. The safe pattern (the
same one that produced the plot bible) is:

1. Open a **separate chat session** with Claude — one whose transcript you agree
   not to read.
2. Have it write the content and return **only the base64**, never the plaintext.
3. Paste that base64 into the file named below and commit it.
4. Come back here (or any Claude Code session) and run `npm run check` — the
   validator and spoiler-scanner confirm it's wired correctly, and you still
   never see the contents.

You can hand that session the two specs below verbatim.

---

## Piece 1 — Flex characters F1–F10  (needed for 11–20 players)

**File to create:** `packs/last-exhibit/flex-characters.md.b64`
**Format:** UTF-8 Markdown, then base64-encoded. Same shape as the core cast
entries in the bible. One entry per character:

```
**F1. <Name>** — <one-line public persona>. SECRETS: <a light personal secret
that gives them something to do and something to hide>. <Optional: a MEMENTO
hook — a line about a piece in the show that grazes their secret.>

**F2. <Name>** — …
```

**Hard rules (the validator/engine enforce or assume these):**
- Ids must be `F1`…`F10`, in order.
- **Never load-bearing.** No flex character may be the killer in any variant, and
  no variant's evidence chain may depend on a flex character. (10-player games
  omit all flex entirely, so the mystery must be complete without them.)
- Each needs a public persona (their role at the party) and a private secret
  (served only to that player). Keep them in the glamorous/spooky gallery world.
- They should create social texture (rivalries, crushes, debts, gossip) that
  points *toward* the core cast, never a parallel mystery.

**How it plugs in:** drop the file in, run `cd engine && npm run build-pack`.
`join` then seats players 11–20 into F1…F10 automatically; the `CAP` line in
`npm run validate` will flip from "10 seats (core only)" to "20 seats — covers
the full 10–20 range."

---

## Piece 2 — Variant-specific branching consequences

The engine already has the **mechanism** (polls, phases, private drops, the
mid-game killer unlock, idle nudges). What's missing is the **text** of the
variant-specific consequences the design calls for, e.g.:

- the private **defense drop** the top-suspected player receives after the
  "who benefits most" poll,
- the **alibi contradiction** flagged after the "where were you" question,
- the **medical-files** reveal that a Phase-4 poll can surface.

**Suggested file:** `packs/last-exhibit/branching.md.b64` (base64), structured so
each entry names: the trigger (which poll/outcome + phase), the target
(which character or "top-voted"), and the drop text **per variant A/B/D/C** where
it differs. Keep every drop gated to its phase; nothing may surface the keystone
(E6) before Phase 4.

**How it plugs in:** tell me the file exists and I'll add the small resolver
(poll-close → evaluate trigger → write a private drop into the target player's
state, shown on their phone). It's a contained change once the content exists.

---

## What needs no authoring

Everything else is done and tested: the fairness validator, the full engine
(join, per-player briefs, NFC prop routing with the keystone gated to Phase 4,
polls, phases, host-only Phase-6 reveal), the hybrid-killer mid-game unlock, the
idle-rescue prompts, the front-end (join / player / gallery / host / prop), the
printables kit, the host runbook, the local dev server, and CI that fails on any
spoiler leak. See `STATE.md` for the full log.
