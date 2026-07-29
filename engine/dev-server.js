#!/usr/bin/env node
'use strict';
/*
 * Local dev server — run the whole app without deploying to Netlify.
 *
 *   node engine/dev-server.js            # then open http://localhost:8888
 *
 * Serves the static front-end from engine/public and routes /api/<fn> to the
 * matching Netlify function handler, mirroring the redirects in netlify.toml.
 * State uses the in-memory store (not shared across restarts). No plot content
 * lives here. Zero external dependencies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// SPOILER SAFETY: local rehearsal defaults to the DUMMY test pack so the owner
// can play without seeing the real solution. Opt into the real pack explicitly
// with USE_REAL_PACK=1 (or by setting MYSTERY_PACK_FILE yourself).
const TEST_PACK = path.join(__dirname, '..', 'packs', 'test', 'pack.json');
if (!process.env.MYSTERY_PACK_FILE && !process.env.USE_REAL_PACK) {
  process.env.MYSTERY_PACK_FILE = TEST_PACK;
}

const PUBLIC = path.join(__dirname, 'public');
const FUNCTIONS = path.join(__dirname, 'functions');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Pretty routes from netlify.toml.
function staticFileFor(pathname) {
  if (pathname === '/' || pathname === '') return 'index.html';
  if (pathname === '/gallery') return 'gallery.html';
  if (pathname === '/host') return 'host.html';
  if (pathname.startsWith('/prop/')) return 'prop.html'; // NFC deep link
  return pathname.replace(/^\/+/, '');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

async function callFunction(name, req, res, url) {
  const file = path.join(FUNCTIONS, name + '.js');
  if (!fs.existsSync(file)) { res.writeHead(404).end('no such function'); return; }
  let handler;
  try { handler = require(file).handler; } catch (e) { res.writeHead(500).end(e.message); return; }

  const body = await readBody(req);
  const qs = {};
  for (const [k, v] of url.searchParams.entries()) qs[k] = v;
  const event = {
    httpMethod: req.method,
    headers: req.headers,
    body: body || null,
    queryStringParameters: qs,
    path: url.pathname,
  };
  try {
    const r = await handler(event, {});
    res.writeHead(r.statusCode || 200, r.headers || { 'content-type': 'application/json' });
    res.end(r.body || '');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function serveStatic(pathname, res) {
  const rel = staticFileFor(pathname);
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'text/plain' });
    res.end(buf);
  });
}

const requestHandler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    return callFunction(url.pathname.slice(5), req, res, url);
  }
  return serveStatic(url.pathname, res);
};

function start(port) {
  const server = http.createServer(requestHandler);
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { requestHandler, start };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8888;
  const usingTest = process.env.MYSTERY_PACK_FILE === TEST_PACK;
  start(port).then(() => {
    if (usingTest) {
      console.log('\x1b[42m\x1b[30m  REHEARSAL MODE — DUMMY TEST PACK (spoiler-safe, fake content)  \x1b[0m');
      console.log('  Safe to play as a guest: no real characters, clues, or solution are loaded.');
    } else {
      console.log('\x1b[41m\x1b[37m  ⚠ REAL PACK LOADED — this WILL reveal the real solution. Not for players.  \x1b[0m');
    }
    console.log(`\nMystery Engine dev server → http://localhost:${port}`);
    console.log('  player join : /            host : /host            gallery : /gallery?party=CODE');
    console.log('  (in-memory state — restarting the server clears all games)');
  });
}
