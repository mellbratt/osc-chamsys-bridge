// Preloaded into bridge child processes by the integration tests. Besides
// counting sockets, this makes a bad test config fail instead of sending UDP
// beyond localhost (in particular, Art-Net to a real console).
const dgram = require('node:dgram');
const createSocket = dgram.createSocket;

dgram.createSocket = function (...args) {
  const socket = createSocket.apply(this, args);
  const send = socket.send;
  socket.send = function (...sendArgs) {
    const address = sendArgs.find((arg) => typeof arg === 'string');
    if (address && address !== '127.0.0.1') {
      throw new Error(`Test blocked non-loopback UDP traffic to ${address}`);
    }
    return send.apply(this, sendArgs);
  };
  console.log('[test] UDP socket created');
  return socket;
};
