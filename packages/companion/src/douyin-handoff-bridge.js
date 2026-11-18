import fs from 'node:fs';
import net from 'node:net';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {isRoomRequestAllowed} from './room-cross-site-security.js';
import {isPrivateLoginRequest} from './room-login-security.js';

const page=fs.readFileSync(new URL('./douyin-handoff-viewer.html',import.meta.url),'utf8');
const require=createRequire(import.meta.url);
export function createHandoffBridge({enabled=false,accessToken,service,ttlMs=180000,readyMs=15000}={}) {
  if (!enabled) return {handle:()=>false,upgrade:()=>false,close:async()=>{}};
  if (typeof accessToken!=='string' || !/^[A-Za-z0-9_-]{32,256}$/.test(accessToken)) throw Error('authentication required');
  if (!service || !Number.isFinite(ttlMs) || ttlMs<100 || ttlMs>1800000 || !Number.isFinite(readyMs) || readyMs<100 || readyMs>ttlMs) throw Error('invalid bridge configuration');
  const {WebSocketServer,WebSocket}=require('ws');
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:65536});
  const digest=createHash('sha256').update(`room:${accessToken}`).digest();
  let active=null, closed=false, closing=null;
  function allowed(req,originRequired=false) {
    if (!isRoomRequestAllowed(req) || !isPrivateLoginRequest(req) || (originRequired && req.headers.origin!==`http://${req.headers.host}`)) return false;
    const matches=req.rawHeaders.filter((v,i)=>i%2===0 && v.toLowerCase()==='authorization');
    const match=/^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization||'');
    return matches.length===1 && timingSafeEqual(digest,createHash('sha256').update(match?Buffer.from(match[1],'base64'):Buffer.alloc(0)).digest());
  }
  function finish(session, cancel=false) {
    if (!session || session.done) return;
    session.done=true; clearTimeout(session.timer); clearTimeout(session.readyTimer);
    session.ws?.terminate(); session.up?.destroy();
    if(active===session) active=null;
    void (cancel ? service.cancelHeadedDouyin() : service.disconnectHeadedDouyin());
  }
  function handle(req,res) {
    if (!req.url?.startsWith('/handoff')) return false;
    if (closed) {res.writeHead(503);res.end();return true;}
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    if (!allowed(req,req.method!=='GET')) {res.writeHead(401,{'WWW-Authenticate':'Basic realm="Companion Room", charset="UTF-8"'});res.end();return true;}
    if(req.url==='/handoff' && req.method==='GET') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});res.end(page);return true;
    }
    if(req.url==='/handoff/start' && req.method==='POST') {
      if(active) {res.writeHead(409);res.end('{}');return true;}
      const result=service.startHeadedDouyin();
      if(result.state!=='starting') {res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify(result));return true;}
      const session={token:randomBytes(32).toString('hex'),claimed:false,done:false};active=session;
      session.timer=setTimeout(()=>finish(session),ttlMs);
      session.readyTimer=setTimeout(()=>{if(!session.claimed) finish(session);},readyMs);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({token:session.token}));return true;
    }
    if(req.url==='/handoff/cancel' && req.method==='POST') {if(active) finish(active,true); else void service.cancelHeadedDouyin();res.writeHead(204);res.end();return true;}
    res.writeHead(404);res.end();return true;
  }
  function upgrade(req,socket,head) {
    if(req.url!=='/handoff/relay') return false;
    if(closed || !allowed(req,true) || !active) {socket.destroy();return true;}
    wss.handleUpgrade(req,socket,head,ws=>{
      let authenticated=false; const session=active;
      const handshake=setTimeout(()=>ws.terminate(),3000);
      ws.on('error',()=>{});
      ws.once('close',()=>{clearTimeout(handshake);if(authenticated)finish(session);});
      ws.on('message',(data,binary)=>{
        if(!authenticated) {
          const supplied=Buffer.from(data); const expected=Buffer.from(session.token);
          if(binary || session.done || session.claimed || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return ws.terminate();
          authenticated=true;session.claimed=true;session.ws=ws;clearTimeout(handshake);clearTimeout(session.readyTimer);
          const waitUntil=Date.now()+readyMs;
          const connect=()=>{
            if(session.done)return;
            const display=service.headedDouyinDisplay();
            if(!display) {if(Date.now()>=waitUntil)finish(session);else session.readyTimer=setTimeout(connect,50);return;}
            const up=session.up=net.createConnection(display.socket);up.on('error',()=>finish(session));up.on('close',()=>finish(session));
            up.on('connect',()=>up.write(display.token+'\n'));
            up.on('data',chunk=>{if(ws.readyState!==WebSocket.OPEN || ws.bufferedAmount>4*1024*1024) return finish(session);ws.send(chunk,{binary:true});});
          };connect();return;
        }
        if(!binary || !session.up || session.up.writableLength>1024*1024) return finish(session);
        session.up.write(data);
      });
    });return true;
  }
  function close(){
    if (closing) return closing;
    closed=true;
    // Shutdown is explicit cancellation: do not let disconnect promote a
    // candidate or block shutdown on an in-flight verification.
    if (active && !active.done) {
      const session=active; session.done=true; active=null;
      clearTimeout(session.timer);clearTimeout(session.readyTimer);
      session.ws?.terminate();session.up?.destroy();
    }
    wss.close();
    closing=Promise.resolve().then(()=>service.cancelHeadedDouyin());
    return closing;
  }
  return {handle,upgrade,close};
}
