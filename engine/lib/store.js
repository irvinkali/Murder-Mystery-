'use strict';
/*
 * Shared game-state store. Primary backend is Netlify Blobs; falls back to an
 * in-memory map when running outside Netlify (local dev / unit tests).
 *
 * CONCURRENCY: with 10–20 phones polling and voting at once, naive
 * read-modify-write can lose updates (e.g. two votes landing together).
 * updateGame therefore uses optimistic concurrency: read with a version tag,
 * mutate a fresh copy, write conditionally, and retry on conflict. The
 * in-memory backend simulates the same versioning so tests exercise the
 * retry path. If the deployed Blobs version doesn't support conditional
 * writes, we degrade to a plain write rather than failing.
 */

let _blobs = null;
try {
  _blobs = require('@netlify/blobs');
} catch (_) {
  _blobs = null;
}

const _mem = new Map();   // partyCode -> serialized game JSON
const _ver = new Map();   // partyCode -> version counter (memory CAS)

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

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
  const raw = _mem.get(partyCode);
  return raw ? JSON.parse(raw) : null;
}

/** Read with a version tag for conditional writes. */
async function getGameWithMeta(partyCode) {
  const b = backend();
  if (b.kind === 'blobs') {
    try {
      const r = await b.store.getWithMetadata(partyCode, { type: 'json' });
      if (!r || r.data == null) return { game: null, etag: null };
      return { game: r.data, etag: r.etag || null };
    } catch (_) {
      return { game: await getGame(partyCode), etag: null };
    }
  }
  const raw = _mem.get(partyCode);
  return { game: raw ? JSON.parse(raw) : null, etag: _ver.get(partyCode) || 0 };
}

/** Unconditional write (creation / last-resort). */
async function putGame(partyCode, game) {
  const b = backend();
  if (b.kind === 'blobs') {
    await b.store.setJSON(partyCode, game);
  } else {
    _mem.set(partyCode, JSON.stringify(game));
    _ver.set(partyCode, (_ver.get(partyCode) || 0) + 1);
  }
  return game;
}

/** Conditional write; returns false on a version conflict. */
async function putGameIf(partyCode, game, etag) {
  const b = backend();
  if (b.kind === 'blobs') {
    if (etag == null) { await b.store.setJSON(partyCode, game); return true; }
    try {
      const res = await b.store.setJSON(partyCode, game, { onlyIfMatch: etag });
      if (res && res.modified === false) return false;
      return true;
    } catch (e) {
      // Older Blobs runtime without conditional writes → degrade gracefully.
      await b.store.setJSON(partyCode, game);
      return true;
    }
  }
  if ((_ver.get(partyCode) || 0) !== etag) return false;
  _mem.set(partyCode, JSON.stringify(game));
  _ver.set(partyCode, etag + 1);
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Optimistic update: read fresh state, mutate, write conditionally; retry on
 * conflict so concurrent updates interleave instead of overwriting each other.
 */
async function updateGame(partyCode, mutate) {
  const ATTEMPTS = 6;
  for (let i = 0; i < ATTEMPTS; i++) {
    const { game, etag } = await getGameWithMeta(partyCode);
    if (!game) return null;
    const next = (await mutate(game)) || game;
    if (await putGameIf(partyCode, next, etag)) return next;
    await sleep(15 + Math.floor(Math.random() * 40) * (i + 1)); // jittered backoff
  }
  // Last resort: apply on the freshest read without the guard (never lose the
  // caller's own mutation entirely).
  const { game } = await getGameWithMeta(partyCode);
  if (!game) return null;
  const next = (await mutate(game)) || game;
  await putGame(partyCode, next);
  return next;
}

module.exports = { getGame, getGameWithMeta, putGame, updateGame, _mem };
