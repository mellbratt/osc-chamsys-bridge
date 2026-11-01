// =====================================================================
//  RIG CONFIG: moving heads from the QuickQ patch
// =====================================================================
// Desk address "2-106" = desk universe 2, address 106. Start the bridge with
// the Art-Net universe the desk shows for universe 1 (usually 0); desk
// universe 2 then goes out as the next Art-Net universe.

// Channel layouts as offsets from the fixture's start address (0 = 1st channel).
// Sources: Prolights user manuals, Jet Wash7 (rev 04/22) and
// Jet Profile300LT (rev 11/25), DMX mode "Standard".
const TYPES = {
  wash7: {
    label: 'Jet Wash 7',
    ch: {
      pan: 0, panFine: 1, tilt: 2, tiltFine: 3, dimmer: 4, shutter: 6,
      colorMacro: 18, zoom: 20,
      control: 22, // fixture settings/resets: never written by this sketch
    },
    names: { 8: 'tint', 9: 'crossfade', 10: 'red', 12: 'green', 14: 'blue', 16: 'white' },
    zoomZeroIsWide: true, // ch 21: wide -> narrow
    shutterOpen: 255,     // ch 7: 0-1 closed, 252-255 open
    // Manual defaults for channels the sketch doesn't drive (offset: value)
    defaults: {
      0: 128, 1: 128, 2: 128, 3: 128,  // pan/tilt centre
      8: 128,                          // tint balanced
      9: 255,                          // crossfade -> RGBW
      10: 255, 11: 255, 12: 255, 13: 255, 14: 255, 15: 255, 16: 255, 17: 255, // RGBW full = white
      20: 128, 21: 128,                // zoom middle
    },
  },

  profile300: {
    label: 'Jet Profile300LT',
    ch: {
      pan: 0, panFine: 1, tilt: 2, tiltFine: 3, dimmer: 4, shutter: 6,
      goboWheel: 13, goboRot: 14, frost: 20, zoom: 21, focus: 23,
      control: 37, // fixture settings/resets: never written by this sketch
    },
    names: {},
    zoomZeroIsWide: false, // ch 22: min -> max beam angle
    shutterOpen: 255,      // ch 7: 252-255 open (126-127 closed)
    defaults: {
      0: 128, 2: 128,                  // pan/tilt centre
      21: 128, 23: 128,                // zoom, focus middle
      28: 128, 30: 128, 32: 128, 34: 128, // blade swivels at 0°
      35: 128,                         // frame rotation 0°
    },
  },
};

const FIXTURES = [
  // Desk universe 1
  { name: 'Wash 26', type: 'wash7', universe: 1, address: 61 },
  { name: 'Wash 27', type: 'wash7', universe: 1, address: 122 },
  { name: 'Wash 28', type: 'wash7', universe: 1, address: 183 },
  { name: 'Wash 29', type: 'wash7', universe: 1, address: 215 },
  { name: 'Wash 30', type: 'wash7', universe: 1, address: 277 },
  { name: 'Wash 31', type: 'wash7', universe: 1, address: 338 },
  { name: 'Wash 32', type: 'wash7', universe: 1, address: 371 },
  { name: 'Profile 17', type: 'profile300', universe: 1, address: 239 },
  { name: 'Profile 18', type: 'profile300', universe: 1, address: 300 },
  { name: 'Profile 19', type: 'profile300', universe: 1, address: 394 },
  // Desk universe 2
  { name: 'Profile 20', type: 'profile300', universe: 2, address: 1 },
  { name: 'Profile 21', type: 'profile300', universe: 2, address: 106 },
  { name: 'Profile 22', type: 'profile300', universe: 2, address: 167 },
  { name: 'Profile 23', type: 'profile300', universe: 2, address: 259 },
  { name: 'Profile 24', type: 'profile300', universe: 2, address: 297 },
  { name: 'Profile 25', type: 'profile300', universe: 2, address: 335 },
  { name: 'Wash 37', type: 'wash7', universe: 2, address: 205 },
  { name: 'Wash 38', type: 'wash7', universe: 2, address: 393 },
  { name: 'Wash 39', type: 'wash7', universe: 2, address: 416 },
  { name: 'Wash 40', type: 'wash7', universe: 2, address: 439 },
  { name: 'Wash 41', type: 'wash7', universe: 2, address: 472 },
];
// Not in the patch photos, so not included: fixtures 11-16 and Washes 33-36.
// Add them here once you know their universe and address.
// Static lights (EclPars, Fresnels) have no layout here and stay dark on
// any universe the sketch has taken over.

// Which desk universes the sketch takes over when you press "Take control".
// Toggled on the page; universe 2 starts with the desk.
const UNIVERSES = [1, 2];
const takeover = new Set([1]);

// Pan Invert is ticked for every moving head on the desk; mirror that.
const INVERT_PAN = true;

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
  selected: new Set([0]), // start with only Wash 26
  raw: new Map(), // "universe:channel" -> value
};
// One 512-channel frame per desk universe.
const frames = Object.fromEntries(UNIVERSES.map((u) => [u, new Array(512).fill(0)]));
let frame = frames[UNIVERSES[0]]; // the universe setCh writes to right now
let lastSentKey = '', lastSendMs = 0, dragging = false;

