// Offline-only entry for the shared inherited-FD lifecycle.
import fs from 'node:fs';
import {runIsolatedHeadedWorker} from '../src/douyin-isolated-headed-worker.js';
if (!process.env.NODE_TEST_CONTEXT || process.getuid() === 0) throw Error('fixture only');
const [sessionDir,chromePath]=process.argv.slice(2);
const controller=new AbortController();
const stop=()=>controller.abort();
process.on('SIGTERM',stop); process.on('SIGINT',stop);
try {
  await runIsolatedHeadedWorker({sessionDir,chromePath,signal:controller.signal,
    delays:{initial:100,qr:100,poll:100},
    onDisplay:details=>{if(process.send) process.send({type:'display',...details});
      else fs.writeFileSync(sessionDir+'/display.json',JSON.stringify(details),{mode:0o600});}});
} finally {stop();}
