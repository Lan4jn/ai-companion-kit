// Private one-shot display primitive. Same-UID and privileged processes remain trusted.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, timingSafeEqual } from 'node:crypto';
const exec = promisify(execFile);

export async function createHeadedDisplay({root, ttlMs=1800000}) {
  if (!path.isAbsolute(root) || !Number.isFinite(ttlMs) || ttlMs < 100 || ttlMs > 1800000) throw Error('invalid display configuration');
  const directory=fs.mkdtempSync(path.join(root,'display-')); fs.chmodSync(directory,0o700);
  const raw=path.join(directory,'rfb.sock'), socket=path.join(directory,'access.sock'), auth=path.join(directory,'Xauthority');
  fs.writeFileSync(auth,'',{mode:0o600,flag:'wx'});
  const token=randomBytes(32).toString('hex');
  let xvnc, windowManager, server, timer, closing, resolveClosed, claimed=false;
  const clients=new Set();
  const closed=new Promise(r=>resolveClosed=r);
  async function close() {
    if (closing) return closing;
    closing=(async()=>{
      clearTimeout(timer);
      for (const s of clients) s.destroy();
      if(server?.listening) await new Promise(r=>server.close(r));
      if(windowManager && windowManager.exitCode===null && windowManager.signalCode===null) {
        const ended=new Promise(r=>windowManager.once('exit',r)); windowManager.kill('SIGTERM');
        const kill=setTimeout(()=>windowManager.kill('SIGKILL'),2000); await ended; clearTimeout(kill);
      }
      if(xvnc && xvnc.exitCode===null && xvnc.signalCode===null) {
        const ended=new Promise(r=>xvnc.once('exit',r)); xvnc.kill('SIGTERM');
        const kill=setTimeout(()=>xvnc.kill('SIGKILL'),2000); await ended; clearTimeout(kill);
      }
      fs.rmSync(directory,{recursive:true,force:true}); resolveClosed();
    })();
    return closing;
  }
  try {
    xvnc=spawn('Xvnc',['-displayfd','3','-auth',auth,'-rfbport','-1','-rfbunixpath',raw,'-rfbunixmode','0600','-SecurityTypes','None','-nolisten','tcp','-geometry','1024x768','-depth','24'],{stdio:['ignore','ignore','ignore','pipe']});
    const display=await new Promise((resolve,reject)=>{
      let data=''; const timeout=setTimeout(()=>reject(Error('display startup timeout')),5000);
      xvnc.once('error',reject); xvnc.once('exit',()=>reject(Error('display exited')));
      xvnc.stdio[3].on('data',b=>{data+=b; if(data.includes('\n')) {clearTimeout(timeout); const n=data.trim(); /^\d+$/.test(n)?resolve(':'+n):reject(Error('invalid display'));}});
    });
    await exec('xauth',['-f',auth,'add',display,'.',randomBytes(16).toString('hex')],{timeout:5000});
    windowManager=spawn('openbox',[],{env:{...process.env,DISPLAY:display,XAUTHORITY:auth},stdio:'ignore'});
    await new Promise((resolve,reject)=>{windowManager.once('spawn',resolve);windowManager.once('error',reject);});
    windowManager.once('exit',()=>close());
    server=net.createServer(s=>{
      clients.add(s); s.on('close',()=>clients.delete(s)); s.on('error',()=>{});
      if(claimed || clients.size>16) return s.destroy();
      let input=Buffer.alloc(0); s.setTimeout(3000,()=>s.destroy());
      s.on('data',function handshake(chunk){
        input=Buffer.concat([input,chunk]); const n=input.indexOf(10);
        if(n<0) {if(input.length>64) s.destroy(); return;}
        const given=input.subarray(0,n), expected=Buffer.from(token);
        if(given.length!==expected.length || !timingSafeEqual(given,expected) || claimed) return s.destroy();
        claimed=true; s.removeListener('data',handshake); s.setTimeout(0);
        const up=net.createConnection(raw); clients.add(up); up.on('close',()=>{clients.delete(up); close();}); up.on('error',()=>close());
        s.on('close',()=>close());
        up.on('connect',()=>{if(input.length>n+1) up.write(input.subarray(n+1)); s.pipe(up); up.pipe(s);});
      });
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});});
    fs.chmodSync(socket,0o600);
    xvnc.once('exit',()=>close()); timer=setTimeout(()=>close(),ttlMs);
    return {directory,socket,token,env:{DISPLAY:display,XAUTHORITY:auth},closed,close};
  } catch(e) { await close(); throw e; }
}
