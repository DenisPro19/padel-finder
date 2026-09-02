'use strict';
/**
 * Padel court finder - local server.
 * Usage: node server.js [--port 8123] [--no-open]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const pt = require('./lib/playtomic');
const store = require('./lib/store');
const auth = require('./lib/auth');
const travel = require('./lib/travel');

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argVal('--port', process.env.PORT || 8123));
// Listen publicly only when a passphrase is set, so an unprotected instance can never
// be reachable from outside the machine by accident.
const HOST = argVal('--host', process.env.HOST || (auth.enabled ? '0.0.0.0' : '127.0.0.1'));
const OPEN = !args.includes('--no-open') && HOST === '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const SPORT = 'PADEL';

// Playtomic's WAF budgets requests per IP over a rolling window. These values keep a
// normal search under it; the client backs off automatically when it does trip.
let cooldownNotice = 0;
pt.configure({
  maxConcurrent: 3,
  minGapMs: 200,
  onCooldown: (ms) => { cooldownNotice = Date.now() + ms; },
});

/* ---------- availability cache ----------
 * Keyed by tenant+date. Playtomic's own page re-reads this constantly, but there is
 * no reason for us to refetch while the user is only tightening a time filter.     */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

async function availability(club, date, force = false) {
  const key = `${club.tenantId}|${date}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.slots;
  const raw = await pt.fetchAvailability(club.tenantId, date, SPORT);
  const slots = pt.expandSlots(raw, club);
  cache.set(key, { at: Date.now(), slots });
  return slots;
}

/* ---------- date helpers (in the club's own timezone) ---------- */

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (isoDate) => new Date(`${isoDate}T12:00:00Z`).getUTCDay(); // 0=Sun

/* ---------- catalog build ---------- */

async function buildCity(query, onProgress) {
  const slugs = await pt.searchClubSlugs(query);
  onProgress?.({ phase: 'found', total: slugs.length });

  let done = 0;
  const clubs = await pt.mapLimit(slugs, 5, async (slug) => {
    let club = null;
    try {
      club = await pt.fetchClub(slug);
    } catch { /* club page gone or malformed - skip it */ }
    done++;
    onProgress?.({ phase: 'club', done, total: slugs.length, name: club?.name || slug });
    if (!club) return null;
    // Keep padel venues only, and drop non-padel courts from the ones we keep.
    const courts = club.courts.filter((c) => c.sport === SPORT);
    if (!courts.length) return null;
    return { ...club, courts };
  });

  const kept = clubs.filter(Boolean);
  const catalog = store.loadCatalog();
  const key = store.upsertCity(catalog, query, kept);
  store.saveCatalog(catalog);
  return { key, clubs: kept, scanned: slugs.length };
}

/* ---------- search ---------- */

function parseList(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function runSearch(params, onProgress, onPartial, ctl) {
  const catalog = store.loadCatalog();
  const cityKey = (params.city || '').trim().toLowerCase();
  const known = store.cityClubs(catalog, cityKey);
  if (!known) throw Object.assign(new Error(`No club list for "${params.city}". Refresh it first.`), { status: 404 });

  const wanted = parseList(params.clubs);
  const clubs = wanted.length ? known.filter((c) => wanted.includes(c.tenantId)) : known;
  if (!clubs.length) throw Object.assign(new Error('No clubs selected.'), { status: 400 });

  const days = Math.max(1, Math.min(30, Number(params.days) || 7));
  const weekdays = parseList(params.weekdays).map(Number);
  const durations = parseList(params.durations).map(Number);
  const startMin = pt.minutesOf(params.start || '00:00');
  const endMin = pt.minutesOf(params.end || '23:59');
  const mustFit = params.fit !== '0';
  const maxPrice = params.maxPrice ? Number(params.maxPrice) : null;
  const indoor = params.indoor || 'any'; // any | indoor | outdoor

  // Day list is anchored to the first club's timezone; within one city they agree.
  const tz = clubs[0].timezone || 'UTC';
  const from = params.from || todayIn(tz);
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    if (!weekdays.length || weekdays.includes(weekdayOf(d))) dates.push(d);
  }

  const nowMs = Date.now();
  const force = params.force === '1';
  const total = clubs.length * dates.length;
  const failures = [];
  const all = [];
  let done = 0;

  const keep = (club, date) => (s) => {
    if (s.date !== date) return false;                    // spillover into the next local day
    if (s.epoch < nowMs) return false;                    // already started
    if (durations.length && !durations.includes(s.duration)) return false;
    if (maxPrice != null && s.price != null && s.price > maxPrice) return false;
    if (indoor === 'indoor' && !s.indoor) return false;
    if (indoor === 'outdoor' && s.indoor) return false;
    if (mustFit) return s.startMin >= startMin && s.endMin <= endMin;
    return s.startMin >= startMin && s.startMin <= endMin;
  };

  const decorate = (club) => (s) => ({
    ...s,
    clubName: club.name,
    clubSlug: club.slug,
    clubCity: club.city,
    bookUrl: `${pt.BASE}/clubs/${club.slug}?date=${s.date}`,
    // app.playtomic.com serves the AASA that playtomic.com only redirects to, and
    // /tenant/* is in it - so this opens the native app, while playtomic.com never can.
    appUrl: `https://app.playtomic.com/tenant/${club.tenantId}`,
  });

  // One day at a time, nearest first: Playtomic's rate limiter means a full scan
  // takes minutes, so the soonest (and most useful) days must land first.
  for (const date of dates) {
    if (ctl?.aborted) break;

    const perClub = await pt.mapLimit(clubs, 3, async (club) => {
      if (ctl?.aborted) return [];
      let slots = [];
      try {
        slots = await availability(club, date, force);
      } catch (err) {
        failures.push({ club: club.name, date, message: err.message });
      }
      done++;
      onProgress?.({ phase: 'scan', done, total, club: club.name, date });
      return slots.filter(keep(club, date)).map(decorate(club));
    });

    const dayResults = perClub.flat().sort(
      (a, b) => a.epoch - b.epoch || (a.price ?? 1e9) - (b.price ?? 1e9) || a.clubName.localeCompare(b.clubName)
    );
    all.push(...dayResults);
    onPartial?.({ date, results: dayResults, done, total, failures: failures.length });
  }

  return {
    results: all,
    meta: {
      clubsScanned: clubs.length,
      daysScanned: dates.length,
      requests: total,
      checked: total - failures.length,
      dates,
      aborted: !!ctl?.aborted,
      failedCount: failures.length,
      failedSample: failures.slice(0, 5).map((f) => `${f.club} ${f.date}: ${f.message}`),
      failedClubDays: failures.map((f) => ({ club: f.club, date: f.date })),
      generatedAt: new Date().toISOString(),
      timezone: tz,
    },
  };
}

