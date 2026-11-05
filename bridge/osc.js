// OSC input (issue #17): students' own code sends OSC to the bridge, and the
// bridge turns it into the same per-light settings the page sends.
//
//   /light/<which>/<what> value(s)
//
// <which> is a light's number (26 for "Wash 26"), a kind of light from the
// models' `group` key (wash, profile...), `moving`, `all`, `mine`, or an OSC
// pattern on the number such as {26,27} or 2[6-9]. <what> is a setting; all
// values are 0..1 except white, which is in kelvin. See the README.
//
// This file has the OSC format itself (decode and encode, no library needed)
// and the meaning of the addresses. The sockets, and who is connected, are in
// bridge.js.

const { canColour, whiteRange } = require('../sketch/colour.js');

// ---------- OSC 1.0 format ----------
// Strings and blobs are padded to a multiple of 4 bytes; numbers are big-endian.

function readString(buf, at) {
  const end = buf.indexOf(0, at);
  if (end < 0) throw new Error('a text value has no end');
  return [buf.toString('utf8', at, end), (end + 4) & ~3];
}

// A packet (a message or a bundle) -> list of { address, args }. Bundles,
// also nested ones, come out as their messages in order; the time tag is
// ignored, so they apply straight away and together.
function decode(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 4) throw new Error('too short');
  let [address, at] = readString(buf, 0);
  if (address === '#bundle') {
    at += 8; // time tag
    const out = [];
    while (at < buf.length) {
      const size = buf.readInt32BE(at);
      at += 4;
      if (size < 0 || at + size > buf.length) throw new Error('a bundle element is cut off');
      out.push(...decode(buf.subarray(at, at + size)));
      at += size;
    }
    return out;
  }
  if (address[0] !== '/') throw new Error('the address must start with /');
  let tags = ',';
  if (at < buf.length) [tags, at] = readString(buf, at);
  if (tags[0] !== ',') tags = ','; // very old senders leave out the type tags
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(at)); at += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(at)); at += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(at)); at += 8; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(at))); at += 8; }
    else if (t === 's' || t === 'S') { let s; [s, at] = readString(buf, at); args.push(s); }
    else if (t === 'b') { const n = buf.readInt32BE(at); args.push(buf.subarray(at + 4, at + 4 + n)); at += (4 + n + 3) & ~3; }
    else if (t === 'T') args.push(1);
    else if (t === 'F') args.push(0);
    else if (t === 'N' || t === 'I') args.push(null);
    else if (t === 'c' || t === 'r' || t === 'm') { args.push(buf.readUInt32BE(at)); at += 4; }
    else if (t === 't') { at += 8; args.push(null); }
    else if (t === '[' || t === ']') continue; // arrays: their items are read as plain values
    else throw new Error(`unknown type tag "${t}"`);
  }
  return [{ address, args }];
}

function padded(b) { return Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]); }

// A number to send as an OSC float even when it is whole, e.g. a position
// of 2 m, so receivers always get the same types.
class Float { constructor(v) { this.value = v; } }

