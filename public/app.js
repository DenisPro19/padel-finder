'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STEPS = ['When', 'Hours', 'Game', 'Clubs'];
const wide = () => window.matchMedia('(min-width:900px)').matches;

const state = {
  clubs: [], selected: new Set(), results: [], meta: null,
  view: 'byday', scanning: false, step: 0, open: new Set(),
};

/* ---------- chip groups ---------- */

const chipValues = (host) => [...host.querySelectorAll('button.on')].map((b) => b.dataset.v);
const setChips = (host, values) =>
  host.querySelectorAll('button').forEach((b) => b.classList.toggle('on', values.includes(b.dataset.v)));

function toggleGroup(host, { single = false } = {}) {
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (single) host.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    else b.classList.toggle('on');
  });
}

/* ---------- formatting ---------- */

function fmtDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}
const money = (s) => (s.price == null ? '' : `${s.price} ${s.currency}`.trim());

/* ---------- query <-> form ---------- */

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
  $('from').value = q.from || new Date().toISOString().slice(0, 10);
  if (q.days) $('days').value = q.days;
  if (q.start) $('start').value = q.start;
  if (q.end) $('end').value = q.end;
  $('fit').checked = q.fit !== '0';
  $('maxPrice').value = q.maxPrice || '';
  setChips($('weekdays'), (q.weekdays || '').split(',').filter(Boolean));
  setChips($('durations'), (q.durations || '').split(',').filter(Boolean));
  setChips($('indoor'), [q.indoor || 'any']);
  syncRangeChips();
  syncTimeChips();
  if (q.clubs) {
    state.selected = new Set(q.clubs.split(',').filter(Boolean));
    renderClubs();
  }
}

/** One-line human summary of a saved search, shown under its name. */
function describe(q) {
  const bits = [`${q.start}–${q.end}`];
  if (q.durations) bits.push(`${q.durations.split(',').join('/')} min`);
  bits.push(`${q.days || 7} days`);
  if (q.indoor && q.indoor !== 'any') bits.push(q.indoor);
  if (q.maxPrice) bits.push(`≤ ${q.maxPrice}`);
  return bits.join(' · ');
}

/* keep the quick-pick chips in step with the detailed inputs */
function syncRangeChips() {
  const d = $('days').value;
  const today = new Date().toISOString().slice(0, 10);
  const plain = !$('from').value || $('from').value === today;
  $('rangePresets').querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', plain && b.dataset.days === d));
}
function syncTimeChips() {
  const s = $('start').value, e = $('end').value;
  $('timePresets').querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.s === s && b.dataset.e === e));
}

/* ---------- server ---------- */

function stream(url, { onProgress, onPartial } = {}) {
  let es;
  const p = new Promise((resolve, reject) => {
    es = new EventSource(url);
    es.addEventListener('progress', (e) => onProgress?.(JSON.parse(e.data)));
    es.addEventListener('partial', (e) => onPartial?.(JSON.parse(e.data)));
    es.addEventListener('done', (e) => { es.close(); resolve(JSON.parse(e.data)); });
    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Lost connection to the server.';
      try { msg = JSON.parse(e.data).message; } catch { /* transport-level */ }
      reject(new Error(msg));
    });
  });
  p.cancel = () => es?.close();
  return p;
}

async function loadCatalog(city) {
  let r = await fetch(`/api/catalog?city=${encodeURIComponent(city || '')}`);
  let data = await r.json();

  // Fall back to the only area we know, so a fresh device is usable immediately.
  if (!data.clubs.length && data.cities.length === 1) {
    city = data.cities[0].query;
    $('city').value = city;
    try { localStorage.setItem('padel.city', city); } catch { /* private mode */ }
    r = await fetch(`/api/catalog?city=${encodeURIComponent(city)}`);
    data = await r.json();
  }

  if (data.authEnabled) $('signout').hidden = false;

  $('cities').replaceChildren(...data.cities.map((c) => {
    const o = el('option'); o.value = c.query; return o;
  }));

  state.clubs = data.clubs;
  state.selected = new Set(data.clubs.map((c) => c.tenantId));
  renderClubs();

  const known = data.cities.find((c) => c.key === (city || '').trim().toLowerCase());
  $('areaBtn').textContent = known ? known.query : (city || 'Choose area');
  $('catalogInfo').textContent = known
    ? `${known.count} clubs · list built ${new Date(known.builtAt).toLocaleDateString()}`
    : city ? 'No club list yet — press Rescan clubs.' : '';
  return data;
}

