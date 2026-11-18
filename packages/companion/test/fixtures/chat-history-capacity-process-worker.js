import {createMemoryBrain} from '../../src/memory-brain-adapter.js';
const [directory, mode, id='1', user='123'] = process.argv.slice(2);
const scope={tenant:'companion',platform:'qq',type:'private',session:`private:${user}`,user};
const store=createMemoryBrain({enabled:true,backend:'sqlite-fts',directory,maxChatHistoryTurns:1,authorize:async()=>true,recoveryAuthorization:async()=>true});
const turn={turnId:`turn-${id}`,events:[`onebot-message:${id}`],text:`question-${id}`,reply:`answer-${id}`};
if (mode==='write-kill') {
 const result=await store.commitChatHistory(scope,turn);
 if(result!=='inserted') throw Error(`unexpected ${result}`);
 process.kill(process.pid,'SIGKILL');
} else if (mode==='forget-kill') {
 await store.forget(scope,{source:'qq-private-message',evidence:turn.events[0]});
 process.kill(process.pid,'SIGKILL');
} else if (mode==='race') {
 // Parent releases all independent Node processes with a one-byte gate.
 await new Promise(resolve=>process.stdin.once('data',resolve));
 try {console.log(await store.commitChatHistory(scope,turn));}
 catch {console.log('rejected');}
} else throw Error('unknown mode');