/* ---------- HTTP plumbing ---------- */

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const LOGIN_PAGE = (msg = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Padel court finder</title><link rel="stylesheet" href="/style.css">
<style>
  body{display:grid;place-items:center;min-height:100vh}
  form{background:var(--panel);border:1px solid var(--line);border-radius:12px;
       padding:28px;width:min(340px,90vw);display:flex;flex-direction:column;gap:14px}
  h1{font-size:16px;display:flex;align-items:center;gap:9px}
  input{background:var(--panel-2);border:1px solid var(--line);color:var(--ink);
        border-radius:8px;padding:10px 12px;font-size:15px}
  .msg{color:var(--bad);font-size:12.5px}
</style></head><body>
<form method="POST" action="/login">
  <h1><span class="ball"></span>Padel court finder</h1>
  <input type="password" name="passphrase" placeholder="Passphrase" autofocus
         autocomplete="current-password" required>
  <button class="primary" type="submit">Enter</button>
  ${msg ? `<div class="msg">${msg}</div>` : ''}
</form></body></html>`;

function sendHtml(res, code, html, headers = {}) {
  const buf = Buffer.from(html);
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = Object.fromEntries(url.searchParams);

  try {
    /* ---- passphrase gate (no-op when PADEL_PASSPHRASE is unset) ---- */
    if (auth.enabled) {
      if (url.pathname === '/login' && req.method === 'POST') {
        const wait = auth.lockoutMs(req);
        if (wait > 0) {
          return sendHtml(res, 429, LOGIN_PAGE(`Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`));
        }
        const body = new URLSearchParams(await readBody(req));
        if (auth.checkPassphrase(body.get('passphrase') || '')) {
          auth.noteSuccess(req);
          return sendHtml(res, 302, '', {
            Location: '/', 'Set-Cookie': auth.cookieHeader(auth.issue(), req),
          });
        }
        auth.noteFailure(req);
        return sendHtml(res, 401, LOGIN_PAGE('Wrong passphrase.'));
      }

      if (url.pathname === '/logout') {
        return sendHtml(res, 302, '', { Location: '/login', 'Set-Cookie': auth.clearCookie() });
      }

      if (!auth.authorized(req)) {
        // The stylesheet is needed by the login page itself; everything else waits.
        if (url.pathname === '/style.css') return serveStatic(res, url.pathname);
        if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'not signed in' });
        return sendHtml(res, url.pathname === '/login' ? 200 : 401, LOGIN_PAGE());
      }

      if (url.pathname === '/login') return sendHtml(res, 302, '', { Location: '/' });
    }

    /* catalog: what we already know */
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      const catalog = store.loadCatalog();
      const cities = Object.entries(catalog.cities).map(([key, v]) => ({
        key, query: v.query, builtAt: v.builtAt, count: v.clubIds.length,
      }));
      const clubs = q.city ? (store.cityClubs(catalog, q.city) || []) : [];
      return sendJson(res, 200, {
        authEnabled: auth.enabled,
        cities,
        clubs: clubs.map((c) => ({
          tenantId: c.tenantId, name: c.name, slug: c.slug, city: c.city,
          courts: c.courts.length,
          indoor: c.courts.filter((x) => x.features.includes('indoor')).length,
          timezone: c.timezone, url: c.url, lat: c.lat, lon: c.lon,
        })),
      });
    }

    /* catalog: rebuild one city (streamed) */
    if (url.pathname === '/api/catalog/refresh') {
      const city = (q.city || '').trim();
      if (!city) return sendJson(res, 400, { error: 'city is required' });
      const send = sseOpen(res);
      try {
        const out = await buildCity(city, (p) => send('progress', p));
        send('done', { city: out.key, clubs: out.clubs.length, scanned: out.scanned });
      } catch (err) {
        send('error', { message: err.message });
      }
      return res.end();
    }

    /* search (streamed) */
    if (url.pathname === '/api/search') {
      const send = sseOpen(res);
      const ctl = { aborted: false };
      req.on('close', () => { ctl.aborted = true; });
      try {
        const out = await runSearch(
          q,
          (p) => send('progress', p),
          (p) => send('partial', p),
          ctl
        );
        if (!ctl.aborted) send('done', out);
      } catch (err) {
        send('error', { message: err.message });
      }
      return res.end();
    }

    /* travel time from the player's location to each club in an area */
    if (url.pathname === '/api/travel' && req.method === 'GET') {
      const lat = Number(q.lat), lon = Number(q.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
          Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return sendJson(res, 400, { error: 'valid lat and lon are required' });
      }
      const clubs = store.cityClubs(store.loadCatalog(), q.city);
      if (!clubs) return sendJson(res, 404, { error: `No club list for "${q.city}".` });
      return sendJson(res, 200, await travel.travelTimes(lat, lon, clubs));
    }

    /* saved searches */
    if (url.pathname === '/api/presets' && req.method === 'GET') {
      return sendJson(res, 200, store.loadPresets());
    }
    if (url.pathname === '/api/presets' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req) || '[]');
      if (!Array.isArray(body)) return sendJson(res, 400, { error: 'expected an array' });
      store.savePresets(body);
      return sendJson(res, 200, body);
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });
    return serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Padel finder listening on ${HOST}:${PORT}`);
  console.log(auth.enabled
    ? 'Passphrase protection ON (PADEL_PASSPHRASE is set).'
    : 'Local only, no passphrase. Set PADEL_PASSPHRASE to expose it publicly.');
  if (OPEN) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
