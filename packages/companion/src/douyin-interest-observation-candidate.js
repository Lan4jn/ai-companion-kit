// Adapter boundary reserved for a trusted playback capture and owner authorization.
// The current Playwright observation runs in page JS, uses page-controlled metadata,
// refetches the player URL, and accepts a caller-supplied page. It cannot establish
// an authenticated source/byte identity or a trusted principal. Caller flags,
// callbacks and model descriptions are not evidence or authorization.
// Do not invoke the page, model, storage, or recall until those boundaries exist.
export async function observeDouyinInterestCandidate(_request = {}) {
  return {status:'rejected', persistence:'blocked_unverified_provenance', recall:'blocked_unverified_provenance'};
}
