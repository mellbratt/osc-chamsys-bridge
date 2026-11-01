// The room setup (light models, lights, map) comes from the bridge, which
// reads it from the config file. Nothing about a particular room is in here.
// Channel numbers in the config are 1-based, as in the manuals; this file
// works with offsets from a light's start address (0 = 1st channel).

let MODELS = {};    // model key -> layout, as offsets
let FIXTURES = [];  // lights from the config
let UNIVERSES = []; // console universes that have lights
const takeover = new Set(); // universes sent when you press "Take control"
let configJson = null;

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
    MODELS[key] = { ...m, ch, names: toOffsets(m.labels), defaults: toOffsets(m.defaults) };
  }
  FIXTURES = cfg.lights;
  UNIVERSES = [...new Set(FIXTURES.map((f) => f.universe))].sort((a, b) => a - b);
  takeover.clear();
  takeover.add(UNIVERSES[0]); // the others start with the console
  for (const u of UNIVERSES) frames[u] = new Array(512).fill(0);
  frame = frames[UNIVERSES[0]];
  state.selected = new Set([0]); // start with only the first light
  buildUi();
}

// =====================================================================

let ws, connected = false, sending = false;
const state = {
  pan: 0.5, tilt: 0.5, dimmer: 0, sweep: false,
  beam: 128,        // 0 = narrowest, 255 = widest (both types)
  washColor: 0,     // Wash 7 colour macro, 0 = open white
  gobo: 0,          // 0 = open, 1-7 = gobo slot
  goboMode: 'index',// 'index' = fixed angle, 'spin' = continuous rotation
  goboAngle: 0,     // degrees, index mode
  goboSpin: 0,      // -100..100, spin mode
  focus: 128,
  frost: 0,
  selected: new Set(),
  solo: null, // index of the soloed light, or null when solo mode is off
  raw: new Map(), // "universe:channel" -> value
};
// One 512-channel frame per console universe, filled in by applyConfig.
const frames = {};
let frame = null; // the universe setCh writes to right now
let lastSentKey = '', lastSendMs = 0, dragging = false;
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
  if (FIXTURES.length) {
    buildFrame();
    pushFrame();
  }
  drawPad();
}

// ---------- DMX frame ----------
function setCh(ch, v) { if (ch != null && ch >= 1 && ch <= 512) frame[ch - 1] = Math.round(v) | 0; }
function put16(ch, fineCh, v01) {
  const v = Math.round(Math.min(1, Math.max(0, v01)) * 65535);
  setCh(ch, v >> 8);
  setCh(fineCh, v & 0xff);
}

// Gobo wheel value. Each slot has a range slotWidth values wide; the middle
// of the range is used.
function goboWheelValue(T, look) {
  const g = T.gobo;
  if (look.gobo === 0 || look.gobo > g.slots) return g.openValue;
  const first = look.goboMode === 'spin' ? g.spinFirst : g.indexFirst;
  return first + g.slotWidth * (look.gobo - 1) + Math.floor(g.slotWidth / 2);
}
// Gobo rotation value: angle in index mode, speed in spin mode.
// Ranges are [slow or 0°, fast or 360°] as DMX values.
function goboRotValue(T, look) {
  const r = T.goboRotation;
  const along = ([a, b], t) => a + t * (b - a);
  if (look.gobo === 0) return r.indexRange[0];
  if (look.goboMode === 'index') return along(r.indexRange, look.goboAngle / 360);
  const s = look.goboSpin;
  if (s === 0) return r.stop;
  return s > 0 ? along(r.forwardRange, s / 100) : along(r.backwardRange, -s / 100);
}

// Solo mode: the soloed light flashes full white about twice a second, with
// a wide open beam, so it's easy to spot. Pan/tilt still follow the pad.
const SOLO_FLASH_MS = 250; // on 250 ms, off 250 ms
function soloLook() {
  const on = Math.floor(millis() / SOLO_FLASH_MS) % 2 === 0;
  return { ...state, dimmer: on ? 255 : 0, beam: 255, washColor: null, gobo: 0, frost: 0 };
}

