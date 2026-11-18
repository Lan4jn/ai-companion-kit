import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/panel.mjs', import.meta.url));

test('standalone panel listens on loopback only by default', async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [script, String(port)], { stdio: 'ignore' });
  try {
    let listener = '';
    for (let i = 0; i < 100 && !listener; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      listener = execFileSync('ss', ['-ltnH'], { encoding: 'utf8' }).split('\n')
        .find(line => line.trim().split(/\s+/)[3]?.endsWith(`:${port}`)) || '';
      if (child.exitCode !== null) throw new Error(`panel exited with ${child.exitCode}`);
    }
    assert.ok(listener, 'panel should start listening');
    assert.equal(listener.trim().split(/\s+/)[3], `127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  }
});
