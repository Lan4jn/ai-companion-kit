import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessScreenProgress, detectPlayhead, screenEpisodeId } from '../src/hongguo-screen-progress.js';

test('same identified episode, changed image and advancing detected playhead verify visual progress', () => {
  const frame = (position, hash, at) => ({ episodeId:'title:第9集', progress:position, frameId:hash, capturedAt:at });
  assert.equal(assessScreenProgress(frame(.2,'a',1000), frame(.23,'b',4000)), true);
  assert.equal(assessScreenProgress(frame(.2,'a',1000), frame(.2,'b',4000)), false);
  assert.equal(assessScreenProgress(frame(.2,'a',1000), {...frame(.23,'b',4000),episodeId:'other'}), false);
  assert.equal(assessScreenProgress(frame(.2,'a',1000), frame(.23,'a',4000)), false);
});

 test('detects one white playhead and rejects absent or multiple markers', () => {
  const width=1920, height=1080, data=Buffer.alloc(width*height*3);
  const marker = x => { for(let y=978;y<=982;y++) for(let dx=0;dx<4;dx++) data.fill(255,(y*width+x+dx)*3,(y*width+x+dx)*3+3); };
  marker(1500); assert.ok(Math.abs(detectPlayhead({data,width,height}) - (1501.5-28)/(1892-28)) < .001);
  marker(1600); assert.equal(detectPlayhead({data,width,height}), null);
  data.fill(0); assert.equal(detectPlayhead({data,width,height}), null);
 });

test('screen identity requires both title and episode', () => {
 assert.equal(screenEpisodeId(['第9集','下山奶爸，医武双绝藏不住了 >']), '下山奶爸，医武双绝藏不住了:第9集');
 assert.equal(screenEpisodeId(['第9集']), null);
});

test('reconciles minor OCR errors in same on-screen title without accepting a different episode or substantially different title', async () => {
 const { reconcileScreenEpisodes } = await import('../src/hongguo-screen-progress.js');
 assert.equal(reconcileScreenEpisodes('下山奶管细医武双绝藏不住了:第10集','下山奶爸，医武双绝藏不住了:第10集'), true);
 assert.equal(reconcileScreenEpisodes('下山奶管细医武双绝藏不住了:第10集','下山奶爸，医武双绝藏不住了:第11集'), false);
 assert.equal(reconcileScreenEpisodes('下山奶爸，医武双绝藏不住了:第10集','都市狂龙，医武双绝藏不住了:第10集'), false);
});
