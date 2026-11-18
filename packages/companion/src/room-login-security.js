import net from 'node:net';
import os from 'node:os';

// Only the directly connected LAN and loopback may reach the credential portal.
// Never use forwarding headers: a proxy is not a trusted security boundary.
function inLoginLan(address) {
  return net.isIP(address) === 4 && address.startsWith('192.168.31.');
}

export function isPrivateLoginRequest(req) {
  const remote = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!(remote === '::1' || (net.isIP(remote) === 4 && remote.startsWith('127.')) || inLoginLan(remote))) return false;

  // Permit only actual local interface addresses on the approved subnet, not an
  // arbitrary private IP or DNS name susceptible to DNS rebinding.
  const lanHosts = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter(i => i.family === 'IPv4' && i.netmask === '255.255.255.0' && inLoginLan(i.address))
    .map(i => i.address);
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]', ...lanHosts];
  let host;
  try {
    const raw = req.headers.host;
    if (typeof raw !== 'string' || /[\s\\/@?#]/.test(raw)) return false;
    const u = new URL('http://' + raw);
    if (raw !== u.host || !allowedHosts.includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return false;
    if (req.socket?.localPort && Number(u.port || 80) !== req.socket.localPort) return false;
    host = u.host;
  } catch { return false; }
  const originHeader = req.headers.origin;
  if (originHeader || (req.method !== 'GET' && req.method !== 'HEAD')) {
    try {
      const origin = new URL(originHeader);
      if (origin.protocol !== 'http:' || origin.host !== host || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== originHeader) return false;
    } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !(req.method === 'GET' || req.method === 'HEAD' ? ['same-origin', 'none'].includes(site) : site === 'same-origin')) return false;
  return true;
}
