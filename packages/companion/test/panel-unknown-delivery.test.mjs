import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('unknown chat outcome never restores a resendable draft', async () => {
 const src=fs.readFileSync(new URL('../scripts/panel.mjs',import.meta.url),'utf8');
 const code=src.slice(src.indexOf('function bindChatInput(){'),src.indexOf('function renderChat(c){'));
 let handler; const input={dataset:{},value:'private draft',addEventListener:(e,fn)=>{handler=fn;}};
 const button={disabled:false,addEventListener(){}}; const alerts=[];
 const ctx={el:id=>id==='chatInput'?input:button,CHAT_SENDING:false,CHAT_CLEARING:false,panelPost:async()=>({ok:false,unknown:true,error:'unknown'}),tick:async()=>{},alert:s=>alerts.push(s)};
 vm.runInNewContext(code+'\nbindChatInput();',ctx);
 await handler({key:'Enter'}); await new Promise(r=>setImmediate(r));
 assert.equal(input.value,'');
 assert.ok(alerts.some(x=>/未知|确认/.test(x)));
});
