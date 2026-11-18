import test from 'node:test';
import assert from 'node:assert/strict';
import * as transport from '../src/tieba-playwright.js';

test('IPv6 resolver pins only conservative global APNIC addresses and rejects mixed unsafe answers', async () => {
  assert.equal(transport.isPublicIPv6('240e:ff:e020:9b0:0:ff:b0c3:d627'), true);
  for (const ip of ['::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1', '240e::1%lo']) assert.equal(transport.isPublicIPv6(ip), false, ip);
  await assert.rejects(transport.resolvePublicIPv6('tieba.baidu.com', async () => ['240e::1', '::1']), /unsafe_dns/);
  assert.equal(await transport.resolvePublicIPv6('tieba.baidu.com', async () => ['240e::1']), '240e::1');
});
