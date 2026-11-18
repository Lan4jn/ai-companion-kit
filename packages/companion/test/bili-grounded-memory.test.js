import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveKnowledge, recallKnowledge } from '../src/bili-living.js';

const video = { bvid:'BV11T411P7o1', title:'测试画面', duration:10 };
const evidence = { version:2, sources:['visual','audio'], coverage:{complete:true,duration:10,segments:[{start:0,end:10,visual:'画面右下角有模糊水印，人物挥手',audio:'[0-10s] 今天天气真好'}]}, playback:{complete:true,fullWatchVerified:true,duration:10,start:0,end:10,watched:10,samples:Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}))} };
function setup(t) { const old = process.env.HOME; const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-grounded-')); process.env.HOME=home; t.after(()=>{process.env.HOME=old;fs.rmSync(home,{recursive:true,force:true});}); return path.join(home,'ai-companion-xiaoyu/ai-companion-kit/packages/companion/data/bili-knowledge.jsonl'); }

test('only literal timed observations survive, never unsupported claims or summaries', t => {
  setup(t);
  const k={summary:'社区有著名水印梗',tags:['社区梗'],points:[
    {source:'visual',start:0,end:10,quote:'画面右下角有模糊水印',claim:'这是社区公认的梗'},
    {source:'audio',start:0,end:10,quote:'今天天气真好'},
    {source:'visual',start:0,end:10,quote:'不存在的社区梗'},
    {source:'visual',start:5,end:9,quote:'人物挥手'}]};
  const rec=saveKnowledge(video,k,evidence);
  assert.ok(rec);
  assert.equal(rec.points.length,2);
  assert.doesNotMatch(JSON.stringify(rec),/社区公认|社区有著名|社区梗/);
  assert.match(rec.points[0],/低可信.*0-10.*画面右下角有模糊水印/);
  assert.match(rec.points[1],/低可信.*0-10.*今天天气真好/);
  assert.deepEqual(recallKnowledge(video.bvid)[0],rec);
});

test('legacy invented claims and forged stored claims are not recalled', t => {
  const file=setup(t); fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,[{...video,summary:'水印是社区梗',points:['人人都知道'],evidence:{...evidence,version:1}},{...video,summary:'社区梗',points:['社区梗'],evidence}].map(JSON.stringify).join('\n'));
  assert.deepEqual(recallKnowledge(video.bvid),[]);
});
