// One pre-connected, privately inherited stream; no listener or bearer token.
// A lost stream is terminal: never reconnect through a pathname or TCP.
import http from 'node:http';
import net from 'node:net';

export function createInheritedBrokerClient(fd) {
  if (!Number.isInteger(fd) || fd < 3) throw Error('invalid broker fd');
  const socket = new net.Socket({fd, readable:true, writable:true});
  let issued = false, closed = false;
  const agent = new http.Agent({keepAlive:true, maxSockets:1, maxFreeSockets:1});
  agent.createConnection = (_options, callback) => {
    if (issued || closed) {
      queueMicrotask(() => callback(Error('broker stream closed')));
      return;
    }
    issued = true;
    return socket;
  };
  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });
  return {
    request(payload) {
      if (closed) return Promise.reject(Error('broker stream closed'));
      return new Promise((resolve, reject) => {
        let req, settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error) reject(error); else resolve(result);
        };
        // The agent serializes requests on one stream; socket inactivity timeouts
        // do not run while queued and can be reset indefinitely by trickle data.
        const deadline = setTimeout(() => {
          const error = Error('broker deadline exceeded');
          req?.destroy(error);
          finish(error);
        }, 10000);
        try {
          req = http.request({host:'inherited.invalid', path:'/request', method:'POST', agent, headers:{'content-type':'application/json'}, timeout:10000}, res => {
            const chunks=[]; let size=0;
            res.on('data', chunk => { size += chunk.length; if (size > 8*1024*1024) req.destroy(Error('response too large')); else chunks.push(chunk); });
            res.on('error', error => finish(error));
            res.on('end', () => { try { if (res.statusCode !== 200) throw Error('broker denied'); finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(e) { finish(e); } });
          });
          req.on('timeout', () => req.destroy(Error('broker timeout')));
          req.on('error', error => finish(error));
          req.end(JSON.stringify(payload));
        } catch(e) { finish(e); }
      });
    },
    close() { closed = true; agent.destroy(); socket.destroy(); }
  };
}
