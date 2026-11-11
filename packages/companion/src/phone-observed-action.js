// All dependencies are injected so actions cannot run without observations.
export async function performObservedAction({ observe, decide, act }) {
  try {
    const before = await observe();
    if (!before || !before.foreground) return {ok:false, reason:'observation-unavailable'};
    const action = await decide(before);
    if (!action || action.type === 'wait') return {ok:false, reason:'no-action'};
    if (!await act(action, before)) return {ok:false, reason:'action-failed'};
    const after = await observe();
    if (!after || !after.foreground) return {ok:false, reason:'verification-unavailable'};
    const changed = before.foreground !== after.foreground || (before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint) || (before.text && after.text && before.text !== after.text);
    if (!changed) return {ok:false, reason:'no-observed-change', before, after, action};
    return {ok:true, before, after, action};
  } catch (error) {
    return {ok:false, reason:'operation-error', error:String(error?.message || error)};
  }
}
