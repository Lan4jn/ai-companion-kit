/**
 * Inspect text immediately before sending to a non-QQ destination.
 * ownerIds must be the configured QQ IDs (strings or numbers), not display names.
 * A non-string message fails closed; callers should block when safe is false.
 */
export function checkOutboundPrivacy(text, ownerIds = []) {
  if (typeof text !== 'string') return { safe: false, reason: 'invalid_text' };
  if (!Array.isArray(ownerIds)) throw new TypeError('ownerIds must be an array');
  const normalized = text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  if (/\[\s*c\s*q\s*:/i.test(normalized)) {
    return { safe: false, reason: 'cq_code' };
  }
  // Remove common separators between digits only, leaving words and other text intact.
  const digitsJoined = normalized.replace(/(?<=\d)[\s\p{P}\p{S}]+(?=\d)/gu, '');
  for (const id of ownerIds) {
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const value = String(id).normalize('NFKC').trim();
    if (/^\d{5,}$/.test(value) && digitsJoined.includes(value)) {
      return { safe: false, reason: 'owner_id' };
    }
  }
  return { safe: true, reason: null };
}
