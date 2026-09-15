'use strict';
/*
 * The lobby: the weeks between casting and the party.
 *
 * Guests join early, find out who they are, see what to wear and who else is
 * coming, and get a handful of in-world beats that arrive on dates the pack
 * sets. It exists because anticipation is most of the fun, and because a guest
 * who has already claimed their seat cannot be mis-seated at the door.
 *
 * SPOILER-SAFE BY CONSTRUCTION. Only two things are ever served from here:
 *  - the character's PUBLIC persona, which is the brief with everything from
 *    SECRET: onward cut off (the same text the host posts on the event wall),
 *  - the pack's plaintext lobby.json, which carries costume notes and beats.
 * Nothing in this module can reach a secret, a variant, an evidence chain or a
 * script line. A beat never names a character in the file: it writes {{C3}} and
 * the name is substituted here, so the plaintext stays clean for the scanner.
 */

const fs = require('fs');
const path = require('path');
const { loadRuntimePack, publicPersona } = require('./runtime');
const { displayNames } = require('./names');
const { packId } = require('./theme');

const PACKS = path.join(__dirname, '..', '..', 'packs');

function loadLobbyFile(id) {
  const dir = id || packId();
  if (!dir || !/^[a-z0-9._-]+$/i.test(dir)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(PACKS, dir, 'lobby.json'), 'utf8')); }
  catch (_) { return null; }
}

/** Every character in the pack, core first, as {id, name, brief}. */
function allCharacters(pack) {
  const p = pack || loadRuntimePack();
  return [...p.cast, ...(p.flex || [])];
}

/** Replace {{C3}} with that character's name. Unknown ids are dropped. */
function resolveNames(text, pack) {
  const chars = allCharacters(pack);
  return String(text == null ? '' : text).replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_, id) => {
    const c = chars.find((x) => x.id === id);
    return c ? c.name : '';
  });
}

/** What to wear, from the pack's lobby file. Absent is fine; it just omits. */
function attireFor(characterId, file) {
  const f = file || loadLobbyFile();
  const c = (f && f.characters && f.characters[characterId]) || null;
  return (c && c.attire) || null;
}

/**
 * The beats that have landed by `now`, oldest first. A beat with no date has
 * always landed. Anything dated in the future is not merely hidden in the UI:
 * it never leaves the server, so there is nothing to find early.
 */
function beatsSoFar(now, pack, file) {
  const f = file || loadLobbyFile();
  const list = (f && Array.isArray(f.beats)) ? f.beats : [];
  const t = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
  return list
    .filter((b) => b && typeof b.body === 'string')
    .map((b) => ({ ...b, _at: b.at ? new Date(b.at).getTime() : 0 }))
    .filter((b) => Number.isFinite(b._at) && b._at <= t)
    .sort((a, b) => a._at - b._at)
    .map((b) => ({
      id: String(b.id || b.at || b.title || ''),
      at: b.at || null,
      from: resolveNames(b.from || '', pack),
      title: resolveNames(b.title || '', pack),
      body: resolveNames(b.body, pack),
    }));
}

/*
 * The weekly question. Light, plot-free noise: a question the room answers in
 * the app while it waits, with the results visible to everybody.
 *
 * Two rules hold it apart from the game's own polls. The answers live under
 * their own key on the game object (LOBBY_ANSWER_KEY), so a lobby answer can
 * never be counted in a game poll or the other way round. And what leaves here
 * is aggregate: counts per option, plus a mark on the asking guest's own
 * choice. Which seat chose what stays on the game object and is served to
 * nobody, the host included.
 */
const LOBBY_ANSWER_KEY = 'lobbyAnswers';

/**
 * The questions that have opened by `now`, oldest first. Same rule as a beat:
 * one dated in the future is not hidden in the UI, it never leaves the server.
 */
