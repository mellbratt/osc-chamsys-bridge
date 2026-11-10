const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'sketch', 'sketch.js'), 'utf8');

function loadUi() {
  const elements = {};
  const context = vm.createContext({
    console,
    setInterval: () => 0,
    location: { host: '127.0.0.1:8080', hostname: '127.0.0.1' },
    WebSocket: class { constructor() { this.readyState = 0; } },
    document: {
      getElementById(id) {
        if (!elements[id]) {
          elements[id] = {
            hidden: id === 'simulator' || id === 'toggle-send',
            className: '',
            textContent: '',
            classList: { toggle() {} },
          };
        }
        return elements[id];
      },
    },
  });
  vm.runInContext(SOURCE, context);
  vm.runInContext('canEdit = true; connected = true; FIXTURES = [];', context);
  return { context, elements };
}

test('mode controls stay hidden until status, then follow simulator state', () => {
  const { context, elements } = loadUi();

  // Config can arrive before status on the bridge computer.
  context.updateStatus();
  assert.equal(elements['toggle-send'].hidden, true);
  assert.equal(elements.simulator.hidden, true);

  vm.runInContext('statusReceived = true; simulate = true; inControl = true;', context);
  context.updateStatus({ universes: [] });
  assert.equal(elements['toggle-send'].hidden, true);
  assert.equal(elements.simulator.hidden, false);
  assert.match(elements.out.textContent, /DMX values the bridge would send/);

  vm.runInContext('simulate = false;', context);
  context.updateStatus({ universes: [], consoleIp: '127.0.0.1', packetsSent: 0 });
  assert.equal(elements['toggle-send'].hidden, false);
  assert.equal(elements.simulator.hidden, true);
});

test('reconnecting clears the old mode until fresh status arrives', () => {
  const { context, elements } = loadUi();
  vm.runInContext('statusReceived = true; simulate = true;', context);

  context.connect();
  context.updateStatus();
  assert.equal(vm.runInContext('statusReceived', context), false);
  assert.equal(vm.runInContext('simulate', context), false);
  assert.equal(elements['toggle-send'].hidden, true);
  assert.equal(elements.simulator.hidden, true);
});
