'use strict';
/**
 * Travel time from the player's location to each club.
 *
 * Uses the public OSRM demo router: its `table` service answers one origin against
 * every club in a single request, and needs no API key. That server has no SLA and
 * asks not to be hammered, so results are cached per rounded origin.
 *
 * Durations are free-flow estimates - OSRM has no live traffic. When it is
 * unreachable we return straight-line distance only and say so, rather than
 * inventing a duration from an assumed average speed.
 */
const OSRM = 'https://router.project-osrm.org';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DESTS = 90;                     // demo server limit is 100 coordinates
const cache = new Map();

/** Great-circle distance in km. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Round the origin before it leaves this machine: ~110 m is far more precision than
// a drive-time estimate needs, and it makes the cache useful.
const round3 = (n) => Math.round(n * 1000) / 1000;

async function fetchTable(lat, lon, clubs) {
  const coords = [`${lon},${lat}`, ...clubs.map((c) => `${c.lon},${c.lat}`)].join(';');
  const url = `${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'padel-finder (personal use)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`router returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 'Ok') throw new Error(`router said ${body.code}`);
  return { durations: body.durations?.[0] || [], distances: body.distances?.[0] || [] };
}

/**
 * @returns {{ byClub: Object, mode: 'drive'|'straight', note: string|null }}
 *          byClub[tenantId] = { minutes|null, km }
 */
async function travelTimes(lat, lon, allClubs) {
  const key = `${round3(lat)},${round3(lon)}|${allClubs.length}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const clubs = allClubs.filter((c) => typeof c.lat === 'number' && typeof c.lon === 'number');
  const byClub = {};
  for (const c of clubs) {
    byClub[c.tenantId] = { minutes: null, km: Math.round(haversine(lat, lon, c.lat, c.lon) * 10) / 10 };
  }

  let mode = 'straight';
  let note = null;
  try {
    const batch = clubs.slice(0, MAX_DESTS);
    const { durations, distances } = await fetchTable(round3(lat), round3(lon), batch);
    batch.forEach((c, i) => {
      const secs = durations[i + 1];
      const metres = distances[i + 1];
      if (typeof secs === 'number') {
        byClub[c.tenantId] = {
          minutes: Math.round(secs / 60),
          km: typeof metres === 'number' ? Math.round(metres / 100) / 10 : byClub[c.tenantId].km,
        };
      }
    });
    mode = 'drive';
  } catch (err) {
    note = `Drive times unavailable (${err.message}). Showing straight-line distance instead.`;
  }

  const value = { byClub, mode, note };
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { travelTimes, haversine };
