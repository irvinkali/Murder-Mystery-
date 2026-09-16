'use strict';
/* POST /api/scan  { partyCode, personalCode, exhibit }  ->  prop reveal
 * `exhibit` is the placard number (or the NFC tag value). Internal prop IDs are
 * resolved server-side and never returned. Keystone stays gated until Phase 4. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, resolvePropScan, propIdFromInput, narrationCopy, say, FALLBACK } = require('../lib/runtime');
const { pushNarrator, foundLine } = require('../lib/narrator');
const { isKeystoneProp, fireTokenLink } = require('../lib/deduction');

// Nothing is "found" before the body is. A find also costs a seat one of a
// small number of registrations per phase, so no single guest can clear the
// board for everybody by typing numbers.
const DISCOVERY_PHASE = 2;
const FINDS_PER_SEAT_PER_PHASE = 3;

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const b = parseBody(event);
  const raw = b.exhibit != null ? b.exhibit : b.propId; // accept either
  if (!b.partyCode || raw == null) return bad('partyCode and exhibit required');

  const code = b.partyCode.toUpperCase();
  const game = await getGame(code);
  if (!game) return notFound('no such party');
  if (!b.personalCode || !game.players[b.personalCode]) return forbidden('join the party first');
  if (game.lobby) return bad('the party has not started yet');

  const pack = loadRuntimePack();
  const propId = propIdFromInput(raw, pack);
  if (!propId) {
    const msg = say(pack, narrationCopy(pack).unknownTag) || FALLBACK.unknownTag;
    return ok({ reveal: { unknown: true, message: msg } });
  }

  const r = resolvePropScan(pack, game.variant, propId, game.phase);
  // One field, always. The internal prop id, the chain-step ordinal and the
  // "this is the gated one" flag all used to ride along here; between them they
  // told a guest which exhibits mattered tonight. See lib/runtime.js.
  const reveal = { label: r.label, blurb: r.blurb, reading: r.reading || null };

  await updateGame(code, (g) => {
    const seat = g.players[b.personalCode];
    if (seat) {
      // Breadth, not taps. This used to be a raw counter, so forty taps of one
      // exhibit read as forty finds — and this number decides who receives the
      // partial release and who takes the exhibits award.
      seat.seen = seat.seen || {};
      seat.seen[propId] = true;
      seat.scanCount = Object.keys(seat.seen).length;
      seat.lastActive = new Date().toISOString();
    }

    // Registering a FIND is not the same as reading an exhibit. Anyone can type
    // a number, and one guest typing the whole range used to mark all seven
    // found for the entire room, which silently switched off every find-hint
    // the evening had. So a find only registers once the body has been found,
    // and one seat may register a bounded number of them per phase.
    const already = !!g.discovered[propId];
    let registered = false;
    if (!already && g.phase >= DISCOVERY_PHASE && seat) {
      const key = 'p' + g.phase;
      seat.finds = seat.finds || {};
      if ((seat.finds[key] || 0) < FINDS_PER_SEAT_PER_PHASE) {
        seat.finds[key] = (seat.finds[key] || 0) + 1;
        g.discovered[propId] = { count: 0, firstAt: new Date().toISOString() };
        registered = true;
      }
    }
    if (g.discovered[propId]) g.discovered[propId].count += 1;
    // The narrator notices the first genuine discovery of each exhibit.
    if (registered) pushNarrator(g, 'found.' + propId, foundLine(propId, pack));
    // Reading the decisive exhibit in the fourth phase is what puts the public
    // link in front of the room. A room that never reads it still gets it when
    // the phase ends (see lib/deduction.fireOutstanding), so the chain is
    // always completable.
    if (isKeystoneProp(pack, g, propId)) fireTokenLink(pack, g);
    g.log.push({ at: new Date().toISOString(), kind: 'scan', propId, by: b.personalCode });
    return g;
  });

  return ok({ reveal });
};
