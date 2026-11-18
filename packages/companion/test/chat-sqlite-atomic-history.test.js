import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {Memory} from '../src/memory.js';

test('confirmed history and forget use the same scoped transaction', async t => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-atomic-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'store'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
 const turn={turnId:'turn-1',events:['onebot-message:-42','onebot-message:43'],text:'secret input',reply:'secret reply'};
 assert.equal(await Memory.prototype.logDurableTurn.call({},turn.turnId,{where:scope.session,who:scope.user,text:turn.text,reply:turn.reply,evidence:turn.events,store,scope}),'inserted');
 assert.equal(await store.commitChatHistory(scope,turn),'duplicate');
 assert.deepEqual(await store.chatHistory(scope),[turn]);
 await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:-42'});
 assert.deepEqual(await store.chatHistory(scope),[]);
 assert.equal(await store.commitChatHistory(scope,turn),'forgotten');
});

test('racing commit and forget cannot resurrect the turn', async t => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-race-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'store'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
 const turn={turnId:'racing',events:['onebot-message:-9'],text:'race input',reply:'race reply'};
 await Promise.all([store.commitChatHistory(scope,turn),store.forget(scope,{source:'qq-private-message',evidence:turn.events[0]})]);
 assert.deepEqual(await store.chatHistory(scope),[]);
 assert.equal(await store.commitChatHistory(scope,turn),'forgotten');
});
