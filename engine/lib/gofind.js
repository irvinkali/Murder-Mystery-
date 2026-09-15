'use strict';
/*
 * THE GO-FIND NUDGE.
 *
 * At fourteen people everybody talks to the four they arrived with, and the
 * room quietly turns back into the groups it walked in as. The app knows the
 * whole roster and it knows who is actually seated, so it can break that up:
 * once per phase from Asking Around onward, every seated guest is handed the
 * name of one other seated character and told to go and find them.
 *
 * WHAT MAKES THIS SAFE TO SHIP NEXT TO A MYSTERY
 *
 * Each round is a single rotation of the seated characters: person i is sent to
 * person i + step. That is a derangement, so nobody is sent to themselves, and
 * every seated character is named EXACTLY once per round. The distribution is
 * not merely even on average, it is even by construction, so there is no
 * pattern in who gets named that could point at anybody.
 *
 * Nothing here reads the sealed variant, the killer, the evidence chain or any
 * secret. The only inputs are the party code, the phase, and which characters
 * are seated. Run the same party shape against all four variants and you get
 * the same nudges in the same order, which is the point and is tested.
 *
 * Deterministic: no randomness and no clock, so a phone polling every few
 * seconds sees the same nudge all phase instead of a new one each time.
 */

const { narrationCopy, say } = require('./runtime');

/** From Asking Around to the end of the night. */
const GOFIND_FROM_PHASE = 3;

/*
 * The wording. Player-facing copy, so a pack may carry its own list under
 * narration.goFind and these are the engine's backstop. `{name}` is the
 * character being pointed at. Deliberately pronoun-free about the target:
 * "them" works for everybody in this cast, and no line implies anything about
 * anyone beyond the fact that two people have not spoken yet.
 */
const FALLBACK_LINES = [
  'Go and find {name}. You have not said two words to them all night.',
  '{name} is somewhere in this room, and you have not spoken since about 1989. Fix that.',
  'Find {name}. Ask them one thing you would actually want the answer to.',
  'You have been talking to the same four people since you walked in. Go and find {name}.',
  '{name}. Go on. Say hello properly and mean it.',
  'Somebody should go and check on {name}. Let it be you.',
  'Go and find {name} and ask them what they thought tonight was going to be like.',
  'Find {name} before the night gets away from you. There is not another thirty-five years in it.',
  '{name} is in here somewhere. Go and find out what they have been doing since graduation.',
  'Go and find {name}. Two minutes. That is all this needs.',
];

/** The pack's own phrasings if it has any, otherwise the engine's. */
function goFindLines(pack) {
  const list = narrationCopy(pack).goFind;
  return (Array.isArray(list) && list.length) ? list : FALLBACK_LINES;
}

/** Small stable string hash. Same input, same number, on every poll and host. */
function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** C2 before C10 before F1: a stable order that does not depend on join time. */
function sortIds(ids) {
  const key = (id) => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(id);
    return m ? [m[1], Number(m[2])] : [id, 0];
  };
  return ids.slice().sort((a, b) => {
    const [pa, na] = key(a); const [pb, nb] = key(b);
    return pa === pb ? na - nb : (pa < pb ? -1 : 1);
  });
}

/** The characters somebody has actually joined as, in a stable order. */
function seatedCharacterIds(game) {
  const seen = new Set();
  for (const p of Object.values((game && game.players) || {})) {
    if (p && p.characterId) seen.add(p.characterId);
  }
  return sortIds([...seen]);
}

/**
 * How far round the circle this phase sends everybody. Never 0 (that would send
 * people to themselves) and it moves between rounds, so nobody is sent to the
 * same person twice while the room stays the size it was. Seeded off the party
 * code alone, so two parties on the same night pair up differently and neither
 * depends on anything sealed.
 */
function stepFor(partyCode, phase, n) {
  if (n < 2) return 0;
  const round = phase - GOFIND_FROM_PHASE;
  return 1 + ((hash(partyCode) + round) % (n - 1));
}

/**
 * The whole room's pairings for one phase: { characterId: targetCharacterId }.
 * Empty before Asking Around, or when there is nobody to be sent to.
 */
function pairingsFor(game, phase) {
  const out = {};
  if (!game || game.lobby) return out;
  if (!(phase >= GOFIND_FROM_PHASE)) return out;
  const ids = seatedCharacterIds(game);
  const n = ids.length;
  if (n < 2) return out;
  const step = stepFor(game.partyCode, phase, n);
  for (let i = 0; i < n; i++) out[ids[i]] = ids[(i + step) % n];
  return out;
}

/**
 * One guest's nudge, or null. Returns the target's character id alongside the
 * line so a caller can assert on the pairing without parsing prose.
 */
function goFindNudge(pack, game, characterId, phase) {
  const target = pairingsFor(game, phase)[characterId];
  if (!target || target === characterId) return null;
  const chars = [...((pack && pack.cast) || []), ...((pack && pack.flex) || [])];
  const to = chars.find((c) => c.id === target);
  if (!to || !to.name) return null;
  const lines = goFindLines(pack);
  // Varied per guest AND per round, so neighbours are not handed the same
  // sentence and nobody reads the same one twice in a night.
  const idx = (hash(game.partyCode + '|' + characterId) + (phase - GOFIND_FROM_PHASE)) % lines.length;
  return { characterId: target, text: say(pack, lines[idx].replace(/\{name\}/g, to.name)) };
}

module.exports = {
  goFindNudge, pairingsFor, seatedCharacterIds, goFindLines,
  GOFIND_FROM_PHASE, FALLBACK_LINES,
};
