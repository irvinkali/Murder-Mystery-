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

// ---------------------------------------------------------------------------
// The loaded pack's presentation kit: branding, the public item map, the invite
// copy and the printable inserts. Served by /api/kit with no party code. No
// plot content — it is the same material the host already has on paper.
// ---------------------------------------------------------------------------
let _kit = null;
async function kit() {
  if (_kit) return _kit;
  try { _kit = await api('kit'); }
  catch (_) { _kit = { brand: {}, world: {}, items: [], printables: [], invite: {} }; }
  return _kit;
}
/** Escape, then honour a **bold** span — the only markup pack copy may use. */
function escBold(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }
function titleCase(s) { return s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : ''; }
/** The pack's word for a findable thing, singular and plural. */
function itemWord(k, plural) {
  const w = (k && k.world) || {};
  return (plural ? w.itemNounPlural : w.itemNoun) || (plural ? 'items' : 'item');
}
/** Replace every [data-brand] element with the pack's wording, and set the tab title. */
async function applyBrand() {
  const k = await kit();
  const b = (k && k.brand) || {};
  const page = document.body.dataset.pageTitle || '';
  if (b.siteTitle) document.title = page ? page + ' \u2014 ' + b.siteTitle : b.siteTitle;
  document.querySelectorAll('[data-brand]').forEach((n) => {
    const v = b[n.dataset.brand];
    if (v) n.textContent = v;
  });
  return k;
}

