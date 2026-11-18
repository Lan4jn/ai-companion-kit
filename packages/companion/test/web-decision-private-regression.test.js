import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {decideWebSurfing} from '../src/web-living.js';

test('autonomous web decision does not consume unscoped chat history', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-decision-private-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'turns.jsonl'),JSON.stringify({who:'群友',text:'私密聊天独特标记不可进入网页决策'})+'\n');
 let prompt;
 await decideWebSurfing({dataDir:dir,brain:{complete:async x=>{prompt=x.prompt;return {want:false}}}});
 assert.doesNotMatch(prompt,/私密聊天独特标记/);
});
