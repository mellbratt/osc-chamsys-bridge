// The built-in ambient look: what free lights do between performances when
// no music program is running them. Soft and slow, so it sits in the
// background:
// - Light: low, each light slowly breathing a little brighter and dimmer.
// - Colour, one of two ways:
//   - 'wheel': drifting slowly round the colour wheel. Neighbouring lights
//     are close in colour, so the room shows a few related colours, not a
//     rainbow.
//   - 'pairs': lights take turns between the two colours of a pair (PAIRS),
//     and the room blends slowly from one pair to the next.
// - Movement: moving heads drift slowly round a small area near where they
//   park, each out of step with the others.
// - Gobos: profiles turn their gobo slowly and change it now and then,
//   fading out before the change and back in after, so it never snaps.
//
// Everything is a function of the time, so it is smooth however often it's
// called. The settings are set on the bridge computer's page and saved in
// config.json under "ambient".

// Settings, in the page's units: [lowest, highest, default].
const SETTINGS = {
  brightness: [0, 100, 15],      // % of full
  colour: [0, 100, 60],          // colour strength %, 0 = white
  colourMinutes: [0.5, 10, 3],   // minutes once round the wheel, or through all the pairs
  movement: [0, 100, 50],        // % of the largest drift, 0 = still
  moveSeconds: [20, 300, 90],    // seconds for one slow sweep
  goboSeconds: [10, 300, 45],    // seconds each gobo stays
};
const COLOUR_MODES = ['wheel', 'pairs'];
const DEFAULTS = { ...Object.fromEntries(Object.entries(SETTINGS).map(([k, [, , d]]) => [k, d])), colours: 'wheel' };

// Colour pairs for the 'pairs' colours, in order.
const PAIRS = [
  ['#2bff88', '#ff3de0'], ['#ff2b3a', '#2bd9ff'], ['#3352ff', '#ffb12b'], ['#a14dff', '#c4ff2b'],
  ['#ffe12b', '#8a3dff'], ['#2bffd4', '#ff3d7d'], ['#ff7a1a', '#1affb8'], ['#ff2bb4', '#2bff5e'],
];
const PAIR_BLEND = 0.3; // share of each pair's time spent blending into the next

// A hex colour as the bridge's hue (0..360) and colour strength (0..1).
// Brightness is the dimmer's job, so it is left out.
function hueSat(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return { hue: 0, sat: 0 };
  const h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return { hue: ((h * 60) + 360) % 360, sat: d / max };
}
const PAIR_COLOURS = PAIRS.map((pair) => pair.map(hueSat));

// Keeps known settings only, clamped to their ranges; the rest are defaults.
function cleanAmbient(values, base = DEFAULTS) {
  const out = { ...base };
  if (!values || typeof values !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(SETTINGS)) {
    const v = Number(values[k]);
    if (values[k] != null && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  if (COLOUR_MODES.includes(values.colours)) out.colours = values.colours;
  return out;
}

const BREATHE = 0.25;         // brightness rises and falls by this share of itself
const BREATHE_MS = 20000;     // one breath
const COLOUR_SPREAD = 0.3;    // how much of the wheel the room spans at once
const PAN_MAX = 0.12;         // movement at 100%: ≈ 65° pan on a 540° head
const TILT_MAX = 0.16;        //                   ≈ 37° tilt on a 233° head
const TILT_PERIOD = 0.78;     // tilt sweeps a bit faster than pan, so the path wanders
const ZOOM = 200;             // 0..255, wider than the page's default for a softer beam
const GOBO_FADE_MS = 3000;    // fade out before a gobo change, and back in after
const GOBO_SPIN = 6;          // gobo turning speed, -100..100 (slow)

const TAU = Math.PI * 2;
const wave = (cycles, phase) => Math.sin(TAU * (cycles + phase));

// How far round each slow cycle is, in turns. Moved forward a little on each
// tick at the speeds set, so changing a speed doesn't make the lights jump.
class AmbientClock {
  constructor() { this.now = 0; this.last = null; this.colour = 0; this.pan = 0; this.tilt = 0; this.gobo = 0; }
  advance(now, s) {
    const dt = this.last == null ? 0 : Math.min(1000, Math.max(0, now - this.last));
    this.last = this.now = now;
    const moveMs = s.moveSeconds * 1000;
    this.colour += dt / (s.colourMinutes * 60000);
    this.pan += dt / moveMs;
    this.tilt += dt / (moveMs * TILT_PERIOD);
    this.gobo += dt / (s.goboSeconds * 1000);
    return this;
  }
}

// The look for light `i` of `count` (model `T`) at clock `c`.
function ambientLook(T, i, count, c, s = DEFAULTS) {
  const phase = i / count, move = s.movement / 100;
  const look = {
    dimmer: (s.brightness / 100) * (1 + BREATHE * wave(c.now / BREATHE_MS, phase * 3)) * 255,
    ...(s.colours === 'pairs' ? pairColour(i, c.colour) : { hue: (((c.colour + phase * COLOUR_SPREAD) % 1) + 1) % 1 * 360, sat: 1 }),
    beam: ZOOM,
    pan: 0.5 + PAN_MAX * move * wave(c.pan, phase * 7),
    tilt: 0.5 + TILT_MAX * move * wave(c.tilt, phase * 5),
  };
  look.sat *= s.colour / 100;
  if (T.gobo) {
    const goboMs = s.goboSeconds * 1000;
    const fadeTurns = Math.min(GOBO_FADE_MS, goboMs / 4) / goboMs;
    const t = c.gobo + phase; // the profiles change gobo one after another
    const round = Math.floor(t), into = t - round;
    const fade = Math.min(1, Math.min(into, 1 - into) / fadeTurns);
    look.dimmer *= fade * fade * (3 - 2 * fade); // smooth in and out
    look.gobo = ((round + i) % T.gobo.slots) + 1;
    look.goboMode = 'spin';
    look.goboSpin = i % 2 ? -GOBO_SPIN : GOBO_SPIN;
  }
  return look;
}

// Light i's colour in the pairs, `turns` of the way through all of them:
// it holds one pair, then blends into the next.
function pairColour(i, turns) {
  const t = (((turns % 1) + 1) % 1) * PAIRS.length;
  const n = Math.floor(t), into = t - n;
  const from = PAIR_COLOURS[n][i % 2], to = PAIR_COLOURS[(n + 1) % PAIRS.length][i % 2];
  const k = Math.max(0, (into - (1 - PAIR_BLEND)) / PAIR_BLEND);
  const blend = k * k * (3 - 2 * k);
  const dh = ((to.hue - from.hue + 540) % 360) - 180; // the short way round
  return { hue: (from.hue + dh * blend + 360) % 360, sat: from.sat + (to.sat - from.sat) * blend };
}

module.exports = { ambientLook, AmbientClock, cleanAmbient, SETTINGS, DEFAULTS, PAIRS };
