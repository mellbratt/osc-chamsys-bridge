// Loads and checks the room config file. Exits with a clear message on any
// problem, so the bridge never starts with a broken patch.
//
// Channel numbers in the file are 1-based, as in the fixture manuals.

const fs = require('fs');
const path = require('path');

const SYMBOLS = ['circle', 'square', 'triangle', 'diamond'];
// Words OSC already uses for sets of lights, so a model's group can't be one.
const OSC_WORDS = ['all', 'mine', 'moving'];
const OSC_DEFAULTS = { port: 8000, replyPort: 9000 };

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    const example = path.join(__dirname, '..', 'config.example.json');
    fail(`No config file at ${file}.\nCopy ${example} to config.json in the repo root and edit it for your room.`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`Could not read ${file}: ${err.message}`);
  }
  const problems = check(cfg);
  if (problems.length) fail(`Problems in ${file}:\n- ${problems.join('\n- ')}`);
  cfg.map = normalizeMap(cfg.map);
  cfg.osc = { ...OSC_DEFAULTS, ...cfg.osc };
  const names = new Set(cfg.lights.map((l) => l.name));
  for (const name of Object.keys(cfg.map.lights)) {
    if (!names.has(name)) console.warn(`Note: the map has a position for "${name}", which isn't in lights. It is ignored.`);
  }
  return cfg;
}

// ---------- Map ----------
// The map is a top-down plan in metres: x to the right, y down the page.
// Light facing is in degrees clockwise from the top of the map.

const DEFAULT_SIZE = { width: 20, height: 12 };

function normalizeMap(map) {
  map = map || {};
  return {
    width: map.width ?? DEFAULT_SIZE.width,
    height: map.height ?? DEFAULT_SIZE.height,
    shapes: map.shapes || [],
    lights: map.lights || {},
  };
}

function checkMap(map) {
  const p = [];
  const num = (n) => typeof n === 'number' && Number.isFinite(n);
  if (!map || typeof map !== 'object') return ['map must be an object.'];
  for (const key of ['width', 'height']) {
    if (map[key] != null && !(num(map[key]) && map[key] > 0 && map[key] <= 1000)) p.push(`map.${key} must be a size in metres, from 0 to 1000.`);
  }
  if (map.shapes != null && !Array.isArray(map.shapes)) p.push('map.shapes must be a list.');
  for (const [i, sh] of (Array.isArray(map.shapes) ? map.shapes : []).entries()) {
    const keys = sh && sh.type === 'rect' ? ['x', 'y', 'w', 'h'] : sh && sh.type === 'line' ? ['x1', 'y1', 'x2', 'y2'] : null;
    if (!keys) { p.push(`map.shapes[${i}].type must be "rect" or "line".`); continue; }
    for (const k of keys) if (!num(sh[k])) p.push(`map.shapes[${i}].${k} must be a number.`);
  }
  if (map.lights != null && (typeof map.lights !== 'object' || Array.isArray(map.lights))) p.push('map.lights must be an object.');
  for (const [name, pos] of Object.entries(map.lights || {})) {
    if (!pos || !num(pos.x) || !num(pos.y) || !num(pos.facing ?? 0)) p.push(`map.lights["${name}"] needs numbers x, y and facing.`);
  }
  return p;
}