function buildFrame() {
  // Hot takeover: each frame replaces that WHOLE universe on the desk.
  for (const u of UNIVERSES) frames[u].fill(0);
  const soloing = state.solo != null;
  const look = soloing ? soloLook() : state;
  FIXTURES.forEach((f, i) => {
    frame = frames[f.universe];
    const T = MODELS[f.model], c = T.ch;
    const at = (off) => (off == null ? null : f.address + off);
    for (const [off, v] of Object.entries(T.defaults)) setCh(f.address + Number(off), v);
    // Lights not in use stay parked at their defaults (centre) and dark.
    if (soloing ? i !== state.solo : !state.selected.has(i)) return;

    put16(at(c.pan), at(c.panFine), f.invertPan ? 1 - look.pan : look.pan);
    put16(at(c.tilt), at(c.tiltFine), look.tilt);
    setCh(at(c.dimmer), look.dimmer);
    if (T.shutterOpen != null) setCh(at(c.shutter), T.shutterOpen);
    setCh(at(c.zoom), T.zoomZeroIsWide ? 255 - look.beam : look.beam);
    setCh(at(c.colorMacro), look.washColor ?? T.colorMacroWhite ?? 0);
    if (T.gobo) setCh(at(c.goboWheel), goboWheelValue(T, look));
    if (T.goboRotation) setCh(at(c.goboRot), goboRotValue(T, look));
    setCh(at(c.focus), look.focus);
    setCh(at(c.frost), look.frost);
  });
  state.raw.forEach((v, key) => {
    const [u, ch] = key.split(':').map(Number);
    if (frames[u] && !isControlChannel(u, ch)) { frame = frames[u]; setCh(ch, v); }
  });
}

function isControlChannel(u, ch) {
  return FIXTURES.some((f) => f.universe === u && f.address + MODELS[f.model].ch.control === ch);
}

