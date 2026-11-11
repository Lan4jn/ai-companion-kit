import {test} from 'node:test';import assert from 'node:assert/strict';import {extractCandidates,chooseCandidate} from '../src/fanqie-select.js';
test('只从实际书名与简介配对为候选，拒绝隐藏项目',()=>{const nodes=[{text:'神序001，参见！',bounds:'[565,872][751,907]'},{text:'【无系统、剧情流】自打神序出现在脑海中，江夏就觉得自己不是正常人了。',bounds:'[565,914][1041,982]'},{text:'隐藏小说',bounds:'[0,0][0,0]'}];const r=extractCandidates(nodes);assert.equal(r.length,1);assert.equal(r[0].title,'神序001，参见！')});
test('模型返回越界或无效时不点击',async()=>{let c=[{title:'书',description:'简介',x:1,y:2}];assert.equal(await chooseCandidate({complete:async()=>'99'},c),null)});
