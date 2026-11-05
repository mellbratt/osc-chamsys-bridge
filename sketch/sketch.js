// The control page. The room setup (light models, lights, map) comes from
// the bridge, which reads it from the config file; nothing about a particular
// room is in here.
//
// Several people can use the page at once (issue #10). The page only asks
// for things: take these lights, let go, set these values, solo this one.
// The bridge decides who has which light and works out the DMX values.
// A page that has just opened only watches until its user does something.

let MODELS = {};    // model key -> layout, channel roles as offsets (0 = 1st channel)
let FIXTURES = [];  // lights from the config
let UNIVERSES = []; // console universes that have lights
let configJson = null;
let canEdit = false; // true on the bridge computer
let myId = null;     // this page's id at the bridge
let owners = {};     // light name -> { owner, selected, solo }, from the bridge
let clientList = {}; // client id -> { label, address, hostName, typedName, last, ... }
let stateReceivedAt = 0;
let inControl = true; // false after "Release to console"

function toOffsets(byChannel) {
  const out = {};
  for (const [n, v] of Object.entries(byChannel || {})) out[Number(n) - 1] = v;
  return out;
}

function applyConfig(cfg) {
  MODELS = {};
  for (const [key, m] of Object.entries(cfg.models)) {
    const ch = {};
    for (const [role, n] of Object.entries(m.channels || {})) ch[role] = n - 1;
    MODELS[key] = { ...m, ch, names: toOffsets(m.labels) };
  }
  FIXTURES = cfg.lights;
  UNIVERSES = [...new Set(FIXTURES.map((f) => f.universe))].sort((a, b) => a - b);
  buildUi();
}

// =====================================================================

let ws, connected = false;
// Pan and tilt are shared by all your lights (one pad); everything else is
// set per kind of light, in typeLooks (types.js).
const state = {
  pan: 0.5, tilt: 0.5, sweep: false,
  selected: new Set(), // lights this page has taken; starts empty (watching only)
  solo: null,          // index of the soloed light, or null when solo mode is off
  raw: new Map(),      // "universe:channel" -> value
};
let lastSent = {}, lastSendMs = 0, dragging = false; // model -> last values sent
let displayOrder = []; // light indexes in the order the list shows them

function setup() {
  const holder = document.getElementById('pad-holder');
  const size = Math.min(holder.clientWidth || 400, 440);
  const c = createCanvas(size, size);
  c.parent(holder);
  const startDrag = () => { dragging = true; state.sweep = false; el('sweep').checked = false; };
  c.mousePressed(startDrag);
  c.touchStarted(() => { startDrag(); return false; });
  connect(); // UI is built when the config arrives
}

function mouseReleased() { dragging = false; }
function touchEnded() { dragging = false; }

function draw() {
  if (state.sweep) {
    const t = millis() / 1000;
    state.pan = 0.5 + 0.3 * Math.cos(t * 0.6);
    state.tilt = 0.5 + 0.25 * Math.sin(t * 0.6);
  } else if (dragging) {
    state.pan = constrain(mouseX / width, 0, 1);
    state.tilt = constrain(mouseY / height, 0, 1);
  }
  pushLook();
  drawPad();
  renderMap();
}

// ---------- What this page asks the bridge for ----------

// The settings for one kind of light, in the bridge's units: the shared pan
// and tilt plus that kind's own controls.
function look(model) {
  return { pan: state.pan, tilt: state.tilt, ...typeLooks[model] };
}
// Settings for the given lights' kinds: { model: values }.
function looksFor(indexes) {
  const models = new Set(indexes.map((i) => FIXTURES[i].model));
  return Object.fromEntries([...models].map((m) => [m, look(m)]));
}

// Sends each kind's settings for this page's lights of that kind, at most 30
// times a second and only when they change. Nothing is sent while the page
// only watches.
function pushLook() {
  if (!FIXTURES.length || (!state.selected.size && state.solo == null)) return;
  const now = millis();
  if (now - lastSendMs < 33) return;
  for (const model of TYPE_KEYS) {
    if (!myLightsOf(model).length) continue;
    const values = look(model), key = JSON.stringify(values);
    if (key === lastSent[model]) continue;
    lastSent[model] = key; lastSendMs = now;
    send({ type: 'set', model, values });
  }
}

