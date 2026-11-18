import net from 'node:net';

// Browser cross-site / DNS-rebinding mitigation, not client authentication.
// Forwarded headers are deliberately ignored: this server has no trusted proxy.
export function isRoomRequestAllowed(req) {
  for (const name of ['host', 'origin', 'sec-fetch-site']) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === name) count++;
    }
    if (count > 1) return false;
  }
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return false;
  const raw = req.headers.host;
  if (typeof raw !== 'string' || /[\s\\/@?#]/.test(raw)) return false;
  let target;
  try { target = new URL(`http://${raw}`); } catch { return false; }
  if (target.host !== raw || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return false;
  if (Number(target.port || 80) !== req.socket.localPort) return false;
  const local = (req.socket.localAddress || '').replace(/^::ffff:/, '');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const loopback = local === '::1' || (net.isIP(local) === 4 && local.startsWith('127.'));
  if (host !== local && !(loopback && (host === 'localhost' || host === '127.0.0.1' || host === '::1'))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${raw}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && !(site === 'none' && ['GET', 'HEAD'].includes(req.method))) return false;
  return true;
}
