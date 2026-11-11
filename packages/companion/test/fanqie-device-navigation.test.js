import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyOpenedReader} from '../src/fanqie-device-navigation.js';

test('direct reader requires exact catalog title and readable content', async () => {
 const actions=[]; const nodes=[{text:'目录',bounds:'[100,1800][200,1900]'}];
 const io={progress:async()=>({page:1,total:20}),capture:async()=>({text:'actual page'}),dump:async()=>nodes,tap:async(x,y)=>{actions.push([x,y]);return true},catalog:async()=>[{text:'域河'},{text:'目录'},{text:'连载至632章'}],back:async()=>actions.push('back')};
 assert.equal(await verifyOpenedReader({title:'域河'},io),true);
 assert.deepEqual(actions,[[150,1850],'back']);
 assert.equal(await verifyOpenedReader({title:'别的书'},io),false);
});

test('reader evidence and catalog structure are required',async()=>{
 const io={progress:async()=>null,capture:async()=>({text:'page'}),dump:async()=>[],tap:async()=>{},catalog:async()=>[{text:'域河'}],back:async()=>{}};
 assert.equal(await verifyOpenedReader({title:'域河'},io),false);
});
