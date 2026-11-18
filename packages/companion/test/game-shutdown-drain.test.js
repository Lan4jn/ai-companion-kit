import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAutopilot } from '../src/game-autopilot.js';

test('stop drains an in-flight start and prevents it starting after shutdown', async () => {
  const game = new GameAutopilot();
  let release, enter;
  const entered = new Promise(r => { enter = r; });
  game.checkForegroundGame = () => { enter(); return new Promise(r => { release = r; }); };
  const start = game.start({sessionKey:'test'});
  await entered;
  let done = false;
  const stopping = Promise.resolve(game.stop('shutdown', {permanent:true, notify:false})).then(() => { done = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(done, false, 'stop must wait for the pending foreground probe');
  release({isGame:true});
  await Promise.all([start, stopping]);
  assert.equal(game.isActive(), false);
  assert.equal(game.timer, null);
  game.checkForegroundGame = () => { throw new Error('must not probe after shutdown'); };
  assert.equal((await game.start({sessionKey:'test'})).ok, false, 'shutdown blocks future starts');
});
