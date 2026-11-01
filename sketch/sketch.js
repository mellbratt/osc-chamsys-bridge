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
let clientList = {}; // client id -> { address }
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
const state = {
  pan: 0.5, tilt: 0.5, dimmer: 0, sweep: false,
  beam: 128,        // 0 = narrowest, 255 = widest (both types)
  washColor: 0,     // colour macro, 0 = open white on the Wash 7
  gobo: 0,          // 0 = open, 1-7 = gobo slot
  goboMode: 'index',// 'index' = fixed angle, 'spin' = continuous rotation
  goboAngle: 0,     // degrees, index mode
  goboSpin: 0,      // -100..100, spin mode
  focus: 128,
  frost: 0,
  selected: new Set(), // lights this page has taken; starts empty (watching only)
  solo: null,          // index of the soloed light, or null when solo mode is off
  raw: new Map(),      // "universe:channel" -> value
};
let lastSentLook = '', lastSendMs = 0, dragging = false;
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

// The settings from the controls, in the bridge's units.
function look() {
  return {
    pan: state.pan, tilt: state.tilt, dimmer: state.dimmer, beam: state.beam, colorMacro: state.washColor,
    gobo: state.gobo, goboMode: state.goboMode, goboAngle: state.goboAngle, goboSpin: state.goboSpin,
    focus: state.focus, frost: state.frost,
  };
}

// Sends the controls' settings for this page's lights, at most 30 times a
// second and only when they change. Nothing is sent while the page only watches.
function pushLook() {
  if (!FIXTURES.length || (!state.selected.size && state.solo == null)) return;
  const now = millis();
  if (now - lastSendMs < 33) return;
  const values = look(), key = JSON.stringify(values);
  if (key === lastSentLook) return;
  lastSentLook = key; lastSendMs = now;
  send({ type: 'set', values });
}

// Who has a light, if it's someone else: their address, or null.
function otherOwner(i) {
  const o = owners[FIXTURES[i].name];
  if (!o || o.owner === myId) return null;
  return (clientList[o.owner] && clientList[o.owner].address) || 'someone else';
}
function busyNote(i) {
  note(`${FIXTURES[i].name} is being controlled by ${otherOwner(i)}.`);
}

function take(indexes) {
  const free = indexes.filter((i) => !otherOwner(i));
  indexes.filter((i) => otherOwner(i)).slice(0, 1).forEach(busyNote);
  if (!free.length) return;
  free.forEach((i) => state.selected.add(i));
  send({ type: 'take', lights: free.map((i) => FIXTURES[i].name), values: look() });
}
function letGo(indexes) {
  indexes.forEach((i) => state.selected.delete(i));
  send({ type: 'release', lights: indexes.map((i) => FIXTURES[i].name) });
}

// After reconnecting (e.g. a phone waking up), ask for the same lights again.
function retake() {
  if (state.selected.size) send({ type: 'take', lights: [...state.selected].map((i) => FIXTURES[i].name), values: look() });
  if (state.solo != null) send({ type: 'solo', light: FIXTURES[state.solo].name, values: look() });
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
  }
}

// ---------- Drawing ----------
function drawPad() {
  background(22, 27, 37);
  stroke(58, 68, 86); strokeWeight(1);
  for (let i = 1; i < 8; i++) {
    line((width * i) / 8, 0, (width * i) / 8, height);
    line(0, (height * i) / 8, width, (height * i) / 8);
  }
  const x = state.pan * width, y = state.tilt * height;
  const glow = map(state.dimmer, 0, 255, 0, 1);
  const spread = map(state.beam, 0, 255, 0.5, 1.6);
  noStroke();
  for (let r = 6; r > 0; r--) {
    fill(242, 176, 74, 30 * glow);
    circle(x, y, 20 + r * 14 * glow * spread);
  }
  fill(242, 176, 74); circle(x, y, 14);
  fill(154, 163, 179); textSize(12);
  if (state.solo != null) text(`Solo: ${FIXTURES[state.solo].name}`, 10, 20);
  const g = state.gobo ? `  gobo ${state.gobo}` : '';
  text(`pan ${(state.pan * 100).toFixed(0)}%  tilt ${(state.tilt * 100).toFixed(0)}%${g}`, 10, height - 10);
}

