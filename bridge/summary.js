// Short, readable summaries of what a client sent, for the device list.

const LABELS = {
  pan: 'pan', tilt: 'tilt', dimmer: 'dimmer', beam: 'beam', colorMacro: 'colour preset',
  hue: 'hue', sat: 'colour amount', kelvin: 'white',
  gobo: 'gobo', goboMode: 'gobo mode', goboAngle: 'gobo angle', goboSpin: 'gobo spin',
  focus: 'focus', frost: 'frost',
};

function list(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

function value(key, v) {
  if (key === 'pan' || key === 'tilt') return `${Math.round(v * 100)}%`;
  if (key === 'gobo') return v === 0 ? 'open' : String(v);
  if (key === 'sat') return `${Math.round(v * 100)}%`;
  if (key === 'hue') return `${Math.round(v)}°`;
  if (key === 'kelvin') return `${Math.round(v)} K`;
  if (typeof v === 'number') return String(Math.round(v * 10) / 10);
  return String(v);
}

// `previous` is the values from the client's last 'set' (for the same model),
// so only changes are listed. `lightCount` is how many lights it applies to,
// and `modelLabel` names the model when the settings are for one model only.
function summarize(msg, previous, lightCount, modelLabel) {
  const names = Array.isArray(msg.lights) ? msg.lights.filter((n) => typeof n === 'string') : [];
  switch (msg.type) {
    case 'take': return names.length ? `took ${list(names)}` : 'took no lights';
    case 'release': return names.length ? `let go of ${list(names)}` : 'let go of no lights';
    case 'set': {
      const values = msg.values && typeof msg.values === 'object' ? msg.values : {};
      const changed = Object.keys(LABELS).filter((k) => values[k] !== undefined && (!previous || previous[k] !== values[k]));
      const what = changed.length ? changed.map((k) => `${LABELS[k]} ${value(k, values[k])}`).join(', ') : 'the same values';
      const kind = modelLabel ? `${modelLabel} light` : 'light';
      return `set ${what} on ${lightCount} ${kind}${lightCount === 1 ? '' : 's'}`;
    }
    case 'solo': return typeof msg.light === 'string' ? `soloed ${msg.light}` : 'ended solo';
    case 'raw': {
      const ch = String(msg.key || '').replace(':', '-');
      return msg.value == null ? `removed the override on ${ch}` : `set channel ${ch} to ${msg.value}`;
    }
    case 'raw-clear': return 'cleared its channel overrides';
    case 'console': return msg.control ? 'took the lights back from the console' : 'released the lights to the console';
    case 'map': return 'edited the map';
    case 'name': return msg.name ? `named itself "${String(msg.name).slice(0, 40)}"` : 'cleared its name';
    case 'free': return 'freed another device\'s lights';
    default: return `sent "${String(msg.type).slice(0, 20)}"`;
  }
}

// The same for an OSC message, from what bridge/osc.js says it did. OSC
// values are 0..1 (white in kelvin), so they're shown as sent.
function summarizeOsc(r) {
  const num = (v) => String(Math.round(v * 1000) / 1000);
  switch (r.type) {
    case 'set': {
      const where = r.lights.length ? `on ${list(r.lights)}` : 'on no lights';
      const busy = r.busy ? ` (${r.busy} controlled by others)` : '';
      return `OSC: set ${r.what} ${r.values.map(num).join(' ')} ${where}${busy}`;
    }
    case 'release': return r.lights.length ? `OSC: let go of ${list(r.lights)}` : 'OSC: let go of no lights';
    case 'release-all': return 'OSC: let go of all its lights';
    case 'ping': return 'OSC: still here (/ping)';
    case 'name': return r.name ? `OSC: named itself "${r.name}"` : 'OSC: cleared its name';
    case 'reply': return `OSC: asked for replies on port ${r.port}`;
    case 'info': return 'OSC: asked for the room info';
    case 'unknown': return `OSC: unknown address ${String(r.address).slice(0, 60)}`;
    case 'not-osc': return 'sent something that isn\'t OSC';
    default: return `OSC: ${String(r.address || '').slice(0, 60)} was not understood (see the warning it was sent)`;
  }
}

module.exports = { summarize, summarizeOsc };
