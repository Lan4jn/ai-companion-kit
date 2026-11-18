import test from 'node:test';
import assert from 'node:assert/strict';
import {beginDouyinRenewal} from '../src/douyin-credential-renewal.js';

const cookie = value => [{name:'sessionid',value,domain:'.douyin.com',path:'/',expires:-1}];

test('renewal commits the exact detached candidate despite mutation during verification', async () => {
  const original=cookie('baseline'), candidate=cookie('candidate');
  let release, entered;
  const gate=new Promise(r=>{release=r}), waiting=new Promise(r=>{entered=r});
  let committed, calls=0;
  const store={snapshot:()=>({version:'version',cookies:original}),commit:(_version,c)=>{committed=c; return true;}};
  const renewal=beginDouyinRenewal({store,enabled:true,verify:async c=>{
    if (++calls===1) {entered(); await gate;}
    c[0].value='verifier mutation';
    return {state:'online',identity:'synthetic'};
  }});
  renewal.cookies[0].value='caller baseline mutation';
  original[0].value='store baseline mutation';
  const done=renewal.finish(candidate);
  await waiting;
  candidate[0].value='caller candidate mutation';
  release();
  assert.equal(await done,true);
  assert.deepEqual(committed,cookie('candidate'));
});

test('renewal rejects whitespace identity and consumes invalid attempts', async () => {
  let commits=0;
  const store={snapshot:()=>({version:'version',cookies:cookie('old')}),commit:()=>{commits++;}};
  const empty=beginDouyinRenewal({store,enabled:true,verify:async()=>({state:'online',identity:'  '})});
  assert.equal(await empty.finish(cookie('new')),false);
  const invalid=beginDouyinRenewal({store,enabled:true,verify:async()=>({state:'online',identity:'synthetic'})});
  assert.equal(await invalid.finish(null),false);
  assert.equal(await invalid.finish(cookie('new')),false);
  assert.equal(commits,0);
});
