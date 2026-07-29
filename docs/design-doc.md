# The Last Exhibit — Design Doc (Spoiler-Safe)

This document captures the **locked design requirements**. It contains no plot,
no solution, and no character secrets — it is safe for the owner to read.

## Format
- 10–20 players, ~2 hours, six phases.
- Funny-dark tone; glamorous / spooky / modern setting (a gallery, opening night).
- The owner **plays**. There is no all-knowing human emcee — the app is the
  game master.

## The mystery
- **Hybrid killer:** nobody (not even the owner) knows the culprit until a
  mid-game private unlock.
- **Randomized solution variant** chosen at game start. Neither the owner nor
  any assistant knows the outcome on the night of the party.
- The design is **two-layer**: a surface mystery any casual player can follow,
  and a deeper evidence chain for players who want to dig. It should not be
  predictable, nor so complex that casual players give up.

## The six phases
1. **Arrivals** — mingling; players learn their own character and public persona.
2. **The Unveiling** — the body is discovered; the game proper begins.
3. **Investigation** — clue discovery, alibis, first anonymous/public polls.
4. **The Keystone** — the decisive evidence becomes reachable; the case turns
   from guessable to provable.
5. **Accusation** — players commit to a theory; branching consequences resolve.
6. **The Reveal** — the app reveals the night's variant and settles the room.

## Mechanics
- **Player join:** party code + personal code on their phone. No accounts.
- **Gallery Screen:** an account-free display mode for iPad → AirPlay. No login,
  no personal data ever shown on the shared screen.
- **Branching:** anonymous and public polls (StoryPop-style) steer optional
  beats and difficulty.
- **Idle-player rescue:** personalized nudge tasks keep quiet players engaged.
- **Props:** few but weighty. Every prop is genuine in at least one variant, so
  none is ever safely ignorable. See `docs/last-exhibit-props-guide.md`.
- **Physical props:** 7 items with NFC tags (NTAG213) opening prop URLs;
  fallback is an in-app "I found something" picker keyed to gallery placard
  numbers.

## Hosting
- Netlify: static front-end + Netlify Functions + Netlify Blobs for shared
  game state. Deployed from the owner's GitHub.

## Fairness guarantees (validated programmatically)
The pack defines a set of fairness rules (e.g. every variant's killer is
provable from its evidence chain; no solution depends on an optional "flex"
character; every prop matters in at least one variant; the keystone is
unreachable before Phase 4). `engine/validate.js` checks these across every
variant and every player count 10–20, and reports only pass/fail.
