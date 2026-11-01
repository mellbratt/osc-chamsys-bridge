// Light map: a top-down plan of the room, drawn as SVG. Units are metres,
// x to the right and y down the page. A light's facing is in degrees,
// clockwise from the top of the map.
//
// Uses from sketch.js: FIXTURES, MODELS, state, displayOrder, setSolo, send, el.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_SNAP = 0.1;       // metres: positions and shapes snap to this
const ARROW_LENGTH = 1.5;   // metres: arrow length when a light points sideways
const SYMBOL_ORDER = ['circle', 'triangle', 'square', 'diamond'];

const mapView = {
  map: null,
  canEdit: false,
  editing: false,
  tool: 'move',     // 'move' | 'rect' | 'line' | 'place'
  picked: null,     // { kind: 'light', name } or { kind: 'shape', index } while editing
  drag: null,
  output: { sending: false, frames: {} }, // what the bridge is sending, for all clients
  lastRender: 0,
  // Each save gets an id. The bridge sends every saved map back with its id;
  // this page ignores its own older saves arriving after a newer local change.
  clientId: Math.random().toString(36).slice(2),
  saveCount: 0,
  pendingSave: null,
};

// ---------- Set-up and messages from the bridge ----------

function initMap(map, canEdit) {
  mapView.map = map;
  mapView.canEdit = canEdit;
  el('map-tools').hidden = !canEdit;
  const svg = el('map');
  svg.addEventListener('pointerdown', onMapDown);
  svg.addEventListener('pointermove', onMapMove);
  svg.addEventListener('pointerup', onMapUp);
  svg.addEventListener('pointercancel', onMapUp);

  el('map-edit').onchange = (e) => setEditing(e.target.checked);
  document.querySelectorAll('input[name=map-tool]').forEach((r) => {
    r.onchange = () => setTool(r.value);
  });
  el('map-width').onchange = el('map-height').onchange = () => {
    const w = parseFloat(el('map-width').value), h = parseFloat(el('map-height').value);
    if (w > 0 && h > 0) { mapView.map.width = w; mapView.map.height = h; saveMap(); }
  };
  el('map-rotate-left').onclick = () => turnPicked(-15);
  el('map-rotate-right').onclick = () => turnPicked(15);
  el('map-facing').onchange = (e) => {
    const p = pickedLightPos();
    if (p) { p.facing = normAngle(parseFloat(e.target.value) || 0); saveMap(); }
  };
  el('map-delete').onclick = deletePicked;
  document.addEventListener('keydown', (e) => {
    if (!mapView.editing || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    if (e.target.matches('input, select, textarea')) return;
    e.preventDefault();
    deletePicked();
  });
  renderMap(true);
}

function mapFromBridge(map, id) {
  const mine = typeof id === 'string' && id.startsWith(mapView.clientId + ':');
  if (mine && mapView.pendingSave && id !== mapView.pendingSave) return; // an older save of ours
  if (id === mapView.pendingSave) mapView.pendingSave = null;
  if (mapView.drag) return; // don't jump while dragging; our own save follows
  mapView.map = map;
  if (mapView.picked && !pickedExists()) mapView.picked = null;
  renderMap(true);
}

function outputFromBridge(msg) {
  mapView.output = msg;
}

function saveMap() {
  mapView.pendingSave = `${mapView.clientId}:${++mapView.saveCount}`;
  send({ type: 'map', map: mapView.map, id: mapView.pendingSave });
  renderMap(true);
}

// ---------- Editing ----------

function setEditing(on) {
  mapView.editing = on;
  el('map-edit').checked = on;
  el('map-edit-tools').hidden = !on;
  if (!on) { setTool('move'); mapView.picked = null; }
  el('map-width').value = mapView.map.width;
  el('map-height').value = mapView.map.height;
  renderMap(true);
}

function setTool(tool) {
  const was = mapView.tool;
  mapView.tool = tool;
  document.querySelectorAll('input[name=map-tool]').forEach((r) => (r.checked = r.value === tool));
  mapView.picked = null;
  if (tool === 'place') {
    // Solo the first light not yet on the map, or the first light if all are
    // placed. Lights someone else is controlling are skipped.
    const usable = displayOrder.filter((i) => !otherOwner(i));
    const next = usable.find((i) => !mapView.map.lights[FIXTURES[i].name]);
    const start = next ?? usable[0];
    if (start != null) setSolo(start);
    else mapNote('Every light is being controlled by someone else, so none can flash for placing.');
  } else if (was === 'place') {
    setSolo(null);
  }
  renderMap(true);
}

function placeSoloedLight(pt) {
  if (state.solo == null) return;
  const name = FIXTURES[state.solo].name;
  const old = mapView.map.lights[name];
  mapView.map.lights[name] = { x: pt.x, y: pt.y, facing: old ? old.facing : 0 };
  saveMap();
  // Move on to the next light that isn't on the map yet.
  const at = displayOrder.indexOf(state.solo);
  const rest = [...displayOrder.slice(at + 1), ...displayOrder.slice(0, at)];
  const next = rest.find((i) => !mapView.map.lights[FIXTURES[i].name] && !otherOwner(i));
  if (next != null) setSolo(next);
  else if (FIXTURES.some((f) => !mapView.map.lights[f.name])) {
    setTool('move');
    mapNote('The lights not on the map yet are being controlled by someone else. Place them once they are free.');
  } else { setTool('move'); mapNote('Every light is on the map. Turn each one to match the way it faces.'); }
}

function pickedLightPos() {
  const p = mapView.picked;
  return p && p.kind === 'light' ? mapView.map.lights[p.name] : null;
}
function pickedExists() {
  const p = mapView.picked;
  return p.kind === 'light' ? !!mapView.map.lights[p.name] : !!mapView.map.shapes[p.index];
}
function turnPicked(by) {
  const p = pickedLightPos();
  if (p) { p.facing = normAngle(p.facing + by); saveMap(); }
}
function deletePicked() {
  const p = mapView.picked;
  if (!p) return;
  if (p.kind === 'light') delete mapView.map.lights[p.name];
  else mapView.map.shapes.splice(p.index, 1);
  mapView.picked = null;
  saveMap();
}

// ---------- Pointer handling ----------

function mapPoint(e) {
  const svg = el('map');
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: snap(p.x), y: snap(p.y) };
}

