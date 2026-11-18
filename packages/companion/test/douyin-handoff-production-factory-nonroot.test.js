import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProductionDouyinHandoffFactory as create} from '../src/douyin-handoff-production-factory.js';

test('production factory is disabled by default and rejects injected launch components', () => {
  assert.throws(() => create(), /disabled/);
  for (const key of ['launcher','rootfs','command','args','allocateIdentity','createBroker','fixturePolicy','transportOptions']) {
    assert.throws(() => create({enabled:true,[key]:()=>{throw Error('must not run');}}), /invalid production factory options/);
  }
});

test('non-root synthetic context cannot unlock production factory', {skip: process.getuid() === 0}, () => {
  process.env.NODE_TEST_CONTEXT='synthetic-isolated-web';
  assert.throws(() => create({enabled:true}), /trusted production rootfs or executable unavailable|audited egress and privileged identity\/supervisor boundary unavailable/);
});
