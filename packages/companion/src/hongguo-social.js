import { checkOutboundPrivacy } from './outbound-privacy.js';

// Pure assessment of caller-provided observations; never operates a device.
export function assessSocialAction({ action, target, text, before, after } = {}) {
  const validId = id => typeof id === 'string' && Boolean(id.trim());
  const sameTarget = validId(target?.contentId) && before?.contentId === target.contentId && after?.contentId === target.contentId;
  const ordered = Number.isFinite(before?.capturedAt) && Number.isFinite(after?.capturedAt) && after.capturedAt > before.capturedAt;
  const like = action === 'like' && before?.liked === false && after?.liked === true;
  const comment = (action === 'comment' || (action === 'reply' && validId(target?.commentId) && after?.comment?.parentId === target.commentId)) && typeof text === 'string' && text.trim() && Array.isArray(before?.commentIds) && validId(after?.comment?.id) && !before.commentIds.includes(after.comment.id) && after.comment.text === text && after.comment.authorIsSelf === true;
  const verified = Boolean(sameTarget && ordered && (like || comment));
  return { verified, limitations: ['核验依赖调用方提供的观察，不能独立证明来源真实。'] };
}

export function decideSocialAction({ consent, interest, choice, ownerIds } = {}) {
  if (typeof interest !== 'string' || !interest.trim()) return { action: 'skip', reason: 'no-interest' };
  if (consent !== true) return { action: 'skip', reason: 'consent-required' };
  if (choice?.action === 'skip' || !choice) return { action: 'skip', reason: 'declined' };
  if (choice.action === 'like') return { action: 'like' };
  const validOwnerIds = Array.isArray(ownerIds) && ownerIds.length > 0 && ownerIds.every(id =>
    (typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) && /^\d{5,}$/.test(String(id).normalize('NFKC').trim())
  );
  if (!['comment', 'reply'].includes(choice.action) || typeof choice.text !== 'string' || !choice.text.trim() || !validOwnerIds || !checkOutboundPrivacy(choice.text, ownerIds).safe) return { action: 'skip', reason: 'invalid-or-private' };
  return { action: choice.action, text: choice.text };
}
