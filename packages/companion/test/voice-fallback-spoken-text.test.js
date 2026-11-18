import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
register('./onebot-no-network-loader.js', import.meta.url);
const { handleTurn } = await import('../src/index.js');
const { Humanizer } = await import('../src/humanize.js');

test('unsupported voice with empty reply stops without synthesized text fallback', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'voice-fallback-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const sent=[];
 const bot={sendVoice:async()=>({ok:false,outcome:'permanent'}),send:async(_key,text)=>{sent.push(text);return {ok:true}},setTyping:async()=>{}};
 const deps={bot,brain:{reply:async()=>({text:'',voiceB64:'synthetic',voiceText:'这里是完整的语音内容。'})},human:new Humanizer({enabled:false}),memory:{dir,touch(){}},waker:{wake(){}}};
 const result=await handleTurn(deps,[{key:'private:42',userId:'42',name:'test',isGroup:false,text:'说句话'}],{ownerIds:[],dataDir:dir});
 assert.deepEqual(sent,[]);
 assert.deepEqual(result,{ok:false,sent:0,outcome:'permanent',error:'VOICE_DELIVERY_FAILED'});
});
