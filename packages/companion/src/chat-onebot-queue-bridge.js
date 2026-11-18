// Opt-in recovery bridge; sender must verify its TLS peer on each request.
// WSS authenticates the service, not its asserted upstream user; trust that service.
// Selector/seal-key holders and same-UID code remain trusted. Whole-journal
// rollback cannot be detected without an independent monotonic authority.
import {startTrustedSenderCandidate} from './chat-trusted-sender-candidate.js';
import {isAuthenticatedOneBotSender} from './chat-onebot-authenticated-sender.js';
import {snapshotAuthenticatedOneBotPrivateMessage} from './transport-onebot.js';
import {createTransportBoundMessageCandidate,createPreGenerationBatchCandidate} from './chat-durable-batch-candidate.js';
import {prepareConciseReply} from './chat-concise-delivery.js';
import {createHmac} from 'node:crypto';
import {Brain} from './brain.js';
const brainAuthorizations=new WeakMap();
export function consumeBrainCandidateAuthorization(capability, brain, messages) {
 const auth=brainAuthorizations.get(capability);
 brainAuthorizations.delete(capability);
 return auth && auth.brain===brain && auth.messages===messages && brain.ownerIds.has(auth.ownerId) ? auth : null;
}
export {signBridgeSelector} from './chat-onebot-queue-selector.js';
const ingressKey=(sealKey,ownerId)=>createHmac('sha256',sealKey).update('onebot-authenticated-ingress-v1\0').update(ownerId).digest();

// Data-only opt-in ingress. The TLS peer is trusted to attest QQ sender IDs.
export function createAuthenticatedOneBotIngressCandidate({enabled=false,queue,bot,sealKey,ownerId}={}) {
 if (enabled!==true) throw Error('authenticated ingress disabled');
 if (typeof ownerId!=='string' || !/^[1-9]\d*$/.test(ownerId)) throw Error('owner required');
 if (!Buffer.isBuffer(sealKey) || sealKey.length!==32) throw Error('32-byte seal key required');
 const scopedKey=ingressKey(sealKey,ownerId);
 const bridge=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:scopedKey});
 return Object.freeze({
  accept(msg) { snapshotAuthenticatedOneBotPrivateMessage(bot,msg,ownerId); return bridge.accept(msg); },
  reconstruct(session,input) {
   const message=bridge.reconstruct(session,input);
   if (message.sender!==ownerId || message.conversation!==`private:${ownerId}`) throw Error('owner mismatch');
   return message;
  }
 });
}

export function createLocalDurableBrainGenerator({brain,ownerId,trustLocalCard=false,history=false,store,scope}={}) {
 if (!(brain instanceof Brain) || !brain.ownerIds.has(ownerId) || trustLocalCard!==true) throw Error('trusted local brain and card required');
 const persona=brain.role.buildDurablePersona({trustLocalCard:true});
 return async messages=>{
  const capability=Object.freeze({});
  const fetched=store ? await store.chatHistory(scope) : null;
  // Bind the exact immutable snapshot supplied to the model, not a mutable
  // caller-owned array that could be changed while generation is in flight.
  const turns=fetched===null ? null : structuredClone(fetched);
  if (turns) { for (const turn of turns) { if (Array.isArray(turn.events)) Object.freeze(turn.events); Object.freeze(turn); } Object.freeze(turns); }
  brainAuthorizations.set(capability,{brain,ownerId,messages,persona,history:history===true,turns});
  const segments=await brain.generateDurableTextCandidate(messages,capability);
  const delivery=await prepareConciseReply(segments.join('\n\n'), (draft, feedback)=>brain.rewriteConciseDraft(draft, feedback), (draft,candidate)=>brain.verifyConciseDraft(draft,candidate), {regenerate:draft=>brain.regenerateConciseDraft(draft,messages.map(m=>({role:'user',content:m.text})))});
  if (delivery.failed) throw Error('concise failed');
  // Paragraph separators are represented by distinct messages. Remove only
  // boundary whitespace so the durable artifact validator accepts those parts.
  const parts=delivery.parts.map(part=>part.trim());
  return history===true ? {segments:parts,history:turns || []} : parts;
 };
}

// Explicit local composition; generation authority and sender remain separate.
// No automatic replay, worker or network listener is started by construction.
export function createAuthenticatedOneBotQueueCandidate({enabled=false,queue,bot,sender,sealKey,selectorKey,ownerId,generate,brain,brainGenerationEnabled=false,trustLocalCard=false,store,scope}={}) {
 if (enabled!==true) throw Error('authenticated queue candidate disabled');
 if (!isAuthenticatedOneBotSender(sender,ownerId)) throw Error('authenticated OneBot sender required');
 if (!Buffer.isBuffer(selectorKey) || selectorKey.length!==32 || !Buffer.isBuffer(sealKey) || sealKey.length!==32 || selectorKey.equals(sealKey)) throw Error('distinct selector key required');
 const ingress=createAuthenticatedOneBotIngressCandidate({enabled:true,queue,bot,sealKey,ownerId});
 const scopedKey=ingressKey(sealKey,ownerId);
 if (selectorKey.equals(scopedKey)) throw Error('distinct selector key required');
 if (brain !== undefined) {
  if (brainGenerationEnabled!==true) throw Error('brain generation disabled');
  if (!(brain instanceof Brain) || !brain.ownerIds.has(ownerId) || generate!==undefined) throw Error('invalid brain generator');
  generate=createLocalDurableBrainGenerator({brain,ownerId,trustLocalCard,history:true,store,scope});
 }
 const generation=createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey:scopedKey,ownerId,generate});
 return Object.freeze({accept:ingress.accept,form:generation.form,startSender:({socket}={})=>startOneBotQueueBridge({enabled:true,queue,bot:sender,sealKey:scopedKey,selectorKey,ownerId,socket,store,scope})});
}

export async function startOneBotQueueBridge({enabled=false,queue,bot,sealKey,selectorKey,ownerId,socket,store,scope}={}) {
 if(enabled!==true) throw Error('bridge disabled');
 if(!isAuthenticatedOneBotSender(bot,ownerId)) throw Error('authenticated OneBot sender required');
 if(!Buffer.isBuffer(selectorKey) || selectorKey.length!==32 || !Buffer.isBuffer(sealKey) || sealKey.length!==32 || selectorKey.equals(sealKey)) throw Error('distinct selector key required');
 return startTrustedSenderCandidate({enabled:true,queue,bot,sealKey,selectorKey,ownerId,socket,store,scope});
}
