// The rig: which client controls which light, each light's settings, and the
// DMX values that come out of them.
//
// Rules (issue #10):
// - A light belongs to whoever takes it first. Others can't change it until
//   it's free.
// - A free light is dark and parked at its defaults.
// - A client with a soloed light: that light flashes, the client's other
//   lights go dark. Other clients' lights are left alone.
// - Ambient clients (in `ambient`) run the room between performances. They
//   only get lights nobody else wants: anyone else who takes one of their
//   lights gets it straight away.
//
// Settings use the same units as the page's controls:
//   pan, tilt 0..1; dimmer, beam, colorMacro, focus, frost 0..255;
//   hue 0..360, sat 0..1, kelvin (see sketch/colour.js);
//   gobo 0 (open) or slot number; goboMode 'index' | 'spin';
//   goboAngle 0..360; goboSpin -100..100.
//
// Settings can be sent for all of a client's lights, or for one model only
// (the page has one set of controls per model).

const { colourValues } = require('../sketch/colour.js');

const WHITE = { hue: 0, sat: 0, kelvin: 5600 };
const DEFAULT_LOOK = {
  pan: 0.5, tilt: 0.5, dimmer: 0, beam: 128, colorMacro: 0, ...WHITE,
  gobo: 0, goboMode: 'index', goboAngle: 0, goboSpin: 0, focus: 128, frost: 0,
};
const RANGES = {
  pan: [0, 1], tilt: [0, 1], dimmer: [0, 255], beam: [0, 255], colorMacro: [0, 255],
  hue: [0, 360], sat: [0, 1], kelvin: [1000, 20000],
  gobo: [0, 64], goboAngle: [0, 360], goboSpin: [-100, 100], focus: [0, 255], frost: [0, 255],
};
const SOLO_FLASH_MS = 250; // on 250 ms, off 250 ms

