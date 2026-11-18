import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {allocateSystemIdentity} from '../src/douyin-system-identity.js';
import {createSystemIdentityLauncher} from '../src/douyin-handoff-service-candidate.js';

test('allocator and factory are default disabled', () => {
  assert.throws(() => allocateSystemIdentity({first: 61000, last: 61010}), /disabled/);
  assert.throws(() => createSystemIdentityLauncher(), /disabled/);
});

test('allocator rejects unbounded ranges before invoking shadow utilities', {skip:process.geteuid?.() !== 0}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-identity-bound-'));
  try {
    for (const [name, text] of Object.entries({passwd:'root:x:0:0:root:/root:/bin/sh\n',group:'root:x:0:\n',shadow:'root:*:19000:0:99999:7:::\n',gshadow:'root:*::\n','nsswitch.conf':'passwd: files\ngroup: files\nshadow: files\n','login.defs':'SYS_UID_MIN 100\nSYS_UID_MAX 2147483646\n'})) fs.writeFileSync(path.join(dir,name),text,{mode:0o600});
    const moduleUrl=new URL('../src/douyin-system-identity.js',import.meta.url).href;
    const source=`import assert from 'node:assert/strict'; import {allocateSystemIdentity as allocate} from ${JSON.stringify(moduleUrl)}; assert.throws(()=>allocate({enabled:true,first:61000,last:2147483646}), /invalid reserved range/);`;
    const result=spawnSync('/usr/bin/bwrap',['--die-with-parent','--unshare-net','--ro-bind','/','/','--bind',dir,'/etc','--','/usr/bin/node','--input-type=module','-e',source],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(fs.readFileSync(path.join(dir,'passwd'),'utf8'),'root:x:0:0:root:/root:/bin/sh\n');
    assert.equal(fs.readFileSync(path.join(dir,'group'),'utf8'),'root:x:0:\n');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('hung NSS helper fails closed within a bounded time', {skip:process.geteuid?.() !== 0}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-identity-hang-'));
  try {
    const helper=path.join(dir,'getent');
    fs.writeFileSync(helper,'#!/bin/sh\nexec /usr/bin/sleep 30\n',{mode:0o755});
    const moduleUrl=new URL('../src/douyin-system-identity.js',import.meta.url).href;
    const source=`import assert from 'node:assert/strict'; import {allocateSystemIdentity as allocate} from ${JSON.stringify(moduleUrl)}; assert.throws(()=>allocate({enabled:true,first:61000,last:61000}), /identity system command failed/);`;
    const result=spawnSync('/usr/bin/bwrap',['--die-with-parent','--unshare-net','--ro-bind','/','/','--ro-bind',helper,'/usr/bin/getent','--','/usr/bin/node','--input-type=module','-e',source],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr || String(result.error));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('shadow allocator reserves concurrent identities permanently in isolated /etc', {skip:process.geteuid?.() !== 0}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-identities-'));
  try {
    for (const [name, text] of Object.entries({passwd:'root:x:0:0:root:/root:/bin/sh\n',group:'root:x:0:\n',shadow:'root:*:19000:0:99999:7:::\n',gshadow:'root:*::\n', 'nsswitch.conf':'passwd: files\ngroup: files\nshadow: files\n', 'login.defs':'SYS_UID_MIN 100\nSYS_UID_MAX 2147483646\n'})) fs.writeFileSync(path.join(dir,name),text,{mode:0o600});
    // Simulate a crash after groupadd but before useradd: its GID is burned.
    fs.appendFileSync(path.join(dir,'group'),'dys61000:x:61000:\n');
    fs.appendFileSync(path.join(dir,'gshadow'),'dys61000:!::\n');
    const moduleUrl=new URL('../src/douyin-system-identity.js',import.meta.url).href;
    const source=`import {spawn} from 'node:child_process';\nimport {allocateSystemIdentity as allocate} from ${JSON.stringify(moduleUrl)};\nconst code=${JSON.stringify(`import {allocateSystemIdentity as allocate} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(allocate({enabled:true,first:61000,last:61007})))`)};\nconst results=await Promise.all(Array.from({length:4},()=>new Promise((ok,fail)=>{const p=spawn(process.execPath,['--input-type=module','-e',code]); let s='',e='';p.stdout.on('data',x=>s+=x);p.stderr.on('data',x=>e+=x);p.on('exit',c=>c?fail(Error(e)):ok(JSON.parse(s)))})));\nif(new Set(results.map(x=>x.uid)).size!==4) throw Error('duplicate');\nconst next=allocate({enabled:true,first:61000,last:61007}); if(results.some(x=>x.uid===next.uid)) throw Error('reused');\nconsole.log(JSON.stringify([...results,next]));`;
    const result=spawnSync('/usr/bin/bwrap',['--die-with-parent','--unshare-net','--ro-bind','/','/','--bind',dir,'/etc','--','/usr/bin/node','--input-type=module','-e',source],{encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr);
    const ids=JSON.parse(result.stdout);
    assert.equal(new Set(ids.map(x=>x.uid)).size,5);
    assert.ok(ids.every(x=>x.uid!==61000 && x.uid===x.gid));
    assert.equal(fs.readFileSync(path.join(dir,'passwd'),'utf8').split('\n').filter(x=>x.startsWith('dys')).length,5);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
