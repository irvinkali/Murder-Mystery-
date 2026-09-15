'use strict';
/* GET /api/state?partyCode=..&personalCode=..
 * Public game state + (with a valid personalCode) that player's private view.
 * Never returns the sealed variant or other players' private content before the
 * Phase-6 reveal. All private content is framed as in-world notes. */

const { ok, bad, notFound, preflight } = require('../lib/api');
const { connect, getGame, updateGame } = require('../lib/store');
const {
  loadRuntimePack, phaseName, publicVictimBlurb, playerBrief, killerUnlock, idleNudge, PHASE_MINUTES, castingList,
  worldCopy,
} = require('../lib/runtime');
const { visibleDrops } = require('../lib/branching');
const { lobbyBrief, lobbyRoom, lobbyCopy, beatsSoFar, nextBeatAt, loadLobbyFile, lobbyQuestions } = require('../lib/lobby');
const { displayNames } = require('../lib/names');
const { shouldAside, maybeAside, attentionLine } = require('../lib/narrator');
const { audioName } = require('../lib/runtime');
const { autoAdvanceDue, maybeAutoAdvance, phaseAllottedMs } = require('../lib/phases');
const { blackoutDue, maybeBlackout, blackoutActive } = require('../lib/blackout');
const { awardsPublic, ownAwardVotes, ceremonyDue, advanceCeremony } = require('../lib/awards');