function onMapDown(e) {
  if (!mapView.map) return;
  const pt = mapPoint(e);
  const lightEl = e.target.closest('[data-light]');
  const shapeEl = e.target.closest('[data-shape]');
  const lightIndex = lightEl ? FIXTURES.findIndex((f) => f.name === lightEl.dataset.light) : -1;

  if (!mapView.editing) {
    if (lightIndex < 0) return;
    // Same as the list: solo it in solo mode, otherwise add or remove it.
    if (state.solo != null) setSolo(lightIndex);
    else toggleSelected(lightIndex);
    renderMap(true);
    return;
  }

  e.preventDefault();
  el('map').setPointerCapture(e.pointerId);
  if (mapView.tool === 'place') {
    // Clicking a light that's already placed solos it, so it can be re-placed.
    if (lightIndex >= 0 && lightIndex !== state.solo) setSolo(lightIndex);
    else placeSoloedLight(pt);
    return;
  }
  if (mapView.tool === 'rect' || mapView.tool === 'line') {
    mapView.drag = { kind: 'draw', from: pt, to: pt };
    return;
  }
  // Move tool: pick a light or shape and drag it.
  if (lightEl && mapView.map.lights[lightEl.dataset.light]) {
    mapView.picked = { kind: 'light', name: lightEl.dataset.light };
  } else if (shapeEl) {
    mapView.picked = { kind: 'shape', index: +shapeEl.dataset.shape };
  } else {
    mapView.picked = null;
  }
  mapView.drag = mapView.picked ? { kind: 'move', last: pt, moved: false } : null;
  renderMap(true);
}

function onMapMove(e) {
  const d = mapView.drag;
  if (!d) return;
  const pt = mapPoint(e);
  if (d.kind === 'draw') { d.to = pt; renderMap(true); return; }
  const dx = pt.x - d.last.x, dy = pt.y - d.last.y;
  if (!dx && !dy) return;
  d.last = pt; d.moved = true;
  const p = mapView.picked;
  if (p.kind === 'light') {
    const pos = mapView.map.lights[p.name];
    pos.x = snap(pos.x + dx); pos.y = snap(pos.y + dy);
  } else {
    const sh = mapView.map.shapes[p.index];
    for (const k of sh.type === 'rect' ? ['x'] : ['x1', 'x2']) sh[k] = snap(sh[k] + dx);
    for (const k of sh.type === 'rect' ? ['y'] : ['y1', 'y2']) sh[k] = snap(sh[k] + dy);
  }
  renderMap(true);
}

