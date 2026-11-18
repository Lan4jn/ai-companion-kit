// Explicit opt-in for an operator-trusted local OneBot LAN and local role card.
// Existing records are never automatically replayed. Unknown effects stay blocked.
import {createHmac} from 'node:crypto';
import {hasAuthorizedResume,hasAuthorizedInput} from './chat-durable-offline-recovery.js';
import fs from 'node:fs';
import path from 'node:path';
import {loadKey} from './chat-durable-runtime-candidate.js';
import {EncryptedChatJournal} from './chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate,createPreGenerationBatchCandidate,createBoundBatchProcessorCandidate} from './chat-durable-batch-candidate.js';
import {createLocalDurableBrainGenerator} from './chat-onebot-queue-bridge.js';
import {createManagedMemoryBrain} from './memory-brain-trust.js';
import {snapshotAuthenticatedOneBotPrivateMessage} from './transport-onebot.js';
import {isAuthenticatedOneBotSender,createAuthenticatedOneBotSender,createTrustedLoopbackOneBotSender} from './chat-onebot-authenticated-sender.js';

// The pinned OneBot service attests upstream QQ identities; it must itself be trusted.
export function createMainDurableTransport({config,onebot,ownerIds=[]}={}) {
 if (config?.enabled!==true) return null;
 const ownerId=String(config.ownerId || ''), t=config.transport;
 if (!/^[1-9]\d*$/.test(ownerId) || !ownerIds.includes(ownerId)) throw Error('configured owner required');
 let ws; try { ws=new URL(onebot?.wsUrl); } catch { throw Error('pinned WSS endpoint required'); }
 if (t?.trustLoopbackOneBot===true) {
  if (typeof onebot?.wsUrl!=='string' || !/^ws:\/\/127\.0\.0\.1(?::[0-9]+)?(?:\/|$)/.test(onebot.wsUrl) || ws.protocol!=='ws:' || ws.hostname!=='127.0.0.1' || ws.username || ws.password || ws.hash || ws.search) throw Error('literal loopback WS required');
  const sender=createTrustedLoopbackOneBotSender({url:t.senderUrl,ownerId,accessToken:onebot?.accessToken || ''});
  console.warn('[持久聊天] 已显式信任本机明文 OneBot：无法验证进程或上游 QQ 身份');
  return {sender,ingressAuthentication:{enabled:true,trustLoopbackOneBot:true,ownerId}};
 }
 if (ws.protocol!=='wss:' || ws.username || ws.password || ws.hash) throw Error('pinned WSS endpoint required');
 if (!t || typeof t.caPath!=='string' || !path.isAbsolute(t.caPath) || typeof t.certificateSha256!=='string' || !/^[a-f0-9]{64}$/.test(t.certificateSha256)) throw Error('pinned transport CA required');
 const ca=fs.readFileSync(t.caPath);
 const sender=createAuthenticatedOneBotSender({url:t.senderUrl,ca,certificateSha256:t.certificateSha256,ownerId,accessToken:onebot?.accessToken || ''});
 return {sender,ingressAuthentication:{enabled:true,ca,certificateSha256:t.certificateSha256,ownerId}};
}

