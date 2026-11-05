// Pages (and later OSC) -> this script -> Art-Net (UDP 6454) -> QuickQ
//
// Usage:  node bridge.js [config-file]
//
// The room setup (console IP, light models, lights, map) is read from a JSON
// config file, by default config.json in the repo root. Copy
// config.example.json to make one. See the README.
//
// While the bridge runs it controls every console universe that has lights
// in the config; "Release to console" on the bridge computer hands them back.
// console.artnetUniverseForUniverse1 in the config is the Art-Net universe
// that console universe 1 maps to (usually 0). Console universe 2 then goes
// to that + 1, and so on.
//
// Several clients can control lights at once: a light belongs to whoever
// takes it first, until they let go or go quiet (see rig.js).
//
// Then open http://localhost:8080 in the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const dns = require('dns');
const { WebSocketServer } = require('ws');
const { loadConfig, saveMap } = require('./config');
const { Rig } = require('./rig');
const { summarize } = require('./summary');

const CONFIG_PATH = path.resolve(process.argv[2] || path.join(__dirname, '..', 'config.json'));
const config = loadConfig(CONFIG_PATH);

const CONSOLE_IP = config.console.ip;
const BASE_UNIVERSE = config.console.artnetUniverseForUniverse1;
const HTTP_PORT = 8080;
const ARTNET_PORT = 6454;
const SEND_HZ = 30;          // Art-Net should be refreshed continuously, not just on change
const QUIET_MS = 10000;      // a client silent this long loses its lights
const PING_MS = 3000;        // how often pages are asked if they're still there

const artnetUniverse = (consoleUniverse) => BASE_UNIVERSE + consoleUniverse - 1;

const rig = new Rig(config);
let inControl = true; // false after "Release to console"
let frames = rig.frames(Date.now());
const sequences = new Map();
let packetsSent = 0;
let lastError = null;

// ---------- Art-Net ----------
const udp = dgram.createSocket('udp4');
udp.bind(() => udp.setBroadcast(true));

function artDmxPacket(universe, data) {
  const seq = sequences.get(universe) || 1;
  sequences.set(universe, seq >= 255 ? 1 : seq + 1);
  const buf = Buffer.alloc(18 + 512);
  buf.write('Art-Net\0', 0, 'ascii');          // ID
  buf.writeUInt16LE(0x5000, 8);                 // OpCode: OpDmx
  buf.writeUInt16BE(14, 10);                    // Protocol version 14
  buf.writeUInt8(seq, 12);                      // Sequence (1-255), per universe
  buf.writeUInt8(0, 13);                        // Physical port
  buf.writeUInt8(universe & 0xff, 14);          // SubUni (sub-net + universe)
  buf.writeUInt8((universe >> 8) & 0x7f, 15);   // Net
  buf.writeUInt16BE(512, 16);                   // Data length
  Buffer.from(data).copy(buf, 18);
  return buf;
}

setInterval(() => {
  frames = rig.frames(Date.now());
  if (!inControl) return;
  for (const [u, data] of frames) {
    udp.send(artDmxPacket(artnetUniverse(u), data), ARTNET_PORT, CONSOLE_IP, (err) => {
      if (err) { lastError = err.message; console.error('UDP error:', err.message); }
    });
    packetsSent++;
  }
}, 1000 / SEND_HZ);

// ---------- Static files (serves ../sketch) ----------
const SKETCH_DIR = path.join(__dirname, '..', 'sketch');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(SKETCH_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(SKETCH_DIR)) { res.writeHead(403); return res.end(); }
  // Read synchronously: Node's async file reads share a small thread pool
  // with network-name lookups (see lookUpName), and on a network without a
  // name server those lookups can hang and hold up the page for everyone.
  // The files are small, so this is quick.
  let data;
  try { data = fs.readFileSync(filePath); } catch { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  res.end(data);
});

// ---------- Clients ----------
const wss = new WebSocketServer({ server });
// ws -> { id, address, canEdit, lastHeard, hostName, typedName, connectedAt, last, lastValues }
const clients = new Map();
let nextClientId = 1;