// Who has a light, if it's someone else: their name or address, or null.
function otherOwner(i) {
  const o = owners[FIXTURES[i].name];
  if (!o || o.owner === myId || o.ambient) return null; // ambient gives way to anyone
  return (clientList[o.owner] && clientList[o.owner].label) || 'someone else';
}
function busyNote(i) {
  note(`${FIXTURES[i].name} is being controlled by ${otherOwner(i)}.`);
}

function take(indexes) {
  const free = indexes.filter((i) => !otherOwner(i));
  indexes.filter((i) => otherOwner(i)).slice(0, 1).forEach(busyNote);
  if (!free.length) return;
  free.forEach((i) => state.selected.add(i));
  send({ type: 'take', lights: free.map((i) => FIXTURES[i].name), values: { pan: state.pan, tilt: state.tilt }, looks: looksFor(free) });
}
function letGo(indexes) {
  indexes.forEach((i) => state.selected.delete(i));
  send({ type: 'release', lights: indexes.map((i) => FIXTURES[i].name) });
}

// After reconnecting (e.g. a phone waking up), ask for the same lights again.
function retake() {
  const mine = [...state.selected];
  if (mine.length) send({ type: 'take', lights: mine.map((i) => FIXTURES[i].name), values: { pan: state.pan, tilt: state.tilt }, looks: looksFor(mine) });
  if (state.solo != null) send({ type: 'solo', light: FIXTURES[state.solo].name, values: { pan: state.pan, tilt: state.tilt }, looks: looksFor([state.solo]) });
  state.raw.forEach((value, key) => send({ type: 'raw', key, value }));
}

// The bridge said no: someone else got there first.
function onRefused(m) {
  const item = m.items[0] || {};
  const who = item.address || 'someone else';
  if (m.what === 'take') {
    for (const it of m.items) {
      const i = FIXTURES.findIndex((f) => f.name === it.name);
      if (i >= 0) state.selected.delete(i);
    }
    syncSelectedBoxes();
    note(`${item.name} is being controlled by ${who}.`);
  } else if (m.what === 'solo') {
    showSolo(null);
    note(`${item.name} is being controlled by ${who}, so it can't be soloed.`);
  } else if (m.what === 'raw') {
    for (const [key] of state.raw) if (!rawAllowed(key)) state.raw.delete(key);
    renderRaw();
    note(item.reason === 'control' ? 'That is a control channel (resets/settings), so it is blocked.'
      : `${item.name || item.channel} is being controlled by ${who}.`);
  } else if (m.what === 'console') {
    note('Only the bridge computer can hand the lights to the console.');
  } else if (m.what === 'free') {
    note('Only the bridge computer can free other devices\' lights.');
  }
}

// The bridge computer freed this page's lights.
function onFreed(m) {
  state.selected.clear();
  state.raw.clear(); renderRaw();
  showSolo(null);
  syncSelectedBoxes();
  note(`${m.by} freed your lights. Tick them again to control them.`);
}

// ---------- Connected devices ----------

