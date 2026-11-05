// One section per kind of light (model): its lights to tick, a line saying
// what that kind can do, and controls for only what it has. A section's
// controls apply to the lights of that kind you have ticked, and are greyed
// out while you have none. Every kind is always shown, so it's clear what
// each one can and can't do.
//
// Uses from sketch.js: FIXTURES, MODELS, state, displayOrder, take, letGo,
// setSolo, syncSelectedBoxes, el. Uses Colour from colour.js.

let TYPE_KEYS = [];   // models that have lights, in config order
const typeLooks = {}; // model -> its controls' settings, in the bridge's units

function defaultTypeLook(T) {
  const range = Colour.whiteRange(T);
  return {
    dimmer: 0, beam: 128, hue: 0, sat: 0,
    kelvin: range ? Math.min(range[1], Math.max(range[0], 5600)) : 5600,
    gobo: 0, goboMode: 'index', goboAngle: 0, goboSpin: 0, focus: 128, frost: 0,
  };
}

// Light indexes this page controls (ticked or soloed) of one model.
function myLightsOf(key) {
  return FIXTURES.map((f, i) => i).filter((i) => FIXTURES[i].model === key && (state.selected.has(i) || state.solo === i));
}

// What a kind of light can do, in words.
function capabilities(T) {
  const c = T.ch, out = [];
  out.push(c.pan != null || c.tilt != null ? 'Moves (use the pad)' : "Doesn't move");
  if (c.dimmer != null) out.push('Dims');
  if (Colour.canColour(T)) out.push('Colour');
  const w = Colour.whiteRange(T);
  if (w) out.push(`White ${w[0]}–${w[1]} K${c.cct == null && c.cto == null ? ' (mixed, approximate)' : ''}`);
  if (c.zoom != null) out.push('Zoom');
  if (T.gobo) out.push(`${T.gobo.slots} gobos`);
  if (c.focus != null) out.push('Focus');
  if (c.frost != null) out.push('Frost');
  return out.join(' · ');
}

function buildTypes() {
  TYPE_KEYS = Object.keys(MODELS).filter((key) => FIXTURES.some((f) => f.model === key));
  const box = el('types');
  box.replaceChildren();
  for (const key of TYPE_KEYS) {
    const T = MODELS[key];
    typeLooks[key] = defaultTypeLook(T);
    const sec = document.createElement('fieldset');
    sec.className = 'type inactive';
    sec.dataset.model = key;
    const legend = document.createElement('legend');
    legend.innerHTML = '<span></span> <span class="small type-count"></span>';
    legend.firstChild.textContent = T.label;
    const can = document.createElement('p');
    can.className = 'small type-can';
    can.textContent = capabilities(T);
    sec.append(legend, can, buildLightList(key), buildControls(key, T));
    box.appendChild(sec);
  }
  updateTypeSections();
}

// The lights of one kind, with All / None.
function buildLightList(key) {
  const wrap = document.createElement('div');
  const group = document.createElement('div');
  group.className = 'group';
  FIXTURES.forEach((f, i) => {
    if (f.model !== key) return;
    const lab = document.createElement('label');
    lab.innerHTML = '<input type="checkbox"> <span></span> <span class="small"></span> <span class="small owner"></span>';
    lab.querySelector('input').dataset.i = i;
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
    group.appendChild(lab);
  });
  const row = document.createElement('div');
  row.className = 'row';
  for (const [mode, text] of [['all', 'All'], ['none', 'None']]) {
    const btn = document.createElement('button');
    btn.className = 'quiet';
    btn.textContent = text;
    btn.onclick = () => {
      const mine = FIXTURES.map((f, i) => i).filter((i) => FIXTURES[i].model === key);
      if (mode === 'all') take(mine.filter((i) => !state.selected.has(i)));
      else letGo(mine.filter((i) => state.selected.has(i)));
      syncSelectedBoxes();
    };
    row.appendChild(btn);
  }
  wrap.append(group, row);
  return wrap;
}

// The controls for one kind of light, only for what it has. A disabled
// inner fieldset greys them all out at once while no light of this kind is ticked.
function buildControls(key, T) {
  const look = typeLooks[key], c = T.ch;
  const box = document.createElement('fieldset');
  box.className = 'type-controls';
  const hint = document.createElement('p');
  hint.className = 'small type-hint';
  hint.textContent = `Tick a ${T.label} above to use these.`;
  box.appendChild(hint);

  const slider = (label, prop, min, max, fmt = (v) => v) => {
    const lab = document.createElement('label');
    lab.className = 'slider';
    lab.innerHTML = `<span></span><input type="range" min="${min}" max="${max}" value="${look[prop]}"><output></output>`;
    lab.firstChild.textContent = label;
    const input = lab.querySelector('input'), out = lab.querySelector('output');
    out.textContent = fmt(look[prop]);
    input.dataset.prop = prop;
    input.oninput = () => { look[prop] = +input.value; out.textContent = fmt(look[prop]); onChange(prop); };
    box.appendChild(lab);
    return input;
  };
  let wheel = null;
  const onChange = (prop) => { if (prop === 'kelvin' && wheel) wheel.redraw(); };

  if (c.dimmer != null) slider('Dimmer', 'dimmer', 0, 255);
  if (Colour.canColour(T)) {
    wheel = colourWheel(look);
    box.appendChild(wheel.node);
  }
  const range = Colour.whiteRange(T);
  if (range) slider('White', 'kelvin', range[0], range[1], (v) => `${v} K`).step = 50;
  if (c.zoom != null) slider('Zoom', 'beam', 0, 255);
  if (T.gobo) box.appendChild(goboControls(look, T));
  if (c.focus != null) slider('Focus', 'focus', 0, 255);
  if (c.frost != null) slider('Frost', 'frost', 0, 255);
  return box;
}

