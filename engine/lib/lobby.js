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
  return Object.values(game.players || {}).map((p) => ({
    characterName: name(p.characterId),
    firstName: p.name,
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
};