function broadcast(text) { wss.clients.forEach((c) => c.readyState === 1 && c.send(text)); }

function status() {
  const universes = rig.universes.map((u) => ({ console: u, artnet: artnetUniverse(u) }));
  return JSON.stringify({ type: 'status', inControl, packetsSent, consoleIp: CONSOLE_IP, universes, lastError });
}
function broadcastStatus() { broadcast(status()); }
setInterval(broadcastStatus, 1000);

// The name shown for a client: typed on its page, else its network name, else its address.
function label(c) { return c.typedName || c.hostName || c.address; }

// Who is connected, what they last sent, and who has which light. Sent when
// it changes, at most 5 times a second (pages send up to 30 messages a second).
let lastState = '', stateDue = false;
function stateMessage() {
  const now = Date.now(), list = {};
  for (const c of clients.values()) {
    list[c.id] = {
      label: label(c), address: c.address, hostName: c.hostName, typedName: c.typedName,
      connectedAgo: now - c.connectedAt,
      last: c.last && { summary: c.last.summary, raw: c.last.raw, ago: now - c.last.at },
    };
  }
  return { type: 'state', owners: rig.owners(), clients: list };
}
function broadcastState(force) {
  if (force) return flushState(true);
  stateDue = true;
}
function flushState(force) {
  stateDue = false;
  const msg = stateMessage();
  // Compare without the ages, which change every millisecond.
  const key = JSON.stringify(msg, (k, v) => (k === 'ago' || k === 'connectedAgo' ? undefined : v));
  if (force || key !== lastState) { lastState = key; broadcast(JSON.stringify(msg)); }
}
setInterval(() => { if (stateDue) flushState(); }, 200);

// Network name of a client, if the network knows one.
function lookUpName(c) {
  if (isThisComputer(c.address)) { c.hostName = os.hostname(); return; }
  dns.lookupService(c.address, 0, (err, host) => {
    if (err || !host || host === c.address) return;
    c.hostName = host;
    broadcastState();
  });
}

// What is being sent to the console, so every page's map can show it.
let lastOutput = '';
function outputMessage() {
  const out = {};
  if (inControl) for (const [u, d] of frames) out[u] = Array.from(d);
  return JSON.stringify({ type: 'output', sending: inControl, frames: out });
}
setInterval(() => {
  const text = outputMessage();
  if (text !== lastOutput) { lastOutput = text; broadcast(text); }
}, 100);

