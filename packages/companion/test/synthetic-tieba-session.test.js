import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createSyntheticTiebaSession } from '../scripts/synthetic-tieba-session.js';

test('synthetic login and reader share one private browser session', async () => {
  const root = await mkdtemp(join(process.env.TMPDIR, 'tieba-synthetic-'));
  let session;
  try {
    session = await createSyntheticTiebaSession({ root });
    await assert.rejects(session.read(), /synthetic_not_authenticated/);
    await session.loginPage.getByRole('button', { name: 'Synthetic sign in' }).click();
    await session.loginPage.getByText('Synthetic session ready').waitFor();
    assert.equal(await session.read(), 'Synthetic forum content');
    assert.equal(await session.loginPage.evaluate(async () => {
      try { await fetch('/synthetic-sign-in', { method: 'POST' }); return 'sent'; }
      catch { return 'blocked'; }
    }), 'blocked');
    let hits = 0;
    const server = createServer((req, res) => { hits++; res.end('leak'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      await session.loginPage.evaluate(async port => {
        try { await fetch(`http://127.0.0.1:${port}/?cookie=synthetic_fixture`, { mode: 'no-cors' }); } catch {}
      }, port);
      assert.equal(hits, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
    await assert.rejects(session.navigate('https://example.com/'), /synthetic_navigation_denied/);
    await session.close();
    await assert.rejects(stat(join(root, 'profile')), { code: 'ENOENT' });
    await assert.rejects(session.read());
    session = undefined;
  } finally {
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
