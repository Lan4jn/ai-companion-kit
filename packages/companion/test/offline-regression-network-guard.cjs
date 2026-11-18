const net = require('node:net');
const tls = require('node:tls');
net.Socket.prototype.connect = function () { throw new Error('network disabled by isolated regression'); };
net.connect = net.createConnection = function () { throw new Error('network disabled by isolated regression'); };
tls.connect = function () { throw new Error('network disabled by isolated regression'); };
globalThis.fetch = async function () { throw new Error('network disabled by isolated regression'); };