function setup() {
  const holder = document.getElementById('pad-holder');
  const size = Math.min(holder.clientWidth || 400, 440);
  const c = createCanvas(size, size);
  c.parent(holder);
  const startDrag = () => { dragging = true; state.sweep = false; el('sweep').checked = false; };
  c.mousePressed(startDrag);
  c.touchStarted(() => { startDrag(); return false; });
  buildUi();
  connect();
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
  buildFrame();
  pushFrame();
  drawPad();
}

// ---------- DMX frame ----------
function setCh(ch, v) { if (ch != null && ch >= 1 && ch <= 512) frame[ch - 1] = Math.round(v) | 0; }
function put16(ch, fineCh, v01) {
  const v = Math.round(Math.min(1, Math.max(0, v01)) * 65535);
  setCh(ch, v >> 8);
  setCh(fineCh, v & 0xff);
}

// Gobo wheel channel (Profile300LT ch 14). Each slot range is 8 values wide;
// +4 picks the middle of the range.
function goboWheelValue() {
  if (state.gobo === 0) return 0;                    // open: 0-11
  const base = state.goboMode === 'spin' ? 68 : 12;  // rotation: 68-123, indexing: 12-67
  return base + 8 * (state.gobo - 1) + 4;
}
// Gobo rotation channel (ch 15): angle in index mode, speed in spin mode.
function goboRotValue() {
  if (state.gobo === 0) return 0;
  if (state.goboMode === 'index') return (state.goboAngle / 360) * 255; // 0-360°
  const s = state.goboSpin;
  if (s === 0) return 128;                         // no rotation
  if (s > 0) return 127 - (s / 100) * 126;         // forward: 127 slow -> 1 fast
  return 129 + (-s / 100) * 126;                   // backward: 129 slow -> 255 fast
}

function buildFrame() {
  // Hot takeover: each frame replaces that WHOLE universe on the desk.
  for (const u of UNIVERSES) frames[u].fill(0);
  FIXTURES.forEach((f, i) => {
    frame = frames[f.universe];
    const T = TYPES[f.type], c = T.ch;
    const at = (off) => (off == null ? null : f.address + off);
    for (const [off, v] of Object.entries(T.defaults)) setCh(f.address + Number(off), v);
    if (!state.selected.has(i)) return; // unselected: parked at centre, dark

    put16(at(c.pan), at(c.panFine), INVERT_PAN ? 1 - state.pan : state.pan);
    put16(at(c.tilt), at(c.tiltFine), state.tilt);
    setCh(at(c.dimmer), state.dimmer);
    setCh(at(c.shutter), T.shutterOpen);
    setCh(at(c.zoom), T.zoomZeroIsWide ? 255 - state.beam : state.beam);
    if (c.colorMacro != null) setCh(at(c.colorMacro), state.washColor);
    if (c.goboWheel != null) {
      setCh(at(c.goboWheel), goboWheelValue());
      setCh(at(c.goboRot), goboRotValue());
      setCh(at(c.focus), state.focus);
      setCh(at(c.frost), state.frost);
    }
  });
  state.raw.forEach((v, key) => {
    const [u, ch] = key.split(':').map(Number);
    if (frames[u] && !isControlChannel(u, ch)) { frame = frames[u]; setCh(ch, v); }
  });
}

function isControlChannel(u, ch) {
  return FIXTURES.some((f) => f.universe === u && f.address + TYPES[f.type].ch.control === ch);
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
    };
    ub.appendChild(lab);
  });

  // Fixture checkboxes, grouped by type
  for (const type of Object.keys(TYPES)) {
    const box = el('group-' + type);
    FIXTURES.forEach((f, i) => {
      if (f.type !== type) return;
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="checkbox" data-i="${i}"${state.selected.has(i) ? ' checked' : ''}> ${f.name} <span class="small">${f.universe}-${String(f.address).padStart(3, '0')}</span>`;
      lab.querySelector('input').onchange = (e) => {
        e.target.checked ? state.selected.add(i) : state.selected.delete(i);
      };
      box.appendChild(lab);
    });
  }
  document.querySelectorAll('[data-select]').forEach((btn) => {
    btn.onclick = () => {
      const [type, mode] = btn.dataset.select.split(':');
      FIXTURES.forEach((f, i) => {
        if (f.type !== type) return;
        mode === 'all' ? state.selected.add(i) : state.selected.delete(i);
      });
      document.querySelectorAll('input[data-i]').forEach((cb) => (cb.checked = state.selected.has(+cb.dataset.i)));
    };
  });

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
  };

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
  btn.classList.toggle('live', sending);
}

// Shows the named channels of the first selected head, as sent.
function updatePeek() {
  const i = [...state.selected][0];
  if (i == null) { el('peek').textContent = 'No head selected'; return; }
  const f = FIXTURES[i], T = TYPES[f.type];
  const names = { ...T.names };
  for (const [name, off] of Object.entries(T.ch)) names[off] = name;
  const lines = Object.keys(names).map(Number).sort((a, b) => a - b)
    .map((off) => `${f.universe}-${f.address + off} ${names[off]}: ${frames[f.universe][f.address - 1 + off]}`);
  const note = takeover.has(f.universe) ? '' : `  (universe ${f.universe} not taken over: not sent)`;
  el('peek').textContent = `${f.name} (${T.label})${note}\n` + lines.join('\n');
}
