// Experimental Playwright-to-Unix-socket adapter, not an isolation boundary.
// The caller must provide kernel-enforced network and principal isolation.
import http from 'node:http';

function brokerRequest(socketPath, token, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath, path:'/request', method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, timeout:10000}, res => {
      const chunks=[]; let size=0;
      res.on('data', chunk => { size += chunk.length; if(size > 8*1024*1024) req.destroy(Error('broker response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { if(res.statusCode !== 200) throw Error('broker denied'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(Error('broker timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

export async function installCandidateBrokerRoute(context, {socketPath, token, counts, brokerClient} = {}) {
  if (brokerClient ? (typeof brokerClient.request !== 'function' || socketPath !== undefined || token !== undefined) : (typeof socketPath !== 'string' || !socketPath.startsWith('/') || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) throw Error('invalid broker configuration');
  if(typeof context.routeWebSocket !== 'function') throw Error('WebSocket routing required');
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    try {
      const req=route.request(), headers={}, original=await req.allHeaders();
      for(const name of ['accept','content-type','cookie','origin','referer']) if(original[name]) headers[name]=original[name];
      const body=req.postDataBuffer();
      if(body && body.length>4096) throw Error('body too large');
      const payload={url:req.url(),method:req.method(),headers,...(body ? {body:body.toString('base64')} : {})};
      const result=await (brokerClient ? brokerClient.request(payload) : brokerRequest(socketPath,token,payload));
      if(result.status!==200 || !result.headers || typeof result.body !== 'string') throw Error('invalid broker response');
      await route.fulfill({status:200,headers:result.headers,body:Buffer.from(result.body,'base64')});
    } catch {
      if(counts) { counts.denied=(counts.denied||0)+1; counts.failed=(counts.failed||0)+1; }
      // Terminal, non-redirect response avoids both Chromium redirect bypass and
      // abort-induced navigation loops; no upstream Location or cookies escape.
      await route.fulfill({status:403,contentType:'text/plain',body:'request denied'}).catch(()=>{});
    }
  });
}
