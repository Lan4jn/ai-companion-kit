// A click is not proof of an interaction. Only an explicit state on the
// target control is evidence; an ambiguous pre-state must never toggle a like.
export async function interactDouyin(page, action) {
  const read = () => page.evaluate((action) => {
    const visible = el => !!el && el.getClientRects().length > 0;
    const blocked = Array.from(document.querySelectorAll('[id^="login-full-panel"], #login-panel-new, [role="dialog"]')).some(el => visible(el) && /登录|验证/.test(el.innerText || ''));
    if (blocked) return { state: 'blocked' };
    if (action === 'like') {
      const el = document.querySelector('[data-e2e="video-player-digg"]');
      if (!visible(el)) return { state: 'unknown' };
      const pressed = el.getAttribute('aria-pressed');
      const marker = el.getAttribute('data-e2e-state');
      const path = el.querySelector('svg path');
      const fill = path ? getComputedStyle(path).fill : '';
      const active = pressed === 'true' || marker === 'video-player-is-digged' || /255,\s*44,\s*85|fe2c55/i.test(fill);
      const inactive = pressed === 'false' || marker === 'video-player-not-digged' || /rgb\(255,\s*255,\s*255\)|^none$/i.test(fill);
      if (active === inactive) return { state: 'unknown' };
      return { state: active ? 'active' : 'inactive' };
    }
    const container = document.querySelector('[data-e2e="user-info"]');
    const buttons = Array.from(container?.querySelectorAll('button') || []).filter(visible);
    const active = buttons.filter(b => /^(已关注|相互关注)$/.test(b.innerText.trim()));
    const inactive = buttons.filter(b => b.innerText.trim() === '关注');
    if (active.length === 1 && inactive.length === 0) return { state: 'active' };
    if (inactive.length === 1 && active.length === 0) return { state: 'inactive' };
    return { state: 'unknown' };
  }, action);
  const before = await read();
  if (before.state === 'active') return { confirmed: true, status: 'already' };
  if (before.state !== 'inactive') return { confirmed: false, status: 'unconfirmed' };
  const clicked = await page.evaluate((action) => {
    const visible = el => !!el && el.getClientRects().length > 0;
    const el = action === 'like' ? document.querySelector('[data-e2e="video-player-digg"]') : Array.from(document.querySelectorAll('[data-e2e="user-info"] button')).find(b => visible(b) && b.innerText.trim() === '关注');
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    el.click();
    return true;
  }, action);
  if (!clicked) return { confirmed: false, status: 'unconfirmed' };
  await page.waitForTimeout(800);
  const after = await read();
  return after.state === 'active' ? { confirmed: true, status: 'confirmed' } : { confirmed: false, status: 'unconfirmed' };
}
