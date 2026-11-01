// p5 -> WebSocket -> this script -> Art-Net (UDP 6454) -> QuickQ
//
// Usage:  node bridge.js [config-file]
//
// The room setup (console IP, light models, lights, map) is read from a JSON
// config file, by default config.json in the repo root. Copy
// config.example.json to make one. See the README.
//
// The page sends one 512-channel frame per console universe (1, 2, ...).
// console.artnetUniverseForUniverse1 in the config is the Art-Net universe
// that console universe 1 maps to (usually 0). Console universe 2 then goes
// to that + 1, and so on.
//
// Then open http://localhost:8080 in the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./config');

const CONFIG_PATH = path.resolve(process.argv[2] || path.join(__dirname, '..', 'config.json'));
const config = loadConfig(CONFIG_PATH);

const CONSOLE_IP = config.console.ip;
const BASE_UNIVERSE = config.console.artnetUniverseForUniverse1;
const HTTP_PORT = 8080;
const ARTNET_PORT = 6454;
const SEND_HZ = 30; // Art-Net should be refreshed continuously, not just on change

const artnetUniverse = (deskUniverse) => BASE_UNIVERSE + deskUniverse - 1;

// desk universe number -> Uint8Array(512). Only universes in here are sent.
let frames = new Map();
let sending = false;
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
  if (!sending) return;
  for (const [deskUni, data] of frames) {
    udp.send(artDmxPacket(artnetUniverse(deskUni), data), ARTNET_PORT, CONSOLE_IP, (err) => {
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
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

function status() {
  const universes = [...frames.keys()].sort((a, b) => a - b)
    .map((u) => ({ desk: u, artnet: artnetUniverse(u) }));
  return JSON.stringify({ type: 'status', sending, packetsSent, consoleIp: CONSOLE_IP, universes, lastError });
}
function broadcastStatus() { wss.clients.forEach((c) => c.readyState === 1 && c.send(status())); }
setInterval(broadcastStatus, 1000);

wss.on('connection', (ws) => {
  console.log('Sketch connected');
  ws.send(JSON.stringify({ type: 'config', models: config.models, lights: config.lights, map: config.map }));
  ws.send(status());

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'frames' && msg.frames && typeof msg.frames === 'object') {
      // Replaces the whole set: a universe left out is no longer sent,
      // and the desk takes it back after a few seconds.
      const next = new Map();
      for (const [key, arr] of Object.entries(msg.frames)) {
        const u = parseInt(key, 10);
        if (!(u >= 1 && u <= 32768) || !Array.isArray(arr)) continue;
        const d = new Uint8Array(512);
        for (let i = 0; i < 512; i++) d[i] = Math.max(0, Math.min(255, arr[i] | 0));
        next.set(u, d);
      }
      const before = [...frames.keys()].join(','), after = [...next.keys()].join(',');
      frames = next;
      if (before !== after) {
        console.log(`Universes now: ${after ? [...next.keys()].map((u) => `desk ${u} -> Art-Net ${artnetUniverse(u)}`).join(', ') : 'none'}`);
        broadcastStatus();
      }
    } else if (msg.type === 'send') {
      sending = !!msg.on;
      console.log(sending ? `Sending Art-Net to ${CONSOLE_IP}` : 'Stopped sending (desk takes back control)');
      broadcastStatus();
    }
  });

  ws.on('close', () => {
    console.log('Sketch disconnected');
    // If nobody is connected, stop sending so the desk takes control back.
    if (wss.clients.size === 0 && sending) {
      sending = false;
      console.log('No sketches left, stopped sending');
    }
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`Bridge ready. Open http://localhost:${HTTP_PORT}`);
  console.log(`Config: ${CONFIG_PATH} (${config.lights.length} lights)`);
  console.log(`Art-Net target: ${CONSOLE_IP}. Desk universe 1 -> Art-Net ${artnetUniverse(1)}, 2 -> ${artnetUniverse(2)}`);
  console.log('Not sending until you press "Take control"');
});