function savedName() {
  try { return localStorage.getItem('light-control-name') || ''; } catch { return ''; }
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// One entry per connected device: name, address, its lights, and what it
// last sent (click for the exact message). Ages count up between updates.
function renderDevices() {
  const ul = el('device-list');
  if (!ul) return;
  const since = Date.now() - stateReceivedAt;
  const ids = Object.keys(clientList).sort((a, b) => (a === myId ? -1 : b === myId ? 1 : 0));
  el('device-count').textContent = `(${ids.length})`;
  const openRaw = new Set([...ul.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  ul.replaceChildren();
  for (const id of ids) {
    const c = clientList[id];
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'device-head';
    const name = document.createElement('strong');
    name.textContent = c.typedName || c.hostName || c.address;
    head.appendChild(name);
    const addr = document.createElement('span');
    addr.className = 'small';
    addr.textContent = [c.typedName && c.hostName, c.address, c.osc && 'OSC', c.ambient && 'ambient', id === myId && '(this page)'].filter(Boolean).join(' · ');
    head.appendChild(addr);
    const lights = Object.entries(owners).filter(([, o]) => o.owner === id).map(([n]) => n);
    if (canEdit && id !== myId && lights.length && !c.ambient) {
      const btn = document.createElement('button');
      btn.className = 'quiet';
      btn.textContent = 'Free its lights';
      btn.onclick = () => send({ type: 'free', client: id });
      head.appendChild(btn);
    }
    li.appendChild(head);
    const has = document.createElement('div');
    has.className = 'small';
    has.textContent = c.ambient
      ? `Ambient: runs ${lights.length} light${lights.length === 1 ? '' : 's'} nobody else is using`
      : lights.length ? `Controls ${lights.join(', ')}` : 'Controls no lights';
    li.appendChild(has);
    if (c.last) {
      const det = document.createElement('details');
      det.dataset.id = id;
      det.open = openRaw.has(id);
      const sum = document.createElement('summary');
      sum.className = 'small';
      sum.textContent = `Last: ${c.last.summary}, ${ago(c.last.ago + since)}`;
      const pre = document.createElement('pre');
      pre.textContent = c.last.raw;
      det.append(sum, pre);
      li.appendChild(det);
    } else {
      const quiet = document.createElement('div');
      quiet.className = 'small';
      quiet.textContent = `Has sent nothing yet (connected ${ago(c.connectedAgo + since)})`;
      li.appendChild(quiet);
    }
    ul.appendChild(li);
  }
}
setInterval(renderDevices, 1000);

// ---------- Drawing ----------
function drawPad() {
  background(22, 27, 37);
  stroke(58, 68, 86); strokeWeight(1);
  for (let i = 1; i < 8; i++) {
    line((width * i) / 8, 0, (width * i) / 8, height);
    line(0, (height * i) / 8, width, (height * i) / 8);
  }
  const x = state.pan * width, y = state.tilt * height;
  const mine = TYPE_KEYS.filter((m) => myLightsOf(m).length).map((m) => typeLooks[m]);
  const glow = map(Math.max(0, ...mine.map((l) => l.dimmer)), 0, 255, 0, 1);
  const spread = map(Math.max(0, ...mine.map((l) => l.beam)), 0, 255, 0.5, 1.6);
  noStroke();
  for (let r = 6; r > 0; r--) {
    fill(242, 176, 74, 30 * glow);
    circle(x, y, 20 + r * 14 * glow * spread);
  }
  fill(242, 176, 74); circle(x, y, 14);
  fill(154, 163, 179); textSize(12);
  if (state.solo != null) text(`Solo: ${FIXTURES[state.solo].name}`, 10, 20);
  text(`pan ${(state.pan * 100).toFixed(0)}%  tilt ${(state.tilt * 100).toFixed(0)}%`, 10, height - 10);
}

// ---------- Bridge connection ----------
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { connected = true; lastSent = {}; updateStatus(); };
  ws.onclose = () => { connected = false; updateStatus(); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'config') {
      // Map edits arrive as 'map' messages, so only the lights and models count here.
      const json = JSON.stringify({ models: m.models, lights: m.lights });
      myId = m.you;
      canEdit = m.canEdit;
      if (configJson && json !== configJson) { location.reload(); return; } // bridge restarted with a new config
      if (!configJson) { configJson = json; applyConfig(m); initMap(m.map, m.canEdit); }
      else retake();
      const name = savedName();
      if (name) send({ type: 'name', name });
      updateStatus();
    }
    if (m.type === 'state') {
      owners = m.owners; clientList = m.clients; stateReceivedAt = Date.now();
      renderOwners(); renderDevices();
    }
    if (m.type === 'freed') onFreed(m);
    if (m.type === 'refused') onRefused(m);
    if (m.type === 'map') mapFromBridge(m.map, m.id);
    if (m.type === 'output') { outputFromBridge(m); updatePeek(); }
    if (m.type === 'error') mapNote(m.message);
    if (m.type === 'status') { inControl = m.inControl; updateStatus(m); }
  };
}
function send(msg) { if (connected && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// ---------- UI ----------
function el(id) { return document.getElementById(id); }
function note(text) { el('control-note').textContent = text; }

function buildUi() {
  // Your name, remembered by this browser and shown to everyone.
  el('my-name').value = savedName();
  el('my-name').onchange = (e) => {
    const name = e.target.value.trim();
    try { localStorage.setItem('light-control-name', name); } catch { /* private window: not remembered */ }
    send({ type: 'name', name });
  };

  // One section per kind of light: its lights and its own controls (types.js).
  buildTypes();

  // Channel finder: universes from the config, starting at the first light's dimmer.
  UNIVERSES.forEach((u) => el('raw-uni').add(new Option(u, u)));
  const first = FIXTURES[0], firstDimmer = MODELS[first.model].ch.dimmer;
  el('raw-uni').value = first.universe;
  el('raw-ch').value = first.address + (firstDimmer ?? 0);

  el('sweep').onchange = (e) => (state.sweep = e.target.checked);

  el('toggle-send').onclick = () => send({ type: 'console', control: !inControl });
  el('toggle-ambient').onclick = () => send({ type: 'ambient', on: !ambient.on });
  el('blackout').onclick = () => {
    blackoutTypes();
    state.raw.clear(); renderRaw();
    send({ type: 'raw-clear' });
    if (state.solo != null) setSolo(null);
  };

  // Solo mode starts on the first ticked light, or the first light nobody else has.
  el('solo').onchange = (e) => {
    if (!e.target.checked) return setSolo(null);
    const start = displayOrder.find((i) => state.selected.has(i)) ?? displayOrder.find((i) => !otherOwner(i));
    if (start == null) { e.target.checked = false; note('Every light is being controlled by someone else.'); return; }
    setSolo(start);
  };
  document.addEventListener('keydown', (e) => {
    if (state.solo == null || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    // Leave arrow keys alone in sliders, number fields, lists and radio buttons.
    if (e.target.matches('input:not([type=checkbox]), select, textarea')) return;
    e.preventDefault();
    // Step to the next light nobody else is using.
    const n = displayOrder.length, dir = e.key === 'ArrowDown' ? 1 : n - 1;
    let at = displayOrder.indexOf(state.solo);
    for (let k = 0; k < n; k++) {
      at = (at + dir) % n;
      if (!otherOwner(displayOrder[at])) return setSolo(displayOrder[at]);
    }
  });

  const rawKey = () => `${el('raw-uni').value}:${parseInt(el('raw-ch').value, 10)}`;
  const applyRaw = () => {
    const u = +el('raw-uni').value, ch = parseInt(el('raw-ch').value, 10);
    const v = parseInt(el('raw-val').value, 10);
    el('raw-out').textContent = v;
    if (!(ch >= 1 && ch <= 512)) return;
    if (isControlChannel(u, ch)) {
      el('raw-list').textContent = `${u}-${ch} is a head's control channel (resets/settings), so it's blocked.`;
      return;
    }
    if (!rawAllowed(rawKey())) {
      const i = FIXTURES.indexOf(lightAt(u, ch));
      return busyNote(i);
    }
    state.raw.set(rawKey(), v);
    send({ type: 'raw', key: rawKey(), value: v });
    renderRaw();
  };
  el('raw-val').oninput = applyRaw;
  el('raw-ch').onchange = el('raw-uni').onchange = () => {
    const v = state.raw.get(rawKey()) ?? 0;
    el('raw-val').value = v; el('raw-out').textContent = v;
  };
  el('raw-clear').onclick = () => { state.raw.clear(); send({ type: 'raw-clear' }); renderRaw(); };
}

function lightAt(u, ch) {
  return FIXTURES.find((f) => f.universe === u && ch >= f.address && ch < f.address + MODELS[f.model].channelCount);
}
function isControlChannel(u, ch) {
  return FIXTURES.some((f) => f.universe === u && f.address + MODELS[f.model].ch.control === ch);
}
function rawAllowed(key) {
  const [u, ch] = key.split(':').map(Number);
  const f = lightAt(u, ch);
  return !f || !otherOwner(FIXTURES.indexOf(f));
}

// Used by the map: a click adds or removes a light, like its checkbox.
function toggleSelected(i) {
  if (state.selected.has(i)) letGo([i]); else take([i]);
  syncSelectedBoxes();
}
function syncSelectedBoxes() {
  document.querySelectorAll('input[data-i]').forEach((cb) => (cb.checked = state.selected.has(+cb.dataset.i)));
  updateTypeSections();
  renderMap(true);
}

// Marks lights other people are controlling, in the list and on the map.
function renderOwners() {
  document.querySelectorAll('.group label').forEach((lab) => {
    const i = +lab.dataset.i, who = otherOwner(i);
    lab.classList.toggle('busy', !!who);
    lab.querySelector('input').disabled = !!who;
    lab.querySelector('.owner').textContent = who ? `· ${who}` : '';
    lab.title = who ? `Being controlled by ${who}` : '';
  });
  renderMap(true);
}

function setSolo(i) {
  if (i != null && otherOwner(i)) return busyNote(i);
  showSolo(i);
  send({ type: 'solo', light: i == null ? null : FIXTURES[i].name, values: { pan: state.pan, tilt: state.tilt }, looks: i == null ? {} : looksFor([i]) });
}

function showSolo(i) {
  state.solo = i;
  el('solo').checked = i != null;
  document.body.classList.toggle('solo-mode', i != null);
  document.querySelectorAll('.group label').forEach((lab) => {
    lab.classList.toggle('solo', i != null && +lab.dataset.i === i);
  });
  updateSoloId();
  updatePeek();
  updateTypeSections();
  renderMap(true);
}

// Shows which light is soloed, and why it might not be visible in the room.
function updateSoloId() {
  const box = el('solo-id');
  if (state.solo == null) { box.hidden = true; return; }
  const f = FIXTURES[state.solo];
  box.hidden = false;
  el('solo-name').textContent = `${f.name}, ${f.universe}-${String(f.address).padStart(3, '0')}`;
  el('solo-note').textContent = inControl ? '' : 'The lights are released to the console, so it isn\'t flashing.';
}


function renderRaw() {
  el('raw-list').textContent = state.raw.size
    ? 'Overrides: ' + [...state.raw].map(([k, v]) => `${k.replace(':', '-')} = ${v}`).join(', ')
    : '';
}

function updateStatus(s) {
  const conn = el('conn'), out = el('out'), btn = el('toggle-send');
  conn.className = connected ? 'ok' : 'bad';
  conn.textContent = connected ? 'Bridge connected' : 'Bridge not running. Start it with: node bridge.js';
  if (connected && inControl && s) {
    out.className = 'live';
    const unis = (s.universes || []).map((x) => `${x.console} (Art-Net ${x.artnet})`).join(', ');
    out.textContent = `Controlling the lights through the console at ${s.consoleIp}. Universes ${unis}. ${s.packetsSent} packets`;
  } else if (connected && !inControl) {
    out.className = '';
    out.textContent = 'Released to the console: the console runs the lights.';
  }
  if (s && s.lastError) out.textContent += `  Error: ${s.lastError}`;
  if (s && s.osc) showOscAddress(s.osc);
  if (s && s.ambient) showAmbient(s.ambient);
  btn.hidden = !canEdit;
  btn.textContent = inControl ? 'Release to console' : 'Take back from console';
  btn.classList.toggle('live', inControl);
  if (FIXTURES.length) updateSoloId();
}

// Ambient: lights nobody uses run a colour cycle, or a music program's
// lights, between performances. Switched on and off on the bridge computer.
let ambient = { on: false, by: null };
function showAmbient(a) {
  ambient = a;
  const btn = el('toggle-ambient');
  btn.hidden = !canEdit;
  btn.textContent = a.on ? 'Switch ambient off' : 'Switch ambient on';
  btn.classList.toggle('live', a.on);
  el('ambient-note').textContent = !a.on
    ? 'Ambient is off: lights nobody uses are dark.'
    : a.by
      ? `Ambient is on: ${a.by} (OSC) runs the lights nobody uses. Tick a light to take it over.`
      : 'Ambient is on: lights nobody uses slowly cycle through the colours. Tick a light to take it over.';
}

// Where students' own code should send OSC: this computer's addresses.
function showOscAddress(o) {
  const ips = o.addresses.length ? o.addresses : [location.hostname];
  el('osc-where').textContent = o.listening
    ? `Your own code can send OSC to ${ips.join(' or ')}, port ${o.port} (UDP). Replies come back on port ${o.replyPort}.`
    : `OSC input is off: port ${o.port} is in use by another program on this computer.`;
}

// Shows the named channels of the soloed or first ticked light, as sent.
function updatePeek() {
  const i = state.solo ?? [...state.selected][0];
  if (i == null) { el('peek').textContent = 'No light ticked'; return; }
  const f = FIXTURES[i], T = MODELS[f.model];
  const frame = mapView.output.sending && mapView.output.frames[f.universe];
  if (!frame) { el('peek').textContent = `${f.name} (${T.label}): released to the console, nothing sent`; return; }
  const names = { ...T.names };
  for (const [name, off] of Object.entries(T.ch)) names[off] = name;
  const lines = Object.keys(names).map(Number).sort((a, b) => a - b)
    .map((off) => `${f.universe}-${f.address + off} ${names[off]}: ${frame[f.address - 1 + off]}`);
  el('peek').textContent = `${f.name} (${T.label})\n` + lines.join('\n');
}
