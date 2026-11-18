// Shared isolated lifecycle; the executable entry is deliberately test-only.
// No environment flag enables official-site login or authorizes broker policy.
import net from 'node:net';
import {runHeadedLifecycle} from './douyin-headed-lifecycle.js';
import {createInheritedBrokerClient} from './douyin-inherited-broker-client.js';
import {installCandidateBrokerRoute} from './douyin-broker-route-candidate.js';

export async function runIsolatedHeadedWorker({sessionDir, chromePath, onDisplay, signal, fd=3, delays, ttlMs=60000}) {
  if (!process.env.NODE_TEST_CONTEXT || process.getuid?.() === 0) throw Error('synthetic worker disabled');
  const client=createInheritedBrokerClient(fd);
  try {
    const reachable=await new Promise(resolve=>{
      const socket=net.connect({host:'8.8.8.8',port:443});
      socket.setTimeout(1000,()=>{socket.destroy();resolve(true);});
      socket.on('connect',()=>{socket.destroy();resolve(true);});
      socket.on('error',()=>resolve(false));
    });
    if (reachable) throw Error('network namespace not isolated');
    await runHeadedLifecycle({sessionDir,signal,displayOptions:{ttlMs},onDisplay,
      daemonOptions:{url:'https://www.douyin.com/',delays,testChromePath:chromePath,
        installTestContext:context=>installCandidateBrokerRoute(context,{brokerClient:client})}});
  } finally {client.close();}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  throw Error('synthetic worker disabled');
}
