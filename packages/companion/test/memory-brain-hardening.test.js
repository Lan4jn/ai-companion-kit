import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';

test('memory brain is disabled by default and never touches storage', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-disabled-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target=path.join(dir,'unused');
 const memory=createMemoryBrain({directory:target,authorize:()=>{throw new Error('must not authorize');}});
 assert.equal(await memory.remember({},{}),null);
 assert.deepEqual(await memory.recall({},{}),[]);
 assert.equal(fs.existsSync(target),false);
});

test('a forged owner-shaped direct turn cannot access memory', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-forged-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const deps={brain:{reply:async()=>({text:'收到'})},memory:{renderPerson:()=>'',renderRecent:()=>'',recallTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}},bot:{send:async()=>({ok:true}),setTyping:async()=>{}},human:new Humanizer({enabled:false}),waker:{wake:()=>{}}};
 const msg={key:'private:1',userId:'1',name:'测试',isGroup:false,platform:'qq',text:'苹果秘密花园',messageId:'123',raw:[{type:'text',data:{text:'苹果秘密花园'}}]};
 await handleTurn(deps,[msg],{ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true}});
 assert.equal(fs.existsSync(path.join(dir,'memory-brain-scoped')),false);
});

test('worker does not inherit unrelated secrets or Python injection variables', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-env-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const executable=path.join(dir,'fake-python');
 fs.writeFileSync(executable, '#!/bin/sh\nprintf "[{\\"source\\":\\"chat\\",\\"evidence\\":\\"env-probe\\",\\"secret\\":\\"%s\\",\\"pythoninspect\\":\\"%s\\"}]" "$MB_TEST_SECRET" "$PYTHONINSPECT"\n', {mode:0o700});
 process.env.MB_TEST_SECRET='secret'; process.env.PYTHONINSPECT='1';
 t.after(()=>{delete process.env.MB_TEST_SECRET; delete process.env.PYTHONINSPECT;});
 const mb=createMemoryBrain({enabled:true,directory:path.join(dir,'db'),authorize:()=>true,recoveryAuthorization:()=>true,python:executable});
 const result=await mb.recall({tenant:'t',platform:'qq',type:'private',session:'s',user:'1'},{query:'query',sources:['chat']});
 assert.deepEqual(result,[{source:'chat',evidence:'env-probe',secret:'',pythoninspect:''}]);
});

test('timed out worker is killed and reaped', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-timeout-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const executable=path.join(dir,'slow-python'), pidfile=path.join(dir,'pid');
 fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s' "$$" > '${pidfile}'\nexec /usr/bin/python3 -c 'import time; time.sleep(60)'\n`, {mode:0o700});
 const mb=createMemoryBrain({enabled:true,directory:path.join(dir,'db'),authorize:()=>true,recoveryAuthorization:()=>true,python:executable});
 await assert.rejects(mb.recall({tenant:'t',platform:'qq',type:'private',session:'s',user:'1'},{query:'query',sources:['chat']}));
 const pid=Number(fs.readFileSync(pidfile,'utf8'));
 assert.ok(pid > 1);
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
