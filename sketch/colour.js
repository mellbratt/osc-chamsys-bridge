// Colour maths shared by the bridge (which works out DMX values) and the page
// (colour picker and map). Loaded as a plain script in the page and with
// require() in the bridge.
//
// A light's colour is set the same way for every model:
//   hue     0..360, the colour on the colour wheel
//   sat     0..1, how much colour: 0 = white, 1 = full colour
//   kelvin  the white's colour temperature, e.g. 3200 (warm) to 10000 (cool)
// Each model makes that colour its own way, from the channels it has:
//   - cct + crossfade (Jet Wash 7, EclFresnel CT+): white from the CCT
//     channel, colour from red/green/blue, blended by the crossfade channel.
//   - cyan/magenta/yellow (Jet Profile300LT): filters take colour out of a
//     white source; CTO warms the white.
//   - red/green/blue(/white) only (EclPar IPMFC): the colour is mixed directly.

(function (exports) {
  const KELVIN = { min: 2800, max: 10000 };
  const DEFAULT_CCT_RANGE = [2800, 10000];
  const DEFAULT_CTO_RANGE = [2800, 6500]; // full CTO .. no CTO (the source's own white)

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

  // Approximate colour of white light at a colour temperature, 0..255 per
  // channel (Tanner Helland's curve fit of black-body colours).
  function kelvinToRgb(k) {
    const t = clamp(k, 1000, 40000) / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [r, g, b].map((v) => clamp(v, 0, 255));
  }

  // The fully saturated colour at a hue, 0..255 per channel.
  function hueToRgb(h) {
    const x = (((h % 360) + 360) % 360) / 60, i = Math.floor(x), f = x - i;
    return [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][i % 6].map((v) => v * 255);
  }

  // Scales a colour so its brightest channel is 255 (brightness is the dimmer's job).
  function full(rgb) {
    const m = Math.max(...rgb);
    return m > 0 ? rgb.map((v) => (v * 255) / m) : [255, 255, 255];
  }

  // What the light should look like: its white, pulled towards the hue.
  function targetRgb(look) {
    return full(mix(kelvinToRgb(look.kelvin), hueToRgb(look.hue), look.sat));
  }

  // The range of white a model can make, in kelvin, or null if it can't set it.
  function whiteRange(T) {
    const ch = T.channels || {};
    if (ch.cct != null) return T.cctRange || DEFAULT_CCT_RANGE;
    if (ch.cto != null) return T.ctoRange || DEFAULT_CTO_RANGE;
    if (ch.red != null && ch.green != null && ch.blue != null) return [KELVIN.min, KELVIN.max]; // mixed, approximate
    return null;
  }
  function canColour(T) {
    const ch = T.channels || {};
    return (ch.red != null && ch.green != null && ch.blue != null) || (ch.cyan != null && ch.magenta != null && ch.yellow != null);
  }

  // DMX values for a model's colour channels: { role: 0..255 }. 16-bit roles
  // come as two entries, e.g. cct and cctFine.
  function colourValues(T, look) {
    const ch = T.channels || {};
    const out = {};
    const put = (role, v) => { if (ch[role] != null) out[role] = Math.round(clamp(v, 0, 255)); };
    const put16 = (role, fine, t) => {
      const v = Math.round(clamp(t, 0, 1) * 65535);
      put(role, v >> 8);
      put(fine, v & 0xff);
    };
    if (ch.cct != null && ch.crossfade != null) {
      const [lo, hi] = T.cctRange || DEFAULT_CCT_RANGE;
      put16('cct', 'cctFine', (look.kelvin - lo) / (hi - lo));
      put('crossfade', look.sat * 255);
      const c = hueToRgb(look.hue);
      put('red', c[0]); put('green', c[1]); put('blue', c[2]); put('white', 0);
      put('colorMacro', 0);
    } else if (ch.cyan != null) {
      const c = mix([255, 255, 255], hueToRgb(look.hue), look.sat);
      put('cyan', 255 - c[0]); put('magenta', 255 - c[1]); put('yellow', 255 - c[2]);
      const [lo, hi] = T.ctoRange || DEFAULT_CTO_RANGE;
      put('cto', ((hi - look.kelvin) / (hi - lo)) * 255);
    } else if (ch.red != null) {
      let [r, g, b] = targetRgb(look);
      let w = 0;
      if (ch.white != null) { w = Math.min(r, g, b); r -= w; g -= w; b -= w; }
      put('red', r); put('green', g); put('blue', b); put('white', w);
      put('colorMacro', 0);
    }
    return out;
  }

  // The colour a light shows, worked out back from its DMX values, for the
  // map. `v(role)` gives the value of a channel role, or null.
  function displayRgb(T, v) {
    const ch = T.channels || {};
    if (ch.cct != null && ch.crossfade != null) {
      const [lo, hi] = T.cctRange || DEFAULT_CCT_RANGE;
      const k = lo + (((v('cct') * 256 + (v('cctFine') ?? 0)) / 65535) * (hi - lo));
      const colour = [v('red'), v('green'), v('blue')].map((x) => Math.min(255, x + (v('white') ?? 0)));
      return full(mix(kelvinToRgb(k), colour, v('crossfade') / 255));
    }
    if (ch.cyan != null) {
      const [lo, hi] = T.ctoRange || DEFAULT_CTO_RANGE;
      const warm = kelvinToRgb(hi - ((v('cto') ?? 0) / 255) * (hi - lo)), source = kelvinToRgb(hi);
      return full([v('cyan'), v('magenta'), v('yellow')].map((x, i) => (255 - x) * (warm[i] / source[i])));
    }
    if (ch.red != null && ch.green != null && ch.blue != null) {
      const w = v('white') ?? 0;
      return full([v('red'), v('green'), v('blue')].map((x) => Math.min(255, x + w)));
    }
    return [255, 236, 200]; // warm white when the model can't show colour
  }

  Object.assign(exports, { KELVIN, kelvinToRgb, hueToRgb, targetRgb, whiteRange, canColour, colourValues, displayRgb });
})(typeof module !== 'undefined' ? module.exports : (window.Colour = {}));
