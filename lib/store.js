'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

/* ---------- club catalog ---------- */
// { cities: { <cityKey>: { query, builtAt, clubIds: [] } }, clubs: { <tenantId>: club } }

const CATALOG_FILE = 'clubs.json';
const emptyCatalog = () => ({ cities: {}, clubs: {} });

const loadCatalog = () => readJson(CATALOG_FILE, emptyCatalog());
const saveCatalog = (c) => writeJson(CATALOG_FILE, c);

function upsertCity(catalog, query, clubs) {
  const key = query.trim().toLowerCase();
  for (const club of clubs) catalog.clubs[club.tenantId] = club;
  catalog.cities[key] = {
    query: query.trim(),
    builtAt: new Date().toISOString(),
    clubIds: clubs.map((c) => c.tenantId),
  };
  return key;
}

function cityClubs(catalog, cityKey) {
  const city = catalog.cities[cityKey?.trim().toLowerCase()];
  if (!city) return null;
  return city.clubIds.map((id) => catalog.clubs[id]).filter(Boolean);
}

/* ---------- saved searches ---------- */

const PRESETS_FILE = 'presets.json';
const loadPresets = () => readJson(PRESETS_FILE, []);
const savePresets = (p) => writeJson(PRESETS_FILE, p);

module.exports = {
  DATA_DIR,
  loadCatalog, saveCatalog, upsertCity, cityClubs,
  loadPresets, savePresets,
};
