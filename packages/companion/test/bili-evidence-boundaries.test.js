import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { recallKnowledge } from '../src/bili-living.js';

const owner = '578021239';
function setup(t) {
  const old = process.env.HOME;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'bili-boundary-'));
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; fs.rmSync(dir, {recursive:true, force:true}); });
  return dir;
}
function brain(dir, recall = recallKnowledge) {
  return new Brain({apiKey:'unused', baseUrl:'http://invalid.local', model:'test', dataDir:dir,
    role:{build:({situation})=>situation}, memory:{renderPerson:()=>'',renderRecent:()=>'',renderDiary:()=>''}, recall});
}

test('unrecorded colloquial watched-video question is answered without fabricating content', async t => {
  const dir = setup(t);
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '没看过那条，别问我' } }] }) };
  });
  const result = await brain(dir).reply({key:`private:${owner}`,userId:owner,text:'你刷到过木星养企鹅那条吗',record:false,tools:false});
  assert.match(JSON.stringify(request.messages), /没有可靠观看记录/, '没有观看记录时必须约束模型不要编造');
  assert.match(result.text, /没看过|不记得|不知道/);
  assert.doesNotMatch(result.text, /企鹅.{0,6}(很|挺|真的)/);
});

test('group structured output preserves JSON protocol without model access', async t => {
  const dir = setup(t);
  let request;
  t.mock.method(globalThis,'fetch',async (_url,options) => {
    request=JSON.parse(options.body);
    return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"reply":true,"text":"不知道"}'}}]})};
  });
  const result = await brain(dir).reply({key:'group:42',userId:owner,text:'你看过的视频讲了什么？只输出 JSON：{"reply":true,"text":"..."}',record:false,tools:false});
  assert.equal(request, undefined);
  const reply = JSON.parse(result.text);
  assert.equal(reply.reply,true);
  assert.match(reply.text,/不知道|没找到/);
});
