// Offline-only host proxy. It cannot reach the Internet: its only upstream is
// the already-created synthetic loopback TLS server, not a resolved address.
import net from 'node:net';
import { resolveCandidateDestination } from '../../src/douyin-egress-candidate-policy.js';

export function createFixtureProxy({ socketPath, fixturePort, lookup, counts }) {
  const server = net.createServer(client => {
    let buffer = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => client.destroy(), 3000);
    client.on('error', () => {});
    client.on('data', async function accept(data) {
      if (done) return;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 8192) return client.destroy();
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      done = true; client.pause(); clearTimeout(timer); client.removeListener('data', accept);
      const head = buffer.subarray(0, end).toString('latin1').split('\r\n');
      if (head[0] !== 'CONNECT www.douyin.com:443 HTTP/1.1' || buffer.length !== end + 4) {
        counts.denied++; return client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
      try { await resolveCandidateDestination('www.douyin.com', lookup); }
      catch { counts.dnsDenied++; return client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }
      // Explicitly fixed destination; never use DNS-selected IP for this fixture.
      const upstream = net.connect({host:'127.0.0.1', port:fixturePort});
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.once('connect', () => {
        counts.tunnels++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    });
  });
  return new Promise((resolve, reject) => {server.once('error', reject); server.listen(socketPath, () => resolve(server));});
}
