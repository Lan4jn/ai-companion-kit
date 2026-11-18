// Experimental opt-in adapter: no production wiring or startup replay.
// The caller must authenticate and bind session -> destination before invoking send.
import { DurableBatchCandidate, createBoundBatchProcessorCandidate } from './chat-durable-batch-candidate.js';
import { cleanAllToolArtifacts } from './safety.js';

const result = status => Object.freeze({status});

// A positive OneBot acknowledgement means transport acceptance, not proof of
// recipient display. Legacy WeChat returns {ok:true} without raw evidence and
// cannot safely confirm delivery here. Never infer retryability from an error.
export function classifyDeliveryCandidate(transport, value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result('unknown');
    if (value.blocked === true) return result('permanent');
    if (value.partial === true) return result('unknown');
    if (value.ok === false && value.outcome === 'permanent') return result('permanent');
    if (value.ok === false && value.outcome === 'retry') return result('retry');
    if (transport === 'onebot' && value.ok === true && (value.outcome === undefined || value.outcome === 'confirmed') &&
        value.data && typeof value.data === 'object' && !Array.isArray(value.data) &&
        value.data.status === 'ok' && value.data.retcode === 0) return result('delivered');
  } catch { /* Malformed untrusted response: retain the claim. */ }
  return result('unknown');
}

// Only verified trusted-generation batches are eligible.
export function createBoundOneBotDeliveryCandidate({enabled = false, queue, bot, sealKey, ownerId} = {}) {
  return createBoundBatchProcessorCandidate({enabled,queue,bot,sealKey,ownerId});
}

export function createDeliveryCandidate({enabled = false, queue, transport, send} = {}) {
  if (enabled !== true) throw Error('delivery candidate disabled');
  if (!(queue instanceof DurableBatchCandidate) || !['onebot','wechat'].includes(transport) || typeof send !== 'function') throw Error('queue, transport and send required');
  return Object.freeze({
    async process(session) {
      // claim persists unknown before any possible external effect. All other
      // outcomes remain unknown until independently reconciled, even retry.
      const claim = queue.claim(session);
      if (!claim) return result('blocked');
      // OneBot.send silently cleans tool markup and parses CQ codes; an ACK for
      // modified content does not establish delivery of the claimed segment.
      if (transport === 'onebot' && (cleanAllToolArtifacts(claim.segment) !== claim.segment || /\[CQ:/i.test(claim.segment))) return result('permanent');
      let outcome;
      try { outcome = classifyDeliveryCandidate(transport, await send(claim.session, claim.segment)); }
      catch { outcome = result('unknown'); }
      if (outcome.status === 'delivered') {
        if (!queue.complete(claim, {status:'delivered'})) return result('unknown');
      }
      return outcome;
    }
  });
}
