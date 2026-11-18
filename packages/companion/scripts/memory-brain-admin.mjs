#!/usr/bin/env node
// Local OS-account/terminal boundary, not a network endpoint or web session.
import {createInterface} from 'node:readline/promises';
import {isAbsolute} from 'node:path';
import {createMemoryManager} from '../src/memory-brain-management.js';
if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
 console.error('interactive terminal required; arguments are not accepted'); process.exit(1);
}
const rl = createInterface({input:process.stdin,output:process.stdout});
try {
 console.log('Candidate-only. Your OS account is the authority; do not use from an untrusted or shared terminal. Input is visible.');
 const directory = await rl.question('Absolute private database directory: ');
 if (!isAbsolute(directory)) throw new Error('absolute directory required');
 const action = await rl.question('Operation (forget or revoke): ');
 if (action !== 'forget' && action !== 'revoke') throw new Error('invalid operation');
 const context = {};
 for (const key of ['tenant','platform','type','session','user']) context[key] = await rl.question(`${key}: `);
 const source = await rl.question('source: ');
 const evidence = action === 'forget' ? await rl.question('evidence: ') : undefined;
 console.log('Revoke permanently removes all memories for the exact scope and source. Forget removes the exact evidence.');
 if (await rl.question('Type DELETE to confirm: ') !== 'DELETE') throw new Error('cancelled');
 const manager = createMemoryManager({enabled:true,directory,authorize:()=>true,authorizeManagement:()=>true});
 await manager[action]({context,source,evidence});
 console.log('Operation completed.');
} catch {
 console.error('Operation not completed. Check local input and access; no private details are logged.');
 process.exitCode = 1;
} finally { rl.close(); }