export function startMainDurableChat({config,brain,bot,sender,ownerIds=[],memoryConfig}={}) {
 if (config?.enabled !== true) return null;
 if (config.trustLocalCard !== true) throw Error('local card trust required');
 const ownerId=String(config.ownerId || '');
 if (!ownerIds.includes(ownerId) || !/^[1-9]\d*$/.test(ownerId)) throw Error('configured owner required');
 if (!isAuthenticatedOneBotSender(sender,ownerId)) throw Error('authenticated OneBot sender required');
 if (typeof config.directory!=='string' || !config.directory.startsWith('/') || typeof config.keyPath!=='string') throw Error('absolute journal directory and key required');
 const scope={tenant:'companion',platform:'qq',type:'private',session:`private:${ownerId}`,user:ownerId};
 if (memoryConfig?.enabled!==true || memoryConfig.trustedProcess!==true || !Array.isArray(memoryConfig.authorizedSources) || !memoryConfig.authorizedSources.includes('qq-private-message') || Object.keys(scope).some(k=>memoryConfig.trustedScope?.[k]!==scope[k])) throw Error('durable history forget barrier unavailable');
 if (memoryConfig.backend !== 'sqlite-fts') throw Error('atomic history reservation requires sqlite-fts');
 const store=createManagedMemoryBrain({directory:memoryConfig.directory,scope,sources:memoryConfig.authorizedSources,trustedProcess:true,python:memoryConfig.python,engineRoot:memoryConfig.engineRoot,backend:memoryConfig.backend,maxChatHistoryTurns:memoryConfig.maxChatHistoryTurns});
 const generate=createLocalDurableBrainGenerator({brain,ownerId,trustLocalCard:true,history:true,store,scope});
 const key=loadKey(config.keyPath); let journal;
 try { journal=new EncryptedChatJournal({directory:config.directory,key}); } finally { key.fill(0); }
 try {
  const queue=new DurableBatchCandidate(journal);
  const sealKey=createHmac('sha256',journal.key).update('main-local-onebot-seal-v1').digest();
  const ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  const generation=createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId,generate});
  // A signed acknowledgement is retained until the durable history commit.
  const delivery=createBoundBatchProcessorCandidate({enabled:true,queue,bot,sender,sealKey,ownerId,retainAcknowledged:true,requireHistoryProvenance:true});
  const sessions=[...new Set(journal.rows.map(r=>r.session))];
  // A recoverable head must not authorize replay of older accepted inputs behind it.
  const startupInputs=new Set(journal.rows.filter(r=>r.type==='input').map(r=>r.id));
  const blocked=new Set(sessions.filter(s=>{ const row=queue.list(s)[0]; return row?.state!=='history-pending' && !hasAuthorizedResume(journal,row) && !hasAuthorizedInput(journal,row); }));
  const timers=new Map(), active=new Map(); let stopped=false;
  async function process(session) {
   if (active.has(session) || blocked.has(session)) return;
   const job=(async()=>{
    try {
     // Check the scoped store before any resumed or new network side effect.
     await store.chatHistory(scope);
     while (!stopped) {
      const rows=queue.list(session);
      if (!rows.length) return;
      if (rows[0].state==='history-pending') { await delivery.recordHistory(session,brain.memory,{store,scope}); continue; }
      if (rows[0].type==='input') await store.requireChatHistoryCapacity(scope);
     if (rows[0].type==='batch' && rows[0].state==='ready' && hasAuthorizedResume(journal,rows[0])) {
      while (queue.list(session)[0]?.state==='ready') {
       const result=await delivery.process(session,{store,scope});
       if (result.status!=='delivered') { blocked.add(session); return; }
      }
      if (queue.list(session)[0]?.state!=='history-pending') { blocked.add(session); return; }
      await delivery.recordHistory(session,brain.memory,{store,scope});
      continue;
     }
     if (rows[0].type==='input' && startupInputs.has(rows[0].id) && hasAuthorizedInput(journal,rows[0])) {
      await generation.form(session,1);
      // Approval covers generation only, never automatic delivery.
      blocked.add(session); return;
     }
     if (rows[0].type!=='input' || startupInputs.has(rows[0].id)) { blocked.add(session); return; }
      const count=rows.findIndex(r=>r.type!=='input' || startupInputs.has(r.id));
      await generation.form(session,count<0 ? rows.length : count);
      while (queue.list(session)[0]?.state === 'ready') {
       const result=await delivery.process(session,{store,scope});
       if (result.status!=='delivered') { blocked.add(session); return; }
      }
      if (queue.list(session)[0]?.state !== 'history-pending') { blocked.add(session); return; }
      await delivery.recordHistory(session,brain.memory,{store,scope});
     }
    } catch (error) { console.error('[持久聊天] 处理失败，会话已暂停:', error.message); blocked.add(session); }
   })();
   active.set(session,job); try { await job; } finally { active.delete(session); }
  }
  for (const session of sessions) if (!blocked.has(session)) setTimeout(()=>void process(session),0);
  return Object.freeze({
   accept(msg,windowMs=0) {
    if (stopped) throw Error('durable chat stopped');
    snapshotAuthenticatedOneBotPrivateMessage(bot,msg,ownerId);
    const ref=ingress.accept(msg);
    if (!ref.duplicate && !blocked.has(ref.session)) {
     clearTimeout(timers.get(ref.session));
     timers.set(ref.session,setTimeout(()=>{timers.delete(ref.session);void process(ref.session);},Math.max(0,Math.min(Number(windowMs)||0,30000))));
    }
    return ref;
   },
   stop() { stopped=true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
   async close() { this.stop(); await Promise.allSettled([...active.values()]); journal.close(); sealKey.fill(0); }
  });
 } catch(error) { journal.close(); throw error; }
}
