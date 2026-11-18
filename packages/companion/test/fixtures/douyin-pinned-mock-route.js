// Offline-only browser adapter for a deliberately synthetic login protocol.
// This is NOT a production policy, proxy, or OS egress boundary.
import { requestPinnedCandidate } from '../../src/douyin-egress-candidate-transport.js';

export async function installMockPinnedRoute(context, options, counts) {
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    // Strict literal URL table: no alternate encoding, queries, fragments or ports.
    const allowed = (req.method() === 'GET' && url === 'https://www.douyin.com/') ||
      (req.method() === 'POST' && ['https://www.douyin.com/mock/challenge','https://www.douyin.com/mock/complete','https://www.douyin.com/mock/redirect'].includes(url));
    if (!allowed) { counts.denied++; return route.abort(); }
    try {
      const original = await req.allHeaders();
      const headers = {accept:'*/*','accept-encoding':'identity'};
      for (const name of ['content-type','cookie','origin','referer']) if (original[name]) headers[name] = original[name];
      const body = req.postDataBuffer();
      if (body && body.length > 4096) throw Error('body denied');
      const result = await requestPinnedCandidate({url,method:req.method(),headers,body:body || undefined}, options);
      // Never fulfill an HTTP redirect: Chromium can follow it outside routing.
      if (result.status >= 300 && result.status < 400) { counts.redirects++; return route.fulfill({status:403,contentType:'text/plain',body:'redirect denied'}); }
      if (result.status !== 200) throw Error('response denied');
      const responseHeaders = {};
      for (const name of ['content-type','set-cookie']) if (result.headers[name]) responseHeaders[name] = result.headers[name];
      await route.fulfill({status:200,headers:responseHeaders,body:result.body});
    } catch { counts.failed++; await route.abort().catch(()=>{}); }
  });
}
