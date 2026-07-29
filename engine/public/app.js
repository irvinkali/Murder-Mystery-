// Shared client helpers for the Mystery Engine front-end.
// No plot content lives here; everything comes from the API at runtime.

const API = '/api';

async function api(path, body, method) {
  const opts = { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}/${path}`, opts);
  let data = {};
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Player identity persisted on the device (never any plot).
const Store = {
  get party() { return localStorage.getItem('me.party') || ''; },
  set party(v) { localStorage.setItem('me.party', v); },
  get code() { return localStorage.getItem('me.code') || ''; },
  set code(v) { localStorage.setItem('me.code', v); },
  get host() { return localStorage.getItem('me.host') || ''; },
  set host(v) { localStorage.setItem('me.host', v); },
  clear() { ['me.party', 'me.code', 'me.host'].forEach((k) => localStorage.removeItem(k)); },
};

function el(sel) { return document.querySelector(sel); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function qs(name) { return new URLSearchParams(location.search).get(name); }
