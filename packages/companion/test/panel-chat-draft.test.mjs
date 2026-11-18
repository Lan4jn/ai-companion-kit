import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('chat clear skips animations when the page is hidden', async () => {
  const source = fs.readFileSync(new URL('../scripts/panel.mjs', import.meta.url), 'utf8');
  const animation = source.slice(source.indexOf('function animateBubblesOut(){'), source.indexOf('async function clearChat(){'));
  let animated = false;
  const screen = {querySelectorAll: () => [{animate() { animated = true; return {finished: new Promise(() => {})}; }}]};
  const context = {document: {hidden: true}, el: () => screen, Promise};
  const result = vm.runInNewContext(animation + '\nPromise.race([animateBubblesOut().then(() => "done"), new Promise(resolve => setTimeout(() => resolve("timeout"), 40))])', {...context, setTimeout});
  assert.equal(await result, 'done');
  assert.equal(animated, false);
});

// Exercise the browser's actual renderer without connecting to real accounts.
test('empty chat refresh preserves an existing input draft', () => {
  const source = fs.readFileSync(new URL('../scripts/panel.mjs', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderChat(c){'), source.indexOf('// ── 人际关系图谱'));
  let draft = '正在输入';
  const screen = { innerHTML: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  const box = { set innerHTML(value) { draft = ''; } };
  const context = { CHAT_CLEARING: false, CHAT_LAST_AT: 0, el: id => id === 'chat' ? box : id === 'chatScreen' ? screen : null, bindChatInput() {}, esc: String, chatTime: String };
  vm.runInNewContext(render + '\nrenderChat({rows:[], total:0, lastAt:0});', context);
  assert.equal(draft, '正在输入');
  assert.match(screen.innerHTML, /还没有聊天记录/);
});