// Saves a new map into the config file and returns it. Re-reads the file so
// hand edits made while the bridge runs are kept; only "map" is replaced.
function saveMap(file, map, current) {
  const problems = checkMap(map);
  if (problems.length) throw new Error(problems.join(' '));
  map = normalizeMap(map);
  // Keep only what the map needs, and only for lights that exist.
  const names = new Set(current.lights.map((l) => l.name));
  map = {
    width: map.width,
    height: map.height,
    shapes: map.shapes.map((sh) => (sh.type === 'rect'
      ? { type: 'rect', x: sh.x, y: sh.y, w: sh.w, h: sh.h }
      : { type: 'line', x1: sh.x1, y1: sh.y1, x2: sh.x2, y2: sh.y2 })),
    lights: Object.fromEntries(Object.entries(map.lights)
      .filter(([name]) => names.has(name))
      .map(([name, pos]) => [name, { x: pos.x, y: pos.y, facing: pos.facing ?? 0 }])),
  };
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${file} to save the map: ${err.message}`);
  }
  onDisk.map = map;
  const tmp = `${file}.saving`;
  fs.writeFileSync(tmp, formatJson(onDisk) + '\n');
  fs.renameSync(tmp, file);
  return map;
}

// JSON with small objects and lists on one line, so the file stays easy to
// read and edit by hand (e.g. one line per light).
function formatJson(value, indent = '') {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v) => [null, v]) : Object.entries(value);
  if (!entries.length) return isArray ? '[]' : '{}';
  const flat = entries.every(([, v]) => v === null || typeof v !== 'object');
  const item = ([k, v], ind) => (k === null ? '' : `${JSON.stringify(k)}: `) + formatJson(v, ind);
  if (flat) {
    const line = entries.map((e) => item(e, '')).join(', ');
    const oneLine = isArray ? `[${line}]` : `{ ${line} }`;
    if (indent.length + oneLine.length <= 120) return oneLine;
  }
  const inner = indent + '  ';
  const body = entries.map((e) => inner + item(e, inner)).join(',\n');
  return isArray ? `[\n${body}\n${indent}]` : `{\n${body}\n${indent}}`;
}

function check(cfg) {
  const p = [];
  const isInt = (n) => Number.isInteger(n);

  const c = cfg.console;
  if (!c || typeof c.ip !== 'string' || !c.ip) p.push('console.ip must be the console\'s IP address, e.g. "10.0.0.10".');
  if (!c || !isInt(c.artnetUniverseForUniverse1) || c.artnetUniverseForUniverse1 < 0) {
    p.push('console.artnetUniverseForUniverse1 must be a whole number, usually 0.');
  }

  const models = cfg.models || {};
  if (!Object.keys(models).length) p.push('models is empty: add at least one light model.');
  for (const [key, m] of Object.entries(models)) {
    const where = `models.${key}`;
    if (!isInt(m.channelCount) || m.channelCount < 1 || m.channelCount > 512) {
      p.push(`${where}.channelCount must be a whole number from 1 to 512.`);
      continue;
    }
    const inRange = (n) => isInt(n) && n >= 1 && n <= m.channelCount;
    for (const [role, n] of Object.entries(m.channels || {})) {
      if (!inRange(n)) p.push(`${where}.channels.${role} is ${n}, must be from 1 to ${m.channelCount}.`);
    }
    for (const n of Object.keys(m.labels || {})) {
      if (!inRange(Number(n))) p.push(`${where}.labels has channel ${n}, must be from 1 to ${m.channelCount}.`);
    }
    for (const [n, v] of Object.entries(m.defaults || {})) {
      if (!inRange(Number(n))) p.push(`${where}.defaults has channel ${n}, must be from 1 to ${m.channelCount}.`);
      if (!isInt(v) || v < 0 || v > 255) p.push(`${where}.defaults channel ${n} is ${v}, must be from 0 to 255.`);
    }
    const ch = m.channels || {};
    if (ch.goboWheel != null && !m.gobo) p.push(`${where} has a goboWheel channel but no "gobo" settings.`);
    if (ch.goboRot != null && !m.goboRotation) p.push(`${where} has a goboRot channel but no "goboRotation" settings.`);
    for (const k of ['panDegrees', 'tiltDegrees']) {
      if (m[k] != null && !(typeof m[k] === 'number' && m[k] > 0 && m[k] <= 720)) p.push(`${where}.${k} must be a number of degrees, or null if unknown.`);
    }
    if (m.group != null && !(typeof m.group === 'string' && /^[a-z][a-z0-9-]*$/i.test(m.group) && !OSC_WORDS.includes(m.group.toLowerCase()))) {
      p.push(`${where}.group must be one word starting with a letter, e.g. "wash", and not ${OSC_WORDS.join(', ')}.`);
    }
    if (m.symbol != null && !SYMBOLS.includes(m.symbol)) p.push(`${where}.symbol must be one of ${SYMBOLS.join(', ')}.`);
    for (const k of ['cctRange', 'ctoRange']) {
      const r = m[k];
      if (r != null && !(Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'number' && x >= 1000 && x <= 20000) && r[0] < r[1])) {
        p.push(`${where}.${k} must be [lowest, highest] in kelvin, e.g. [2800, 10000].`);
      }
    }
  }

  const lights = cfg.lights || [];
  if (!Array.isArray(lights) || !lights.length) p.push('lights is empty: add at least one light.');
  const names = new Set();
  const used = new Map(); // "universe:channel" -> light name
  for (const [i, l] of (Array.isArray(lights) ? lights : []).entries()) {
    const where = `lights[${i}]${l && l.name ? ` (${l.name})` : ''}`;
    if (!l || typeof l.name !== 'string' || !l.name) { p.push(`${where} needs a name.`); continue; }
    if (names.has(l.name)) p.push(`${where}: the name "${l.name}" is used twice.`);
    names.add(l.name);
    const m = models[l.model];
    if (!m) { p.push(`${where}: unknown model "${l.model}".`); continue; }
    if (!isInt(l.universe) || l.universe < 1) { p.push(`${where}.universe must be a whole number from 1.`); continue; }
    if (!isInt(l.address) || l.address < 1 || l.address + m.channelCount - 1 > 512) {
      p.push(`${where}.address is ${l.address}; with ${m.channelCount} channels it must be from 1 to ${513 - m.channelCount}.`);
      continue;
    }
    if (l.mounting != null && l.mounting !== 'hanging' && l.mounting !== 'standing') {
      p.push(`${where}.mounting must be "hanging" or "standing".`);
    }
    for (let n = l.address; n < l.address + m.channelCount; n++) {
      const key = `${l.universe}:${n}`;
      if (used.has(key)) {
        p.push(`${where} overlaps ${used.get(key)} at ${l.universe}-${n}.`);
        break;
      }
      used.set(key, l.name);
    }
  }
  if (cfg.map != null) p.push(...checkMap(cfg.map));
  if (cfg.osc != null && (typeof cfg.osc !== 'object' || Array.isArray(cfg.osc))) p.push('osc must be an object, e.g. { "port": 8000, "replyPort": 9000 }.');
  for (const k of Object.keys(OSC_DEFAULTS)) {
    const v = cfg.osc && cfg.osc[k];
    if (v != null && !(isInt(v) && v >= 1 && v <= 65535)) p.push(`osc.${k} must be a port number from 1 to 65535.`);
  }
  return p;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

module.exports = { loadConfig, saveMap, formatJson };
