'use strict';
/* Small helpers shared by the Netlify Functions (classic handler style). */

const crypto = require('crypto');

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
const ok = (b) => json(200, b);
const bad = (msg) => json(400, { error: msg });
const forbidden = (msg) => json(403, { error: msg || 'forbidden' });
const notFound = (msg) => json(404, { error: msg || 'not found' });
const preflight = () => ({ statusCode: 204, headers: JSON_HEADERS, body: '' });

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch (_) { return {}; }
}

// Unambiguous alphabet (no O/0/I/1).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return s;
}
const partyCode = () => code(4);
const personalCode = () => code(5);
const token = () => crypto.randomBytes(16).toString('hex');

module.exports = { json, ok, bad, forbidden, notFound, preflight, parseBody, partyCode, personalCode, token };