function onMapUp() {
  const d = mapView.drag;
  mapView.drag = null;
  if (!d) return;
  if (d.kind === 'draw') {
    const { from: a, to: b } = d;
    const shape = mapView.tool === 'rect'
      ? { type: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: snap(Math.abs(b.x - a.x)), h: snap(Math.abs(b.y - a.y)) }
      : { type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const big = shape.type === 'rect' ? shape.w > 0 && shape.h > 0 : Math.hypot(b.x - a.x, b.y - a.y) > 0;
    if (big) {
      mapView.map.shapes.push(shape);
      mapView.picked = { kind: 'shape', index: mapView.map.shapes.length - 1 };
      saveMap();
    } else renderMap(true);
  } else if (d.moved) {
    saveMap();
  }
}

// ---------- Live values ----------

// Brightness, colour and direction of a light, from what the bridge is
// sending. Null when the console is in control of the light's universe.
function liveLight(f) {
  const fr = mapView.output.sending && mapView.output.frames[f.universe];
  if (!fr) return null;
  const T = MODELS[f.model], c = T.ch;
  const v = (off) => (off == null ? null : fr[f.address - 1 + off]);
  const v16 = (hi, lo) => (v(hi) == null ? null : (v(hi) * 256 + (v(lo) ?? 0)) / 65535);
  const level = c.dimmer != null ? v(c.dimmer) / 255 : 1;
  let rgb = [255, 236, 200]; // warm white when the colour is unknown
  if (c.red != null && c.green != null && c.blue != null) {
    const w = v(c.white) ?? 0;
    rgb = [v(c.red), v(c.green), v(c.blue)].map((x) => Math.min(255, x + w));
  }
  return { level, rgb, pan: v16(c.pan, c.panFine), tilt: v16(c.tilt, c.tiltFine) };
}

// Arrow from the light to where it points, in metres, or null if unknown.
// Pan and tilt centre = pointing straight down (hanging) or up (standing),
// with the head tipped towards the light's facing for tilt above centre.
function aimVector(f, pos, live) {
  const T = MODELS[f.model];
  if (!live || live.pan == null || live.tilt == null || !T.panDegrees || !T.tiltDegrees) return null;
  const pan = f.invertPan ? 1 - live.pan : live.pan;
  const panAngle = (pan - 0.5) * T.panDegrees * (f.mounting === 'standing' ? -1 : 1);
  const tiltAngle = (live.tilt - 0.5) * T.tiltDegrees;
  const out = Math.sin(rad(tiltAngle)); // how far from straight down/up, -1..1
  const dir = rad(pos.facing + panAngle);
  return { dx: Math.sin(dir) * out * ARROW_LENGTH, dy: -Math.cos(dir) * out * ARROW_LENGTH };
}

// ---------- Drawing ----------

function renderMap(now) {
  if (!mapView.map) return;
  const t = Date.now();
  if (!now && t - mapView.lastRender < 100) return;
  mapView.lastRender = t;
  const { width: W, height: H } = mapView.map;
  const svg = el('map');
  svg.setAttribute('viewBox', `-0.6 -0.6 ${W + 1.2} ${H + 1.2}`);
  svg.classList.toggle('editing', mapView.editing);
  svg.dataset.tool = mapView.tool;
  const g = el('map-content');
  g.replaceChildren();

  add(g, 'rect', { x: 0, y: 0, width: W, height: H, class: 'map-room' });
  for (let x = 1; x < W; x++) add(g, 'line', { x1: x, y1: 0, x2: x, y2: H, class: 'map-grid' });
  for (let y = 1; y < H; y++) add(g, 'line', { x1: 0, y1: y, x2: W, y2: y, class: 'map-grid' });

  mapView.map.shapes.forEach((sh, i) => {
    const picked = mapView.picked && mapView.picked.kind === 'shape' && mapView.picked.index === i;
    const attrs = { 'data-shape': i, class: `map-shape${picked ? ' picked' : ''}` };
    if (sh.type === 'rect') add(g, 'rect', { ...attrs, x: sh.x, y: sh.y, width: sh.w, height: sh.h });
    else add(g, 'line', { ...attrs, x1: sh.x1, y1: sh.y1, x2: sh.x2, y2: sh.y2 });
  });

  const d = mapView.drag;
  if (d && d.kind === 'draw') {
    const { from: a, to: b } = d;
    if (mapView.tool === 'rect') {
      add(g, 'rect', { class: 'map-shape drawing', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
    } else add(g, 'line', { class: 'map-shape drawing', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }

  const unplaced = [];
  const modelKeys = Object.keys(MODELS);
  FIXTURES.forEach((f, i) => {
    const pos = mapView.map.lights[f.name];
    if (!pos) { unplaced.push(f.name); return; }
    const T = MODELS[f.model];
    const live = liveLight(f);
    const soloed = state.solo === i;
    const selected = state.solo == null && state.selected.has(i);
    const picked = mapView.picked && mapView.picked.kind === 'light' && mapView.picked.name === f.name;
    const who = otherOwner(i);
    const cls = ['map-light', soloed && 'soloed', selected && 'selected', picked && 'picked', who && 'busy'].filter(Boolean).join(' ');
    const lg = add(g, 'g', { class: cls, 'data-light': f.name, transform: `translate(${pos.x} ${pos.y})` });
    add(lg, 'title', {}).textContent = who ? `${f.name}: being controlled by ${who}` : f.name;

    if (live && live.level > 0) {
      const [r, gg, b] = live.rgb;
      add(lg, 'circle', { r: 0.7, class: 'map-glow', fill: `rgb(${r},${gg},${b})`, 'fill-opacity': (0.15 + 0.6 * live.level).toFixed(2) });
    }
    const aim = aimVector(f, pos, live);
    if (aim) add(lg, 'line', { x1: 0, y1: 0, x2: aim.dx, y2: aim.dy, class: 'map-aim' });
    if (mapView.editing) {
      // Short tick showing which way the light's front faces.
      const fd = rad(pos.facing);
      add(lg, 'line', { x1: 0, y1: 0, x2: Math.sin(fd) * 0.45, y2: -Math.cos(fd) * 0.45, class: 'map-facing' });
    }
    if (soloed || selected || picked) add(lg, 'circle', { r: 0.42, class: 'map-ring' });
    const symbol = T.symbol || SYMBOL_ORDER[modelKeys.indexOf(f.model) % SYMBOL_ORDER.length];
    drawSymbol(lg, symbol, 0.24);
    const label = add(lg, 'text', { y: 0.68, class: 'map-name' });
    label.textContent = f.name;
    const addr = add(lg, 'text', { y: 1.02, class: 'map-addr' });
    addr.textContent = `${f.universe}-${String(f.address).padStart(3, '0')}`;
  });

  // Text under the map
  const status = [];
  if (!mapView.output.sending) status.push('The console is in control, so the map shows no live brightness or direction.');
  if (unplaced.length) status.push(`Not on the map yet: ${unplaced.join(', ')}.`);
  const noRange = [...new Set(FIXTURES.map((f) => MODELS[f.model]).filter((T) => !T.panDegrees || !T.tiltDegrees).map((T) => T.label))];
  if (noRange.length) status.push(`No direction arrow for ${noRange.join(', ')}: set panDegrees and tiltDegrees in the config.`);
  el('map-status').textContent = status.join(' ');

  // Edit panel for the picked item
  const p = mapView.picked;
  el('map-picked').hidden = !p;
  el('map-light-tools').hidden = !(p && p.kind === 'light');
  if (p) {
    el('map-picked-name').textContent = p.kind === 'light' ? p.name : (mapView.map.shapes[p.index].type === 'rect' ? 'Rectangle' : 'Line');
    el('map-delete').textContent = p.kind === 'light' ? 'Remove from map' : 'Delete shape';
    if (p.kind === 'light' && document.activeElement !== el('map-facing')) el('map-facing').value = Math.round(pickedLightPos().facing);
  }
  el('map-place-hint').hidden = !(mapView.editing && mapView.tool === 'place');
}

function drawSymbol(parent, symbol, r) {
  if (symbol === 'square') return add(parent, 'rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, class: 'map-symbol' });
  if (symbol === 'triangle') {
    return add(parent, 'polygon', { points: `0,${-r * 1.2} ${r * 1.1},${r * 0.8} ${-r * 1.1},${r * 0.8}`, class: 'map-symbol' });
  }
  if (symbol === 'diamond') return add(parent, 'polygon', { points: `0,${-r * 1.3} ${r * 1.3},0 0,${r * 1.3} ${-r * 1.3},0`, class: 'map-symbol' });
  return add(parent, 'circle', { r, class: 'map-symbol' });
}

// ---------- Helpers ----------

function add(parent, tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}
function mapNote(text) { el('map-note').textContent = text; }
function snap(v) { return Math.round(Math.round(v / MAP_SNAP) * MAP_SNAP * 1000) / 1000; }
function rad(deg) { return (deg * Math.PI) / 180; }
function normAngle(a) { return ((a % 360) + 360) % 360; }
