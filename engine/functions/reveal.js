'use strict';
/* POST /api/reveal  { partyCode, hostToken }
 * Host-only, Phase 6 only, and ONLY after the mandatory final vote has closed.
 * Publishes the sealed solution to the gallery (everyone sees it) and returns
 * it to the host. The host keeps advance/pause control. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, getVariant, KEYSTONE_PHASE, PHASES, audioName, AUDIO_KEYS } = require('../lib/runtime');
const { finalVoteClosed } = require('../lib/pollsched');

const REVEAL_PHASE = PHASES[PHASES.length - 1].n; // 6

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad('POST only');

  const { partyCode, hostToken } = parseBody(event);
  if (!partyCode) return bad('partyCode required');

  const game = await getGame(partyCode.toUpperCase());
  if (!game) return notFound('no such party');
  if (hostToken !== game.hostToken) return forbidden('host only');
  if (game.phase < REVEAL_PHASE) return forbidden(`the reveal unlocks in phase ${REVEAL_PHASE}`);
  if (!finalVoteClosed(game)) return forbidden('the final vote must close before the reveal');

  const pack = loadRuntimePack();
  const v = getVariant(pack, game.variant);
  if (!v) return bad('sealed variant missing');

  const solution = {
    variant: v.letter,
    killer: v.killer,
    motive: v.motive,
    method: v.method,
    evidence: v.evidence.steps,
    keystonePhase: KEYSTONE_PHASE,
  };

  // Broadcast to the gallery for everyone (Phase 6 reveal plays on screen).
  // Only the ACTIVE variant's audio files are referenced.
  const revealAudio = [audioName(AUDIO_KEYS.revealTitle(v.letter)), audioName(AUDIO_KEYS.revealMethod(v.letter))];
  await updateGame(game.partyCode, (g) => {
    g.reveal = { ...solution, audio: revealAudio, at: new Date().toISOString() };
    return g;
  });

  return ok(solution);
};