// One message. Whole numbers are sent as ints, other numbers and Floats as
// floats, text as strings.
function encode(address, args = []) {
  const type = (a) => (a instanceof Float ? 'f' : typeof a === 'string' ? 's' : Number.isInteger(a) ? 'i' : 'f');
  const parts = [padded(Buffer.from(address)), padded(Buffer.from(`,${args.map(type).join('')}`))];
  for (const a of args) {
    if (typeof a === 'string') { parts.push(padded(Buffer.from(a))); continue; }
    const b = Buffer.alloc(4);
    if (a instanceof Float) b.writeFloatBE(a.value);
    else if (Number.isInteger(a)) b.writeInt32BE(a);
    else b.writeFloatBE(a);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// ---------- OSC address patterns ----------
// * any text, ? one character, [abc] [a-z] [!abc] one of / not one of, {a,b} either.

const isPattern = (s) => /[*?[\]{}]/.test(s);

function patternToRegExp(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = p.indexOf(']', i);
      if (end < 0) return null;
      let set = p.slice(i + 1, end).replace(/[\\^]/g, '\\$&');
      if (set[0] === '!') set = `^${set.slice(1)}`;
      re += `[${set}]`;
      i = end;
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end < 0) return null;
      re += `(?:${p.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
      i = end;
    } else re += escapeRe(c);
  }
  try { return new RegExp(`^${re}$`); } catch { return null; }
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

// ---------- The lights ----------

// The number in a light's name: 26 for "Wash 26". null if it has none.
function lightNumber(name) {
  const m = /(\d+)\s*$/.exec(name);
  return m ? Number(m[1]) : null;
}

const KEYWORDS = ['all', 'mine', 'moving'];

// The settings OSC can send, what each needs on a model, and how its value
// becomes the rig's units (see the top of rig.js). `n` is how many numbers it takes.
const SETTINGS = {
  dimmer: { n: 1, has: (T) => T.channels.dimmer != null, look: ([v]) => ({ dimmer: clamp01(v) * 255 }) },
  colour: { n: 3, has: (T) => canColour(T), look: (v) => rgbToHueSat(v.map(clamp01)) },
  hue: { n: 1, has: (T) => canColour(T), look: ([v]) => ({ hue: clamp01(v) * 360 }) },
  sat: { n: 1, has: (T) => canColour(T), look: ([v]) => ({ sat: clamp01(v) }) },
  white: { n: 1, has: (T) => !!whiteRange(T), look: ([v]) => ({ kelvin: v }) }, // the rig clamps kelvin
  pan: { n: 1, has: (T) => T.channels.pan != null, look: ([v]) => ({ pan: clamp01(v) }) },
  tilt: { n: 1, has: (T) => T.channels.tilt != null, look: ([v]) => ({ tilt: clamp01(v) }) },
  // The rig's beam is 0 = narrowest, 255 = widest, on every model.
  zoom: { n: 1, has: (T) => T.channels.zoom != null, look: ([v]) => ({ beam: clamp01(v) * 255 }) },
  focus: { n: 1, has: (T) => T.channels.focus != null, look: ([v]) => ({ focus: clamp01(v) * 255 }) },
  frost: { n: 1, has: (T) => T.channels.frost != null, look: ([v]) => ({ frost: clamp01(v) * 255 }) },
  gobo: {
    n: 1, has: (T) => !!T.gobo,
    look: ([v], T) => ({ gobo: Math.min(T.gobo.slots, Math.max(0, Math.round(v))) }),
  },
  // A fixed angle and spinning are two modes of the same channels, as on the page.
  goboangle: { n: 1, has: (T) => !!T.goboRotation, look: ([v]) => ({ goboMode: 'index', goboAngle: clamp01(v) * 360 }) },
  gobospin: {
    n: 1, has: (T) => !!T.goboRotation,
    look: ([v]) => ({ goboMode: 'spin', goboSpin: Math.min(1, Math.max(-1, v)) * 100 }),
  },
  release: { n: 0, has: () => true },
};
SETTINGS.color = SETTINGS.colour;

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

// Red, green and blue (0..1) -> hue and saturation. Brightness is left to the
// dimmer, so 0.5 0 0 is the same full red as 1 0 0.
function rgbToHueSat([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max === 0 || d === 0) return { hue: 0, sat: 0 };
  let h;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { hue: h * 60, sat: d / max };
}

// Numbers from a message's values: ints, floats, true/false and number text.
function numbers(args) {
  return args.map((a) => (typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN));
}

function short(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// ---------- What the addresses do ----------

class OscRouter {
  // `labelOf(clientId)` gives the name shown for whoever has a light.
  constructor(rig, config, labelOf) {
    this.rig = rig;
    this.config = config;
    this.labelOf = labelOf;
    this.lights = config.lights.map((l) => ({
      ...l, number: lightNumber(l.name), group: (config.models[l.model].group || '').toLowerCase() || null,
    }));
    this.groups = new Set(this.lights.map((l) => l.group).filter(Boolean));
  }

  // Problems worth printing when the bridge starts.
  notes() {
    const out = [], seen = new Map();
    for (const l of this.lights) {
      if (l.number == null) out.push(`"${l.name}" has no number at the end of its name, so OSC can only reach it with all, moving, mine or its kind.`);
      else if (seen.has(l.number)) out.push(`"${l.name}" and "${seen.get(l.number)}" have the same number, so /light/${l.number}/... controls both.`);
      else seen.set(l.number, l.name);
    }
    for (const [key, m] of Object.entries(this.config.models)) {
      if (!m.group && this.lights.some((l) => l.model === key)) out.push(`models.${key} has no "group", so OSC can't reach its lights by kind. Add e.g. "group": "wash".`);
    }
    return out;
  }

  // The lights a <which> means for this sender, or a reason it means none.
  pick(which, sender) {
    const w = which.toLowerCase();
    const moving = (l) => { const ch = this.config.models[l.model].channels; return ch.pan != null && ch.tilt != null; };
    if (w === 'all') return { lights: this.lights };
    if (w === 'moving') return { lights: this.lights.filter(moving) };
    if (w === 'mine') {
      const owners = this.rig.owners();
      return { lights: this.lights.filter((l) => owners[l.name] && owners[l.name].owner === sender.id) };
    }
    if (this.groups.has(w)) return { lights: this.lights.filter((l) => l.group === w) };
    if (/^\d+$/.test(w)) {
      const lights = this.lights.filter((l) => l.number === Number(w));
      return lights.length ? { lights } : { error: `No light ${w}. ${this.numberRange()}` };
    }
    if (isPattern(w)) {
      const re = patternToRegExp(w);
      if (!re) return { error: `"${which}" is not a pattern the bridge understands.` };
      const lights = this.lights.filter((l) => l.number != null && re.test(String(l.number)));
      return lights.length ? { lights } : { error: `No light number matches "${which}". ${this.numberRange()}` };
    }
    const words = ['all', 'moving', 'mine', ...this.groups].join(', ');
    return { error: `Unknown light "${which}". Use a light's number, a pattern such as {26,27}, or one of: ${words}.` };
  }

  numberRange() {
    const ns = this.lights.map((l) => l.number).filter((n) => n != null).sort((a, b) => a - b);
    return ns.length ? `Lights are numbered ${ns[0]} to ${ns[ns.length - 1]}.` : '';
  }

  // Handles one message from a sender. `reply(address, args)` answers it.
  // Returns what it did, for the device list (worded by summary.js).
  handle(sender, { address, args }, reply) {
    const parts = address.toLowerCase().split('/').filter(Boolean);
    const [head] = parts;
    if (parts.length === 1 && head === 'ping') return { type: 'ping' };
    if (parts.length === 1 && head === 'name') {
      const name = typeof args[0] === 'string' ? args[0].replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      sender.typedName = name || null;
      return { type: 'name', name };
    }
    if (parts.length === 1 && head === 'release') {
      this.rig.dropClient(sender.id);
      return { type: 'release-all' };
    }
    if (parts.length === 1 && head === 'reply') {
      const port = numbers(args)[0];
      if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
        this.warn(sender, reply, `reply:${args[0]}`, '/reply needs a port number, e.g. /reply 9001.');
        return { type: 'problem', address };
      }
      sender.replyPort = port;
      return { type: 'reply', port };
    }
    if (parts.length === 1 && head === 'info') {
      this.info(reply);
      return { type: 'info' };
    }
    if (head === 'light' && parts.length === 3) return this.light(sender, parts[1], parts[2], args, reply) || { type: 'problem', address };
    this.warn(sender, reply, `address:${address}`, `Unknown address ${address}. Light settings look like /light/26/dimmer 0.8.`);
    return { type: 'unknown', address };
  }

  // /light/<which>/<what> value(s). Returns nothing if the message was wrong.
  light(sender, which, what, args, reply) {
    const setting = SETTINGS[what];
    if (!setting) {
      const known = Object.keys(SETTINGS).filter((k) => k !== 'color').join(', ');
      this.warn(sender, reply, `what:${what}`, `Unknown setting "${what}". Settings: ${known}.`);
      return null;
    }
    const picked = this.pick(which, sender);
    if (picked.error) {
      this.warn(sender, reply, `which:${which}`, picked.error);
      return null;
    }
    if (!picked.lights.length) {
      this.warn(sender, reply, `none:${which}`, which.toLowerCase() === 'mine'
        ? "You don't control any lights yet, so /light/mine/... did nothing. Send to a light's number or kind first."
        : `No lights are "${which}".`);
      return null;
    }
    const model = (l) => this.config.models[l.model];
    const can = picked.lights.filter((l) => setting.has(model(l)));
    const cannot = picked.lights.filter((l) => !setting.has(model(l)));
    if (cannot.length) {
      this.warn(sender, reply, `cannot:${which}/${what}`, `${short(cannot.map((l) => l.name))} can't do ${what}, so it was skipped for ${cannot.length === 1 ? 'that light' : 'those lights'}.`);
    }

    if (what === 'release') {
      this.rig.release(sender.id, can.map((l) => l.name));
      return { type: 'release', lights: can.map((l) => l.name) };
    }

    const values = numbers(args);
    if (values.length < setting.n || values.slice(0, setting.n).some((v) => !Number.isFinite(v))) {
      const need = setting.n === 1 ? 'a number' : `${setting.n} numbers (red green blue, 0 to 1)`;
      this.warn(sender, reply, `values:${what}`, `/light/${which}/${what} needs ${need}.`);
      return null;
    }
    const v = values.slice(0, setting.n);
    // Each model gets its own look, as gobo depends on the model.
    const busy = [];
    for (const key of new Set(can.map((l) => l.model))) {
      const names = can.filter((l) => l.model === key).map((l) => l.name);
      busy.push(...this.rig.take(sender.id, names, setting.look(v, this.config.models[key])));
    }
    this.reportTaken(sender, busy, reply);
    const done = can.filter((l) => !busy.some((b) => b.name === l.name)).map((l) => l.name);
    return { type: 'set', what: what === 'color' ? 'colour' : what, values: v, lights: done, busy: busy.length };
  }

  // /taken: lights someone else has. Said once per light and owner, so a
  // sender that sends every frame isn't flooded.
  reportTaken(sender, busy, reply) {
    for (const [name, owner] of sender.taken) {
      const s = this.rig.owners()[name];
      if (!s || s.owner !== owner) sender.taken.delete(name); // freed or changed hands: say it again next time
    }
    const fresh = busy.filter((b) => sender.taken.get(b.name) !== b.owner);
    if (!fresh.length) return;
    fresh.forEach((b) => sender.taken.set(b.name, b.owner));
    const byOwner = new Map();
    for (const b of fresh) byOwner.set(b.owner, [...(byOwner.get(b.owner) || []), b.name]);
    const text = [...byOwner].map(([owner, names]) => `${short(names)} ${names.length === 1 ? 'is' : 'are'} controlled by ${this.labelOf(owner)}`).join('; ');
    reply('/taken', [`${text}.`, ...fresh.map((b) => lightNumber(b.name)).filter((n) => n != null)]);
  }

  // /warn, once per kind of problem per sender.
  warn(sender, reply, key, text) {
    if (sender.warned.has(key)) return;
    sender.warned.add(key);
    reply('/warn', [text]);
  }

  // /info -> /room width height count, then /info/light number name kind x y facing
  // per light. x, y and facing are -1 for lights not on the map.
  info(reply) {
    const map = this.config.map || {};
    reply('/room', [new Float(Number(map.width) || 0), new Float(Number(map.height) || 0), this.lights.length]);
    for (const l of this.lights) {
      const pos = (map.lights || {})[l.name];
      const at = pos ? [pos.x, pos.y, pos.facing ?? 0].map(Number) : [-1, -1, -1];
      reply('/info/light', [l.number ?? -1, l.name, l.group || l.model, ...at.map((v) => new Float(v))]);
    }
  }
}

module.exports = { decode, encode, Float, patternToRegExp, lightNumber, rgbToHueSat, OscRouter, SETTINGS };
