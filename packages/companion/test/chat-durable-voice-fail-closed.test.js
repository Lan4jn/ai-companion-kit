import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Brain} from '../src/brain.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';

test('durable Brain rejects unsupported voice tool even when its content is a cliche', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-voice-deny-'));
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,31)});
 t.after(()=>{journal.close();fs.rmSync(dir,{recursive:true,force:true})});
 t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{tool_calls:[{id:'v',type:'function',function:{name:'voice_say',arguments:JSON.stringify({text:'我记下了'})}}]}}]})}));
 const brain=new Brain({apiKey:'fixture',baseUrl:'https://example.invalid',model:'fixture',memory:{renderPerson:()=>'',renderRecent:()=>''},ownerIds:[]});
 await assert.rejects(brain.reply({key:'private:42',userId:'42',text:'你好',record:false,durableToolEffects:{enabled:true,journal,batchId:'test',batch:'[]'}}),/durable tool not allowed/);
 assert.equal(journal.rows.length,0);
});
