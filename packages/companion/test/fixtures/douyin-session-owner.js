import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=process.argv[2],dir=fs.mkdtempSync(path.join(root,'session-'));
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(path.join(dir,'.owner.json'),JSON.stringify({owner:process.pid,child:child.pid}));
console.log(JSON.stringify({dir,pid:child.pid}));
child.unref();
setInterval(()=>{},1000);
