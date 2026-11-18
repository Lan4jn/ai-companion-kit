import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAndSelectFanqie } from '../src/fanqie-device-navigation.js';
import { executePhoneTool } from '../src/phone-tools.js';

test('direct navigation refuses device actions outside a phone lock', async () => {
  const prev = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = 'fake';
  try {
    await assert.rejects(openAndSelectFanqie({serial:'fake',brain:{}}), /Phone mutex lock lost/);
  } finally { if (prev === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = prev; }
});
