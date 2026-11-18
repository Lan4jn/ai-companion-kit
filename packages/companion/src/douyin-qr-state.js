// Decisions contain no page text, credentials or identifiers.
export function decideQrAction({risk, hasChooseVerify, hasInputSms, hasSession, modalGone, challengePending, confirmation, isExpired, isQrScreen, refreshDue, reopenDue} = {}) {
  if (risk || hasChooseVerify || hasInputSms) return 'challenge';
  if (hasSession && modalGone) return 'candidate';
  if (challengePending) return 'hold';
  if (confirmation) return 'confirm';
  if (isExpired || (isQrScreen && refreshDue)) return 'refresh';
  if (!isQrScreen && reopenDue) return 'reopen';
  return 'wait';
}
const stages = new Set(['starting','navigating','waiting_modal','ready','confirm','refreshing','challenge','candidate','verifying','verified','verify_offline','verify_risk','verify_unknown','promoted','commit_failed','expired','browser_error','unknown']);
export function safeQrDiagnostic(stage) {return typeof stage === 'string' && stages.has(stage) ? stage : 'unknown';}
