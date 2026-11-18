import test from 'node:test';
import assert from 'node:assert/strict';
import {returnReaderToBookstore} from '../src/fanqie-device-navigation.js';
const node=(text,id,bounds,clickable=false)=>({text,id,bounds,clickable,enabled:true,packageName:'com.dragon.read'});
const base=()=>({focus:'com.dragon.read/com.dragon.read.reader.ui.ReaderActivity',nodes:[node('','com.dragon.read:id/aah','[28,59][70,101]',true),node('目录','x','[139,1859][173,1883]'),node('设置','x','[651,1859][685,1883]')],progress:{chapter:'第1章',page:2,total:1764}});
test('only exits an unchanged reader via the observed back control',async()=>{
 let taps=0;const state=base();const r=await returnReaderToBookstore({snapshot:async()=>state,tap:async(x,y)=>{assert.deepEqual([x,y],[49,80]);taps++;return true},bookstore:async()=>true});assert.equal(r,true);assert.equal(taps,1);
});
test('does not exit for changed progress, overlays, or non-reader foreground',async()=>{
 for(const mutate of [s=>s.progress.page++,s=>s.nodes.push(node('隐私协议','','[1,1][10,10]')),s=>s.focus='com.hongguo/.Main',s=>s.nodes[0].bounds='[30,59][70,101]']){
  let calls=0,taps=0;const r=await returnReaderToBookstore({snapshot:async()=>{const s=base();if(++calls===2)mutate(s);return s},tap:async()=>{taps++;return true},bookstore:async()=>true});assert.equal(r,false);assert.equal(taps,0);
 }
});
