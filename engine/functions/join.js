'use strict';
/* POST /api/join  { partyCode, name, characterId? } -> { personalCode, character }
 * Seating order:
 *  0. The name ALREADY holds a seat in this party -> that same seat, with its
 *     original personal code. Joining is therefore safe to repeat: a guest who
 *     claimed their character in the lobby weeks ago arrives on the night, types
 *     the same name, and gets the same character rather than a fresh seat out of
 *     what is left. It also rescues anyone who lost their seat code.
 *  1. The name matches a host reservation (case/spacing ignored) -> that character.
 *  2. characterId given -> claims that unclaimed, unreserved character (casting).
 *  3. Otherwise the next unclaimed seat, core cast first, skipping reserved
 *     seats; if only reserved seats remain, one of those is used so a surprise
 *     guest or a typo is never turned away. (Fairness rule 2: flex are never
 *     load-bearing.) */

const { ok, bad, notFound, preflight, parseBody, personalCode } = require('../lib/api');
const { connect, updateGame } = require('../lib/store');
const { loadRuntimePack, playerBrief, assignableIds, normName } = require('../lib/runtime');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, name, characterId } = parseBody(event);
  if (!partyCode || !name) return bad('partyCode and name required');

  const pack = loadRuntimePack();
  const seatOrder = assignableIds(pack); // core cast first, then flex
  if (characterId && !seatOrder.includes(characterId)) return bad('no such character');
  const want = normName(name);

  let assignedId = null;
  let pcode = null;
  let alreadyClaimed = false;
  let reservedElsewhere = false;
  let returning = false;

  const game = await updateGame(partyCode.toUpperCase(), (g) => {
    assignedId = null; alreadyClaimed = false; reservedElsewhere = false; returning = false; // reset on retry

    // Already seated under this name? Hand back the same seat, untouched.
    const seated = Object.entries(g.players || {})
      .find(([, p]) => normName(p.name) === want && p.characterId);
    if (want && seated) {
      pcode = seated[0];
      assignedId = seated[1].characterId;
      returning = true;
      g.players[pcode].lastActive = new Date().toISOString();
      return g;
    }

    const taken = new Set(Object.keys(g.assignments));
    const res = g.reservations || {};
    const open = (id) => !taken.has(id);
    const match = want ? seatOrder.find((id) => open(id) && res[id] && normName(res[id]) === want) : null;
    if (match) {
      assignedId = match;
    } else if (characterId) {
      if (taken.has(characterId)) { alreadyClaimed = true; return g; }
      if (res[characterId]) { reservedElsewhere = true; return g; }
      assignedId = characterId;
    } else {
      assignedId = seatOrder.find((id) => open(id) && !res[id]) || seatOrder.find(open) || null;
    }
    if (!assignedId) return g; // full (all seats claimed)
    pcode = personalCode();
    const now = new Date().toISOString();
    g.players[pcode] = { name, characterId: assignedId, joinedAt: now, lastActive: now };
    g.assignments[assignedId] = pcode;
    g.log.push({ at: new Date().toISOString(), kind: 'join', characterId: assignedId });
    return g;
  });

  if (!game) return notFound('no such party');
  if (alreadyClaimed) return bad('that character was just claimed — pick another');
  if (reservedElsewhere) return bad('that character is reserved for another guest — pick another');
  if (!assignedId) return bad('party is full (all characters assigned)');

  return ok({ personalCode: pcode, character: playerBrief(pack, assignedId), returning });
};
