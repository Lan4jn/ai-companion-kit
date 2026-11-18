import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifyDurableContext} from '../src/chat-durable-context.js';

const key=Buffer.alloc(32,7), scope={tenant:'fixture',platform:'qq',type:'private',session:'private:123',user:'123'};
const signed=(data,k=key)=>{const bytes=Buffer.from(JSON.stringify(data));return {bytes,mac:createHmac('sha256',k).update('durable-context-v1\0').update(bytes).digest()};};
const bundle=()=>({version:1,scope,expiresAt:Date.now()+30000,role:'小鱼喜欢自然聊天',memories:[{scope,text:'我们喜欢吃苹果'}]});
const verify=(value,overrides={})=>verifyDurableContext({enabled:true,key,scope,...signed(value),...overrides});

test('authenticated exact-scope snapshot preserves natural role and memory',()=>{
 const result=verify(bundle()); assert.equal(result.role,'小鱼喜欢自然聊天'); assert.deepEqual(result.memories,['我们喜欢吃苹果']);
});
test('disabled, untrusted, expired and cross-scope snapshots fail closed',()=>{
 const value=bundle(); assert.throws(()=>verify(value,{enabled:false}));
 assert.throws(()=>verify(value,{mac:Buffer.alloc(32)}));
 assert.throws(()=>verify({...value,expiresAt:Date.now()-1}));
 assert.throws(()=>verify({...value,scope:{...scope,user:'124'}}));
 assert.throws(()=>verify({...value,memories:[{scope:{...scope,session:'private:124'},text:'secret'}]}));
 assert.throws(()=>verify({...value,role:''}));
});
