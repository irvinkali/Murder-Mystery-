'use strict';
/*
 * Shared game-state store. Primary backend is Netlify Blobs; falls back to an
 * in-memory map when running outside Netlify (local dev / unit tests).
 *
 * State shape (per party): {
 *   partyCode, hostToken, createdAt, phase,
 *   variant,            // SEALED — never serialized to a client before reveal
 *   players: { [personalCode]: { name, characterId, joinedAt } },
 *   assignments: { [characterId]: personalCode },
 *   discovered: { [propId]: { count, firstAt } },
 *   polls: { [pollId]: { question, options, votes:{code:choice}, closed } },
 *   log: [ { at, kind, ... } ],
 * }
 */

let _blobs = null;
try {
  _blobs = require('@netlify/blobs');
} catch (_) {
  _blobs = null;
}

const _mem = new Map();

function backend() {
  if (_blobs && process.env.NETLIFY) {
    try {
      return { kind: 'blobs', store: _blobs.getStore({ name: 'mystery-games', consistency: 'strong' }) };
    } catch (_) {
      /* fall through to memory */
    }
  }
  return { kind: 'memory' };
}

async function getGame(partyCode) {
  const b = backend();
  if (b.kind === 'blobs') {
    const v = await b.store.get(partyCode, { type: 'json' });
    return v || null;
  }
  return _mem.get(partyCode) || null;
}

async function putGame(partyCode, game) {
  const b = backend();
  if (b.kind === 'blobs') {
    await b.store.setJSON(partyCode, game);
  } else {
    _mem.set(partyCode, game);
  }
  return game;
}

/** Optimistic update helper: read → mutate → write. */
async function updateGame(partyCode, mutate) {
  const game = await getGame(partyCode);
  if (!game) return null;
  const next = (await mutate(game)) || game;
  await putGame(partyCode, next);
  return next;
}

module.exports = { getGame, putGame, updateGame, _mem };
