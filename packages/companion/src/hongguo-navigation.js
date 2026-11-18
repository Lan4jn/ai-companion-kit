// Inert orchestration. The caller supplies trusted, independently verified mappings
// and an adapter that atomically revalidates foreground, identity and bounds at tap.
// No device adapter, model, logging, timers or UI identifiers are guessed here.
const text = x => typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= 200;
function validBounds(value) {
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value || '');
  if (!m) return false;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return x2 > x1 && y2 > y1 && x2 <= 10000 && y2 <= 10000;
}
function eligible(snapshot, trusted) {
  if (snapshot?.foreground !== true || snapshot?.blocked !== false || !Array.isArray(snapshot.items) || !Array.isArray(trusted)) return [];
  return snapshot.items.filter(item => {
    if (!item || !text(item.resourceId) || !/^[\w.]+:id\/\w+$/.test(item.resourceId) || !text(item.title) || !text(item.episodeId) || item.clickable !== true || item.enabled !== true || !validBounds(item.bounds)) return false;
    // A repeated resource ID or ambiguous identity is not safe to click.
    if (snapshot.items.filter(x => x?.resourceId === item.resourceId).length !== 1) return false;
    return trusted.filter(x => x?.resourceId === item.resourceId && x.title === item.title && x.episodeId === item.episodeId).length === 1;
  }).map(({ resourceId, title, episodeId, bounds }) => ({ resourceId, title, episodeId, bounds }));
}
const same = (a, b) => a.resourceId === b.resourceId && a.title === b.title && a.episodeId === b.episodeId && a.bounds === b.bounds;

export async function navigateHongguo({ permission, choose, observe, tap, playback, trusted } = {}) {
  if (permission !== true) return { status: 'permission_required' };
  if (typeof choose !== 'function') return { status: 'unavailable' };
  try {
    const want = await choose({ stage: 'want' });
    if (want === null || want === false) return { status: 'skipped' };
    if (want !== true || typeof observe !== 'function' || typeof tap !== 'function' || typeof playback !== 'function') return { status: 'unavailable' };
    const candidates = eligible(await observe(), trusted);
    if (!candidates.length) return { status: 'unrecognized' };
    // Only a numeric index from the model is accepted, never a model-provided target.
    const index = await choose({ stage: 'select', titles: candidates.map(c => c.title) });
    if (index === null || index === false) return { status: 'skipped' };
    if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length) return { status: 'unrecognized' };
    const selected = candidates[index];
    const again = eligible(await observe(), trusted);
    if (again.filter(item => same(item, selected)).length !== 1) return { status: 'unrecognized' };
    // The injected adapter must check this exact target again immediately before
    // dispatch, and return revalidated:true only when that check succeeded.
    const dispatched = await tap({ ...selected });
    if (dispatched?.dispatched !== true || dispatched?.revalidated !== true) return { status: 'unverified' };
    const state = await playback();
    if (state?.state !== 'playing' || state.episodeId !== selected.episodeId || !Number.isSafeInteger(state.positionMs) || state.positionMs < 0) return { status: 'unverified' };
    return { status: 'verified', episodeId: selected.episodeId };
  } catch {
    return { status: 'unavailable' };
  }
}
