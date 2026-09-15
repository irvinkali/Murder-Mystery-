'use strict';
/*
 * Guest names (the real people, not the characters).
 *
 * The join page asks for a first and last name, but the room only ever sees a
 * first name. The last name is held back unless two guests at the same party
 * share a first name, and then only enough of it is added to tell them apart.
 *
 * Nothing here is plot content.
 */

const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase();

/** "Marlow Ashgrove" -> { first: 'Marlow', last: 'Ashgrove' }. One word is all first. */
function splitName(full) {
  const parts = norm(full).split(' ').filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

/** First and last back into the single string stored on the seat. */
function fullName(first, last) {
  return [norm(first), norm(last)].filter(Boolean).join(' ');
}

/**
 * What each seat is called on screen, keyed by personal code.
 *
 * First name alone wherever it is the only one of its kind in this party.
 * Where it is not: first name plus last initial, and the whole last name if
 * the initials collide too. A guest who gave no last name keeps their first
 * name either way, because there is nothing to add.
 */
function displayNames(game) {
  const players = (game && game.players) || {};
  const groups = new Map();
  for (const [code, p] of Object.entries(players)) {
    const { first, last } = splitName(p && p.name);
    const k = key(first);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ code, first, last });
  }

  const out = {};
  for (const seats of groups.values()) {
    if (seats.length === 1) {
      out[seats[0].code] = seats[0].first || 'Guest';
      continue;
    }
    // Shared first name. Initials are enough unless two of them are the same.
    const initials = seats.map((s) => key(s.last).slice(0, 1)).filter(Boolean);
    const initialsAreEnough = new Set(initials).size === initials.length;
    for (const s of seats) {
      const base = s.first || 'Guest';
      if (!s.last) { out[s.code] = base; continue; }
      out[s.code] = initialsAreEnough
        ? `${base} ${s.last.slice(0, 1).toUpperCase()}.`
        : `${base} ${s.last}`;
    }
  }
  return out;
}

/**
 * Which of `entries` a typed name refers to. Entries are { key, name }.
 *
 * An exact full-name match wins. Failing that, a one-word name matches on the
 * first name alone, so a reservation the host wrote as "Taylor" still catches
 * a guest who types "Taylor Pellit", and a guest who claimed a character with
 * one name in the lobby gets that same seat back when they type both on the
 * night. Two full names that differ never match each other, and ambiguity is
 * never resolved by guessing: two Taylors return two hits and the caller falls
 * through to its normal path.
 */
function matchNames(typed, entries) {
  const want = norm(typed);
  if (!want) return [];
  const list = (entries || []).filter((e) => e && norm(e.name));
  const exact = list.filter((e) => key(e.name) === key(want));
  if (exact.length) return exact.map((e) => e.key);
  const wantParts = want.split(' ');
  return list
    .filter((e) => {
      const hasParts = norm(e.name).split(' ');
      if (wantParts.length > 1 && hasParts.length > 1) return false; // two full names, already compared
      return key(wantParts[0]) === key(hasParts[0]);
    })
    .map((e) => e.key);
}

module.exports = { splitName, fullName, displayNames, matchNames };
