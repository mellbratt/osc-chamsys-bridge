// Light map: a top-down plan of the room, drawn as SVG. Units are metres,
// x to the right and y down the page. A light's facing is in degrees,
// clockwise from the top of the map.
//
// Uses from sketch.js: FIXTURES, MODELS, state, displayOrder, setSolo, send, el.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_SNAP = 0.1;       // metres: positions and shapes snap to this
const ARROW_LENGTH = 1.2;   // metres: arrow length when a light points sideways
const SYMBOL_ORDER = ['circle', 'triangle', 'square', 'diamond'];
const SYMBOL_R = 0.24;      // metres: symbol size
const LABEL_SIZE = 0.3;     // metres: label text height

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
  renderLegend();
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
  const rgb = Colour.displayRgb(T, (role) => v(c[role])).map(Math.round);
  // A colour preset (macro) is set. Its exact colour isn't known here, so
  // the map marks it instead of guessing. 0-1 means "no preset".
  const macro = c.colorMacro != null && v(c.colorMacro) > 1 ? v(c.colorMacro) : 0;
  return { level, rgb, macro, pan: v16(c.pan, c.panFine), tilt: v16(c.tilt, c.tiltFine) };
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
  const labels = labelLayout();
  // Two passes: arrows first, so no arrow is drawn over another light.
  const lightsLayer = add(g, 'g', {}), aimLayer = add(g, 'g', {});
  g.insertBefore(aimLayer, lightsLayer);
  FIXTURES.forEach((f, i) => {
    const pos = mapView.map.lights[f.name];
    if (!pos) { unplaced.push(f.name); return; }
    const live = liveLight(f);
    const on = !!live && live.level > 0;
    const colour = live ? `rgb(${live.rgb.join(',')})` : null;
    const soloed = state.solo === i;
    const selected = state.solo == null && state.selected.has(i);
    const picked = mapView.picked && mapView.picked.kind === 'light' && mapView.picked.name === f.name;
    const who = otherOwner(i);
    const cls = ['map-light', on ? 'on' : 'off', soloed && 'soloed', selected && 'selected', picked && 'picked', who && 'busy']
      .filter(Boolean).join(' ');
    const lg = add(lightsLayer, 'g', { class: cls, 'data-light': f.name, transform: `translate(${pos.x} ${pos.y})` });
    add(lg, 'title', {}).textContent = lightTooltip(f, live, who);

    // Where it points: an arrow from the edge of the symbol, in the light's colour.
    const aim = aimVector(f, pos, live);
    if (aim && Math.hypot(aim.dx, aim.dy) > 0.15) drawArrow(aimLayer, pos, aim, on ? colour : null);

    // On: a small glow and a symbol filled with its colour, brighter when brighter.
    if (on) add(lg, 'circle', { r: 0.4, class: 'map-glow', fill: colour, 'fill-opacity': (0.2 + 0.4 * live.level).toFixed(2) });
    if (soloed || selected || picked) add(lg, 'circle', { r: 0.47, class: 'map-ring' });
    if (live && live.macro) drawPresetRing(lg);
    if (mapView.editing) {
      // Short tick showing which way the light's front faces.
      const fd = rad(pos.facing);
      add(lg, 'line', { x1: 0, y1: 0, x2: Math.sin(fd) * 0.45, y2: -Math.cos(fd) * 0.45, class: 'map-facing' });
    }
    const sym = drawSymbol(lg, symbolFor(f.model), SYMBOL_R);
    if (on) sym.style.fill = shade(live.rgb, 0.35 + 0.65 * live.level);

    const lab = labels.get(f.name);
    const text = add(lg, 'text', { x: lab.x, y: lab.y, 'text-anchor': lab.anchor, class: 'map-name' });
    text.textContent = lab.text;
  });

  // Text under the map
  const status = [];
  if (!mapView.output.sending) status.push('The console is in control, so the map shows no live brightness or direction.');
  if (unplaced.length) status.push(`Not on the map yet: ${unplaced.join(', ')}.`);
  // Only lights that move need a direction arrow.
  const noRange = [...new Set(FIXTURES.map((f) => MODELS[f.model]).filter((T) => T.ch.pan != null && (!T.panDegrees || !T.tiltDegrees)).map((T) => T.label))];
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

function symbolFor(model) {
  return MODELS[model].symbol || SYMBOL_ORDER[Object.keys(MODELS).indexOf(model) % SYMBOL_ORDER.length];
}

function lightTooltip(f, live, who) {
  const lines = [`${f.name} (${MODELS[f.model].label}), ${f.universe}-${String(f.address).padStart(3, '0')}`];
  if (who) lines.push(`Being controlled by ${who}`);
  if (live) {
    lines.push(live.level > 0 ? `On, ${Math.round(live.level * 100)}%` : 'Off');
    if (live.macro) lines.push(`Colour preset ${live.macro}`);
  }
  return lines.join('\n');
}

// Arrow from the edge of the light's symbol to where it points.
function drawArrow(parent, pos, aim, colour) {
  const len = Math.hypot(aim.dx, aim.dy), ux = aim.dx / len, uy = aim.dy / len;
  const start = SYMBOL_R + 0.12, head = 0.22;
  const x1 = pos.x + ux * start, y1 = pos.y + uy * start;
  const tx = pos.x + ux * (start + len), ty = pos.y + uy * (start + len);
  const cls = colour ? 'map-aim' : 'map-aim dark';
  const style = colour ? `stroke:${colour};fill:${colour}` : '';
  add(parent, 'line', { x1, y1, x2: tx - ux * head * 0.8, y2: ty - uy * head * 0.8, class: cls, style });
  const px = -uy * head * 0.55, py = ux * head * 0.55;
  add(parent, 'polygon', {
    points: `${tx},${ty} ${tx - ux * head + px},${ty - uy * head + py} ${tx - ux * head - px},${ty - uy * head - py}`,
    class: `${cls} head`, style,
  });
}

