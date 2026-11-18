import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createIsolatedHeadedLauncher} from '../src/douyin-isolated-launcher-candidate.js';

const options={env:{DOUYIN_LOGIN_SESSION_DIR:'/unused'}};
const wait=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});

test('launcher binds each allocated identity to the matching session and command', async()=>{
  let next=61000, closed=0;
  const prepared=[], commands=[];
  const launch=createIsolatedHeadedLauncher({
    allocateIdentity:()=>({uid:next,gid:next++}),
    prepareSession:(dir,id)=>prepared.push([dir,id.uid,id.gid]),
    allocateBroker:()=>({fd:fs.openSync('/dev/null','r'),broker:{close(){closed++;}}}),
    command:process.execPath,
    args:(dir,id)=>{commands.push([dir,id.uid,id.gid]);return ['-e','process.disconnect()'];},
  });
  await wait(launch('',[],options)); await wait(launch('',[],options));
  assert.deepEqual(prepared,[['/unused',61000,61000],['/unused',61001,61001]]);
  assert.deepEqual(commands,prepared);
  assert.equal(closed,2);
});

test('invalid identity fails before session preparation and broker allocation',()=>{
  let touched=false;
  const launch=createIsolatedHeadedLauncher({allocateIdentity:()=>({uid:0,gid:1}),
    prepareSession:()=>{touched=true;},allocateBroker:()=>{touched=true;},
    command:process.execPath,args:()=>[]});
  assert.throws(()=>launch('',[],options),/invalid session identity/);
  assert.equal(touched,false);
});

test('failed preparation burns the allocated identity rather than reusing it',async()=>{
  let next=61000, first=true; const seen=[];
  const launch=createIsolatedHeadedLauncher({allocateIdentity:()=>({uid:next,gid:next++}),
    prepareSession:(dir,id)=>{seen.push(id.uid);if(first){first=false;throw Error('prepare failed');}},
    allocateBroker:()=>({fd:fs.openSync('/dev/null','r'),broker:{close(){}}}),
    command:process.execPath,args:()=>['-e','process.disconnect()']});
  assert.throws(()=>launch('',[],options),/prepare failed/);
  await wait(launch('',[],options));
  assert.deepEqual(seen,[61000,61001]);
});
