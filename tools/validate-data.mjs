#!/usr/bin/env node
/**
 * validate-data.mjs — validate src/data/*.json against the contract in
 * src/core/types.ts and docs/DESIGN.md.
 *
 * Run: node tools/validate-data.mjs
 * Missing files are warnings. Invalid content is an error (exit code 1).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_W, MAP_H } from './lib/project.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'src/data');
const REALM_W = 2400;
const REALM_H = 1350;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNDERSCORE_ID = /^[a-z][a-z0-9_]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

const errors = [];
const warnings = [];
const err = (path, message) => errors.push(`${path}: ${message}`);
const warn = (path, message) => warnings.push(`${path}: ${message}`);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const oneOf = (v, values) => values.includes(v);

// nameKana: nameJa のふりがな。漢字（CJK統合漢字と々）を含む名前だけが持つ。
const KANJI = /[\u4e00-\u9fff\u3005]/;
const NAME_KANA = /^[\u3041-\u3096\u30fc\u30fb ]+$/; // ひらがな + 長音ー + 中点・ + 半角空白

function validateNameKana(c, p) {
  if (!isStr(c.nameJa) || !KANJI.test(c.nameJa)) {
    if (c.nameKana !== undefined) err(`${p}.nameKana`, 'must be absent when nameJa has no kanji');
    return;
  }
  if (!isStr(c.nameKana)) {
    err(`${p}.nameKana`, 'required when nameJa contains kanji');
    return;
  }
  if (!NAME_KANA.test(c.nameKana)) {
    err(`${p}.nameKana`, `must be hiragana (ー ・ space allowed), got "${c.nameKana}"`);
  }
}

const INDUSTRIES = ['agri', 'food', 'tourism', 'industry', 'tech', 'finance', 'energy', 'shipping', 'media'];
const REGIONS = [
  'east_asia', 'southeast_asia', 'south_asia', 'middle_east', 'europe', 'russia_central_asia',
  'africa', 'north_america', 'central_america', 'south_america', 'oceania',
];
const PERKS = [
  'none', 'agri_boost', 'tech_boost', 'tourism_boost', 'finance_boost', 'sailor', 'lucky',
  'tough', 'card_shark', 'haggler', 'pickpocket', 'piper_charm',
];
const ROLES = ['hero', 'sidekick', 'villain', 'animal', 'monster', 'royal', 'trickster'];
const LINE_KEYS = [
  'select', 'turn', 'buy', 'monopoly', 'goal', 'blue', 'red', 'card',
  'piper_get', 'piper_hit', 'win', 'lose',
];
const WHO = ['self', 'all', 'others', 'richest', 'poorest', 'random_other'];
const CARD_KINDS = ['move', 'money', 'attack', 'defense', 'special'];
const SQUARE_KINDS = ['blue', 'red', 'yellow', 'news', 'shop', 'warp', 'portal'];
const REALM_IDS = ['heaven', 'hell', 'space'];
const REALM_OR_WORLD = [...REALM_IDS, 'world'];
const EDGE_MODES = ['rail', 'sea', 'air'];
const EFFECT_OPS = [
  'cash', 'cash_pct', 'per_property', 'industry_mod', 'price_mod', 'sell',
  'card', 'move', 'skip', 'piper', 'gamble', 'realm',
];

const LANDMARK_CITY = {
  big_ben: ['london'],
  eiffel: ['paris'],
  brandenburg: ['berlin'],
  colosseum: ['rome'],
  kremlin: ['moscow'],
  statue_liberty: ['new-york'],
  golden_gate: ['san-francisco'],
  sugarloaf: ['rio-de-janeiro'],
  pyramids: ['cairo'],
  taj_mahal: ['agra', 'delhi'],
  tokyo_tower: ['tokyo'],
  great_wall: ['beijing'],
  angkor_wat: ['siem-reap', 'phnom-penh'],
  machu_picchu: ['cusco', 'lima'],
  chichen_itza: ['cancun', 'mexico-city'],
  table_mountain: ['cape-town'],
  harbour_bridge: ['sydney'],
  windmill: ['amsterdam'],
  osaka_castle: ['osaka'],
  acropolis: ['athens'],
  cn_tower: ['toronto'],
  gyeongbokgung: ['seoul'],
  petra: ['amman'],
  kilimanjaro: ['nairobi', 'arusha'],
  neuschwanstein: ['munich'],
  mt_fuji: ['shizuoka'],
  niagara: ['niagara-falls', 'buffalo'],
  iguazu: ['foz-do-iguacu'],
  victoria_falls: ['livingstone'],
  ha_long_bay: ['hanoi', 'ha-long'],
  cappadocia: ['kayseri'],
  prague_castle: ['prague'],
  hermitage: ['st-petersburg'],
  gateway_arch: ['st-louis'],
  baobab: ['antananarivo'],
  terracotta: ['xian'],
};

// ---------------------------------------------------------------- DESIGN.md
const design = readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8');
function designCharacterIds() {
  const section = design.split('## 7.')[1]?.split('\n## ')[0] ?? '';
  const ids = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('シート')) continue;
    const cell = line.split('|').map((s) => s.trim())[2] ?? '';
    for (const m of cell.matchAll(/([a-z][a-z0-9_]+)\s+[^,]+/g)) ids.push(m[1]);
  }
  return new Set(ids);
}
const DESIGN_CHAR_IDS = designCharacterIds();

function designCardIds() {
  const section = design.split('### 2.5')[1]?.split('### 2.6')[0] ?? '';
  const ids = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*`([a-z0-9_]+)`/);
    if (m) ids.push(m[1]);
  }
  return new Set(ids);
}
const DESIGN_CARD_IDS = designCardIds();

function designNpcIds() {
  const line = design.split('\n').find((l) => l.startsWith('NPC（')) ?? '';
  return new Set([...line.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]).filter((id) => id !== 'npcs.json'));
}
const DESIGN_NPC_IDS = designNpcIds();

if (DESIGN_CHAR_IDS.size !== 48) err('docs/DESIGN.md', `parsed ${DESIGN_CHAR_IDS.size} character ids (expected 48)`);
if (DESIGN_CARD_IDS.size !== 14) err('docs/DESIGN.md', `parsed ${DESIGN_CARD_IDS.size} card ids (expected 14)`);
if (DESIGN_NPC_IDS.size !== 8) err('docs/DESIGN.md', `parsed ${DESIGN_NPC_IDS.size} NPC ids (expected 8)`);

// ---------------------------------------------------------------- load JSON
const KNOWN = ['cities.json', 'realms.json', 'warp.json', 'board.json', 'characters.json', 'events.json', 'cards.json', 'npcs.json', 'emotes.json'];
const data = {};
let jsonFiles = [];
try {
  jsonFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
} catch (e) {
  err('src/data', `cannot read directory: ${e.message}`);
}
for (const file of jsonFiles) {
  const path = join(DATA_DIR, file);
  if (!KNOWN.includes(file)) {
    warn(`src/data/${file}`, 'unrecognised data file (not validated)');
    continue;
  }
  try {
    data[file] = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    err(`src/data/${file}`, `invalid JSON: ${e.message}`);
  }
}
for (const file of KNOWN) {
  if (!jsonFiles.includes(file)) warn(`src/data/${file}`, 'missing (warning only)');
}

const cities = Array.isArray(data['cities.json']) ? data['cities.json'] : null;
const cityIds = new Set();
if (cities) for (const c of cities) if (isObj(c) && isStr(c.id)) cityIds.add(c.id);

// ---------------------------------------------------------------- cities
if (data['cities.json'] !== undefined) {
  if (!Array.isArray(data['cities.json'])) {
    err('cities.json', 'must be an array of City');
  } else {
    if (cities.length !== 372) err('cities.json', `expected exactly 372 cities, got ${cities.length}`);
    const seenIds = new Set();
    const seenPropertyIds = new Set();
    const seenLandmarks = new Map();
    const regionCounts = {};
    let tier1 = 0;

    cities.forEach((c, ci) => {
      const p = `cities[${ci}]`;
      if (!isObj(c)) { err(p, 'must be an object'); return; }
      if (!isStr(c.id)) err(`${p}.id`, 'must be a non-empty string');
      else {
        if (!KEBAB.test(c.id)) err(`${p}.id`, `must be kebab-case ascii, got "${c.id}"`);
        if (seenIds.has(c.id)) err(`${p}.id`, `duplicate city id "${c.id}"`);
        seenIds.add(c.id);
      }
      for (const key of ['nameJa', 'nameEn', 'countryJa', 'blurb']) {
        if (!isStr(c[key])) err(`${p}.${key}`, 'must be a non-empty string');
      }
      validateNameKana(c, p);
      if (isStr(c.blurb) && c.blurb.includes('\n')) err(`${p}.blurb`, 'must be one line');
      if (!isStr(c.country) || !/^[A-Z]{2}$/.test(c.country)) err(`${p}.country`, 'must be ISO 3166-1 alpha-2 uppercase');
      if (!oneOf(c.region, REGIONS)) err(`${p}.region`, `invalid region "${c.region}"`);
      else regionCounts[c.region] = (regionCounts[c.region] || 0) + 1;
      if (!isNum(c.lat) || c.lat < -56 || c.lat > 80) err(`${p}.lat`, 'must be a finite number in [-56, 80]');
      if (!isNum(c.lon) || c.lon < -180 || c.lon > 180) err(`${p}.lon`, 'must be a finite number in [-180, 180]');
      if (isNum(c.lat) && Math.abs(c.lat * 100 - Math.round(c.lat * 100)) > 1e-6) err(`${p}.lat`, 'must have at most 2 decimals');
      if (isNum(c.lon) && Math.abs(c.lon * 100 - Math.round(c.lon * 100)) > 1e-6) err(`${p}.lon`, 'must have at most 2 decimals');
      if (![1, 2, 3].includes(c.tier)) err(`${p}.tier`, 'must be 1, 2 or 3');
      if (c.tier === 1) tier1++;
      if (typeof c.port !== 'boolean') err(`${p}.port`, 'must be boolean');
      if (typeof c.airport !== 'boolean') err(`${p}.airport`, 'must be boolean');

      if (c.landmark !== undefined) {
        if (!isStr(c.landmark)) err(`${p}.landmark`, 'must be a non-empty string when present');
        else if (!(c.landmark in LANDMARK_CITY)) err(`${p}.landmark`, `"${c.landmark}" is not an allowed landmark id`);
        else {
          if (seenLandmarks.has(c.landmark)) err(`${p}.landmark`, `duplicate landmark "${c.landmark}" (already on ${seenLandmarks.get(c.landmark)})`);
          seenLandmarks.set(c.landmark, isStr(c.id) ? c.id : p);
          if (!LANDMARK_CITY[c.landmark].includes(c.id)) {
            err(`${p}.landmark`, `"${c.landmark}" belongs on ${LANDMARK_CITY[c.landmark].join(' or ')}, not "${c.id}"`);
          }
        }
      }

      if (!Array.isArray(c.properties)) {
        err(`${p}.properties`, 'must be an array');
      } else {
        if (c.properties.length < 2 || c.properties.length > 6) {
          err(`${p}.properties`, `must have 2..6 properties, got ${c.properties.length}`);
        }
        const localNames = new Set();
        c.properties.forEach((pr, pi) => {
          const pp = `${p}.properties[${pi}]`;
          if (!isObj(pr)) { err(pp, 'must be an object'); return; }
          if (!isStr(pr.id)) err(`${pp}.id`, 'must be a non-empty string');
          else {
            if (!isStr(c.id) || pr.id !== `${c.id}-${pi + 1}`) {
              err(`${pp}.id`, `must be "${c.id}-${pi + 1}" (prefix + sequence)`);
            }
            if (seenPropertyIds.has(pr.id)) err(`${pp}.id`, `duplicate property id "${pr.id}"`);
            seenPropertyIds.add(pr.id);
          }
          if (!isStr(pr.name)) err(`${pp}.name`, 'must be a non-empty string');
          else {
            if (localNames.has(pr.name)) warn(`${pp}.name`, `duplicate property name "${pr.name}" in this city`);
            localNames.add(pr.name);
          }
          if (!oneOf(pr.industry, INDUSTRIES)) err(`${pp}.industry`, `invalid industry "${pr.industry}"`);
          if (!isNum(pr.price) || pr.price <= 0) err(`${pp}.price`, 'must be a positive number');
          if (!isNum(pr.yieldPct) || pr.yieldPct <= 0 || pr.yieldPct > 100) err(`${pp}.yieldPct`, 'must be in (0, 100]');
          // Soft balance check documented in docs/CONTENT.md.
          if (isNum(pr.price) && isNum(pr.yieldPct)) {
            if (pr.industry === 'agri' || pr.industry === 'food') {
              if (pr.price > 30 || pr.price < 1 || pr.yieldPct < 30 || pr.yieldPct > 80) {
                warn(`${pp}`, 'agri/food normally 1..30億, yield 30..80%');
              }
            } else if (['finance', 'tech', 'energy'].includes(pr.industry)) {
              if (pr.price < 200 || pr.price > 3000 || pr.yieldPct < 2 || pr.yieldPct > 10) {
                warn(`${pp}`, 'finance/tech/energy normally 200..3000億, yield 2..10%');
              }
            } else if (pr.price < 20 || pr.price > 300 || pr.yieldPct < 8 || pr.yieldPct > 25) {
              warn(`${pp}`, 'tourism/industry/shipping/media normally 20..300億, yield 8..25%');
            }
          }
        });
      }
    });

    for (const region of REGIONS) {
      if (!regionCounts[region]) err('cities.json', `region "${region}" is not represented`);
    }
    if ((regionCounts.africa || 0) < 30) warn('cities.json', `Africa should have ~30 cities, got ${regionCounts.africa || 0}`);
    if ((regionCounts.south_america || 0) < 18) warn('cities.json', `South America should have ~18 cities, got ${regionCounts.south_america || 0}`);
    if ((regionCounts.oceania || 0) < 10) warn('cities.json', `Oceania should have ~10 cities, got ${regionCounts.oceania || 0}`);
    if ((regionCounts.europe || 0) < 58) warn('cities.json', `Europe should have ~60 cities, got ${regionCounts.europe || 0}`);
    if ((regionCounts.north_america || 0) < 32) warn('cities.json', `USA/Canada should have ~35 cities, got ${regionCounts.north_america || 0}`);
    if ((regionCounts.southeast_asia || 0) < 18) warn('cities.json', `SE Asia should have ~20 cities, got ${regionCounts.southeast_asia || 0}`);
    const japan = cities.filter((c) => c.country === 'JP').length;
    if (japan < 20 || japan > 30) warn('cities.json', `Japan should have ~25 cities, got ${japan}`);
    const india = cities.filter((c) => c.country === 'IN').length;
    if (india < 10 || india > 14) warn('cities.json', `India should have ~12 cities, got ${india}`);
    const china = cities.filter((c) => c.country === 'CN').length;
    if (china < 18 || china > 26) warn('cities.json', `China should have ~20 cities, got ${china}`);
    if (tier1 < 30 || tier1 > 40) warn('cities.json', `tier 1 should be ~35 cities, got ${tier1}`);
    for (const landmark of Object.keys(LANDMARK_CITY)) {
      if (!seenLandmarks.has(landmark)) warn('cities.json', `landmark "${landmark}" is not used`);
    }
  }
}

// ---------------------------------------------------------------- warp.json
if (data['warp.json'] !== undefined) {
  const w = data['warp.json'];
  if (!isObj(w) || w.w !== MAP_W || w.h !== MAP_H) err('warp.json', `expected w=${MAP_W}, h=${MAP_H}`);
  if (!isInt(w.cols) || !isInt(w.rows) || w.cols < 2 || w.rows < 2) err('warp.json', 'cols/rows must be integers >= 2');
  const n = w.cols * w.rows;
  for (const key of ['dx', 'dy']) {
    if (!Array.isArray(w[key]) || w[key].length !== n) err('warp.json', `${key} must have ${n} entries`);
    else if (w[key].some((v) => !isNum(v))) err('warp.json', `${key} must contain finite numbers`);
  }
}

// ---------------------------------------------------------------- realms.json
const realmCities = [];
if (data['realms.json'] !== undefined) {
  if (!Array.isArray(data['realms.json'])) {
    err('realms.json', 'must be an array of realm City objects');
  } else {
    const perRealm = {};
    for (const [i, c] of data['realms.json'].entries()) {
      const p = `realms[${i}]`;
      if (!isObj(c)) { err(p, 'must be an object'); continue; }
      if (!isStr(c.id)) err(`${p}.id`, 'must be a non-empty string');
      else {
        if (!KEBAB.test(c.id)) err(`${p}.id`, `must be kebab-case ascii, got "${c.id}"`);
        if (cityIds.has(c.id)) err(`${p}.id`, `duplicate city id "${c.id}" (already in cities.json)`);
        cityIds.add(c.id);
        realmCities.push(c);
      }
      if (!oneOf(c.realm, REALM_IDS)) err(`${p}.realm`, `invalid realm "${c.realm}"`);
      else perRealm[c.realm] = (perRealm[c.realm] || 0) + 1;
      for (const key of ['nameJa', 'nameEn', 'countryJa', 'blurb']) {
        if (!isStr(c[key])) err(`${p}.${key}`, 'must be a non-empty string');
      }
      validateNameKana(c, p);
      if (isStr(c.blurb) && c.blurb.includes('\n')) err(`${p}.blurb`, 'must be one line');
      if (!isStr(c.country) || !/^[A-Z]{2}$/.test(c.country)) err(`${p}.country`, 'must be 2 uppercase letters');
      if (!oneOf(c.region, REGIONS)) err(`${p}.region`, `invalid region "${c.region}"`);
      if (![1, 2, 3].includes(c.tier)) err(`${p}.tier`, 'must be 1, 2 or 3');
      if (c.lat !== 0 || c.lon !== 0) err(p, 'realm stations must have lat=0, lon=0');
      if (c.landmark !== undefined) err(`${p}.landmark`, 'realm stations cannot have landmarks');
      if (c.port === true || c.airport === true) warn(p, 'realm stations normally have port=false, airport=false');
      if (!Array.isArray(c.properties) || c.properties.length < 2 || c.properties.length > 4) {
        err(`${p}.properties`, `must have 2..4 properties, got ${Array.isArray(c.properties) ? c.properties.length : 'none'}`);
      } else {
        for (const [pi, pr] of c.properties.entries()) {
          const pp = `${p}.properties[${pi}]`;
          if (!isObj(pr)) { err(pp, 'must be an object'); continue; }
          if (!isStr(pr.id) || pr.id !== `${c.id}-${pi + 1}`) err(`${pp}.id`, `must be "${c.id}-${pi + 1}"`);
          if (!isStr(pr.name)) err(`${pp}.name`, 'must be a non-empty string');
          if (!oneOf(pr.industry, INDUSTRIES)) err(`${pp}.industry`, `invalid industry "${pr.industry}"`);
          if (!isNum(pr.price) || pr.price <= 0) err(`${pp}.price`, 'must be a positive number');
          if (!isNum(pr.yieldPct) || pr.yieldPct <= 0 || pr.yieldPct > 100) err(`${pp}.yieldPct`, 'must be in (0, 100]');
        }
      }
    }
    for (const realm of REALM_IDS) if ((perRealm[realm] || 0) !== 8) err('realms.json', `${realm} must have exactly 8 stations, got ${perRealm[realm] || 0}`);
  }
}

// ---------------------------------------------------------------- board
const boardNodeById = new Map();
if (data['board.json'] !== undefined) {
  const b = data['board.json'];
  if (!isObj(b) || !Array.isArray(b.nodes) || !Array.isArray(b.edges)) {
    err('board.json', 'must be { nodes: BoardNode[], edges: BoardEdge[] }');
  } else {
    const nodeIds = new Set();
    const cityNodeIds = new Map();
    const cityNodeCount = new Map();
    const nodeById = new Map();
    const squareNodes = [];
    b.nodes.forEach((n, i) => {
      const p = `board.nodes[${i}]`;
      if (!isObj(n)) { err(p, 'must be an object'); return; }
      if (!isStr(n.id)) { err(`${p}.id`, 'must be a non-empty string'); return; }
      if (nodeIds.has(n.id)) err(`${p}.id`, `duplicate node id "${n.id}"`);
      nodeIds.add(n.id);
      nodeById.set(n.id, n);
      if (n.realm !== undefined && !oneOf(n.realm, REALM_IDS)) err(`${p}.realm`, `invalid realm "${n.realm}"`);
      const coordW = n.realm ? REALM_W : MAP_W;
      const coordH = n.realm ? REALM_H : MAP_H;
      if (!isNum(n.x) || n.x < 0 || n.x > coordW) err(`${p}.x`, `must be in [0, ${coordW}]`);
      if (!isNum(n.y) || n.y < 0 || n.y > coordH) err(`${p}.y`, `must be in [0, ${coordH}]`);
      if (isNum(n.x) && Math.abs(n.x * 10 - Math.round(n.x * 10)) > 1e-6) err(`${p}.x`, 'must be rounded to 0.1');
      if (isNum(n.y) && Math.abs(n.y * 10 - Math.round(n.y * 10)) > 1e-6) err(`${p}.y`, 'must be rounded to 0.1');
      if (n.kind === 'city') {
        if (!isStr(n.cityId)) err(`${p}.cityId`, 'city node requires cityId');
        else {
          if (cityIds.size && !cityIds.has(n.cityId)) err(`${p}.cityId`, `unknown city "${n.cityId}"`);
          if (n.id !== `c:${n.cityId}`) err(`${p}.id`, `city node id must be "c:${n.cityId}"`);
          cityNodeCount.set(n.cityId, (cityNodeCount.get(n.cityId) || 0) + 1);
          cityNodeIds.set(n.id, n.cityId);
        }
      } else if (oneOf(n.kind, SQUARE_KINDS)) {
        if (n.cityId !== undefined) err(`${p}.cityId`, 'square nodes must not have cityId');
        if (n.realm) {
          if (!new RegExp(`^r:${n.realm}:\\d+$`).test(n.id)) err(`${p}.id`, `realm square id must be "r:${n.realm}:<n>"`);
        } else if (!/^s:\d+$/.test(n.id)) {
          err(`${p}.id`, 'square node id must be "s:<n>"');
        }
        squareNodes.push(n);
      } else {
        err(`${p}.kind`, `invalid node kind "${n.kind}"`);
      }
    });
    if (cityIds.size) {
      for (const id of cityIds) {
        const count = cityNodeCount.get(id) || 0;
        if (count !== 1) err('board.json', `city "${id}" must have exactly one node, got ${count}`);
      }
      for (const id of cityNodeCount.keys()) {
        if (!cityIds.has(id)) err('board.json', `board has node for unknown city "${id}"`);
      }
    }
    const worldNodes = b.nodes.filter((n) => n.realm === undefined);
    const worldNodeCount = worldNodes.length;
    if (worldNodeCount < 800) err('board.json', `too few world nodes: ${worldNodeCount}`);
    else if (worldNodeCount < 2600 || worldNodeCount > 3200) {
      warn('board.json', `world nodes ${worldNodeCount} outside the 2600-3200 target (spacing-constrained)`);
    }
    const mixCounts = { blue: 0, red: 0, yellow: 0, news: 0, shop: 0, warp: 0 };
    for (const n of worldNodes) if (n.kind in mixCounts) mixCounts[n.kind]++;
    const mixDenom = Object.values(mixCounts).reduce((a, b) => a + b, 0);
    // 36/17/15/14/4/2 sums to 88; compare the six non-city kinds after normalising.
    const mixTargets = { blue: 36 / 0.88, red: 17 / 0.88, yellow: 15 / 0.88, news: 14 / 0.88, shop: 4 / 0.88, warp: 2 / 0.88 };
    for (const [kind, targetPct] of Object.entries(mixTargets)) {
      const actualPct = mixDenom ? (100 * mixCounts[kind]) / mixDenom : 0;
      if (Math.abs(actualPct - targetPct) > 3) {
        err('board.json', `square mix ${kind}: ${actualPct.toFixed(1)}% (normalised target ${targetPct.toFixed(1)}% ±3)`);
      }
    }

// 60-unit spacing: squares must never sit within 60 of any node; only
    // station-to-station pairs may be closer when islands/labels force it.
    const spacingWrapDx = (ax, bx) => {
      let dx = bx - ax;
      if (dx > MAP_W / 2) dx -= MAP_W;
      if (dx <= -MAP_W / 2) dx += MAP_W;
      return dx;
    };
    const closeStations = [];
    for (let i = 0; i < worldNodes.length; i++) {
      for (let j = i + 1; j < worldNodes.length; j++) {
        const a = worldNodes[i], b2 = worldNodes[j];
        const d = Math.hypot(spacingWrapDx(a.x, b2.x), a.y - b2.y);
        if (d >= 60) continue;
        if (a.kind !== 'city' || b2.kind !== 'city') {
          err('board.json', 'node spacing ' + d.toFixed(1) + ' < 60: ' + a.id + ' (' + a.kind + ') - ' + b2.id + ' (' + b2.kind + ')');
        } else {
          closeStations.push([d, a.cityId || a.id, b2.cityId || b2.id]);
        }
      }
    }
    if (closeStations.length) {
      closeStations.sort((a, b2) => a[0] - b2[0]);
      const listed = closeStations.slice(0, 12).map(([d, a, b2]) => a + '-' + b2 + ' ' + d.toFixed(1)).join(', ');
      warn('board.json', closeStations.length + ' unavoidable land-locked station pairs < 60: ' + listed + (closeStations.length > 12 ? ', ...' : ''));
    }

    const adj = new Map();
    for (const id of nodeIds) adj.set(id, []);
    const edgeKeys = new Set();
    b.edges.forEach((e, i) => {
      const p = `board.edges[${i}]`;
      if (!isObj(e)) { err(p, 'must be an object'); return; }
      if (!nodeById.has(e.a)) err(`${p}.a`, `unknown node "${e.a}"`);
      if (!nodeById.has(e.b)) err(`${p}.b`, `unknown node "${e.b}"`);
      if (e.a === e.b) err(p, 'self-loop edge');
      if (!oneOf(e.mode, EDGE_MODES)) err(`${p}.mode`, `invalid mode "${e.mode}"`);
      if (nodeById.has(e.a) && nodeById.has(e.b)) {
        const na = nodeById.get(e.a), nb = nodeById.get(e.b);
        if ((na.realm ?? null) !== (nb.realm ?? null)) err(p, 'edge must not cross realm boundaries');
        const key = [e.a, e.b].sort().join('|');
        if (edgeKeys.has(key)) err(p, `duplicate edge ${e.a} <-> ${e.b}`);
        edgeKeys.add(key);
        adj.get(e.a).push(e.b);
        adj.get(e.b).push(e.a);
      }
    });
    // Air routes: endpoints must be airport cities or intermediate squares.
    // Air squares are fly-over nodes; they may only join air edges and must not
    // sit on another route's line (they may cross over, not share the line).
    const airportById = new Map((cities || []).map((c) => [c.id, c.airport === true]));
    const airSquares = new Set();
    for (const e of b.edges) {
      if (e.mode !== 'air') continue;
      for (const nodeId of [e.a, e.b]) {
        const n = nodeById.get(nodeId);
        if (!n) continue;
        if (n.realm) err('board.json', `air edge ${e.a} - ${e.b} must stay on the world map`);
        if (n.kind === 'city' && n.cityId && airportById.get(n.cityId) !== true) {
          err('board.json', `air edge ${e.a} - ${e.b} has non-airport city ${n.cityId}`);
        }
        if (n.kind !== 'city') airSquares.add(n);
      }
    }
    const pointSegmentDistance = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      if (l2 === 0) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax) * dx + (py - ay) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    };
    for (const square of airSquares) {
      for (const nb of adj.get(square.id) || []) {
        const edge = b.edges.find((e) =>
          (e.a === square.id && e.b === nb) || (e.b === square.id && e.a === nb),
        );
        if (edge && edge.mode !== 'air') {
          err('board.json', `air square ${square.id} is attached to non-air edge ${edge.a}-${edge.b}`);
        }
      }
      for (const e of b.edges) {
        if (e.a === square.id || e.b === square.id) continue;
        const p = nodeById.get(e.a), q = nodeById.get(e.b);
        if (!p || !q) continue;
        if (p.realm !== undefined || q.realm !== undefined) continue;
        const ax = p.x;
        const bx = ax + spacingWrapDx(p.x, q.x);
        let nearest = Infinity;
        for (const shift of [-MAP_W, 0, MAP_W]) {
          nearest = Math.min(nearest, pointSegmentDistance(square.x + shift, square.y, ax, p.y, bx, q.y));
        }
        if (nearest < 12) {
          err('board.json', `air square ${square.id} sits on another route line ${e.a}-${e.b} (${nearest.toFixed(1)})`);
        }
      }
    }
    // Every city should be reachable and not isolated.
    for (const [nodeId, cityId] of cityNodeIds) {
      if ((adj.get(nodeId) || []).length === 0) err('board.json', `city node ${cityId} is isolated`);
    }
    // News squares must not touch each other.
    for (const e of b.edges) {
      const na = nodeById.get(e.a), nb = nodeById.get(e.b);
      if (na?.kind === 'news' && nb?.kind === 'news') err('board.json', `two news squares are adjacent (${e.a} - ${e.b})`);
    }
    // Connectivity is per map: the world has no edges to the realms.
    if (nodeById.size) {
      const groups = new Map();
      for (const n of b.nodes) {
        const key = n.realm ?? 'world';
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(n.id);
      }
      for (const [key, ids] of groups) {
        const start = [...ids][0];
        const seen = new Set([start]);
        const queue = [start];
        for (let q = 0; q < queue.length; q++) {
          for (const nxt of adj.get(queue[q])) {
            if (ids.has(nxt) && !seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
          }
        }
        if (seen.size !== ids.size) {
          err('board.json', `${key} map is disconnected: ${ids.size - seen.size} of ${ids.size} nodes unreachable`);
        }
      }
    }
    const portalTargets = { heaven: 1, hell: 1, space: 2 };
    for (const realm of REALM_IDS) {
      const stations = b.nodes.filter((n) => n.realm === realm && n.kind === 'city').length;
      const portals = b.nodes.filter((n) => n.realm === realm && n.kind === 'portal').length;
      if (stations !== 8) err('board.json', `${realm} must have 8 station nodes, got ${stations}`);
      if (portals !== portalTargets[realm]) err('board.json', `${realm} must have ${portalTargets[realm]} portal(s), got ${portals}`);
    }
  }
}

// ---------------------------------------------------------------- land asset
const LAND_PATH = join(ROOT, 'public/assets/map/land.json');
if (!existsSync(LAND_PATH)) {
  warn('public/assets/map/land.json', 'missing (run npm run board)');
} else {
  const size = statSync(LAND_PATH).size;
  if (size > 900 * 1024) err('public/assets/map/land.json', `${(size / 1024).toFixed(1)} KB exceeds 900 KB`);
  try {
    const land = JSON.parse(readFileSync(LAND_PATH, 'utf8'));
    if (!isObj(land) || land.w !== MAP_W || land.h !== MAP_H) err('public/assets/map/land.json', `expected w=${MAP_W}, h=${MAP_H}`);
    if (!Array.isArray(land.polygons)) err('public/assets/map/land.json', 'polygons must be an array');
    else {
      land.polygons.forEach((poly, pi) => {
        if (!Array.isArray(poly) || poly.length === 0) { err(`land.polygons[${pi}]`, 'must be a non-empty array of rings'); return; }
        poly.forEach((ring, ri) => {
          const p = `land.polygons[${pi}][${ri}]`;
          if (!Array.isArray(ring) || ring.length < 8 || ring.length % 2 !== 0) {
            err(p, 'must be a flat even-length array of >= 4 points');
            return;
          }
          for (let i = 0; i < ring.length; i += 2) {
            const x = ring[i], y = ring[i + 1];
            if (!isNum(x) || !isNum(y)) { err(p, 'coordinates must be finite numbers'); break; }
            if (x < 0 || x > MAP_W || y < 0 || y > MAP_H) { err(p, `coordinate out of bounds (${x}, ${y})`); break; }
            if (i >= 2 && Math.abs(x - ring[i - 2]) > MAP_W / 2) { err(p, 'ring jumps across the map seam'); break; }
          }
          if (ring[0] !== ring[ring.length - 2] || ring[1] !== ring[ring.length - 1]) err(p, 'ring must be closed');
        });
      });
    }
  } catch (e) {
    err('public/assets/map/land.json', `invalid JSON: ${e.message}`);
  }
}

// ---------------------------------------------------------------- characters
let charIds = new Set(DESIGN_CHAR_IDS);
if (data['characters.json'] !== undefined) {
  const chars = data['characters.json'];
  if (!Array.isArray(chars)) {
    err('characters.json', 'must be an array of Character');
  } else {
    const ids = new Set();
    chars.forEach((c, i) => {
      const p = `characters[${i}]`;
      if (!isObj(c)) { err(p, 'must be an object'); return; }
      if (!isStr(c.id)) err(`${p}.id`, 'must be a non-empty string');
      else {
        if (!UNDERSCORE_ID.test(c.id)) err(`${p}.id`, `must be ascii slug, got "${c.id}"`);
        if (ids.has(c.id)) err(`${p}.id`, `duplicate character id "${c.id}"`);
        ids.add(c.id);
      }
      for (const key of ['nameJa', 'origin', 'originRegion', 'personality']) {
        if (!isStr(c[key])) err(`${p}.${key}`, 'must be a non-empty string');
      }
      if (!oneOf(c.role, ROLES)) err(`${p}.role`, `invalid role "${c.role}"`);
      if (!isStr(c.sprite)) err(`${p}.sprite`, 'must be a non-empty public-relative path');
      else {
        if (!c.sprite.startsWith('assets/')) err(`${p}.sprite`, 'must be public-relative starting with "assets/"');
        if (!existsSync(join(ROOT, 'public', c.sprite))) warn(`${p}.sprite`, `file not found: public/${c.sprite}`);
      }
      if (!isStr(c.color) || !COLOR.test(c.color)) err(`${p}.color`, 'must be #rrggbb');
      if (!oneOf(c.perk, PERKS)) err(`${p}.perk`, `invalid perk "${c.perk}"`);
      validateVoice(c.voice, `${p}.voice`);
      if (!isObj(c.lines)) err(`${p}.lines`, 'must be an object');
      else {
        for (const key of LINE_KEYS) {
          if (!isStr(c.lines[key])) err(`${p}.lines.${key}`, 'must be a non-empty string');
        }
        for (const key of Object.keys(c.lines)) {
          if (!LINE_KEYS.includes(key)) warn(`${p}.lines.${key}`, 'unknown line key');
        }
      }
    });
    if (chars.length !== 48) err('characters.json', `expected 48 characters, got ${chars.length}`);
    for (const id of DESIGN_CHAR_IDS) if (!ids.has(id)) err('characters.json', `missing character id "${id}" from DESIGN.md §7`);
    for (const id of ids) if (!DESIGN_CHAR_IDS.has(id)) err('characters.json', `unknown character id "${id}" (not in DESIGN.md §7)`);
    charIds = ids;
  }
}

// ---------------------------------------------------------------- npcs
let npcIds = new Set([...DESIGN_NPC_IDS, 'narrator']);
if (data['npcs.json'] !== undefined) {
  const npcs = data['npcs.json'];
  if (!Array.isArray(npcs)) {
    err('npcs.json', 'must be an array of NpcDef');
  } else {
    const ids = new Set();
    npcs.forEach((n, i) => {
      const p = `npcs[${i}]`;
      if (!isObj(n)) { err(p, 'must be an object'); return; }
      if (!isStr(n.id)) err(`${p}.id`, 'must be a non-empty string');
      else {
        if (ids.has(n.id)) err(`${p}.id`, `duplicate npc id "${n.id}"`);
        ids.add(n.id);
        if (!DESIGN_NPC_IDS.has(n.id) && n.id !== 'narrator') err(`${p}.id`, `"${n.id}" is not a DESIGN.md NPC id`);
      }
      if (!isStr(n.nameJa)) err(`${p}.nameJa`, 'must be a non-empty string');
      if (n.sprite !== undefined) {
        if (!isStr(n.sprite) || !n.sprite.startsWith('assets/')) err(`${p}.sprite`, 'must be a public-relative path');
        else if (!existsSync(join(ROOT, 'public', n.sprite))) warn(`${p}.sprite`, `file not found: public/${n.sprite}`);
      }
      validateVoice(n.voice, `${p}.voice`);
    });
    for (const id of DESIGN_NPC_IDS) if (!ids.has(id)) err('npcs.json', `missing NPC "${id}" from DESIGN.md §7`);
    if (!ids.has('narrator')) warn('npcs.json', 'narrator entry is missing (narrator lines will be silent)');
    npcIds = ids;
  }
}

// ---------------------------------------------------------------- cards
let cardIds = new Set(DESIGN_CARD_IDS);
if (data['cards.json'] !== undefined) {
  const cards = data['cards.json'];
  if (!Array.isArray(cards)) {
    err('cards.json', 'must be an array of CardDef');
  } else {
    const ids = new Set();
    cards.forEach((c, i) => {
      const p = `cards[${i}]`;
      if (!isObj(c)) { err(p, 'must be an object'); return; }
      if (!isStr(c.id)) err(`${p}.id`, 'must be a non-empty string');
      else {
        if (ids.has(c.id)) err(`${p}.id`, `duplicate card id "${c.id}"`);
        ids.add(c.id);
        if (!DESIGN_CARD_IDS.has(c.id)) err(`${p}.id`, `"${c.id}" is not a DESIGN.md §2.5 card id`);
      }
      for (const key of ['name', 'desc']) if (!isStr(c[key])) err(`${p}.${key}`, 'must be a non-empty string');
      if (!oneOf(c.kind, CARD_KINDS)) err(`${p}.kind`, `invalid card kind "${c.kind}"`);
      if (!isNum(c.weight) || c.weight <= 0) err(`${p}.weight`, 'must be a positive number');
      if (!isNum(c.price) || c.price <= 0) err(`${p}.price`, 'must be a positive number');
      if (c.needsTarget !== undefined && !['player', 'city', 'airport'].includes(c.needsTarget)) {
        err(`${p}.needsTarget`, 'must be player, city or airport');
      }
    });
    if (cards.length !== 14) err('cards.json', `expected 14 cards, got ${cards.length}`);
    for (const id of DESIGN_CARD_IDS) if (!ids.has(id)) err('cards.json', `missing card id "${id}" from DESIGN.md §2.5`);
    for (const id of ids) if (!DESIGN_CARD_IDS.has(id)) err('cards.json', `unknown card id "${id}"`);
    cardIds = ids;
  }
}

// ---------------------------------------------------------------- emotes
const EMOTE_ANIMS = ['jump', 'angry', 'cry', 'laugh', 'dance', 'taunt', 'dogeza', 'money_rain', 'flex', 'sleep', 'heart',
  'throw', 'hit', 'spotlight'];
const EMOTE_CATS = ['emotion', 'action', 'taunt', 'poke', 'unique'];
if (data['emotes.json'] !== undefined) {
  const emotes = data['emotes.json'];
  if (!Array.isArray(emotes)) {
    err('emotes.json', 'must be an array of EmoteDef');
  } else {
    const ids = new Set();
    const uniqueOwners = new Map();
    const checkLines = (obj, p, maxLen) => {
      if (!isObj(obj) || !isStr(obj.default)) { err(p, 'must be an object with a non-empty "default"'); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (k !== 'default' && !charIds.has(k)) err(`${p}.${k}`, `unknown character id "${k}"`);
        if (!isStr(v)) err(`${p}.${k}`, 'must be a non-empty string');
        else if (v.length > maxLen) warn(`${p}.${k}`, `line longer than ${maxLen} chars`);
      }
    };
    emotes.forEach((e, i) => {
      const p = `emotes[${i}]`;
      if (!isObj(e)) { err(p, 'must be an object'); return; }
      if (!isStr(e.id) || !UNDERSCORE_ID.test(e.id)) err(`${p}.id`, 'must be a snake_case id');
      else if (ids.has(e.id)) err(`${p}.id`, `duplicate emote id "${e.id}"`);
      else ids.add(e.id);
      if (!oneOf(e.category, EMOTE_CATS)) err(`${p}.category`, `invalid category "${e.category}"`);
      if (!oneOf(e.anim, EMOTE_ANIMS)) err(`${p}.anim`, `invalid anim "${e.anim}" (add it to MapView.playEmote first)`);
      for (const key of ['label', 'icon']) if (!isStr(e[key])) err(`${p}.${key}`, 'must be a non-empty string');
      if (!isNum(e.cooldownMs) || e.cooldownMs < 1000) err(`${p}.cooldownMs`, 'must be >= 1000');
      if (e.targeted !== (e.anim === 'throw')) err(`${p}.targeted`, 'targeted must be true exactly when anim is "throw"');
      if (e.targeted && !isStr(e.projectile)) err(`${p}.projectile`, 'targeted emotes need a projectile');
      if (e.targeted) checkLines(e.hitLines, `${p}.hitLines`, 22);
      checkLines(e.lines, `${p}.lines`, 28);
      if (e.category === 'unique') {
        if (!charIds.has(e.characterId)) err(`${p}.characterId`, `unknown owner "${e.characterId}"`);
        else if (uniqueOwners.has(e.characterId)) err(`${p}.characterId`, `second unique emote for "${e.characterId}"`);
        else uniqueOwners.set(e.characterId, e.id);
      } else if (e.characterId !== undefined) err(`${p}.characterId`, 'only unique emotes have an owner');
    });
    for (const id of charIds) if (!uniqueOwners.has(id)) warn('emotes.json', `character "${id}" has no unique emote`);
  }
}

// ---------------------------------------------------------------- events
if (data['events.json'] !== undefined) {
  const events = data['events.json'];
  if (!Array.isArray(events)) {
    err('events.json', 'must be an array of GameEventDef');
  } else {
    const ids = new Set();
    events.forEach((ev, i) => {
      const p = `events[${i}]`;
      if (!isObj(ev)) { err(p, 'must be an object'); return; }
      if (!isStr(ev.id)) err(`${p}.id`, 'must be a non-empty string');
      else {
        if (!KEBAB.test(ev.id)) err(`${p}.id`, `must be kebab-case, got "${ev.id}"`);
        if (ids.has(ev.id)) err(`${p}.id`, `duplicate event id "${ev.id}"`);
        ids.add(ev.id);
      }
      if (!isStr(ev.title)) err(`${p}.title`, 'must be a non-empty string');
      if (!['news', 'history', 'fable'].includes(ev.kind)) err(`${p}.kind`, `invalid kind "${ev.kind}"`);
      if (!isStr(ev.satireNote)) err(`${p}.satireNote`, 'must be a non-empty string');
      if (!isNum(ev.weight) || ev.weight <= 0) err(`${p}.weight`, 'must be a positive number');
      if (ev.minYear !== undefined && (!isInt(ev.minYear) || ev.minYear < 1 || ev.minYear > 10)) {
        err(`${p}.minYear`, 'must be an integer 1..10');
      }
      if (ev.once !== undefined && typeof ev.once !== 'boolean') err(`${p}.once`, 'must be boolean');
      if (ev.monthly !== undefined && typeof ev.monthly !== 'boolean') err(`${p}.monthly`, 'must be boolean');
      if (ev.realms !== undefined) {
        if (!Array.isArray(ev.realms) || ev.realms.length === 0) err(`${p}.realms`, 'must be a non-empty array when present');
        else for (const [ri, r] of ev.realms.entries()) {
          if (!oneOf(r, REALM_OR_WORLD)) err(`${p}.realms[${ri}]`, `invalid realm "${r}"`);
        }
      }
      if (ev.months !== undefined) {
        if (!Array.isArray(ev.months) || ev.months.length === 0) err(`${p}.months`, 'must be a non-empty array when present');
        else for (const [mi, m] of ev.months.entries()) {
          if (!isInt(m) || m < 1 || m > 12) err(`${p}.months[${mi}]`, 'must be an integer 1..12');
        }
      }
      if (ev.image !== undefined && !isStr(ev.image)) err(`${p}.image`, 'must be a public-relative path');

      if (ev.kind === 'news' || ev.kind === 'history') {
        if (!isStr(ev.fact)) err(`${p}.fact`, 'required for news/history');
        if (!Array.isArray(ev.sources) || ev.sources.length === 0) err(`${p}.sources`, 'required for news/history');
      }
      if (Array.isArray(ev.sources)) {
        ev.sources.forEach((s, si) => {
          const sp = `${p}.sources[${si}]`;
          if (!isObj(s)) { err(sp, 'must be an object'); return; }
          if (!isStr(s.title)) err(`${sp}.title`, 'must be a non-empty string');
          if (!isStr(s.url)) err(`${sp}.url`, 'must be a non-empty string');
          else if (!/^https?:\/\//.test(s.url)) warn(`${sp}.url`, 'should be an http(s) URL');
          if (s.date !== undefined && !isStr(s.date)) err(`${sp}.date`, 'must be a string');
        });
      }

      const validateLines = (lines, lp) => {
        if (!Array.isArray(lines) || lines.length === 0) { err(lp, 'must be a non-empty array'); return; }
        lines.forEach((line, li) => {
          const lpp = `${lp}[${li}]`;
          if (!isObj(line)) { err(lpp, 'must be an object'); return; }
          validateSpeaker(line.speaker, `${lpp}.speaker`);
          if (!isStr(line.text)) err(`${lpp}.text`, 'must be a non-empty string');
        });
      };
      validateLines(ev.lines, `${p}.lines`);

      if (ev.choices !== undefined) {
        if (!Array.isArray(ev.choices) || ev.choices.length === 0) err(`${p}.choices`, 'must be a non-empty array when present');
        else {
          ev.choices.forEach((ch, ci) => {
            const cp = `${p}.choices[${ci}]`;
            if (!isObj(ch)) { err(cp, 'must be an object'); return; }
            if (!isStr(ch.label)) err(`${cp}.label`, 'must be a non-empty string');
            if (!isStr(ch.detail)) err(`${cp}.detail`, 'must be a non-empty string');
            if (!Array.isArray(ch.effects) || ch.effects.length === 0) err(`${cp}.effects`, 'must be a non-empty array');
            else ch.effects.forEach((ef, ei) => validateEffect(ef, `${cp}.effects[${ei}]`));
            if (ch.reply !== undefined) validateLines(ch.reply, `${cp}.reply`);
            if (ch.cpuWeight !== undefined && (!isNum(ch.cpuWeight) || ch.cpuWeight < 0)) err(`${cp}.cpuWeight`, 'must be a non-negative number');
          });
        }
      }
      if (ev.effects !== undefined) {
        if (!Array.isArray(ev.effects)) err(`${p}.effects`, 'must be an array');
        else ev.effects.forEach((ef, ei) => validateEffect(ef, `${p}.effects[${ei}]`));
      }
      if (ev.choices === undefined && ev.effects === undefined) err(p, 'must have choices or effects');
    });
  }
}

// ---------------------------------------------------------------- effect / speaker validators
function validateVoice(v, p) {
  if (!isObj(v)) { err(p, 'must be an object'); return; }
  if (!isInt(v.speaker)) err(`${p}.speaker`, 'must be an integer VOICEVOX style id');
  if (!isNum(v.speed) || v.speed <= 0) err(`${p}.speed`, 'must be a positive number');
  if (!isNum(v.pitch)) err(`${p}.pitch`, 'must be a number');
  if (!isNum(v.intonation) || v.intonation <= 0) err(`${p}.intonation`, 'must be a positive number');
}

function validateSpeaker(sp, p) {
  if (sp === 'narrator') return;
  if (sp === 'self') { err(p, '"self" is not allowed in events (use Fx say + lineKey)'); return; }
  if (!isStr(sp)) { err(p, 'must be narrator, char:<id> or npc:<id>'); return; }
  if (sp.startsWith('char:')) {
    const id = sp.slice(5);
    if (!charIds.has(id)) err(p, `unknown character "${id}"`);
    return;
  }
  if (sp.startsWith('npc:')) {
    const id = sp.slice(4);
    if (!npcIds.has(id)) err(p, `unknown NPC "${id}"`);
    return;
  }
  err(p, `invalid speaker reference "${sp}"`);
}

function validateEffect(ef, p, depth = 0) {
  if (depth > 8) { err(p, 'effect nesting is too deep'); return; }
  if (!isObj(ef)) { err(p, 'must be an object'); return; }
  if (!EFFECT_OPS.includes(ef.op)) { err(`${p}.op`, `invalid effect op "${ef.op}"`); return; }
  const who = (wp) => {
    if (!oneOf(ef.who, WHO)) err(wp, `invalid who "${ef.who}"`);
  };
  const industry = (ip, allowAny = false) => {
    if (allowAny && ef.industry === 'any') return;
    if (!oneOf(ef.industry, INDUSTRIES)) err(ip, `invalid industry "${ef.industry}"`);
  };
  switch (ef.op) {
    case 'cash':
      who(`${p}.who`);
      if (!isNum(ef.amount)) err(`${p}.amount`, 'must be a number');
      if (ef.scale !== undefined && typeof ef.scale !== 'boolean') err(`${p}.scale`, 'must be boolean');
      break;
    case 'cash_pct':
      who(`${p}.who`);
      if (!isNum(ef.pct)) err(`${p}.pct`, 'must be a number');
      break;
    case 'per_property':
      who(`${p}.who`);
      industry(`${p}.industry`, true);
      if (!isNum(ef.perProperty)) err(`${p}.perProperty`, 'must be a number');
      if (ef.scale !== undefined && typeof ef.scale !== 'boolean') err(`${p}.scale`, 'must be boolean');
      break;
    case 'industry_mod':
      industry(`${p}.industry`);
      if (!isNum(ef.mult) || ef.mult <= 0) err(`${p}.mult`, 'must be a positive number');
      if (!isInt(ef.years) || ef.years <= 0) err(`${p}.years`, 'must be a positive integer');
      if (!isStr(ef.label)) err(`${p}.label`, 'must be a non-empty string');
      break;
    case 'price_mod':
      industry(`${p}.industry`);
      if (!isNum(ef.mult) || ef.mult <= 0) err(`${p}.mult`, 'must be a positive number');
      break;
    case 'sell':
      who(`${p}.who`);
      industry(`${p}.industry`, true);
      if (!isInt(ef.count) || ef.count <= 0) err(`${p}.count`, 'must be a positive integer');
      if (!isNum(ef.priceMult) || ef.priceMult < 0) err(`${p}.priceMult`, 'must be >= 0');
      break;
    case 'card':
      who(`${p}.who`);
      if (!isStr(ef.card)) err(`${p}.card`, 'must be a card id');
      else if (!cardIds.has(ef.card)) err(`${p}.card`, `unknown card "${ef.card}"`);
      if (ef.count !== undefined && (!isInt(ef.count) || ef.count <= 0)) err(`${p}.count`, 'must be a positive integer');
      break;
    case 'move': {
      who(`${p}.who`);
      const special = ['destination_near', 'random_city', 'nearest_port'];
      if (!isStr(ef.to)) err(`${p}.to`, 'must be a city id or move keyword');
      else if (!special.includes(ef.to) && !cityIds.has(ef.to)) {
        if (cityIds.size) err(`${p}.to`, `unknown city "${ef.to}"`);
      }
      break;
    }
    case 'skip':
      who(`${p}.who`);
      if (!isInt(ef.turns) || ef.turns <= 0) err(`${p}.turns`, 'must be a positive integer');
      break;
    case 'piper':
      if (!oneOf(ef.to, WHO)) err(`${p}.to`, `invalid who "${ef.to}"`);
      break;
    case 'realm':
      who(`${p}.who`);
      if (!oneOf(ef.realm, REALM_OR_WORLD)) err(`${p}.realm`, `invalid realm "${ef.realm}"`);
      break;
    case 'gamble':
      if (!isNum(ef.chance) || ef.chance < 0 || ef.chance > 1) err(`${p}.chance`, 'must be in [0, 1]');
      if (!Array.isArray(ef.win)) err(`${p}.win`, 'must be an array');
      else ef.win.forEach((x, i) => validateEffect(x, `${p}.win[${i}]`, depth + 1));
      if (!Array.isArray(ef.lose)) err(`${p}.lose`, 'must be an array');
      else ef.lose.forEach((x, i) => validateEffect(x, `${p}.lose[${i}]`, depth + 1));
      break;
  }
}

// ---------------------------------------------------------------- report
if (warnings.length) {
  console.log(`warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  WARN ${w}`);
}
if (errors.length) {
  console.error(`errors (${errors.length}):`);
  for (const e of errors) console.error(`  ERR ${e}`);
  console.error(`\nvalidation failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`validation OK: ${jsonFiles.length} data file(s), ${warnings.length} warning(s)`);