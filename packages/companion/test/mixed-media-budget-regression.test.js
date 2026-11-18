import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTurn} from '../src/index.js';
import {Humanizer} from '../src/humanize.js';

async function run(reply, imageResults=[]) {
 const sent=[];
 const bot={sendImage:async(_k,img)=>{sent.push(['image',img]);return imageResults.shift() ?? {ok:true}},send:async(_k,text)=>{sent.push(['text',text]);return {ok:true}},sendVoice:async()=>{sent.push(['voice']);return {ok:true}},setTyping:async()=>{}};
 const brain={reply:async()=>reply,rewriteConciseDraft:async()=>'',regenerateConciseDraft:async()=>'',verifyConciseDraft:async()=>true};
 const memory={renderPerson:()=>'',renderRecent:()=>'',sessionTurns:()=>[],touch:()=>{},logTurn:()=>{}};
 await handleTurn({bot,brain,human:new Humanizer({enabled:false}),memory,waker:{wake(){}}},[{platform:'qq',key:'private:42',userId:'42',name:'fixture',isGroup:false,text:'你好',images:[],raw:[]}],{ownerIds:[],dataDir:process.env.TMPDIR});
 return sent;
}
const image='base64://'+'YQ=='.repeat(50);
test('tool image payload and natural text are delivered, payload does not count as text',async()=>{
 const sent=await run({text:`看这里\n[CQ:image,file=${image}]`});
 assert.deepEqual(sent,[['image',image],['text','看这里']]);
});
test('multiple attachments with 50 code points stay within three actual sends',async()=>{
 const sent=await run({text:`${'🐟'.repeat(50)}[CQ:image,file=${image}][CQ:image,file=${image}]`});
 assert.equal(sent.length,3); assert.deepEqual(sent.map(x=>x[0]),['image','image','text']); assert.equal([...sent[2][1]].length,50);
});
test('too many image and text bubbles fail before sending any',async()=>{
 const sent=await run({text:`一\n\n二[CQ:image,file=${image}][CQ:image,file=${image}]`});
 assert.deepEqual(sent,[]);
});
test('unknown image outcome stops subsequent attachments and text',async()=>{
 const sent=await run({text:`好[CQ:image,file=${image}][CQ:image,file=${image}]`},[{ok:false,outcome:'unknown'}]);
 assert.deepEqual(sent,[['image',image]]);
});
test('image plus two voice chunks fits',async()=>{
 const sent=await run({text:`[CQ:image,file=${image}]`,voiceB64:'a',voiceText:'你好',voiceChunks:[{base64:'a',spokenText:'你'},{base64:'b',spokenText:'好'}]});
 assert.deepEqual(sent.map(x=>x[0]),['image','voice','voice']);
});
