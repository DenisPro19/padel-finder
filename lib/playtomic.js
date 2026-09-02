'use strict';
/**
 * Minimal Playtomic client.
 *
 * Everything here talks to playtomic.com's own same-origin API, which is what the
 * public club pages use. api.playtomic.io sits behind a WAF that rejects non-browser
 * TLS fingerprints, so we deliberately avoid it.
 *
 * Endpoints used:
 *   GET /search?q=<city>                          -> server-rendered list of /clubs/<slug>
 *   GET /clubs/<slug>                             -> RSC payload containing the tenant object
 *   GET /api/clubs/availability?tenant_id&date&sport_id -> free slots
 *
 * IMPORTANT: availability start_date + start_time are UTC. The club page converts
 * them into the tenant's own timezone before display, and so do we. A slot late in
 * the local evening can therefore come back stamped with the previous UTC date.
 */

const BASE = 'https://playtomic.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
};

/* ---------- request pacing ----------
 * playtomic.com sits behind CloudFront with a rate-based WAF rule. Bursting a few
 * hundred availability lookups gets the whole IP served 403 "Request blocked" for a
 * while, which silently looks like "no courts free". So every request goes through
 * one gate: bounded concurrency, a minimum gap between starts, and a global cooldown
 * that every in-flight worker respects as soon as one of them is refused.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gate = {
  maxConcurrent: 3,
  minGapMs: 160,
  active: 0,
  lastStart: 0,
  cooldownUntil: 0,
  queue: [],
  timer: null,
  onCooldown: null,
};

function pump() {
  if (gate.timer) { clearTimeout(gate.timer); gate.timer = null; }
  while (gate.queue.length && gate.active < gate.maxConcurrent) {
    const now = Date.now();
    const earliest = Math.max(gate.lastStart + gate.minGapMs, gate.cooldownUntil);
    if (now < earliest) {
      gate.timer = setTimeout(pump, earliest - now);
      return;
    }
    gate.active++;
    gate.lastStart = now;
    gate.queue.shift()();
  }
}

function acquire() {
  return new Promise((resolve) => { gate.queue.push(resolve); pump(); });
}

function release() {
  gate.active--;
  pump();
}

/** Pauses every worker for `ms`, so one 403 does not become a hundred. */
function coolDown(ms) {
  gate.cooldownUntil = Math.max(gate.cooldownUntil, Date.now() + ms);
  gate.onCooldown?.(ms);
}

/** Tunes the gate. Lower/slower is safer; used by the server per search size. */
function configure({ maxConcurrent, minGapMs, onCooldown } = {}) {
  if (maxConcurrent) gate.maxConcurrent = maxConcurrent;
  if (minGapMs != null) gate.minGapMs = minGapMs;
  if (onCooldown !== undefined) gate.onCooldown = onCooldown;
}

const rateLimited = () => Date.now() < gate.cooldownUntil;

async function request(url, { json = false, tries = 3, timeout = 25000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    await acquire();
    let res;
    try {
      res = await fetch(url, {
        headers: { ...HEADERS, Accept: json ? 'application/json' : 'text/html,*/*' },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      lastErr = err;
      release();
      if (attempt < tries - 1) await sleep(500 * 2 ** attempt);
      continue;
    }

    try {
      // 403 here is the WAF rate limiter, not a permissions problem: back the whole
      // client off rather than burning retries one request at a time.
      if (res.status === 403) {
        const wait = 5000 * 2 ** attempt;
        coolDown(wait);
        lastErr = Object.assign(new Error('rate limited by Playtomic (HTTP 403)'), { rateLimited: true });
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        coolDown(1500 * 2 ** attempt);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (res.status === 404) {
        throw Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404, fatal: true });
      }
      if (!res.ok) {
        lastErr = Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        continue;
      }
      return json ? await res.json() : await res.text();
    } finally {
      release();
    }
  }
  throw lastErr;
}

/* ---------- RSC payload extraction ---------- */

// Reads a JS string literal starting at `start` (which must point at the opening
// quote) and returns its raw source, escapes intact.
function readStringLiteral(src, start) {
  let esc = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') return src.slice(start, i + 1);
  }
  return null;
}

// Decodes every self.__next_f.push([1,"..."]) chunk into one flight payload.
function decodeFlight(html) {
  const marker = 'self.__next_f.push([1,';
  let out = '';
  let idx = 0;
  for (;;) {
    idx = html.indexOf(marker, idx);
    if (idx === -1) break;
    const quote = html.indexOf('"', idx + marker.length);
    if (quote === -1) break;
    const literal = readStringLiteral(html, quote);
    if (!literal) break;
    try { out += JSON.parse(literal); } catch { /* skip malformed chunk */ }
    idx = quote + literal.length;
  }
  return out;
}

