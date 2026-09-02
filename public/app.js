'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const state = { clubs: [], selected: new Set(), results: [], meta: null, view: 'byday', scanning: false };

/* ---------- small helpers ---------- */

const chipValues = (host) => [...host.querySelectorAll('button.on')].map((b) => b.dataset.v);
const setChips = (host, values) => {
  host.querySelectorAll('button').forEach((b) => b.classList.toggle('on', values.includes(b.dataset.v)));
};

function toggleGroup(host, { single = false } = {}) {
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (single) host.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    else b.classList.toggle('on');
  });
}

function fmtDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

const money = (s) => (s.price == null ? '' : `${s.price} ${s.currency}`.trim());

/** Reads the whole form into the query the server expects. */
function currentQuery() {
  return {
    city: $('city').value.trim(),
    from: $('from').value,
    days: $('days').value,
    weekdays: chipValues($('weekdays')).join(','),
    start: $('start').value || '00:00',
    end: $('end').value || '23:59',
    fit: $('fit').checked ? '1' : '0',
    durations: chipValues($('durations')).join(','),
    indoor: chipValues($('indoor'))[0] || 'any',
    maxPrice: $('maxPrice').value,
    clubs: state.selected.size === state.clubs.length ? '' : [...state.selected].join(','),
  };
}

function applyQuery(q) {
  if (q.city) $('city').value = q.city;
  if (q.from) $('from').value = q.from;
  if (q.days) $('days').value = q.days;
  if (q.start) $('start').value = q.start;
  if (q.end) $('end').value = q.end;
  $('fit').checked = q.fit !== '0';
  $('maxPrice').value = q.maxPrice || '';
  setChips($('weekdays'), (q.weekdays || '').split(',').filter(Boolean));
  setChips($('durations'), (q.durations || '').split(',').filter(Boolean));
  setChips($('indoor'), [q.indoor || 'any']);
  if (q.clubs) {
    state.selected = new Set(q.clubs.split(',').filter(Boolean));
    renderClubs();
  }
}

/* ---------- server calls ---------- */

/** Consumes an SSE endpoint; resolves with the `done` payload. */
function stream(url, { onProgress, onPartial } = {}) {
  let es;
  const p = new Promise((resolve, reject) => {
    es = new EventSource(url);
    es.addEventListener('progress', (e) => onProgress?.(JSON.parse(e.data)));
    es.addEventListener('partial', (e) => onPartial?.(JSON.parse(e.data)));
    es.addEventListener('done', (e) => { es.close(); resolve(JSON.parse(e.data)); });
    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Connection to the local server failed.';
      try { msg = JSON.parse(e.data).message; } catch { /* transport-level error */ }
      reject(new Error(msg));
    });
  });
  p.cancel = () => es?.close();
  return p;
}

async function loadCatalog(city) {
  let r = await fetch(`/api/catalog?city=${encodeURIComponent(city || '')}`);
  let data = await r.json();

  // Nothing asked for (or asked for an area we have never scanned): fall back to
  // the only city we do know about, so a fresh window is immediately usable.
  if (!data.clubs.length && data.cities.length === 1) {
    city = data.cities[0].query;
    $('city').value = city;
    localStorage.setItem('padel.city', city);
    r = await fetch(`/api/catalog?city=${encodeURIComponent(city)}`);
    data = await r.json();
  }

  const dl = $('cities');
  dl.replaceChildren(...data.cities.map((c) => { const o = el('option'); o.value = c.query; return o; }));

  if (data.authEnabled && !document.getElementById('signout')) {
    const a = el('a', 'link', 'Sign out');
    a.id = 'signout';
    a.href = '/logout';
    document.querySelector('.city').append(a);
  }

  state.clubs = data.clubs;
  state.selected = new Set(data.clubs.map((c) => c.tenantId));
  renderClubs();

  const known = data.cities.find((c) => c.key === (city || '').trim().toLowerCase());
  $('catalogInfo').textContent = known
    ? `${known.count} clubs, list built ${new Date(known.builtAt).toLocaleDateString()}`
    : city ? 'no club list yet - press Rescan clubs' : '';
  return data;
}

/* ---------- rendering ---------- */

function renderClubs() {
  const host = $('clubs');
  host.replaceChildren();
  $('clubCount').textContent = state.clubs.length ? `${state.selected.size}/${state.clubs.length}` : '';

  for (const c of state.clubs) {
    const label = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(c.tenantId);
    cb.onchange = () => {
      cb.checked ? state.selected.add(c.tenantId) : state.selected.delete(c.tenantId);
      $('clubCount').textContent = `${state.selected.size}/${state.clubs.length}`;
    };
    label.append(cb, el('span', null, c.name),
      el('span', 'meta', `${c.courts}${c.indoor ? ` · ${c.indoor} in` : ''}`));
    host.append(label);
  }
}

