import test from 'node:test';
import assert from 'node:assert/strict';
import {continuousPlaybackEvidence} from '../src/bili-browser.js';
test('continuous playback tolerates media duration corrections when final endpoint is reached',()=>{
 const samples=Array.from({length:21},(_,i)=>({time:i*.5,wall:i*.25,duration:i<5?10.4:10,rate:2,paused:i===20,ended:i===20,seeking:false,identity:true}));
 assert.equal(continuousPlaybackEvidence(samples).complete,true);
});