// Brace-matches a JSON object beginning at `i`, respecting string literals.
function sliceJsonObject(src, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

/* ---------- public API ---------- */

/** Club slugs shown by Playtomic's own search for a free-text place query. */
async function searchClubSlugs(query) {
  const html = await request(`${BASE}/search?q=${encodeURIComponent(query)}`);
  const slugs = new Set();
  for (const m of html.matchAll(/\/clubs\/([a-z0-9][a-z0-9-]*)/gi)) slugs.add(m[1]);
  return [...slugs];
}

/** Full tenant record for a club slug: id, timezone, coordinates, courts. */
async function fetchClub(slug) {
  const html = await request(`${BASE}/clubs/${encodeURIComponent(slug)}`);
  const flight = decodeFlight(html);
  const at = flight.indexOf('{"tenant_id":');
  if (at === -1) return null;
  const raw = sliceJsonObject(flight, at);
  if (!raw) return null;

  let t;
  try { t = JSON.parse(raw); } catch { return null; }
  const addr = t.address || {};
  const courts = (t.resources || []).map((r) => ({
    id: r.resourceId,
    name: r.name,
    sport: r.sport,
    features: r.features || [],
  }));

  return {
    tenantId: t.tenant_id,
    name: t.tenant_name,
    slug: t.slug || slug,
    city: addr.city || '',
    area: addr.sub_administrative_area || addr.administrative_area || '',
    street: addr.street || '',
    country: addr.country_code || '',
    timezone: addr.timezone || 'UTC',
    lat: addr.coordinate?.lat ?? null,
    lon: addr.coordinate?.lon ?? null,
    sports: t.sport_ids || [],
    openingHours: t.opening_hours || null,
    courts,
    url: `${BASE}/clubs/${t.slug || slug}`,
  };
}

/** Raw availability for one club on one *local* date. */
function fetchAvailability(tenantId, date, sportId = 'PADEL') {
  const url =
    `${BASE}/api/clubs/availability?tenant_id=${encodeURIComponent(tenantId)}` +
    `&date=${encodeURIComponent(date)}&sport_id=${encodeURIComponent(sportId)}`;
  return request(url, { json: true });
}

/* ---------- time + price handling ---------- */

const fmtCache = new Map();
function localFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** UTC date+time -> { date: 'YYYY-MM-DD', time: 'HH:MM' } in the club's timezone. */
function toClubLocal(utcDate, utcTime, tz) {
  const at = new Date(`${utcDate}T${utcTime}Z`);
  if (Number.isNaN(at.getTime())) return null;
  const p = Object.fromEntries(
    localFormatter(tz).formatToParts(at).map((x) => [x.type, x.value])
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    epoch: at.getTime(),
  };
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const hhmmOf = (mins) =>
  `${String(Math.floor((mins % 1440) / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

function parsePrice(raw) {
  if (typeof raw !== 'string') return { amount: null, currency: '' };
  const m = raw.match(/([\d.,]+)\s*([A-Z]{3})?/);
  if (!m) return { amount: null, currency: '' };
  return { amount: Number(m[1].replace(',', '.')), currency: m[2] || '' };
}

/**
 * Flattens a raw availability response into local-time slots for one club.
 * Court names are resolved from the club record; unknown ids keep their uuid.
 */
function expandSlots(raw, club) {
  const byId = new Map(club.courts.map((c) => [c.id, c]));
  const out = [];
  for (const entry of raw || []) {
    const court = byId.get(entry.resource_id);
    for (const slot of entry.slots || []) {
      const local = toClubLocal(entry.start_date, slot.start_time, club.timezone);
      if (!local) continue;
      const startMin = minutesOf(local.time);
      const price = parsePrice(slot.price);
      out.push({
        clubId: club.tenantId,
        courtId: entry.resource_id,
        court: court?.name || entry.resource_id.slice(0, 8),
        features: court?.features || [],
        indoor: (court?.features || []).includes('indoor'),
        date: local.date,
        start: local.time,
        startMin,
        end: hhmmOf(startMin + slot.duration),
        endMin: startMin + slot.duration,
        duration: slot.duration,
        epoch: local.epoch,
        price: price.amount,
        currency: price.currency,
      });
    }
  }
  return out;
}

/** Runs `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  BASE,
  configure,
  rateLimited,
  searchClubSlugs,
  fetchClub,
  fetchAvailability,
  expandSlots,
  toClubLocal,
  minutesOf,
  hhmmOf,
  mapLimit,
};