// ---------- Bridge connection ----------
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { connected = true; lastSentLook = ''; updateStatus(); };
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
      updateStatus();
    }
    if (m.type === 'state') { owners = m.owners; clientList = m.clients; renderOwners(); }
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
  // Light checkboxes, one group per model
  for (const [key, T] of Object.entries(MODELS)) {
    if (!FIXTURES.some((f) => f.model === key)) continue;
    const set = document.createElement('fieldset');
    set.innerHTML = '<legend></legend><div class="group"></div><div class="row">'
      + '<button class="quiet" data-mode="all">All</button><button class="quiet" data-mode="none">None</button></div>';
    set.querySelector('legend').textContent = T.label;
    const box = set.querySelector('.group');
    FIXTURES.forEach((f, i) => {
      if (f.model !== key) return;
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="checkbox" data-i="${i}"> <span></span> <span class="small"></span> <span class="small owner"></span>`;
      lab.querySelectorAll('span')[0].textContent = f.name;
      lab.querySelectorAll('span')[1].textContent = `${f.universe}-${String(f.address).padStart(3, '0')}`;
      lab.dataset.i = i;
      lab.querySelector('input').onchange = (e) => {
        if (e.target.checked) take([i]); else letGo([i]);
        syncSelectedBoxes();
      };
      // In solo mode, clicking a light's name solos it instead of ticking it.
      lab.onclick = (e) => {
        if (state.solo == null) return;
        e.preventDefault();
        setSolo(i);
      };
      displayOrder.push(i);
      box.appendChild(lab);
    });
    set.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.onclick = () => {
        const mine = FIXTURES.map((f, i) => i).filter((i) => FIXTURES[i].model === key);
        if (btn.dataset.mode === 'all') take(mine.filter((i) => !state.selected.has(i)));
        else letGo(mine.filter((i) => state.selected.has(i)));
        syncSelectedBoxes();
      };
    });
    el('groups').appendChild(set);
  }

  // Show the colour and gobo panels only if some light has those channels.
  const models = FIXTURES.map((f) => MODELS[f.model]);
  el('panel-color').hidden = !models.some((T) => T.ch.colorMacro != null);
  const goboSlots = Math.max(0, ...models.map((T) => (T.gobo ? T.gobo.slots : 0)));
  el('panel-gobo').hidden = !models.some((T) => T.ch.goboWheel != null || T.ch.focus != null || T.ch.frost != null);
  for (let g = 1; g <= goboSlots; g++) el('gobo').add(new Option(`Gobo ${g}`, g));

  // Channel finder: universes from the config, starting at the first light's dimmer.
  UNIVERSES.forEach((u) => el('raw-uni').add(new Option(u, u)));
  const first = FIXTURES[0], firstDimmer = MODELS[first.model].ch.dimmer;
  el('raw-uni').value = first.universe;
  el('raw-ch').value = first.address + (firstDimmer ?? 0);

  bindSlider('dimmer', (v) => (state.dimmer = v));
  bindSlider('beam', (v) => (state.beam = v));
  bindSlider('color', (v) => (state.washColor = v));
  bindSlider('focus', (v) => (state.focus = v));
  bindSlider('frost', (v) => (state.frost = v));
  el('sweep').onchange = (e) => (state.sweep = e.target.checked);

  // Gobo controls
  el('gobo').onchange = (e) => (state.gobo = +e.target.value);
  document.querySelectorAll('input[name=gobo-mode]').forEach((r) => {
    r.onchange = () => { state.goboMode = r.value; configureGoboSlider(); };
  });
  el('gobo-move').oninput = (e) => {
    const v = +e.target.value;
    if (state.goboMode === 'index') state.goboAngle = v; else state.goboSpin = v;
    el('gobo-move-out').textContent = state.goboMode === 'index' ? `${v}°` : v;
  };
  configureGoboSlider();

  el('toggle-send').onclick = () => send({ type: 'console', control: !inControl });
  el('blackout').onclick = () => {
    state.dimmer = 0; el('dimmer').value = 0; el('dimmer-out').textContent = 0;
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
  send({ type: 'solo', light: i == null ? null : FIXTURES[i].name, values: look() });
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

function configureGoboSlider() {
  const s = el('gobo-move'), label = el('gobo-move-label');
  if (state.goboMode === 'index') {
    s.min = 0; s.max = 360; s.value = state.goboAngle;
    label.textContent = 'Angle';
    el('gobo-move-out').textContent = `${state.goboAngle}°`;
  } else {
    s.min = -100; s.max = 100; s.value = state.goboSpin;
    label.textContent = 'Spin';
    el('gobo-move-out').textContent = state.goboSpin;
  }
}

function bindSlider(id, fn) {
  el(id).oninput = (e) => { const v = +e.target.value; el(id + '-out').textContent = v; fn(v); };
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
  btn.hidden = !canEdit;
  btn.textContent = inControl ? 'Release to console' : 'Take back from console';
  btn.classList.toggle('live', inControl);
  if (FIXTURES.length) updateSoloId();
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
