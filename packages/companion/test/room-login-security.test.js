import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { isPrivateLoginRequest } from '../src/room-login-security.js';

const lan = Object.values(os.networkInterfaces()).flat().filter(Boolean).find(i => i.family === 'IPv4' && i.netmask === '255.255.255.0' && i.address.startsWith('192.168.31.'))?.address;
const req = (remoteAddress, host, origin, method = 'GET', extra = {}) => ({socket:{remoteAddress,localPort:18888},headers:{host, ...(origin ? {origin}: {}), ...extra},method});

test('only direct loopback and approved LAN peers with legitimate Host are accepted', () => {
  assert.equal(isPrivateLoginRequest(req('127.0.0.1','localhost:18888')), true);
  assert.equal(isPrivateLoginRequest(req('::ffff:127.0.0.1','127.0.0.1:18888')), true);
  assert.equal(isPrivateLoginRequest(req('::1','[::1]:18888')), true);
  for (const remote of ['192.0.2.3','192.168.32.2','192.168.310.2','172.17.0.2','10.241.1.2','2001:db8::1']) {
    assert.equal(isPrivateLoginRequest(req(remote,'localhost:18888',null,'GET',{'x-forwarded-for':'192.168.31.3'})), false,remote);
  }
  for (const host of ['evil.test:18888','192.168.31.4:18888','localhost:18889','localhost:18888@evil.test','127.1:18888']) assert.equal(isPrivateLoginRequest(req('127.0.0.1',host)), false,host);
  if (lan) {
    assert.equal(isPrivateLoginRequest(req('192.168.31.42',`${lan}:18888`)), true);
    assert.equal(isPrivateLoginRequest(req('::ffff:192.168.31.42',`${lan}:18888`)), true);
  }
});

test('same origin and fetch metadata protect both reads and mutations', () => {
  const host = lan ? `${lan}:18888` : 'localhost:18888';
  const peer = lan ? '192.168.31.42' : '127.0.0.1';
  assert.equal(isPrivateLoginRequest(req(peer,host,`http://${host}`,'POST')), true);
  for (const origin of [null,'http://evil.test','https://'+host,`http://${host}/path`,`http://${host}:1`]) assert.equal(isPrivateLoginRequest(req(peer,host,origin,'POST')), false);
  assert.equal(isPrivateLoginRequest(req(peer,host,'http://evil.test','GET')), false);
  assert.equal(isPrivateLoginRequest(req(peer,host,null,'GET',{'sec-fetch-site':'cross-site'})), false);
  assert.equal(isPrivateLoginRequest(req(peer,host,`http://${host}`,'POST',{'sec-fetch-site':'cross-site'})), false);
});
