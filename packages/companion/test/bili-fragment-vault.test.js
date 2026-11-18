import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openFragmentVault } from '../src/bili-fragment-vault.js';

const base = process.env.TMPDIR || os.tmpdir();
test('durable bound credentials reject mutation, cross-scope and replay', () => {
 const root=fs.mkdtempSync(path.join(base,'bili-vault-')); fs.chmodSync(root,0o700);
 try {
  const dir=path.join(root,'vault');
  const data={scope:{tenant:'companion',user:'a'},bvid:'BV1234567890',segment:{start:0,end:5,visual:'片段内容'},quote:'片段',playback:{start:0,end:6}};
  const vault=openFragmentVault(dir); const token=vault.issue(data);
  assert.equal(vault.verify(token,data),true);
  assert.equal(vault.verify(token,{...data,quote:'内容'}),false);
  assert.equal(vault.verify(token,{...data,bvid:'BV0987654321'}),false);
  assert.equal(vault.verify(token,{...data,segment:{...data.segment,end:4}}),false);
  assert.equal(vault.verify(token,{...data,playback:{start:0,end:7}}),false);
  assert.equal(vault.verify(token,{...data,scope:{tenant:'companion',user:'b'}}),false);
  const script=`import {openFragmentVault} from ${JSON.stringify(new URL('../src/bili-fragment-vault.js',import.meta.url).href)}; const v=openFragmentVault(process.argv[1]); console.log(v.verify(JSON.parse(process.argv[2]),JSON.parse(process.argv[3])))`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,dir,JSON.stringify(token),JSON.stringify(data)],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),'true');
  assert.equal(vault.consume(token,data),true); assert.equal(vault.consume(token,data),false);
  assert.equal(vault.verify(token,data),true);
  fs.chmodSync(path.join(dir,'key'),0o644); assert.equal(vault.verify(token,data),false); assert.throws(()=>openFragmentVault(dir));
  fs.chmodSync(path.join(dir,'key'),0o600);
  fs.chmodSync(dir,0o755); assert.throws(()=>openFragmentVault(dir));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
