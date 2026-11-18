#!/usr/bin/env node
// Explicit operator-started candidate. Never enabled by normal companion startup.
import {startTrustedSenderService} from '../src/chat-trusted-sender-service.js';
let service;
try {
 const args=process.argv.slice(2), opts={};
 const allowed=['--enable','--directory','--key','--seal-key','--owner','--socket','--port','--certificate-sha256','--token-file','--onebot-unix-socket'];
 for(let i=0;i<args.length;i++) {const k=args[i];if(!allowed.includes(k)||Object.hasOwn(opts,k))throw Error('arguments');if(k==='--enable')opts[k]=true;else {if(!args[i+1]||args[i+1].startsWith('--'))throw Error('arguments');opts[k]=args[++i];}}
 if(['--enable','--directory','--key','--seal-key','--owner','--socket'].some(k=>!opts[k]))throw Error('arguments');
 const unix=!!opts['--onebot-unix-socket'];
 if(unix ? ['--port','--certificate-sha256','--token-file'].some(k=>opts[k]) : (!opts['--port']||!opts['--certificate-sha256']||!opts['--token-file']||!/^[1-9]\d{0,4}$/.test(opts['--port'])))throw Error('arguments');
 const endpoint=unix?{unixSocketPath:opts['--onebot-unix-socket']}:{host:'127.0.0.1',port:Number(opts['--port']),certificateSha256:opts['--certificate-sha256'],tokenPath:opts['--token-file']};
 service=await startTrustedSenderService({enabled:opts['--enable'],directory:opts['--directory'],keyPath:opts['--key'],sealKeyPath:opts['--seal-key'],ownerId:opts['--owner'],socket:opts['--socket'],endpoint});
 console.log('Restricted sender ready; explicit selection required. ACK is not recipient display.');
 let stopping=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;try{await service.close();}catch{console.error('Sender shutdown failed; investigate offline.');process.exitCode=1;}});
} catch {console.error('Sender refused; check identity evidence, permissions, arguments and journal offline.');process.exitCode=1;}