function pushFrame() {
  const now = millis();
  if (now - lastSendMs < 33) return;
  // Only universes switched to "take over" are sent; the rest stay with the desk.
  const out = {};
  for (const u of UNIVERSES) if (takeover.has(u)) out[u] = frames[u];
  const key = JSON.stringify(out);
  if (key === lastSentKey) return;
  lastSentKey = key; lastSendMs = now;
  send({ type: 'frames', frames: out });
  updatePeek();
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
  ws.onopen = () => { connected = true; lastSentKey = ''; updateStatus(); };
  ws.onclose = () => { connected = false; sending = false; updateStatus(); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'config') {
      const json = JSON.stringify(m);
      if (configJson && json !== configJson) location.reload(); // bridge restarted with a new config
      else if (!configJson) { configJson = json; applyConfig(m); }
    }
    if (m.type === 'status') { sending = m.sending; updateStatus(m); }
  };
}
function send(msg) { if (connected && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// ---------- UI ----------
function el(id) { return document.getElementById(id); }

function buildUi() {
  const ub = el('universes');
  UNIVERSES.forEach((u) => {
    const lab = document.createElement('label');
    lab.className = 'check';
    lab.innerHTML = `<input type="checkbox"${takeover.has(u) ? ' checked' : ''}> Universe ${u}`;
    lab.querySelector('input').onchange = (e) => {
      e.target.checked ? takeover.add(u) : takeover.delete(u);
      updateSoloId();
    };
    ub.appendChild(lab);
  });

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
      lab.innerHTML = `<input type="checkbox" data-i="${i}"${state.selected.has(i) ? ' checked' : ''}> <span></span> <span class="small"></span>`;
      lab.querySelectorAll('span')[0].textContent = f.name;
      lab.querySelectorAll('span')[1].textContent = `${f.universe}-${String(f.address).padStart(3, '0')}`;
      lab.dataset.i = i;
      lab.querySelector('input').onchange = (e) => {
        e.target.checked ? state.selected.add(i) : state.selected.delete(i);
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
        FIXTURES.forEach((f, i) => {
          if (f.model !== key) return;
          btn.dataset.mode === 'all' ? state.selected.add(i) : state.selected.delete(i);
        });
        document.querySelectorAll('input[data-i]').forEach((cb) => (cb.checked = state.selected.has(+cb.dataset.i)));
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

  el('toggle-send').onclick = () => send({ type: 'send', on: !sending });
  el('blackout').onclick = () => {
    state.dimmer = 0; el('dimmer').value = 0; el('dimmer-out').textContent = 0;
    state.raw.clear(); renderRaw();
    if (state.solo != null) setSolo(null);
  };

  // Solo mode starts on the first ticked light, or the top of the list.
  el('solo').onchange = (e) => {
    const firstTicked = displayOrder.find((i) => state.selected.has(i));
    setSolo(e.target.checked ? firstTicked ?? displayOrder[0] : null);
  };
  document.addEventListener('keydown', (e) => {
    if (state.solo == null || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    // Leave arrow keys alone in sliders, number fields, lists and radio buttons.
    if (e.target.matches('input:not([type=checkbox]), select, textarea')) return;
    e.preventDefault();
    const at = displayOrder.indexOf(state.solo), n = displayOrder.length;
    setSolo(displayOrder[(at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]);
  });

  const rawKey = () => `${el('raw-uni').value}:${parseInt(el('raw-ch').value, 10)}`;
  const applyRaw = () => {
    const u = +el('raw-uni').value, ch = parseInt(el('raw-ch').value, 10);
    const v = parseInt(el('raw-val').value, 10);
    el('raw-out').textContent = v;
    if (isControlChannel(u, ch)) {
      el('raw-list').textContent = `${u}-${ch} is a head's control channel (resets/settings), so it's blocked.`;
      return;
    }
    if (ch >= 1 && ch <= 512) { state.raw.set(rawKey(), v); renderRaw(); }
  };
  el('raw-val').oninput = applyRaw;
  el('raw-ch').onchange = el('raw-uni').onchange = () => {
    const v = state.raw.get(rawKey()) ?? 0;
    el('raw-val').value = v; el('raw-out').textContent = v;
  };
  el('raw-clear').onclick = () => { state.raw.clear(); renderRaw(); };
}

function setSolo(i) {
  state.solo = i;
  el('solo').checked = i != null;
  document.body.classList.toggle('solo-mode', i != null);
  document.querySelectorAll('.group label').forEach((lab) => {
    lab.classList.toggle('solo', i != null && +lab.dataset.i === i);
  });
  updateSoloId();
  updatePeek();
}

// Shows which light is soloed, and why it might not be visible in the room.
function updateSoloId() {
  const box = el('solo-id');
  if (state.solo == null) { box.hidden = true; return; }
  const f = FIXTURES[state.solo];
  box.hidden = false;
  el('solo-name').textContent = `${f.name}, ${f.universe}-${String(f.address).padStart(3, '0')}`;
  el('solo-note').textContent = !takeover.has(f.universe)
    ? `Universe ${f.universe} isn't ticked under "Universes to take over", so this light isn't being sent.`
    : !sending ? 'Press "Take control" to see it flash.' : '';
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
  conn.textContent = connected ? 'Bridge connected' : 'Bridge not running. Start it with: node bridge.js <desk-ip> <universe>';
  if (sending && s) {
    out.className = 'live';
    const unis = (s.universes || []).map((x) => `${x.desk} (Art-Net ${x.artnet})`).join(', ') || 'none ticked';
    out.textContent = `Controlling the desk at ${s.consoleIp}. Universes: ${unis}. ${s.packetsSent} packets`;
  } else {
    out.className = '';
    out.textContent = connected ? 'Desk in control (nothing sent)' : '';
  }
  if (s && s.lastError) out.textContent += `  Error: ${s.lastError}`;
  btn.textContent = sending ? 'Release to desk' : 'Take control';
  if (FIXTURES.length) updateSoloId();
  btn.classList.toggle('live', sending);
}

// Shows the named channels of the first selected head, as sent.
function updatePeek() {
  const i = state.solo ?? [...state.selected][0];
  if (i == null) { el('peek').textContent = 'No head selected'; return; }
  const f = FIXTURES[i], T = MODELS[f.model];
  const names = { ...T.names };
  for (const [name, off] of Object.entries(T.ch)) names[off] = name;
  const lines = Object.keys(names).map(Number).sort((a, b) => a - b)
    .map((off) => `${f.universe}-${f.address + off} ${names[off]}: ${frames[f.universe][f.address - 1 + off]}`);
  const note = takeover.has(f.universe) ? '' : `  (universe ${f.universe} not taken over: not sent)`;
  el('peek').textContent = `${f.name} (${T.label})${note}\n` + lines.join('\n');
}
