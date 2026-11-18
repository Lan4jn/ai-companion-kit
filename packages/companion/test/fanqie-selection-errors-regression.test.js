import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCandidate} from '../src/fanqie-select.js';
import {selectAndOpen} from '../src/fanqie-navigation.js';
const cards=[{title:'一本小说',description:'一个真实候选'}];
test('malformed selection is an error, never a refusal',async()=>{
 const result=await selectAndOpen({observe:async()=>cards,choose:c=>chooseCandidate({complete:async()=>'{"choice":null}'},c),click:async()=>{throw Error('must not click')},enter:async()=>true});
 assert.equal(result.reason,'selection-unavailable');
});
test('explicit zero remains a refusal',async()=>{
 const result=await selectAndOpen({observe:async()=>cards,choose:c=>chooseCandidate({complete:async()=>'{"choice":0}'},c),click:async()=>{throw Error('must not click')},enter:async()=>true});
 assert.equal(result.reason,'not-interested');
});
