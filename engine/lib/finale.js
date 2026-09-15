'use strict';
/*
 * THE CURTAIN CALL. Building the Phase-6 reveal: the sealed solution, the final
 * vote as it landed, and the narrated awards that come off live game data.
 *
 * This lives in lib/ rather than in the reveal endpoint because two things can
 * now fire it: the host pressing the button, and autopilot firing it for her
 * when the final vote closes and she is busy being a character. Both go through
 * applyReveal, so the reveal is built one way and can only happen once.
 *
 * SPOILER-SAFE in the sense the rest of lib/ is: it handles the solution, so
 * nothing here may be logged or printed by a caller.
 */

const { displayNames } = require('./names');
const { loadRuntimePack, getVariant, KEYSTONE_PHASE, PHASES, audioName, AUDIO_KEYS, resolveKillerId } = require('./runtime');
const { tally } = require('./pollsched');
const { narrationCopy, say, worldCopy, FALLBACK } = require('./runtime');

// Award titles and notes are pack copy; these neutral shapes are the fallback.
const FALLBACK_AWARDS = {
  bestDetective: { title: 'Best Detective', note: 'Named the killer, and did the work to earn it.' },
  sharpestEye: { title: 'Sharpest Eye', note: 'Examined {count} {items}.' },
  mostSuspected: { title: 'Most Suspected Innocent', note: 'Collected {count} accusation{s} while entirely innocent.' },
  caught: { title: 'Caught Red-Handed', note: 'The room saw through it. Take a bow anyway.' },
  perfect: { title: 'The Perfect Crime', note: 'Fooled the room to the very end. Take a bow — carefully.' },
};

/** One award, rendered from pack copy with {count}, {s} and {items} filled. */
function award(pack, key, count) {
  const a = ((narrationCopy(pack).awards || {})[key]) || FALLBACK_AWARDS[key];
  const w = worldCopy(pack);
  const n = typeof count === 'number' ? count : 0;
  const vars = {
    count: n,
    s: n === 1 ? '' : 's',
    items: n === 1 ? (w.itemNoun || FALLBACK.itemNoun) : (w.itemNounPlural || FALLBACK.itemNounPlural),
  };
  return { title: say(pack, a.title, vars), note: say(pack, a.note, vars) };
}

const REVEAL_PHASE = PHASES[PHASES.length - 1].n; // 6

/** The curtain call: final-vote results + narrated awards, from live game data. */
function computeFinale(pack, game, killerId) {
  const killer = pack.cast.find((c) => c.id === killerId);
  const killerName = killer ? killer.name : null;
  const finalPoll = game.polls && game.polls.final;
  const voteCounts = finalPoll ? tally(finalPoll) : {};
  const votes = finalPoll ? finalPoll.votes : {};
  const players = game.players || {};
  const shown = displayNames(game);
  const info = (code) => {
    const p = players[code] || {};
    const ch = pack.cast.concat(pack.flex || []).find((c) => c.id === p.characterId);
    return { firstName: shown[code] || p.name || '?', characterName: ch ? ch.name : '?', scans: p.scanCount || 0, joined: p.joinedAt || '' };
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
    const a = award(pack, 'bestDetective');
    awards.push({ title: a.title, firstName: w.firstName, characterName: w.characterName, note: a.note });
  }
  // Sharpest Eye: most exhibits examined overall.
  const byScans = Object.keys(players).map((c) => ({ code: c, ...info(c) })).sort((a, b) => (b.scans - a.scans) || a.joined.localeCompare(b.joined));
  if (byScans.length && byScans[0].scans > 0) {
    const a = award(pack, 'sharpestEye', byScans[0].scans);
    awards.push({ title: a.title, firstName: byScans[0].firstName, characterName: byScans[0].characterName, note: a.note });
  }
  // Most Suspected Innocent: the wrongly-accused crowd favourite.
  const innocent = Object.entries(voteCounts).filter(([name, n]) => name !== killerName && n > 0).sort((a, b) => b[1] - a[1])[0];
  if (innocent) {
    const seat = Object.entries(players).find(([, p]) => {
      const ch = pack.cast.concat(pack.flex || []).find((c) => c.id === p.characterId);
      return ch && ch.name === innocent[0];
    });
    const a = award(pack, 'mostSuspected', innocent[1]);
    awards.push({ title: a.title, firstName: seat ? (shown[seat[0]] || seat[1].name) : '', characterName: innocent[0], note: a.note });
  }
  // The killer takes a bow.
  const killerSeat = Object.entries(players).find(([, p]) => p.characterId === killerId);
  if (killerSeat) {
    const a = award(pack, caught ? 'caught' : 'perfect');
    awards.push({ title: a.title, firstName: shown[killerSeat[0]] || killerSeat[1].name, characterName: killerName, note: a.note });
  }
  return { voteCounts, caught, awards };
}


/**
 * The sealed solution plus the curtain call, ready to publish. Returns null if
 * the variant is missing (a party created against a pack that no longer has it).
 */
function buildReveal(pack, game) {
  const v = getVariant(pack, game.variant);
  if (!v) return null;
  const killerId = resolveKillerId(pack, game.variant);
  const killerChar = pack.cast.find((c) => c.id === killerId);
  const finale = computeFinale(pack, game, killerId);
  return {
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
}

/**
 * Publish the reveal onto the game, once. A game that already carries one is
 * left exactly as it is, so a host who pressed the button is never overwritten
 * by autopilot arriving a moment later (or the other way round).
 * Mutates `game`; returns the solution, or null if there was nothing to build.
 */
function applyReveal(pack, game) {
  if (game.reveal) return game.reveal;
  const solution = buildReveal(pack, game);
  if (!solution) return null;
  const v = getVariant(pack, game.variant);
  // Only the ACTIVE variant's audio files are ever referenced.
  const audio = [audioName(AUDIO_KEYS.revealTitle(v.letter)), audioName(AUDIO_KEYS.revealMethod(v.letter))];
  game.reveal = { ...solution, audio, at: new Date().toISOString() };
  return solution;
}

const REVEAL_PHASE_N = REVEAL_PHASE;

module.exports = { computeFinale, buildReveal, applyReveal, award, REVEAL_PHASE: REVEAL_PHASE_N };