function slotRow(s, { showDay = false, showClub = true } = {}) {
  const tr = el('tr');
  const time = el('td', 't-time');
  time.append(`${s.start}–${s.end}`, el('span', 't-dur', ` ${s.duration}m`));
  if (showDay) time.prepend(el('span', 't-dur', `${fmtDay(s.date)} `));

  const club = el('td');
  if (showClub) club.append(el('div', 't-club', s.clubName));
  const court = el('div', showClub ? 't-court' : 't-club', s.court);
  if (s.indoor) court.append(el('span', 'tag in', 'indoor'));
  club.append(court);

  const price = el('td', 't-price', money(s));
  const book = el('td', 't-price');
  const a = el('a', 'book', 'Book ↗');
  a.href = s.bookUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
  book.append(a);

  tr.append(time, club, price, book);
  return tr;
}

function table(slots, opts) {
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Time', opts?.showClub === false ? 'Court' : 'Club / court', 'Price', '']) hr.append(el('th', null, h));
  thead.append(hr);
  const tb = el('tbody');
  for (const s of slots) tb.append(slotRow(s, opts));
  t.append(thead, tb);
  return t;
}

function renderResults() {
  const out = $('out');
  out.replaceChildren();
  const { results, meta } = state;

  if (meta?.failedCount) {
    const missed = [...new Set((meta.failedClubDays || []).map((f) => f.club))];
    out.append(el('div', 'notice',
      `Incomplete: ${meta.failedCount} of ${meta.requests} club-days could not be checked ` +
      `(Playtomic rate-limited the lookups). Those clubs may have free courts that are not listed ` +
      `below${missed.length ? ` - affected: ${missed.slice(0, 6).join(', ')}${missed.length > 6 ? '…' : ''}` : ''}. ` +
      `Search again to fill the gaps; cached days will not be refetched.`));
  }

  if (!results.length) {
    const e = el('div', 'empty');
    if (state.scanning) {
      e.append(el('strong', null, 'Searching…'),
        el('div', null, 'Days are checked nearest first and appear here as they arrive.'));
      out.append(e);
      return;
    }
    e.append(el('strong', null, 'No free courts in that window'),
      el('div', null, meta
        ? `Checked ${meta.checked} of ${meta.requests} club-days. Try widening the hours, adding 60 min games, or extending the date range.`
        : 'Set your filters and press Search.'));
    out.append(e);
    return;
  }

  if (state.view === 'list') {
    out.append(table(results, { showDay: true }));
    return;
  }

  if (state.view === 'byclub') {
    const groups = new Map();
    for (const s of results) {
      if (!groups.has(s.clubName)) groups.set(s.clubName, []);
      groups.get(s.clubName).push(s);
    }
    for (const [name, slots] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      const wrap = el('div', 'day');
      const head = el('div', 'day-head');
      head.append(el('h3', null, name), el('span', 'n', `${slots.length} slots`));
      wrap.append(head, table(slots, { showDay: true, showClub: false }));
      out.append(wrap);
    }
    return;
  }

  // by day. "Today" means today at the club, not in UTC - they differ for the
  // late-night slots that Playtomic reports against the previous UTC date.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: meta?.timezone || undefined,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const groups = new Map();
  for (const s of results) {
    if (!groups.has(s.date)) groups.set(s.date, []);
    groups.get(s.date).push(s);
  }
  for (const [date, slots] of groups) {
    const wrap = el('div', 'day');
    const head = el('div', 'day-head');
    head.append(el('h3', null, fmtDay(date)));
    if (date === today) head.append(el('span', 'today', 'TODAY'));
    const clubsHere = new Set(slots.map((s) => s.clubName)).size;
    head.append(el('span', 'n', `${slots.length} slots · ${clubsHere} club${clubsHere > 1 ? 's' : ''}`));
    wrap.append(head, table(slots));
    out.append(wrap);
  }
}

/* ---------- actions ---------- */

let inflight = null;

async function doSearch() {
  const q = currentQuery();
  if (!q.city) return setStatus('Enter an area first.', true);
  if (!state.clubs.length) return setStatus('No club list for this area - press Rescan clubs.', true);
  if (!state.selected.size) return setStatus('Select at least one club.', true);

  inflight?.cancel();                    // a new search supersedes the running one
  $('search').textContent = 'Stop';
  $('progress').hidden = false;
  $('bar').style.width = '0%';
  state.results = [];
  state.meta = null;
  state.scanning = true;
  renderResults();
  setStatus('Checking availability…');

  try {
    const url = '/api/search?' + new URLSearchParams(q);
    inflight = stream(url, {
      onProgress: (p) => {
        $('bar').style.width = `${Math.round((p.done / p.total) * 100)}%`;
      },
      // Days stream back nearest-first, so show each one the moment it lands.
      onPartial: (p) => {
        state.results = state.results.concat(p.results);
        renderResults();
        setStatus(`${state.results.length} free slots so far · checked ${p.done}/${p.total} club-days`);
      },
    });
    const out = await inflight;
    state.results = out.results;
    state.meta = out.meta;
    const clubsWith = new Set(out.results.map((r) => r.clubId)).size;
    setStatus(out.results.length
      ? `${out.results.length} free slots at ${clubsWith} of ${out.meta.clubsScanned} clubs`
      : `Nothing free · ${out.meta.checked} of ${out.meta.requests} club-days checked`);
    renderResults();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    inflight = null;
    state.scanning = false;
    $('search').textContent = 'Search';
    $('progress').hidden = true;
  }
}