// Only pages opened on this computer may edit the map or release to the console.
function isThisComputer(address) {
  const a = String(address || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  return Object.values(os.networkInterfaces()).flat().some((i) => i && i.address === a);
}

// Pages answer pings automatically while open. A page that stops answering
// (phone locked, network gone) loses its lights after QUIET_MS.
setInterval(() => {
  const now = Date.now();
  for (const [ws, c] of clients) {
    if (now - c.lastHeard > QUIET_MS) {
      console.log(`Client ${c.id} (${c.address}) went quiet; its lights are free`);
      dropClient(ws);
      ws.terminate();
    } else if (ws.readyState === 1) {
      ws.ping();
    }
  }
}, PING_MS);

function dropClient(ws) {
  const c = clients.get(ws);
  if (!c) return;
  clients.delete(ws);
  rig.dropClient(c.id);
  broadcastState();
}

function refuse(ws, busy, what) {
  const owner = (id) => [...clients.values()].find((c) => c.id === id);
  const items = busy.map((b) => ({ ...b, address: b.owner && owner(b.owner) ? label(owner(b.owner)) : undefined }));
  ws.send(JSON.stringify({ type: 'refused', what, items }));
}

wss.on('connection', (ws, req) => {
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const client = {
    id: `c${nextClientId++}`, address, canEdit: isThisComputer(address), lastHeard: Date.now(),
    hostName: null, typedName: null, connectedAt: Date.now(), last: null, lastValues: null,
  };
  clients.set(ws, client);
  lookUpName(client);
  console.log(`Client ${client.id} connected from ${address}${client.canEdit ? ' (this computer)' : ''}`);
  ws.send(JSON.stringify({
    type: 'config', models: config.models, lights: config.lights, map: config.map,
    canEdit: client.canEdit, you: client.id,
  }));
  ws.send(outputMessage());
  ws.send(status());
  broadcastState(true);

  ws.on('pong', () => { client.lastHeard = Date.now(); });

  ws.on('message', (raw) => {
    client.lastHeard = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const names = Array.isArray(msg.lights) ? msg.lights.filter((n) => typeof n === 'string') : [];

    // Remember what it sent, for the device list.
    const mine = Object.values(rig.owners()).filter((o) => o.owner === client.id && (o.selected || o.solo)).length;
    const text = String(raw);
    client.last = {
      summary: summarize(msg, client.lastValues, mine),
      raw: text.length > 600 ? `${text.slice(0, 600)}…` : text,
      at: Date.now(),
    };
    if (msg.type === 'set' && msg.values) client.lastValues = { ...client.lastValues, ...msg.values };

    if (msg.type === 'take') {
      const busy = rig.take(client.id, names, msg.values);
      if (busy.length) refuse(ws, busy, 'take');
    } else if (msg.type === 'release') {
      rig.release(client.id, names);
    } else if (msg.type === 'set') {
      rig.set(client.id, msg.values);
    } else if (msg.type === 'solo') {
      const busy = rig.solo(client.id, typeof msg.light === 'string' ? msg.light : null, msg.values);
      if (busy) refuse(ws, [busy], 'solo');
    } else if (msg.type === 'raw' && typeof msg.key === 'string') {
      const busy = rig.setRaw(client.id, msg.key, msg.value);
      if (busy) refuse(ws, [busy], 'raw');
    } else if (msg.type === 'raw-clear') {
      rig.clearRaw(client.id);
    } else if (msg.type === 'name') {
      const name = typeof msg.name === 'string' ? msg.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      client.typedName = name || null;
    } else if (msg.type === 'free') {
      // The bridge computer frees all lights of another client, which stays connected.
      if (!client.canEdit) return refuse(ws, [{ reason: 'not-bridge-computer' }], 'free');
      for (const [otherWs, other] of clients) {
        if (other.id !== msg.client) continue;
        rig.dropClient(other.id);
        client.last.summary = `freed the lights of ${label(other)}`;
        if (otherWs.readyState === 1) otherWs.send(JSON.stringify({ type: 'freed', by: label(client) }));
        console.log(`${label(client)} freed the lights of ${label(other)}`);
      }
    } else if (msg.type === 'console') {
      if (!client.canEdit) return refuse(ws, [{ reason: 'not-bridge-computer' }], 'console');
      inControl = !!msg.control;
      console.log(inControl ? `Controlling the console's universes again (${CONSOLE_IP})` : 'Released to the console');
      broadcastStatus();
    } else if (msg.type === 'map') {
      if (!client.canEdit) {
        ws.send(JSON.stringify({ type: 'error', message: 'The map can only be edited on the bridge computer.' }));
        return;
      }
      try {
        config.map = saveMap(CONFIG_PATH, msg.map, config);
      } catch (err) {
        console.error('Map not saved:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: `Map not saved: ${err.message}` }));
        // Send the saved map back so the page drops the refused change.
        ws.send(JSON.stringify({ type: 'map', map: config.map, id: msg.id }));
        return;
      }
      broadcast(JSON.stringify({ type: 'map', map: config.map, id: msg.id }));
    }
    broadcastState();
  });

  ws.on('close', () => {
    if (clients.has(ws)) console.log(`Client ${client.id} disconnected; its lights are free`);
    dropClient(ws);
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`Bridge ready. Open http://localhost:${HTTP_PORT}`);
  console.log(`Config: ${CONFIG_PATH} (${config.lights.length} lights)`);
  console.log(`Controlling console universes ${rig.universes.join(', ')} at ${CONSOLE_IP} (Art-Net ${rig.universes.map(artnetUniverse).join(', ')})`);
  console.log('Lights nobody has taken are dark. "Release to console" on the page hands control back.');
});