/* ---------- clubs ---------- */

function renderClubs() {
  const host = $('clubs');
  const term = ($('clubFilter').value || '').toLowerCase();
  host.replaceChildren();
  $('clubCount').textContent = state.clubs.length ? `${state.selected.size}/${state.clubs.length}` : '';

  for (const c of state.clubs) {
    if (term && !c.name.toLowerCase().includes(term)) continue;
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

/* ---------- results ---------- */

function offerCard(s, { showDay = false, showClub = true } = {}) {
  const row = el('div', 'offer');
  const info = el('div', 'info');

  if (showClub) info.append(el('div', 'club', s.clubName));
  const court = el('div', 'court');
  court.append(showClub ? s.court : `${s.court}`);
  if (s.indoor) court.append(el('span', 'tag in', 'indoor'));
  info.append(court);

  const when = showDay ? `${fmtDay(s.date)} · ${s.start}–${s.end} · ${s.duration}m`
                       : `${s.start}–${s.end} · ${s.duration}m`;
  info.append(el('div', 'when', when));

  const book = el('a', 'book', 'Book');
  book.href = s.bookUrl; book.target = '_blank'; book.rel = 'noopener noreferrer';

  row.append(info, el('div', 'price', money(s)), book);
  return row;
}

function renderResults() {
  const out = $('out');
  out.replaceChildren();
  const { results, meta } = state;

  if (meta?.failedCount) {
    const missed = [...new Set((meta.failedClubDays || []).map((f) => f.club))];
    out.append(el('div', 'notice',
      `Incomplete: ${meta.failedCount} of ${meta.requests} club-days could not be checked ` +
      `(Playtomic rate-limited them), so those may have free courts not shown here` +
      `${missed.length ? ` — affected: ${missed.slice(0, 4).join(', ')}${missed.length > 4 ? '…' : ''}` : ''}. ` +
      `Search again to fill the gaps.`));
  }

  if (!results.length) {
    const e = el('div', 'empty');
    if (state.scanning) {
      e.append(el('strong', null, 'Searching…'),
        el('div', null, 'Nearest days are checked first and appear as they arrive.'));
    } else {
      e.append(el('strong', null, 'No free courts in that window'),
        el('div', null, meta
          ? `Checked ${meta.checked} of ${meta.requests} club-days. Try wider hours, 60 min games, or more days.`
          : 'Set your filters and press Search.'));
    }
    out.append(e);
    return;
  }

  if (state.view === 'list') {
    const wrap = el('div', 'offers');
    for (const s of results) wrap.append(offerCard(s, { showDay: true }));
    out.append(wrap);
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
      const list = el('div', 'offers');
      for (const s of slots) list.append(offerCard(s, { showDay: true, showClub: false }));
      wrap.append(head, list);
      out.append(wrap);
    }
    return;
  }

  /* By day: a day is a row of start times; tapping one opens its clubs. This keeps
   * a thousand-slot result readable on a phone instead of an endless card list. */
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: meta?.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const days = new Map();
  for (const s of results) {
    if (!days.has(s.date)) days.set(s.date, new Map());
    const times = days.get(s.date);
    if (!times.has(s.start)) times.set(s.start, []);
    times.get(s.start).push(s);
  }

  for (const [date, times] of days) {
    const wrap = el('div', 'day');
    const head = el('div', 'day-head');
    head.append(el('h3', null, fmtDay(date)));
    if (date === today) head.append(el('span', 'today', 'TODAY'));
    const total = [...times.values()].reduce((n, a) => n + a.length, 0);
    const clubsHere = new Set([...times.values()].flat().map((s) => s.clubName)).size;
    head.append(el('span', 'n', `${total} slots · ${clubsHere} club${clubsHere > 1 ? 's' : ''}`));

    const grid = el('div', 'timegrid');
    const panel = el('div', 'offers');

    const draw = () => {
      panel.replaceChildren();
      for (const [time, slots] of times) {
        if (!state.open.has(`${date} ${time}`)) continue;
        for (const s of slots) panel.append(offerCard(s, { showClub: true }));
      }
    };

    for (const [time, slots] of times) {
      const key = `${date} ${time}`;
      const b = el('button', 'timeslot');
      b.type = 'button';
      b.append(el('span', null, time),
        el('span', 'c', `${new Set(slots.map((s) => s.clubName)).size} clubs`));
      b.classList.toggle('on', state.open.has(key));
      b.onclick = () => {
        state.open.has(key) ? state.open.delete(key) : state.open.add(key);
        b.classList.toggle('on', state.open.has(key));
        draw();
      };
      grid.append(b);
    }
    draw();
    wrap.append(head, grid, panel);
    out.append(wrap);
  }
}

/* ---------- navigation ---------- */

function showStep(i) {
  state.step = Math.max(0, Math.min(STEPS.length - 1, i));
  document.querySelectorAll('.step').forEach((s) => {
    s.hidden = Number(s.dataset.step) !== state.step;
  });
  $('back').hidden = state.step === 0;
  $('next').hidden = state.step === STEPS.length - 1;
  renderStepBar();
  window.scrollTo({ top: 0 });
}

function renderStepBar() {
  const bar = $('stepBar');
  bar.replaceChildren();
  STEPS.forEach((name, i) => {
    const b = el('button', i === state.step ? 'on' : i < state.step ? 'done' : '');
    b.type = 'button';
    b.append(el('i'), el('span', null, `${i + 1}. ${name}`));
    b.onclick = () => showStep(i);
    bar.append(b);
  });
}

function showResults(on) {
  if (wide()) return;                       // both panes are visible on desktop
  $('screenSearch').hidden = on;
  $('screenResults').hidden = !on;
  window.scrollTo({ top: 0 });
}

/* ---------- actions ---------- */

function setStatus(text, bad = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('err', bad);
}

let inflight = null;

async function doSearch() {
  const q = currentQuery();
  if (!q.city) return setStatus('Choose an area first.', true);
  if (!state.clubs.length) return setStatus('No club list — open Area and rescan.', true);
  if (!state.selected.size) return setStatus('Select at least one club.', true);

  inflight?.cancel();
  showResults(true);
  $('search').textContent = 'Stop';
  $('progress').hidden = false;
  $('bar').style.width = '0%';
  state.results = [];
  state.meta = null;
  state.scanning = true;
  state.open.clear();
  renderResults();
  setStatus('Checking availability…');

  try {
    inflight = stream('/api/search?' + new URLSearchParams(q), {
      onProgress: (p) => { $('bar').style.width = `${Math.round((p.done / p.total) * 100)}%`; },
      onPartial: (p) => {
        state.results = state.results.concat(p.results);
        // Open the first day's earliest time so something useful is on screen at once.
        if (p.results.length && state.open.size === 0) {
          state.open.add(`${p.results[0].date} ${p.results[0].start}`);
        }
        renderResults();
        setStatus(`${state.results.length} slots so far · ${p.done}/${p.total} club-days`);
      },
    });
    const out = await inflight;
    state.results = out.results;
    state.meta = out.meta;
    const clubsWith = new Set(out.results.map((r) => r.clubId)).size;
    setStatus(out.results.length
      ? `${out.results.length} free slots · ${clubsWith} of ${out.meta.clubsScanned} clubs`
      : `Nothing free · ${out.meta.checked}/${out.meta.requests} club-days checked`);
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
  setStatus(`Stopped · ${state.results.length} slots found`);
  renderResults();
  return true;
}

async function rescan() {
  const city = $('city').value.trim();
  if (!city) return;
  $('refreshClubs').disabled = true;
  $('catalogInfo').textContent = `Scanning Playtomic near ${city}…`;
  try {
    const out = await stream(`/api/catalog/refresh?city=${encodeURIComponent(city)}`, {
      onProgress: (p) => {
        if (p.phase === 'club') $('catalogInfo').textContent = `Reading clubs ${p.done}/${p.total}: ${p.name}`;
      },
    });
    await loadCatalog(city);
    $('catalogInfo').textContent = `${out.clubs} padel clubs found (${out.scanned} venues checked)`;
  } catch (err) {
    $('catalogInfo').textContent = err.message;
  } finally {
    $('refreshClubs').disabled = false;
  }
}

/* ---------- saved searches ---------- */

const PRESET_KEY = 'padel.presets';
const readMirror = () => {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch { return []; }
};
const writeMirror = (l) => {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(l)); } catch { /* private mode */ }
};
const putPresets = (list) => fetch('/api/presets', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list),
});