function stopSearch() {
  if (!inflight) return false;
  inflight.cancel();
  inflight = null;
  state.scanning = false;
  $('search').textContent = 'Search';
  $('progress').hidden = true;
  setStatus(`Stopped · ${state.results.length} free slots found so far`);
  renderResults();
  return true;
}

async function rescan() {
  const city = $('city').value.trim();
  if (!city) return setStatus('Enter an area first.', true);
  $('refreshClubs').disabled = true;
  $('progress').hidden = false;
  setStatus(`Scanning Playtomic for clubs near ${city}…`);
  try {
    const out = await stream(`/api/catalog/refresh?city=${encodeURIComponent(city)}`, {
      onProgress: (p) => {
        if (p.total) $('bar').style.width = `${Math.round(((p.done || 0) / p.total) * 100)}%`;
        if (p.phase === 'club') setStatus(`Reading clubs ${p.done}/${p.total}: ${p.name}`);
      },
    });
    await loadCatalog(city);
    setStatus(`${out.clubs} padel clubs found (${out.scanned} venues checked)`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('refreshClubs').disabled = false;
    $('progress').hidden = true;
  }
}

function setStatus(text, bad = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('err', bad);
}

/* ---------- presets ---------- */

/* Saved searches live on the server so they follow you between devices. Cloud free
 * tiers have ephemeral disks though, so the browser keeps a mirror and restores it
 * when a restarted instance comes back empty. */
const PRESET_KEY = 'padel.presets';

const readMirror = () => {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch { return []; }
};
const writeMirror = (list) => {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch { /* private mode */ }
};

const putPresets = (list) =>
  fetch('/api/presets', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list),
  });

async function loadPresets() {
  let list = await (await fetch('/api/presets')).json();

  const mirror = readMirror();
  if (!list.length && mirror.length) {
    await putPresets(mirror);
    list = mirror;
  } else {
    writeMirror(list);
  }
  const host = $('presets');
  host.replaceChildren();
  for (const p of list) {
    const row = el('div', 'preset');
    const use = el('button', null, p.name);
    use.onclick = () => { applyQuery(p.query); doSearch(); };
    const del = el('button', 'del', '×');
    del.title = 'Delete';
    del.onclick = async () => {
      const next = list.filter((x) => x.name !== p.name);
      writeMirror(next);
      await putPresets(next);
      loadPresets();
    };
    row.append(use, del);
    host.append(row);
  }
  return list;
}

async function savePreset() {
  const name = $('presetName').value.trim();
  if (!name) return setStatus('Name the search first.', true);
  const list = (await (await fetch('/api/presets')).json()).filter((x) => x.name !== name);
  list.push({ name, query: currentQuery() });
  writeMirror(list);
  await putPresets(list);
  $('presetName').value = '';
  loadPresets();
}

/* ---------- boot ---------- */

(function init() {
  // weekday chips, Monday first
  const host = $('weekdays');
  for (const i of [1, 2, 3, 4, 5, 6, 0]) {
    const b = el('button', null, DAY_NAMES[i]);
    b.dataset.v = String(i);
    host.append(b);
  }
  toggleGroup(host);
  toggleGroup($('durations'));
  toggleGroup($('indoor'), { single: true });
  toggleGroup($('view'), { single: true });

  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.view = b.dataset.v;
    renderResults();
  });

  $('timePresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('start').value = b.dataset.s;
    $('end').value = b.dataset.e;
  });

  $('from').value = new Date().toISOString().slice(0, 10);
  $('search').onclick = () => { if (!stopSearch()) doSearch(); };
  $('refreshClubs').onclick = rescan;
  $('allClubs').onclick = () => { state.selected = new Set(state.clubs.map((c) => c.tenantId)); renderClubs(); };
  $('noClubs').onclick = () => { state.selected = new Set(); renderClubs(); };
  $('savePreset').onclick = savePreset;
  $('city').addEventListener('change', () => loadCatalog($('city').value.trim()));

  const lastCity = localStorage.getItem('padel.city') || '';
  if (lastCity) $('city').value = lastCity;
  $('city').addEventListener('input', () => localStorage.setItem('padel.city', $('city').value.trim()));

  loadCatalog(lastCity).then(() => loadPresets());
})();
