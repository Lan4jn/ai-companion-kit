import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Brain} from '../src/brain.js';
const mk=()=>new Brain({apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',memory:{renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],remember:()=>{},logTurn:()=>{}},role:{build:()=>''},dataDir:process.env.TMPDIR});
test('factual reply is unchanged without requesting a rewrite',async t=>{
 const bodies=[];t.mock.method(globalThis,'fetch',async (_u,o)=>{const b=JSON.parse(o.body);bodies.push(b); const choice=bodies.length===1?{message:{content:'这条我认。正文包含重要事实。'},finish_reason:'stop'}:{message:{content:'不完整内容'},finish_reason:'length'};const x={choices:[choice]};return {ok:true,text:async()=>JSON.stringify(x),json:async()=>x}});
 const r=await mk().reply({key:'private:fs-audit',userId:'42',text:'你好',record:false});
 assert.equal(r.text,'这条我认。正文包含重要事实。');assert.equal(bodies.length,1);
});
test('rewrites do not expose provider response body in logs',async t=>{
 const logs=[];t.mock.method(console,'warn',(...x)=>logs.push(x.join(' ')));let n=0;t.mock.method(globalThis,'fetch',async()=>{n++; if(n===1)return {ok:false,status:400,text:async()=> 'SECRET_FIXTURE'};const x={choices:[{message:{content:'你好'}}]};return {ok:true,text:async()=>JSON.stringify(x)}});
 await mk().reply({key:'private:fs-audit2',userId:'42',text:'你好',record:false});assert.ok(!logs.join(' ').includes('SECRET_FIXTURE'));
});