async function loadPresets() {
  let list = await (await fetch('/api/presets')).json();
  const mirror = readMirror();
  // Cloud free tiers wipe the disk on restart; restore from the browser's copy.
  if (!list.length && mirror.length) { await putPresets(mirror); list = mirror; }
  else writeMirror(list);

  $('presetWrap').hidden = !list.length;
  const host = $('presets');
  host.replaceChildren();
  for (const p of list) {
    const row = el('div', 'preset');
    const use = el('button', null, p.name);
    use.type = 'button';
    use.append(el('span', 'sub', describe(p.query)));
    use.onclick = () => { applyQuery(p.query); doSearch(); };
    const del = el('button', 'del', '×');
    del.type = 'button';
    del.onclick = async () => {
      const next = list.filter((x) => x.name !== p.name);
      writeMirror(next);
      await putPresets(next);
      loadPresets();
    };
    row.append(use, del);
    host.append(row);
  }
}

async function savePreset() {
  const name = $('presetName').value.trim();
  if (!name) return;
  const list = (await (await fetch('/api/presets')).json()).filter((x) => x.name !== name);
  list.push({ name, query: currentQuery() });
  writeMirror(list);
  await putPresets(list);
  $('presetName').value = '';
  loadPresets();
}

/* ---------- boot ---------- */

