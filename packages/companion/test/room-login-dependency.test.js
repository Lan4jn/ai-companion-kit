import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));

test('room login browser dependency is required and locked for companion', async () => {
  const manifest = await readJson(new URL('../package.json', import.meta.url));
  const lock = await readJson(new URL('../package-lock.json', import.meta.url));
  const version = manifest.dependencies?.['playwright-core'];
  assert.ok(version, 'playwright-core must be a required dependency');
  assert.equal(manifest.optionalDependencies?.['playwright-core'], undefined);
  assert.equal(lock.packages[''].dependencies?.['playwright-core'], version);
  assert.ok(lock.packages['node_modules/playwright-core']?.version);
});
