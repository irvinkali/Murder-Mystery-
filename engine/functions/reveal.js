'use strict';
/* POST /api/reveal  { partyCode, hostToken }
 * Host-only, Phase 6 only, and ONLY after the mandatory final vote has closed.
 * Publishes the sealed solution to the gallery (everyone sees it) and returns
 * it to the host. The host keeps advance/pause control. */

const { ok, bad, notFound, forbidden, preflight, parseBody } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const { loadRuntimePack, getVariant, KEYSTONE_PHASE, PHASES, audioName, AUDIO_KEYS, resolveKillerId } = require('../lib/runtime');
const { finalVoteClosed, tally } = require('../lib/pollsched');

const REVEAL_PHASE = PHASES[PHASES.length - 1].n; // 6

/** The curtain call: final-vote results + narrated awards, from live game data. */
function computeFinale(pack, game, killerId) {
  const killer = pack.cast.find((c) => c.id === killerId);
  const killerName = killer ? killer.name : null;
  const finalPoll = game.polls && game.polls.final;
  const voteCounts = finalPoll ? tally(finalPoll) : {};
  const votes = finalPoll ? finalPoll.votes : {};
  const players = game.players || {};
  const info = (code) => {
    const p = players[code] || {};
    const ch = pack.cast.concat(pack.flex || []).find((c) => c.id === p.characterId);
    return { firstName: p.name || '?', characterName: ch ? ch.name : '?', scans: p.scanCount || 0, joined: p.joinedAt || '' };
  };

  const awards = [];
  // Was the killer caught? (strict plurality of the final vote)
  const maxVotes = Math.max(0, ...Object.values(voteCounts));
  const caught = !!killerName && maxVotes > 0 && (voteCounts[killerName] || 0) === maxVotes &&
    Object.entries(voteCounts).filter(([, n]) => n === maxVotes).length === 1;

  // Best Detective: voted for the killer; ties break on exhibits found, then join order.
  const correct = Object.entries(votes).filter(([, choice]) => choice === killerName).map(([code]) => code);
  if (correct.length) {
    correct.sort((a, b) => (info(b).scans - info(a).scans) || info(a).joined.localeCompare(info(b).joined));
    const w = info(correct[0]);
    awards.push({ title: 'Best Detective', firstName: w.firstName, characterName: w.characterName,
      note: 'Named the killer, and did the work to earn it.' });
  }
  // Sharpest Eye: most exhibits examined overall.
  const byScans = Object.keys(players).map((c) => ({ code: c, ...info(c) })).sort((a, b) => (b.scans - a.scans) || a.joined.localeCompare(b.joined));
  if (byScans.length && byScans[0].scans > 0) {
    awards.push({ title: 'Sharpest Eye', firstName: byScans[0].firstName, characterName: byScans[0].characterName,
      note: `Examined ${byScans[0].scans} exhibit${byScans[0].scans === 1 ? '' : 's'} — nothing in this gallery went unnoticed.` });
  }
  // Most Suspected Innocent: the wrongly-accused crowd favourite.
  const innocent = Object.entries(voteCounts).filter(([name, n]) => name !== killerName && n > 0).sort((a, b) => b[1] - a[1])[0];
  if (innocent) {
    const seat = Object.entries(players).find(([, p]) => {
      const ch = pack.cast.concat(pack.flex || []).find((c) => c.id === p.characterId);
      return ch && ch.name === innocent[0];
    });
    awards.push({ title: 'Most Suspected Innocent', firstName: seat ? seat[1].name : '', characterName: innocent[0],
      note: `Collected ${innocent[1]} accusation${innocent[1] === 1 ? '' : 's'} while entirely innocent. The room apologises. Somewhat.` });
  }
  // The killer takes a bow.
  const killerSeat = Object.entries(players).find(([, p]) => p.characterId === killerId);
  if (killerSeat) {
    awards.push({ title: caught ? 'Caught Red-Handed' : 'The Perfect Crime', firstName: killerSeat[1].name, characterName: killerName,
      note: caught ? 'The room saw through it. Take a bow anyway.' : 'Fooled the room to the very end. Take a bow — carefully.' });
  }
  return { voteCounts, caught, awards };
}

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

  const killerId = resolveKillerId(pack, game.variant);
  const killerChar = pack.cast.find((c) => c.id === killerId);
  const finale = computeFinale(pack, game, killerId);
  const solution = {
    variant: v.letter,
    // Use the cast's proper name casing (the variant header shouts in caps).
    killer: killerChar ? killerChar.name : v.killer,
    motive: v.motive,
    method: v.method,
    evidence: v.evidence.steps,
    keystonePhase: KEYSTONE_PHASE,
    voteCounts: finale.voteCounts,
    caught: finale.caught,
    awards: finale.awards,
    awardsIntroAudio: audioName('awards.intro'),
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