(function init() {
  const wd = $('weekdays');
  for (const i of [1, 2, 3, 4, 5, 6, 0]) {
    const b = el('button', null, DAY_NAMES[i]);
    b.type = 'button';
    b.dataset.v = String(i);
    wd.append(b);
  }
  toggleGroup(wd);
  toggleGroup($('durations'));
  toggleGroup($('indoor'), { single: true });

  $('rangePresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('days').value = b.dataset.days;
    $('from').value = new Date().toISOString().slice(0, 10);
    setChips($('weekdays'), []);
    syncRangeChips();
  });
  $('timePresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('start').value = b.dataset.s;
    $('end').value = b.dataset.e;
    syncTimeChips();
  });
  $('days').addEventListener('input', syncRangeChips);
  $('from').addEventListener('input', syncRangeChips);
  $('start').addEventListener('input', syncTimeChips);
  $('end').addEventListener('input', syncTimeChips);

  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('view').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.view = b.dataset.v;
    renderResults();
  });

  $('from').value = new Date().toISOString().slice(0, 10);
  $('next').onclick = () => showStep(state.step + 1);
  $('back').onclick = () => showStep(state.step - 1);
  $('edit').onclick = () => showResults(false);
  $('search').onclick = () => { if (!stopSearch()) doSearch(); };
  $('allClubs').onclick = () => { state.selected = new Set(state.clubs.map((c) => c.tenantId)); renderClubs(); };
  $('noClubs').onclick = () => { state.selected = new Set(); renderClubs(); };
  $('clubFilter').addEventListener('input', renderClubs);
  $('savePreset').onclick = savePreset;

  const sheet = $('areaSheet');
  $('areaBtn').onclick = () => { sheet.hidden = false; };
  $('areaDone').onclick = () => { sheet.hidden = true; };
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
  $('refreshClubs').onclick = rescan;
  $('city').addEventListener('change', () => {
    const c = $('city').value.trim();
    try { localStorage.setItem('padel.city', c); } catch { /* private mode */ }
    loadCatalog(c);
  });

  window.addEventListener('resize', () => {
    if (wide()) { $('screenSearch').hidden = false; $('screenResults').hidden = false; }
  });

  showStep(0);
  if (wide()) { $('screenResults').hidden = false; }

  let lastCity = '';
  try { lastCity = localStorage.getItem('padel.city') || ''; } catch { /* private mode */ }
  if (lastCity) $('city').value = lastCity;

  loadCatalog(lastCity).then(loadPresets).catch(() => {
    setStatus('Could not reach the server. Reload the page.', true);
  });
})();
