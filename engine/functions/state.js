'use strict';
/* GET /api/state?partyCode=..&personalCode=..
 * Public game state + (with a valid personalCode) that player's private view.
 * Never returns the sealed variant or other players' private content before the
 * Phase-6 reveal. All private content is framed as in-world notes. */

const { ok, bad, notFound, preflight } = require('../lib/api');
const { getGame, updateGame } = require('../lib/store');
const {
  loadRuntimePack, phaseInfo, publicVictimBlurb, playerBrief, killerUnlock, idleNudge, PHASE_MINUTES,
} = require('../lib/runtime');
const { visibleDrops } = require('../lib/branching');
const { shouldAside, maybeAside, ATTENTION } = require('../lib/narrator');
const { audioName } = require('../lib/runtime');
const { autoAdvanceDue, maybeAutoAdvance, phaseAllottedMs } = require('../lib/phases');
const { blackoutDue, maybeBlackout, blackoutActive } = require('../lib/blackout');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const q = event.queryStringParameters || {};
  if (!q.partyCode) return bad('partyCode required');

  let game = await getGame(q.partyCode.toUpperCase());
  if (!game) return notFound('no such party');

  const pack = loadRuntimePack();

  // The phase clock ticks lazily on every poll: fire the two-minute warning or
  // the automatic phase change when due. (Pure pre-check, then a re-checked
  // mutation, so concurrent pollers don't double-fire.)
  if (autoAdvanceDue(game)) {
    game = (await updateGame(game.partyCode, (g) => { maybeAutoAdvance(pack, g); return g; })) || game;
  }

  // The blackout set-piece starts/ends on its own clock.
  if (blackoutDue(game)) {
    game = (await updateGame(game.partyCode, (g) => { maybeBlackout(pack, g); return g; })) || game;
  }

  // If the room has gone quiet mid-game, the narrator drops an aside.
  if (shouldAside(game)) {
    game = (await updateGame(game.partyCode, (g) => { maybeAside(g); return g; })) || game;
  }
  const charName = (id) => {
    const c = [...pack.cast, ...(pack.flex || [])].find((x) => x.id === id);
    return c ? c.name : id;
  };

  // Room list: who's actually in, real first name + character name (public).
  const roster = Object.entries(game.players).map(([code, p]) => ({
    characterId: p.characterId,
    characterName: charName(p.characterId),
    firstName: p.name,
  }));

  // Gallery narrator cards (most recent first): find-hints, medical, etc.
  const screenCards = (game.screenCards || []).slice(-6).reverse().map((c) => ({ kind: c.kind, text: c.text, audio: c.audio || null }));

  // Aggregate-only results for closed anonymous polls (for the gallery).
  const pollResults = Object.entries(game.pollResults || {}).map(([id, r]) => ({ id, question: r.question, counts: r.counts }));

  const publicState = {
    partyCode: game.partyCode,
    phase: game.phase,
    phaseName: phaseInfo(game.phase).name,
    playerCount: roster.length,
    victim: publicVictimBlurb(pack),
    roster,
    narration: game.narration ? game.narration.text : null,
    narrationAudio: game.narration ? game.narration.audio : null,
    // The spoken call-to-attention played before major announcements.
    attention: { text: ATTENTION, audio: audioName('attention') },
    // Live narrator interjections (found exhibits, vote reactions, asides).
    narratorFeed: (game.narratorFeed || []).slice(-8).map((n) => ({ id: n.id, text: n.text, audio: n.audio, major: !!n.major })),
    screenCards,
    pollResults,
    reveal: game.reveal || null, // set only after the Phase-6 reveal
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
      name: me.name,
      character: playerBrief(pack, me.characterId),
      // The current phase's private script line ("Your lines" card). Never future.
      lines: pack.scriptLines ? (pack.scriptLines[me.characterId] || {})[game.phase] || null : null,
      killer: unlock,
      // Idle nudge — suppressed if a find-hint already gave them something to do.
      nudge: hasHint ? null : idleNudge(me.characterId, game.phase, idleMs),
      drops,
      alibiSubmitted: !!(game.alibi && game.alibi[q.personalCode]),
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
