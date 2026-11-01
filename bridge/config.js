// Loads and checks the room config file. Exits with a clear message on any
// problem, so the bridge never starts with a broken patch.
//
// Channel numbers in the file are 1-based, as in the fixture manuals.

const fs = require('fs');
const path = require('path');

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
  cfg.map = cfg.map || {};
  cfg.map.shapes = cfg.map.shapes || [];
  cfg.map.lights = cfg.map.lights || {};
  return cfg;
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
  return p;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

module.exports = { loadConfig };