function questionsSoFar(now, file) {
  const f = file || loadLobbyFile();
  const list = (f && Array.isArray(f.questions)) ? f.questions : [];
  const t = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
  return list
    .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length >= 2)
    .map((q) => ({ ...q, _at: q.at ? new Date(q.at).getTime() : 0 }))
    .filter((q) => Number.isFinite(q._at) && q._at <= t)
    .sort((a, b) => a._at - b._at)
    .map((q) => ({
      id: String(q.id || q.at || q.question || ''),
      at: q.at || null,
      question: String(q.question),
      options: q.options.map((o) => String(o)),
    }));
}

/** One question by id, but only if it has actually opened. */
function openQuestion(id, now, file) {
  return questionsSoFar(now, file).find((q) => q.id === id) || null;
}

/**
 * The open questions as one guest sees them: the question, the options, the
 * aggregate counts, and which option is theirs. The seat-to-choice map is read
 * here and never emitted, so no payload can say who voted for what.
 */
function lobbyQuestions(game, now, personalCode, file) {
  const answers = (game && game[LOBBY_ANSWER_KEY]) || {};
  return questionsSoFar(now, file).map((q) => {
    const cast = answers[q.id] || {};
    const counts = {};
    for (const o of q.options) counts[o] = 0;
    for (const choice of Object.values(cast)) {
      if (Object.prototype.hasOwnProperty.call(counts, choice)) counts[choice] += 1;
    }
    const mine = personalCode ? cast[personalCode] : undefined;
    return {
      id: q.id,
      question: q.question,
      options: q.options,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      yourChoice: (typeof mine === 'string' && q.options.includes(mine)) ? mine : null,
    };
  });
}

/** Record one seat's answer. One per seat per question, and changeable. */
function recordLobbyAnswer(game, questionId, personalCode, choice) {
  game[LOBBY_ANSWER_KEY] = game[LOBBY_ANSWER_KEY] || {};
  game[LOBBY_ANSWER_KEY][questionId] = game[LOBBY_ANSWER_KEY][questionId] || {};
  game[LOBBY_ANSWER_KEY][questionId][personalCode] = choice;
  return game;
}

/** The next beat's date, so the page can say when there is more to come. */
function nextBeatAt(now, file) {
  const f = file || loadLobbyFile();
  const list = (f && Array.isArray(f.beats)) ? f.beats : [];
  const t = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
  const future = list
    .map((b) => (b && b.at ? new Date(b.at).getTime() : NaN))
    .filter((x) => Number.isFinite(x) && x > t)
    .sort((a, b) => a - b);
  return future.length ? new Date(future[0]).toISOString() : null;
}

/**
 * One guest's lobby view. The public half and nothing else: no brief, no
 * script line, no seat in the evidence chain. `persona` is derived from the
 * pack at request time rather than stored, so it cannot drift out of step with
 * the dossier it is cut from.
 */
function lobbyBrief(pack, characterId, file) {
  const c = allCharacters(pack).find((x) => x.id === characterId);
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    persona: publicPersona(c),
    attire: attireFor(c.id, file),
  };
}

/** The party as the room will see it: who is coming as whom, claimed only. */
function lobbyRoom(pack, game) {
  const chars = allCharacters(pack);
  const name = (id) => { const c = chars.find((x) => x.id === id); return c ? c.name : id; };
  const shown = displayNames(game);
  return Object.entries(game.players || {}).map(([code, p]) => ({
    characterName: name(p.characterId),
    firstName: shown[code] || p.name,
  }));
}

/** The pack's own words for the waiting room. Neutral fallbacks if unauthored. */
function lobbyCopy(file) {
  const f = file || loadLobbyFile();
  const c = (f && f.copy) || {};
  return {
    title: c.title || 'Before the night',
    standfirst: c.standfirst || 'You have your character. The rest arrives on the night.',
    doorsNote: c.doorsNote || 'Everything private to you opens when the doors open.',
    eventAt: c.eventAt || null,
  };
}

module.exports = {
  loadLobbyFile, lobbyBrief, lobbyRoom, lobbyCopy,
  beatsSoFar, nextBeatAt, attireFor, resolveNames,
  LOBBY_ANSWER_KEY, questionsSoFar, openQuestion, lobbyQuestions, recordLobbyAnswer,
};
