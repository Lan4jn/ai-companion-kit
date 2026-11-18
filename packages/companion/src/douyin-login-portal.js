// The legacy portal launched an unsandboxed browser and accepted verification
// codes. Keep its former endpoint fail-closed; it must not start a login daemon.
import http from 'node:http';

const server = http.createServer((_req, res) => {
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end('{"state":"disabled"}');
});

server.listen(18080, '127.0.0.1', () => console.log('Legacy Douyin login portal disabled'));
