# The Last Exhibit — Host Runbook & Dress-Rehearsal Guide

Everything you need to set up, rehearse, and run the night — with **zero
spoilers**. The solution is chosen at random when you start the party and is
sealed inside the app. No screen ever shows it to you until the final reveal,
so you can play too.

---

## 1. One-time setup (do this a week ahead)

### Deploy the app (Netlify)
1. Push this repo to your GitHub (already connected).
2. In Netlify: **Add new site → Import from GitHub → this repo.**
3. Build settings are read from `netlify.toml` automatically:
   - Publish directory: `engine/public`
   - Functions: `engine/functions`
   - Build command re-checks the pack and fairness rules on every deploy.
4. Netlify **Blobs** needs no setup — it's on by default for Functions. Shared
   game state lives there.
5. Note your site address, e.g. `https://your-game.netlify.app`.

### Verify it deployed cleanly
- Open `https://your-site/host` → click **Create party** → you should get a
  4-letter code.
- Open `https://your-site` on your phone → join with that code and your name →
  you should see a character dossier.

---

## 2. Build & place the props (30 minutes)

1. Follow **`docs/last-exhibit-props-guide.md`** to assemble the seven props
   (about $10 of thrifted bits).
2. Open `https://your-site/printables` in a browser. Enter your site address at
   the top and **Print / Save as PDF**. You get:
   - the **NFC tag map** (which URL to write to which prop),
   - **prop labels & fold-inserts** (fold the marked ones *without reading* —
     they're deliberately ambiguous; the app tells the real story),
   - **gallery placards** (Exhibit No. 1–12),
   - a printable **invite**.
3. Program the 7 NFC stickers with the free **NFC Tools** app: Write → add a
   **URL** record → paste the prop's URL from the map (e.g. `…/prop/P4`). Tap to
   test — a phone should open the prop page.
4. Place the props per the placement guide. Test-tap each once during setup.

> If any tag misbehaves, guests can always use **"I found something"** in the
> app and pick the exhibit number. Meaning is tied to the item, not the tag.

---

## 3. Dress rehearsal (grab one other person + two phones)

Run this a few days before. It touches every moving part without spoiling you.

1. **Create a party** at `/host`. Put the **Gallery Screen** on your TV:
   open the "Open Gallery Screen" link, or `https://your-site/gallery?party=CODE`,
   and AirPlay/cast it. Confirm no personal data appears there — only phase,
   the room, and the guest list.
2. **Join twice** (both phones) with the party code. Each phone should show a
   different character and a private dossier.
3. **Walk the phases** on `/host` with **Advance phase →**:
   - Phase 1 Arrivals → 2 The Unveiling → 3 Investigation.
   - At **Phase 3**, one player's phone privately reveals a role change with
     do/don't guidance. Don't peek at the other phone — this is the design
     working. (If *you* ever draw that role on the night, the app coaches you;
     no acting skill needed.)
4. **Scan a prop** (tap a tag, or use "I found something"). Before Phase 4, the
   decisive piece stays "to be announced." **Advance to Phase 4** and scan again
   — more should surface. This is the fairness guarantee in action.
5. **Run a poll** from `/host`: type a question and 2–4 options, **Open poll**.
   Vote on both phones. **Close** it to see the tally (votes are anonymous).
6. **Advance to Phase 6** and click **Reveal the solution** on `/host`. This is
   the *only* place and time the sealed answer appears. Read it, enjoy, and
   **click "Forget this party on this device"** so you go into the real night
   unspoiled. Start a fresh party for the actual party.

Rehearsal checklist: ✅ deploy ✅ join ✅ gallery on TV ✅ phase advance
✅ mid-game role unlock ✅ prop scan before/after Phase 4 ✅ poll tally
✅ reveal — then wipe.

---

## 4. Night-of run sheet (~2 hours)

You mostly let the app be the game master; you set tempo and read the room.

| Phase | ~Time | You do | The app does |
|------|------|--------|--------------|
| 1 · Arrivals | 20m | Hand out the party code; help people join | Assigns characters, gives each a private dossier |
| 2 · The Unveiling | 10m | Gather everyone; "discover" the body | Opens the case; publishes what the room knows |
| 3 · Investigation | 35m | Encourage snooping & prop-hunting; run 1–2 polls | Privately unlocks the hidden role; serves clues |
| 4 · The Keystone | 25m | Keep energy up; run the pivotal poll | Unlocks the decisive evidence |
| 5 · Accusation | 20m | Let players make their case; final poll | Resolves branch consequences |
| 6 · The Reveal | 10m | Trigger the reveal from `/host`; read it aloud | Reveals the sealed solution |

**Polls** (StoryPop-style) are your main lever. Good ones: "Who benefits most?",
"Where were you at 6:40?", "Should we subpoena the doctor's files?" Options are
usually the guest characters — read them off the in-app roster.

**Quiet guests?** Walk over and hand them a small task drawn from their own
dossier ("someone noticed you two talking — go manage it"). Every dossier has
hooks for this.

---

## 5. Troubleshooting

- **A tag won't scan** → use "I found something" in the app; keep one spare
  sticker programmed with any URL as a backup.
- **A guest lost their code** → they just re-join at the site with a new name;
  characters are handed out in order, so seat them early.
- **More/fewer guests than expected** → any count 10–20 works; the mystery is
  provably solvable at every size (checked automatically on each deploy).
- **You want to reset mid-setup** → `/host` → "Forget this party on this
  device," then create a fresh party.

---

## 6. The promise

- The killer is chosen **at random when you start the party**. You don't know
  it. Claude doesn't know it. It can't leak, because it isn't decided until
  night-of and it never appears on any screen before Phase 6.
- Every prop matters in at least one version of the truth, so nothing is safely
  ignored. Every guest is plausibly guilty. The decisive clue can't arrive early.
- You get to actually play. Have a wonderful, sinister evening.
