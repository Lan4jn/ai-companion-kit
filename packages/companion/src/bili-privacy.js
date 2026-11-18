import { checkOutboundPrivacy } from './outbound-privacy.js';

// A missing or invalid owner list is not evidence that an outbound message is safe.
export function biliPrivacyBlock(text, ownerIds) {
  try {
    if (!Array.isArray(ownerIds) || ownerIds.length === 0 || !ownerIds.every(id => /^\d{5,}$/.test(String(id ?? '').normalize('NFKC').trim()))) throw new TypeError('missing or invalid ownerIds');
    const result = checkOutboundPrivacy(text, ownerIds);
    if (result?.safe === true) return null;
    return { ok: false, code: 'privacy_blocked', reason: result?.reason || 'privacy_check_failed' };
  } catch {
    return { ok: false, code: 'privacy_blocked', reason: 'privacy_check_failed' };
  }
}
