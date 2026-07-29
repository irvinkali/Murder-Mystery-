'use strict';
/*
 * Branching-consequence resolver.
 *
 * Pure decision logic over the parsed branching data + game state. It selects
 * WHICH drop text a player receives and to WHOM/WHEN, per branching.md §4:
 *
 *   §4.1 Defense drops — Phase 3 only, once per game, on the "who benefits"
 *        poll close. Target = top-voted core character.
 *   §4.2 Alibi flag — Phase 3, once, only when the target's logged 6:40 answer
 *        contradicts (i.e. does NOT place them with the victim / near the back room).
 *   §4.3 Medical reveal — Phase 4 only. YES-majority: FULL to all + a [SCREEN]
 *        line. NO-majority: PARTIAL to the three most-active investigators,
 *        delayed ~6 minutes, framed as a leak; must still arrive before Phase 5.
 *   §4.5 Killer-complicating ordering — a complicating drop may only be served
 *        AFTER the killer unlock has fired for that player. If the unlock has
 *        not yet fired when a complicating drop is due, serve the DEFAULT text
 *        and suppress the complicating version (no pre-unlock self-spoilage).
 *
 * No plot literals live here; all drop text flows from the parsed pack.
 */

const { resolveKillerId } = require('./runtime');

const MEDICAL_DELAY_MS = 6 * 60 * 1000; // §4.3 "~6 minutes later"

/** Map a poll option label (a typed character name) to a core character id. */
function matchCharByLabel(pack, label) {
  if (!label) return null;
  const L = String(label).trim().toUpperCase();
  const hit = pack.cast.find((c) => {
    const name = c.name.toUpperCase();
    return name === L || name.includes(L) || L.includes(name) ||
      name.split(/\s+/)[0] === L; // first-name match
  });
  return hit ? hit.id : null;
}

function personalCodeFor(game, characterId) {
  return game.assignments[characterId] || null;
}

/**
 * §4.1 + §4.5. Given the winning core character of the "who benefits" poll,
 * decide the private defense drop. Returns { targetCode, drop } or null.
 */
function computeDefense(pack, game, winningCharId) {
  const b = pack.branchingData;
  if (!b || !b.defense) return null;
  const entry = b.defense.targets[winningCharId];
  if (!entry) return null;

  const targetCode = personalCodeFor(game, winningCharId);
  if (!targetCode) return null;

  const variant = game.variant;
  const isKiller = resolveKillerId(pack, variant) === winningCharId;
  const unlockFired = !!(game.players[targetCode] && game.players[targetCode].killerSeenAt);

  let text = entry.default;
  let kind = 'defense';
  // Complicating version only if: this player IS the variant's killer, a
  // complicating line exists for THIS variant, AND the unlock already fired.
  if (isKiller && entry.complicating && entry.complicating.variant === variant) {
    if (unlockFired) { text = entry.complicating.text; kind = 'defense-complicating'; }
    // else: §4.5 — fall back to default and suppress complicating.
  }
  if (!text) return null;
  return { targetCode, drop: { kind, text } };
}

/**
 * §4.2. Fire only when the variant's alibi target has logged an answer that
 * does NOT place them with the victim / near the back room. Returns { targetCode,
 * drop } or null.
 */
function computeAlibi(pack, game) {
  const b = pack.branchingData;
  if (!b || !b.alibi) return null;
  const entry = b.alibi[game.variant];
  if (!entry) return null;
  const targetCode = personalCodeFor(game, entry.charId);
  if (!targetCode) return null;
  const answer = (game.alibi || {})[targetCode];
  if (!answer) return null; // no answer logged → no flag
  // "Near the scene" = with the victim or by the back room. Derive the victim's
  // name from the pack (never hard-code it — that would leak into source).
  const victimFirst = ((pack.victim || '').match(/\*\*([^*\s]+)/) || [])[1] || '\0';
  const nearScene = new RegExp('\\b' + victimFirst + '\\b|back[\\s-]?room', 'i');
  if (nearScene.test(answer)) return null; // honesty is its own gamble → no drop
  return { targetCode, drop: { kind: 'alibi', text: entry.text } };
}

/** The three most active investigators (by prop scans); ties break by join order. */
function topScanners(game, n) {
  return Object.entries(game.players)
    .map(([code, p]) => ({ code, scans: p.scanCount || 0, joined: p.joinedAt || '' }))
    .sort((a, b) => (b.scans - a.scans) || a.joined.localeCompare(b.joined))
    .slice(0, n)
    .map((x) => x.code);
}

/**
 * §4.3. Medical reveal. `outcome` is 'yes' or 'no'. Returns a descriptor the
 * caller applies: { drops:[{targetCode, drop}], screen? }.
 */
function computeMedical(pack, game, outcome, nowMs) {
  const b = pack.branchingData;
  if (!b || !b.medical) return { drops: [] };
  const entry = b.medical[game.variant];
  if (!entry) return { drops: [] };

  if (outcome === 'yes') {
    const drops = Object.keys(game.players).map((code) => ({
      targetCode: code,
      drop: { kind: 'medical-full', text: entry.full },
    }));
    return { drops, screen: 'The files are open.' };
  }
  // NO-majority: partial leak to the three most active investigators, delayed.
  const availableAt = new Date((nowMs || Date.now()) + MEDICAL_DELAY_MS).toISOString();
  const drops = topScanners(game, 3).map((code) => ({
    targetCode: code,
    drop: { kind: 'medical-leak', text: entry.partial, availableAt },
  }));
  return { drops };
}

/** Append resolved drops to game state. */
function mergeDrops(game, drops) {
  if (!game.drops) game.drops = {};
  for (const { targetCode, drop } of drops) {
    if (!targetCode) continue;
    (game.drops[targetCode] = game.drops[targetCode] || []).push({ ...drop, at: new Date().toISOString() });
  }
}

/**
 * Drops a given player can currently see: immediate ones, timed ones whose
 * delay has elapsed, and — per §4.3 — any pending drop once accusations
 * (Phase 5) open. Internal fields are stripped.
 */
function visibleDrops(game, code, phase, nowMs) {
  const now = nowMs || Date.now();
  const list = (game.drops && game.drops[code]) || [];
  return list
    .filter((d) => !d.availableAt || Date.parse(d.availableAt) <= now || phase >= 5)
    .map((d) => ({ kind: d.kind, text: d.text, at: d.at }));
}

module.exports = {
  MEDICAL_DELAY_MS,
  matchCharByLabel,
  computeDefense,
  computeAlibi,
  computeMedical,
  topScanners,
  mergeDrops,
  visibleDrops,
};
