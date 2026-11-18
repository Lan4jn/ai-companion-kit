// Experimental policy primitive only; not connected to the headed daemon.
// This is NOT an egress proxy or a network isolation boundary.
import dns from 'node:dns/promises';
import net from 'node:net';
import { isPublicAddress } from './web-evidence.js';

const allowedHosts = new Set(['www.douyin.com']);

// No POST endpoint is enabled: official login methods and paths have not yet
// been verified, and guessing an authentication endpoint is not safe.
export function authorizeCandidateRequest(method, input) {
  if (!['GET', 'HEAD'].includes(method) || typeof input !== 'string' || /[\\\x00-\x20]/.test(input)) return null;
  try {
    const raw = input.match(/^https:\/\/([^/?#]+)([^?#]*)/);
    if (!raw || raw[1] !== 'www.douyin.com' || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(raw[2])) return null;
    const url = new URL(input);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password || url.port || url.hash || url.search || url.pathname !== '/') return null;
    return url.href;
  } catch { return null; }
}

// Callers must use the returned address as the actual TLS socket destination,
// retain the original hostname for SNI and certificate verification, and never
// follow redirects without re-authorizing them. No caller is wired up yet.
export async function resolveCandidateDestination(hostname, lookup = dns.lookup) {
  if (!allowedHosts.has(hostname)) throw new Error('destination denied');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item =>
    !item || ![4, 6].includes(item.family) || net.isIP(item.address) !== item.family || !isPublicAddress(item.address))) {
    throw new Error('unsafe DNS');
  }
  return Object.freeze({ address: addresses[0].address, family: addresses[0].family });
}
