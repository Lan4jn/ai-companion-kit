import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaPlaywrightSource } from '../src/tieba-playwright.js';

test('authenticated session option fails closed rather than silently reading anonymously', () => {
  for (const authenticatedSession of [{}, { authenticated: true }, { context: {} }]) {
    assert.throws(() => createTiebaPlaywrightSource({ authenticatedSession }), /tieba_authenticated_session_unavailable/);
  }
});
