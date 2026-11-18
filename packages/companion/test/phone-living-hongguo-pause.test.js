import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/phone-living.js', import.meta.url), 'utf8');
function functionSource(name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  return source.slice(start, source.indexOf(nextMarker, start));
}

test('every weighted impulse excludes paused hongguo and retains fanqie', () => {
  let randoms = [0.9, 0];
  const math = Object.create(Math);
  math.random = () => randoms.shift() ?? 0;
  const context = vm.createContext({ Math: math, Date: class extends Date { getHours() { return 12; } }, state: { currentApp: 'other' } });
  vm.runInContext(functionSource('decideNextImpulse', '/**\n * 活人化自主行为'), context);
  const choices = new Set();
  for (const current of ['other', 'fanqie', 'hongguo', 'douyin', 'bilibili', 'mota', 'music', 'taptap']) {
    context.state.currentApp = current;
    for (let i = 0; i < 1000; i++) {
      randoms = [0.9, i / 1000];
      const result = context.decideNextImpulse();
      assert.notEqual(result, 'hongguo', `current=${current}, index=${i}`);
      choices.add(result);
    }
  }
  for (const app of ['fanqie', 'douyin', 'bilibili', 'mota', 'music', 'taptap']) assert.ok(choices.has(app), app);
});

test('autonomous launcher refuses hongguo but permits fanqie', async () => {
  const commands = [];
  const state = {};
  const context = vm.createContext({ APPS: { hongguo: 'com.phoenix.read', fanqie: 'com.dragon.read' }, state, Math, silentShell: async command => commands.push(command) });
  vm.runInContext('async ' + functionSource('launchApp', '/**\n * 录一小段'), context);
  await context.launchApp('hongguo');
  assert.deepEqual(commands, []);
  await context.launchApp('fanqie');
  assert.deepEqual(commands, ['monkey -p com.dragon.read -c android.intent.category.LAUNCHER 1']);
});