// A ring of three colours around the symbol: a colour preset is set.
function drawPresetRing(parent) {
  ['#e5484d', '#46a758', '#3e8ef7'].forEach((stroke, k) => {
    add(parent, 'circle', { r: 0.31, class: 'map-preset', stroke, pathLength: 3, 'stroke-dasharray': '1 2', 'stroke-dashoffset': -k });
  });
}

// A colour darkened towards the map background, for dim lights.
function shade(rgb, k) {
  const bg = [27, 33, 48];
  return `rgb(${rgb.map((c, i) => Math.round(bg[i] + (c - bg[i]) * k)).join(',')})`;
}

// ---------- Labels ----------

// Short label for each light: the number in its name when that's unique
// (the symbol already shows the model), else the whole name.
function shortLabels() {
  const num = (name) => (name.match(/(\d+)\s*$/) || [])[1];
  const counts = {};
  FIXTURES.forEach((f) => { const n = num(f.name); if (n) counts[n] = (counts[n] || 0) + 1; });
  return new Map(FIXTURES.map((f) => { const n = num(f.name); return [f.name, n && counts[n] === 1 ? n : f.name]; }));
}

// Places each label next to its light where it covers no other light, label
// or line of the room. Recomputed only when the map changes, so labels don't
// jump around while lights change.
const LABEL_SPOTS = [ // [dx, dy of the text's anchor point, text-anchor], in order of preference
  [0.5, 0.1, 'start'], [-0.5, 0.1, 'end'], [0, -0.5, 'middle'], [0, 0.75, 'middle'],
  [0.34, -0.36, 'start'], [0.34, 0.58, 'start'], [-0.34, -0.36, 'end'], [-0.34, 0.58, 'end'],
];
let labelCache = { key: null, layout: null };

function labelLayout() {
  const map = mapView.map;
  const key = JSON.stringify([map.lights, map.shapes, FIXTURES.map((f) => f.name)]);
  if (labelCache.key === key) return labelCache.layout;

  const texts = shortLabels();
  const placed = FIXTURES.filter((f) => map.lights[f.name]);
  const symbolBox = (p) => ({ x: p.x - 0.3, y: p.y - 0.3, w: 0.6, h: 0.6 });
  const symbols = placed.map((f) => ({ name: f.name, box: symbolBox(map.lights[f.name]) }));
  const segments = [];
  for (const sh of map.shapes) {
    if (sh.type === 'line') segments.push([sh.x1, sh.y1, sh.x2, sh.y2]);
    else {
      const { x, y, w, h } = sh;
      segments.push([x, y, x + w, y], [x + w, y, x + w, y + h], [x, y + h, x + w, y + h], [x, y, x, y + h]);
    }
  }
  const taken = [];
  const layout = new Map();
  // Most crowded lights first, so they get the best spots.
  const crowd = (f) => {
    const p = map.lights[f.name];
    return placed.filter((o) => o !== f && Math.hypot(map.lights[o.name].x - p.x, map.lights[o.name].y - p.y) < 1.5).length;
  };
  for (const f of [...placed].sort((a, b) => crowd(b) - crowd(a))) {
    const p = map.lights[f.name], text = texts.get(f.name);
    const w = text.length * LABEL_SIZE * 0.58 + 0.04, h = LABEL_SIZE;
    let best = null;
    LABEL_SPOTS.forEach(([dx, dy, anchor], k) => {
      const left = anchor === 'start' ? dx : anchor === 'end' ? dx - w : dx - w / 2;
      const box = { x: p.x + left, y: p.y + dy - h * 0.8, w, h };
      let score = k * 0.01;
      for (const s of symbols) if (overlap(box, s.box)) score += 10;
      for (const t of taken) if (overlap(box, t)) score += 10;
      for (const seg of segments) if (segmentHitsBox(seg, box)) score += 4;
      if (!best || score < best.score) best = { score, box, x: dx, y: dy, anchor };
    });
    taken.push(best.box);
    layout.set(f.name, { text, x: best.x, y: best.y, anchor: best.anchor });
  }
  labelCache = { key, layout };
  return layout;
}

function overlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Whether a line segment crosses a box (Liang-Barsky clipping).
function segmentHitsBox([x1, y1, x2, y2], b) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - b.x], [dx, b.x + b.w - x1], [-dy, y1 - b.y], [dy, b.y + b.h - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

// Key under the map: one symbol per model in use, and what the marks mean.
function renderLegend() {
  const box = el('map-legend');
  if (!box) return;
  box.replaceChildren();
  const icon = (draw) => {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '-0.5 -0.5 1 1');
    s.setAttribute('class', 'legend-icon');
    draw(s);
    return s;
  };
  const item = (svg, text) => {
    const span = document.createElement('span');
    span.className = 'legend-item';
    span.append(svg, text);
    box.appendChild(span);
  };
  for (const key of [...new Set(FIXTURES.map((f) => f.model))]) {
    item(icon((s) => drawSymbol(s, symbolFor(key), SYMBOL_R)), MODELS[key].label);
  }
  item(icon((s) => { const sym = drawSymbol(s, 'circle', SYMBOL_R); sym.style.fill = 'rgb(255,236,200)'; }), 'Filled: on, in its colour');
  item(icon((s) => drawSymbol(s, 'circle', SYMBOL_R)), 'Hollow: off');
  item(icon((s) => drawArrow(s, { x: -0.45, y: 0 }, { dx: 0.5, dy: 0 }, 'rgb(255,236,200)')), 'Where it points (none: straight down)');
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