function goboControls(look, T) {
  const wrap = document.createElement('div');
  const name = `gobo-mode-${Math.random().toString(36).slice(2)}`;
  wrap.innerHTML = `<label class="slider"><span>Gobo</span><select></select></label>
    <div class="row">
      <label class="check"><input type="radio" name="${name}" value="index" checked> Fixed angle</label>
      <label class="check"><input type="radio" name="${name}" value="spin"> Spin</label>
    </div>
    <label class="slider"><span class="move-label">Angle</span><input type="range"><output></output></label>`;
  const sel = wrap.querySelector('select');
  sel.add(new Option('Open (no gobo)', 0));
  for (let g = 1; g <= T.gobo.slots; g++) sel.add(new Option(`Gobo ${g}`, g));
  sel.onchange = () => (look.gobo = +sel.value);
  const move = wrap.querySelector('input[type=range]'), out = wrap.querySelector('output'), label = wrap.querySelector('.move-label');
  const configure = () => {
    const index = look.goboMode === 'index';
    move.min = index ? 0 : -100; move.max = index ? 360 : 100;
    move.value = index ? look.goboAngle : look.goboSpin;
    label.textContent = index ? 'Angle' : 'Spin';
    out.textContent = index ? `${look.goboAngle}°` : look.goboSpin;
  };
  wrap.querySelectorAll('input[type=radio]').forEach((r) => { r.onchange = () => { look.goboMode = r.value; configure(); }; });
  move.oninput = () => {
    const v = +move.value;
    if (look.goboMode === 'index') look.goboAngle = v; else look.goboSpin = v;
    out.textContent = look.goboMode === 'index' ? `${v}°` : v;
  };
  configure();
  const tip = document.createElement('p');
  tip.className = 'small';
  tip.textContent = 'Spin: negative is backwards, positive forwards, 0 stops.';
  wrap.appendChild(tip);
  return wrap;
}

// A colour wheel: the angle picks the colour, the distance from the centre
// how much of it. The centre is white, at the White slider's temperature.
function colourWheel(look) {
  const node = document.createElement('div');
  node.className = 'colour';
  node.innerHTML = '<span class="colour-label">Colour</span><canvas></canvas><div class="colour-side"><span class="swatch"></span><output></output><button class="quiet" type="button">White</button></div>';
  const canvas = node.querySelector('canvas'), out = node.querySelector('output'), swatch = node.querySelector('.swatch');
  const SIZE = 132, dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = SIZE * dpr;
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  const g = canvas.getContext('2d');
  let image = null, imageKelvin = null;

  const paintWheel = () => {
    const n = canvas.width, r = n / 2, img = g.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x - r + 0.5, dy = y - r + 0.5, d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const [R, G, B] = Colour.targetRgb({ hue, sat: d, kelvin: look.kelvin });
        const k = (y * n + x) * 4;
        img.data[k] = R; img.data[k + 1] = G; img.data[k + 2] = B; img.data[k + 3] = d > 0.98 ? 255 * (1 - d) * 50 : 255;
      }
    }
    image = img; imageKelvin = look.kelvin;
  };
  const redraw = () => {
    if (!image || imageKelvin !== look.kelvin) paintWheel();
    g.putImageData(image, 0, 0);
    const r = canvas.width / 2, a = (look.hue * Math.PI) / 180;
    const mx = r + Math.cos(a) * look.sat * (r - 4 * dpr), my = r + Math.sin(a) * look.sat * (r - 4 * dpr);
    g.lineWidth = 2 * dpr;
    g.strokeStyle = '#000'; g.beginPath(); g.arc(mx, my, 6 * dpr, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#fff'; g.beginPath(); g.arc(mx, my, 4.5 * dpr, 0, Math.PI * 2); g.stroke();
    swatch.style.background = `rgb(${Colour.targetRgb(look).map(Math.round).join(',')})`;
    out.textContent = look.sat < 0.02 ? 'White' : `${Math.round(look.sat * 100)}% colour`;
  };
  const pick = (e) => {
    if (canvas.closest('fieldset:disabled')) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2, dy = e.clientY - rect.top - rect.height / 2;
    look.hue = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) % 360;
    look.sat = Math.round(Math.min(1, Math.hypot(dx, dy) / (rect.width / 2 - 4)) * 100) / 100;
    redraw();
  };
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pick(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('pointercancel', () => (dragging = false));
  node.querySelector('button').onclick = () => { look.sat = 0; redraw(); };
  redraw();
  return { node, redraw };
}

// Greys out sections with none of your lights, and shows how many you have.
function updateTypeSections() {
  document.querySelectorAll('fieldset.type').forEach((sec) => {
    const n = myLightsOf(sec.dataset.model).length;
    sec.classList.toggle('inactive', n === 0);
    sec.querySelector('.type-controls').disabled = n === 0;
    sec.querySelector('.type-count').textContent = n ? `· ${n} ticked` : '';
  });
}

// Blackout: every kind's dimmer to 0, on the page too.
function blackoutTypes() {
  for (const key of TYPE_KEYS) typeLooks[key].dimmer = 0;
  document.querySelectorAll('.type-controls input[data-prop=dimmer]').forEach((input) => {
    input.value = 0;
    input.nextElementSibling.textContent = 0;
  });
}
