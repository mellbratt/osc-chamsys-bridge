const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const osc = require('../osc');

const BRIDGE = path.join(__dirname, '..', 'bridge.js');
const UDP_GUARD = path.join(__dirname, 'udp-guard.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const udpSocketCount = (output) => (output.match(/^\[test\] UDP socket created$/gm) || []).length;

function closeUdp(socket) {
  return new Promise((resolve) => {
    if (!socket) return resolve();
    try { socket.close(resolve); } catch { resolve(); }
  });
}

async function bindUdp(socket, port = 0) {
  const listening = once(socket, 'listening');
  socket.bind(port, '127.0.0.1');
  await listening;
}

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await bindUdp(socket);
  const { port } = socket.address();
  await closeUdp(socket);
  return port;
}

async function freeTcpPort() {
  const server = net.createServer();
  const listening = once(server, 'listening');
  server.listen(0); // bridge.js also listens on all interfaces
  await listening;
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitFor(check, description, child, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    if (child && (child.exitCode != null || child.signalCode != null)) {
      throw new Error(`Bridge exited while waiting for ${description}.\n${output()}`);
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.\n${output ? output() : ''}`);
}

// Starts against localhost only. The Art-Net listener both keeps normal test
// traffic off the network and catches accidental sends from simulator mode.
async function withBridge(simulate, run, { simulateAfterConfig = false } = {}) {
  const httpPort = await freeTcpPort();
  const artnetPort = await freeUdpPort();
  const oscPort = await freeUdpPort();
  const replyPort = await freeUdpPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osc-chamsys-bridge-'));
  const configPath = path.join(dir, 'room.json');
  const config = {
    console: { ip: '127.0.0.1', artnetUniverseForUniverse1: 0 },
    osc: { port: oscPort, replyPort },
    models: {
      par: { label: 'Test Par', group: 'par', channelCount: 1, channels: { dimmer: 1 } },
    },
    lights: [{ name: 'Par 1', model: 'par', universe: 1, address: 1 }],
    map: { width: 10, height: 10, shapes: [], lights: {} },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));

  const packets = [];
  const artnet = dgram.createSocket('udp4');
  artnet.on('message', (data) => packets.push(data));
  let child, ws, sender;
  let output = '';
  try {
    await bindUdp(artnet, artnetPort);
    const args = simulate
      ? simulateAfterConfig ? [configPath, '--simulate'] : ['--simulate', configPath]
      : [configPath];
    child = spawn(process.execPath, ['--require', UDP_GUARD, BRIDGE, ...args], {
      env: {
        ...process.env,
        BRIDGE_HTTP_PORT: String(httpPort),
        BRIDGE_ARTNET_PORT: String(artnetPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const wait = (check, description) => waitFor(check, description, child, () => output);
    await wait(() => output.includes('Bridge ready.'), 'bridge startup');

    const messages = [];
    ws = new WebSocket(`ws://127.0.0.1:${httpPort}`);
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    const status = await wait(() => messages.find((m) => m.type === 'status'), 'initial status');

    sender = dgram.createSocket('udp4');
    await bindUdp(sender);
    await run({ child, configPath, httpPort, oscPort, messages, packets, sender, status, wait, ws, getOutput: () => output });
  } finally {
    if (ws) ws.terminate();
    await closeUdp(sender);
    await stopChild(child);
    await closeUdp(artnet);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('simulator runs OSC and live frames without opening Art-Net output', async () => {
  await withBridge(true, async ({ httpPort, oscPort, messages, packets, sender, status, wait, ws, getOutput }) => {
    assert.equal(status.simulate, true);
    assert.equal(status.inControl, true);
    assert.equal(status.packetsSent, 0);
    assert.equal(udpSocketCount(getOutput()), 1, 'only the OSC UDP socket should be open');

    const response = await fetch(`http://127.0.0.1:${httpPort}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="simulator" hidden/);

    const message = osc.encode('/light/1/dimmer', [0.8]);
    await new Promise((resolve, reject) => {
      sender.send(message, oscPort, '127.0.0.1', (err) => err ? reject(err) : resolve());
    });
    const frame = await wait(
      () => messages.find((m) => m.type === 'output' && m.frames[1]?.[0] === 204),
      'simulated dimmer frame',
    );
    assert.equal(frame.sending, true);
    await wait(
      () => messages.find((m) => m.type === 'state' && m.owners?.['Par 1']?.owner?.startsWith('o')),
      'OSC light ownership',
    );

    // A crafted page message must not disable simulated output either.
    ws.send(JSON.stringify({ type: 'console', control: false }));
    await delay(1100);
    const latestStatus = messages.filter((m) => m.type === 'status').at(-1);
    assert.equal(latestStatus.inControl, true);
    assert.equal(latestStatus.packetsSent, 0);
    assert.equal(packets.length, 0, 'simulator sent an Art-Net packet');
  });
});

test('simulator flag after the config cannot enable Art-Net', async () => {
  await withBridge(true, async ({ packets, status, getOutput }) => {
    assert.equal(status.simulate, true);
    assert.equal(udpSocketCount(getOutput()), 1, 'only the OSC UDP socket should be open');
    await delay(150);
    assert.equal(packets.length, 0);
  }, { simulateAfterConfig: true });
});

test('normal mode keeps the positional config argument and sends Art-Net', async () => {
  await withBridge(false, async ({ configPath, packets, status, wait, getOutput }) => {
    assert.equal(status.simulate, false);
    assert.equal(status.inControl, true);
    assert.ok(getOutput().includes(`Config: ${configPath} `), getOutput());
    assert.equal(udpSocketCount(getOutput()), 2, 'both Art-Net and OSC sockets should be open');
    const packet = await wait(() => packets[0], 'normal Art-Net output');
    assert.equal(packet.subarray(0, 8).toString('ascii'), 'Art-Net\0');
    assert.equal(packet.readUInt16BE(16), 512);
  });
});

test('invalid command lines fail before loading a config', async () => {
  const cases = [
    ['--unknown'],
    ['first.json', 'second.json'],
    ['--simulate', '--simulate'],
  ];
  for (const args of cases) {
    const child = spawn(process.execPath, [BRIDGE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `${args.join(' ')}\n${output}`);
    assert.match(output, /Usage: node bridge\.js \[--simulate\] \[config-file\]/);
    assert.doesNotMatch(output, /Bridge ready/);
  }
});
