#!/usr/bin/env node
// Candidate-only, interactive local administrative operation; never expose as a service.
import {createInterface} from 'node:readline/promises';
import {isAbsolute} from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
 console.error('interactive terminal required; arguments are not accepted'); process.exit(1);
}
const rl=createInterface({input:process.stdin,output:process.stdout});
try {
 console.log('Candidate only; license unresolved. Trusted local administrator only. Input and results are visible.');
 console.log('A restored backup can contain revoked or forgotten memories. Review all intervening revocations before authorizing. This tool cannot verify rollback history.');
 const directory=await rl.question('Absolute private database directory: ');
 if (!isAbsolute(directory)) throw new Error('absolute directory required');
 const context={};
 for (const k of ['tenant','platform','type','session','user']) context[k]=await rl.question(`${k}: `);
 const source=await rl.question('source: ');
 const query=await rl.question('query: ');
 console.log('This authorizes one recall of this exact scope and source, including potentially restored memories.');
 if (await rl.question('Type AUTHORIZE RESTORED MEMORY to proceed: ') !== 'AUTHORIZE RESTORED MEMORY') throw new Error('cancelled');
 const brain=createMemoryBrain({enabled:true,directory,authorize:()=>true,recoveryAuthorization:()=>true});
 console.log(JSON.stringify(await brain.recall(context,{query,sources:[source]}),null,2));
} catch {
 console.error('Recall not completed. Check local input and access; no private details are logged.');
 process.exitCode=1;
} finally {rl.close();}