exports.handler = async (event) => {
  connect(event);
  if (event.httpMethod === 'OPTIONS') return preflight();
  const q = event.queryStringParameters || {};
  if (!q.partyCode) return bad('partyCode required');

  let game = await getGame(q.partyCode.toUpperCase());
  if (!game) return notFound('no such party');

  const pack = loadRuntimePack();

  // ---------------------------------------------------------------------
  // LOBBY. Before the host opens the doors the evening does not exist yet:
  // no clock, no narrator, no blackout, no evidence. A guest gets the public
  // half of their character and the beats that have already landed. This
  // returns early on purpose, so none of the game-state code below can run
  // and there is no path from here to a secret.
  // ---------------------------------------------------------------------
  if (game.lobby) {
    const file = loadLobbyFile();
    const now = new Date();
    // The weekly question is aggregate plus the asker's own mark. A seat code
    // that is not actually a seat here gets the counts and no mark.
    const seat = (q.personalCode && game.players[q.personalCode]) ? q.personalCode : null;
    const state = {
      partyCode: game.partyCode,
      lobby: true,
      phase: 0,
      phaseName: 'Before the night',
      playerCount: Object.keys(game.players || {}).length,
      world: { title: worldCopy(pack).title || null, venue: worldCopy(pack).venue || null },
      copy: lobbyCopy(file),
      beats: beatsSoFar(now, pack, file),
      nextBeatAt: nextBeatAt(now, file),
      questions: lobbyQuestions(game, now, seat, file),
      room: lobbyRoom(pack, game),
      casting: castingList(pack, game),
    };
    let me = null;
    if (q.personalCode && game.players[q.personalCode]) {
      const p = game.players[q.personalCode];
      me = { name: displayNames(game)[q.personalCode] || p.name, character: lobbyBrief(pack, p.characterId, file) };
    }
    return ok({ state, you: me });
  }

  // The phase clock ticks lazily on every poll: fire the two-minute warning or
  // the automatic phase change when due. (Pure pre-check, then a re-checked
  // mutation, so concurrent pollers don't double-fire.)
  if (autoAdvanceDue(game)) {
    game = (await updateGame(game.partyCode, (g) => { maybeAutoAdvance(pack, g); return g; })) || game;
  }

  // The awards ceremony walks itself: each award gets its title beat, its
  // winner and its hold, then the next one comes up on the next poll.
  if (ceremonyDue(game)) {
    game = (await updateGame(game.partyCode, (g) => { advanceCeremony(g); return g; })) || game;
  }

  // The blackout set-piece starts/ends on its own clock.
  if (blackoutDue(game)) {
    game = (await updateGame(game.partyCode, (g) => { maybeBlackout(pack, g); return g; })) || game;
  }

  // If the room has gone quiet mid-game, the narrator drops an aside.
  if (shouldAside(game)) {
    game = (await updateGame(game.partyCode, (g) => { maybeAside(g, undefined, pack); return g; })) || game;
  }
  const charName = (id) => {
    const c = [...pack.cast, ...(pack.flex || [])].find((x) => x.id === id);
    return c ? c.name : id;
  };

  // Room list: who's actually in, real name + character name (public). The
  // real name is a first name unless two guests here share one.
  const shown = displayNames(game);
  const roster = Object.entries(game.players).map(([code, p]) => ({
    characterId: p.characterId,
    characterName: charName(p.characterId),
    firstName: shown[code] || p.name,
  }));

  // Gallery narrator cards (most recent first): find-hints, medical, etc.
  const screenCards = (game.screenCards || []).slice(-6).reverse().map((c) => ({ kind: c.kind, text: c.text, audio: c.audio || null }));

  // Aggregate-only results for closed anonymous polls (for the gallery).
  const pollResults = Object.entries(game.pollResults || {}).map(([id, r]) => ({ id, question: r.question, counts: r.counts }));

  const publicState = {
    partyCode: game.partyCode,
    phase: game.phase,
    phaseName: phaseName(game.phase, pack),
    playerCount: roster.length,
    victim: publicVictimBlurb(pack),
    // Pack identity + the words the front-end needs (title, item noun, the
    // public alibi question, the victim's pronouns). No plot content.
    world: {
      title: worldCopy(pack).title || null,
      venue: worldCopy(pack).venue || null,
      itemNoun: worldCopy(pack).itemNoun || null,
      itemNounPlural: worldCopy(pack).itemNounPlural || null,
      alibiQuestion: worldCopy(pack).alibiQuestion || null,
      victimPronouns: worldCopy(pack).victimPronouns || null,
    },
    roster,
    // Unclaimed characters with their game-public personas (for casting at join).
    casting: castingList(pack, game),
    narration: game.narration ? game.narration.text : null,
    narrationAudio: game.narration ? game.narration.audio : null,
    // The spoken call-to-attention played before major announcements.
    attention: { text: attentionLine(pack), audio: audioName('attention') },
    // Live narrator interjections (found exhibits, vote reactions, asides).
    narratorFeed: (game.narratorFeed || []).slice(-8).map((n) => ({ id: n.id, text: n.text, audio: n.audio, major: !!n.major })),
    screenCards,
    pollResults,
    reveal: game.reveal || null, // set only after the Phase-6 reveal
    // The superlatives: null until the host opens them, and counts-only after.
    awards: awardsPublic(pack, game),
    // Live polls players can act on (guidance shown to players).
    polls: Object.entries(game.polls || {}).map(([id, p]) => ({
      id, question: p.question, options: p.options, closed: p.closed,
      kind: p.kind || 'anonymous', mandatory: !!p.mandatory, guidance: p.guidance || '',
      total: Object.keys(p.votes).length,
    })),
    discoveredCount: Object.keys(game.discovered || {}).length,
    // The room goes dark on every screen while this is true.
    blackout: blackoutActive(game),
    // Phase clock — auto-advance changes phases when time runs out.
    timing: {
      phaseStartedAt: game.phaseStartedAt || game.createdAt,
      paused: !!game.paused,
      pausedAt: game.pausedAt || null,
      pauseAccumMs: game.pauseAccumMs || 0,
      suggestedMinutes: PHASE_MINUTES[game.phase] || null,
      allottedMinutes: phaseAllottedMs(game) ? Math.round(phaseAllottedMs(game) / 60000) : null,
      autoAdvance: game.autoAdvance !== false,
    },
  };

  let you = null;
  if (q.personalCode && game.players[q.personalCode]) {
    const me = game.players[q.personalCode];
    const idleMs = Date.now() - new Date(me.lastActive || me.joinedAt).getTime();
    const unlock = killerUnlock(pack, game.variant, me.characterId, game.phase);
    const drops = visibleDrops(game, q.personalCode, game.phase);
    const hasHint = drops.some((d) => d.kind === 'hint');
    you = {
      name: shown[q.personalCode] || me.name,
      character: playerBrief(pack, me.characterId),
      // The current phase's private script line ("Your lines" card). Never future.
      lines: pack.scriptLines ? (pack.scriptLines[me.characterId] || {})[game.phase] || null : null,
      killer: unlock,
      // Idle nudge — suppressed if a find-hint already gave them something to do.
      nudge: hasHint ? null : idleNudge(me.characterId, game.phase, idleMs, undefined, pack),
      drops,
      alibiSubmitted: !!(game.alibi && game.alibi[q.personalCode]),
      // This guest's own superlative choices, so their phone can mark them.
      awardVotes: ownAwardVotes(game, q.personalCode),
    };
    if (unlock && !me.killerSeenAt) {
      await updateGame(game.partyCode, (g) => {
        if (g.players[q.personalCode] && !g.players[q.personalCode].killerSeenAt) {
          g.players[q.personalCode].killerSeenAt = new Date().toISOString();
        }
        return g;
      });
    }
  }

  return ok({ state: publicState, you });
};