// Keeps known settings only, clamped to their ranges.
function cleanLook(values) {
  const out = {};
  if (!values || typeof values !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = Number(values[k]);
    if (values[k] != null && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  if (out.gobo != null) out.gobo = Math.round(out.gobo);
  if (values.goboMode === 'index' || values.goboMode === 'spin') out.goboMode = values.goboMode;
  return out;
}

// Model layouts with channel numbers turned into offsets (0 = first channel).
function prepareModels(models) {
  const out = {};
  for (const [key, m] of Object.entries(models)) {
    const ch = {};
    for (const [role, n] of Object.entries(m.channels || {})) ch[role] = n - 1;
    const defaults = {};
    for (const [n, v] of Object.entries(m.defaults || {})) defaults[Number(n) - 1] = v;
    out[key] = { ...m, ch, defaults };
  }
  return out;
}

class Rig {
  constructor(config) {
    this.models = prepareModels(config.models);
    this.lights = config.lights;
    this.byName = new Map(this.lights.map((l) => [l.name, l]));
    this.universes = [...new Set(this.lights.map((l) => l.universe))].sort((a, b) => a - b);
    // name -> { owner, selected, solo, look }
    this.state = new Map(this.lights.map((l) => [l.name, free()]));
    this.raw = new Map(); // "universe:channel" -> { owner, value }
    this.ambient = new Set(); // ambient client ids
  }

  // Whether `client` may take a light `s` someone else has: only from an
  // ambient client, and not as one. The light starts afresh for the taker.
  takesOver(client, name, s) {
    if (!this.ambient.has(s.owner) || this.ambient.has(client)) return false;
    this.state.set(name, free());
    return true;
  }

  // ---------- Ownership ----------

  // The settings a light gets from shared values plus its model's own values.
  lookFor(name, s, values, looks) {
    const model = this.byName.get(name).model;
    const own = looks && typeof looks === 'object' ? looks[model] : null;
    return { ...(s.look || DEFAULT_LOOK), ...cleanLook(values), ...cleanLook(own) };
  }

  // Takes lights for a client and gives them its look. `looks` holds settings
  // per model ({ modelKey: values }). Returns busy lights.
  take(client, names, values, looks) {
    const busy = [];
    for (const name of names) {
      let s = this.state.get(name);
      if (!s) continue;
      if (s.owner && s.owner !== client) {
        if (!this.takesOver(client, name, s)) { busy.push({ name, owner: s.owner }); continue; }
        s = this.state.get(name);
      }
      s.owner = client;
      s.selected = true;
      s.look = this.lookFor(name, s, values, looks);
    }
    return busy;
  }

  // Lets go of lights. A light still soloed or with overrides stays taken.
  release(client, names) {
    for (const name of names) {
      const s = this.state.get(name);
      if (!s || s.owner !== client) continue;
      s.selected = false;
      this.freeIfUnused(name);
    }
  }

  // Applies settings to every light the client has selected or soloed, or
  // only to those of one model.
  set(client, values, model) {
    const look = cleanLook(values);
    for (const [name, s] of this.state) {
      if (model && this.byName.get(name).model !== model) continue;
      if (s.owner === client && (s.selected || s.solo)) s.look = { ...(s.look || DEFAULT_LOOK), ...look };
    }
  }

  // Solos one light for a client (null ends solo). Returns busy info or null.
  solo(client, name, values, looks) {
    let s = name == null ? null : this.state.get(name);
    if (s && s.owner && s.owner !== client) {
      if (!this.takesOver(client, name, s)) return { name, owner: s.owner };
      s = this.state.get(name);
    }
    for (const [n, other] of this.state) {
      if (other.owner === client && other.solo && n !== name) { other.solo = false; this.freeIfUnused(n); }
    }
    if (s) {
      s.owner = client;
      s.solo = true;
      s.look = this.lookFor(name, s, values, looks);
    }
    return null;
  }

  // Sets (or with value null, removes) a single-channel override.
  // Allowed if the channel's light is free or the client's, or the channel
  // isn't part of any light and nobody else has overridden it.
  setRaw(client, key, value) {
    const [u, ch] = key.split(':').map(Number);
    if (!this.universes.includes(u) || !(ch >= 1 && ch <= 512)) return null;
    const light = this.lightAt(u, ch);
    if (light && this.models[light.model].ch.control === ch - light.address) return { reason: 'control' };
    let s = light && this.state.get(light.name);
    if (s && s.owner && s.owner !== client) {
      if (!this.takesOver(client, light.name, s)) return { name: light.name, owner: s.owner };
      s = this.state.get(light.name);
    }
    const r = this.raw.get(key);
    if (r && r.owner !== client) return { channel: key, owner: r.owner };
    if (value == null) {
      this.raw.delete(key);
      if (light) this.freeIfUnused(light.name);
      return null;
    }
    this.raw.set(key, { owner: client, value: Math.min(255, Math.max(0, Math.round(Number(value) || 0))) });
    if (s && !s.owner) s.owner = client;
    return null;
  }

  clearRaw(client) {
    for (const [key, r] of this.raw) {
      if (r.owner !== client) continue;
      this.raw.delete(key);
      const [u, ch] = key.split(':').map(Number);
      const light = this.lightAt(u, ch);
      if (light) this.freeIfUnused(light.name);
    }
  }

  // Frees everything a client has, e.g. when it disconnects or goes quiet.
  dropClient(client) {
    for (const [name, s] of this.state) if (s.owner === client) this.state.set(name, free());
    for (const [key, r] of this.raw) if (r.owner === client) this.raw.delete(key);
  }

  freeIfUnused(name) {
    const s = this.state.get(name);
    if (!s || s.selected || s.solo) return;
    const l = this.byName.get(name);
    const count = this.models[l.model].channelCount;
    for (const [key, r] of this.raw) {
      const [u, ch] = key.split(':').map(Number);
      if (r.owner === s.owner && u === l.universe && ch >= l.address && ch < l.address + count) return;
    }
    this.state.set(name, free());
  }

  lightAt(u, ch) {
    return this.lights.find((l) => l.universe === u && ch >= l.address && ch < l.address + this.models[l.model].channelCount);
  }

  // Who has what, for the pages.
  owners() {
    const out = {};
    for (const [name, s] of this.state) {
      if (s.owner) out[name] = { owner: s.owner, selected: s.selected, solo: s.solo, ...(this.ambient.has(s.owner) && { ambient: true }) };
    }
    return out;
  }

  // ---------- DMX ----------

  // One 512-channel frame per console universe, at time `now` (ms).
  frames(now) {
    const frames = new Map(this.universes.map((u) => [u, new Uint8Array(512)]));
    const soloing = new Set();
    for (const s of this.state.values()) if (s.solo) soloing.add(s.owner);
    const flashOn = Math.floor(now / SOLO_FLASH_MS) % 2 === 0;

    for (const l of this.lights) {
      const frame = frames.get(l.universe);
      const T = this.models[l.model], c = T.ch;
      const setCh = (n, v) => { if (n != null && n >= 1 && n <= 512) frame[n - 1] = Math.round(v) | 0; };
      const at = (off) => (off == null ? null : l.address + off);
      for (const [off, v] of Object.entries(T.defaults)) setCh(l.address + Number(off), v);

      const s = this.state.get(l.name);
      // Not in use, or its owner is soloing another light: parked and dark.
      if (!s.owner || !s.look || (!s.solo && (!s.selected || soloing.has(s.owner)))) continue;

      // A soloed light flashes open white with a wide beam; pan/tilt as set.
      const look = s.solo
        ? { ...s.look, dimmer: flashOn ? 255 : 0, beam: 255, colorMacro: T.colorMacroWhite ?? 0, ...WHITE, gobo: 0, frost: 0 }
        : s.look;
      const put16 = (hi, lo, v01) => {
        const v = Math.round(Math.min(1, Math.max(0, v01)) * 65535);
        setCh(hi, v >> 8);
        setCh(lo, v & 0xff);
      };
      put16(at(c.pan), at(c.panFine), l.invertPan ? 1 - look.pan : look.pan);
      put16(at(c.tilt), at(c.tiltFine), look.tilt);
      setCh(at(c.dimmer), look.dimmer);
      if (T.shutterOpen != null) setCh(at(c.shutter), T.shutterOpen);
      setCh(at(c.zoom), T.zoomZeroIsWide ? 255 - look.beam : look.beam);
      setCh(at(c.colorMacro), look.colorMacro);
      for (const [role, v] of Object.entries(colourValues(T, look))) setCh(at(c[role]), v);
      if (T.gobo) setCh(at(c.goboWheel), goboWheelValue(T.gobo, look));
      if (T.goboRotation) setCh(at(c.goboRot), goboRotValue(T.goboRotation, look));
      setCh(at(c.focus), look.focus);
      setCh(at(c.frost), look.frost);
    }
    for (const [key, r] of this.raw) {
      const [u, ch] = key.split(':').map(Number);
      frames.get(u)[ch - 1] = r.value;
    }
    return frames;
  }
}

function free() {
  return { owner: null, selected: false, solo: false, look: null };
}

// Gobo wheel value. Each slot has a range slotWidth values wide; the middle
// of the range is used.
function goboWheelValue(g, look) {
  if (look.gobo === 0 || look.gobo > g.slots) return g.openValue;
  const first = look.goboMode === 'spin' ? g.spinFirst : g.indexFirst;
  return first + g.slotWidth * (look.gobo - 1) + Math.floor(g.slotWidth / 2);
}

// Gobo rotation value: angle in index mode, speed in spin mode.
// Ranges are [slow or 0°, fast or 360°] as DMX values.
function goboRotValue(r, look) {
  const along = ([a, b], t) => a + t * (b - a);
  if (look.gobo === 0) return r.indexRange[0];
  if (look.goboMode === 'index') return along(r.indexRange, look.goboAngle / 360);
  const s = look.goboSpin;
  if (s === 0) return r.stop;
  return s > 0 ? along(r.forwardRange, s / 100) : along(r.backwardRange, -s / 100);
}

module.exports = { Rig, DEFAULT_LOOK, cleanLook };
