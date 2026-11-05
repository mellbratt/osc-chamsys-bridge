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

module.exports = { summarize };
