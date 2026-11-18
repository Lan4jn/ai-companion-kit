// Production integration gate. No caller-provided commands, rootfs, identity,
// broker policy, or test hooks are accepted at this trust boundary.
// This deliberately does not launch anything until a separately audited
// privilege-separated allocator and supervisor protocol exist.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/opt/companion/douyin-handoff';
const REQUIRED = Object.freeze([
  [ROOT, 'directory'],
  [ROOT + '/rootfs', 'directory'],
  [ROOT + '/rootfs/usr/bin/node', 'file'],
  [ROOT + '/rootfs/usr/bin/chromium', 'file'],
  [ROOT + '/supervisor', 'file'],
]);

function checkTrustedPath(target, kind) {
  // Check every ancestor without resolving symlinks; a writable ancestor could
  // replace an otherwise root-owned executable between validation and use.
  let current = '/';
  for (const component of target.split('/').filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw Error('untrusted production path');
    if (current !== target && !stat.isDirectory()) throw Error('invalid production path');
    if (current === target && (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || !(stat.mode & 0o111))) throw Error('invalid production artifact');
  }
}

export function createProductionDouyinHandoffFactory(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => k !== 'enabled')) throw Error('invalid production factory options');
  if (options.enabled !== true) throw Error('production handoff disabled');
  for (const [target, kind] of REQUIRED) {
    try { checkTrustedPath(target, kind); }
    catch { throw Error('trusted production rootfs or executable unavailable'); }
  }
  // Path ownership alone is not a race-free exec mechanism, nor does it audit
  // the rootfs contents. Never connect the synthetic broker or allocate host
  // identities as a fallback, particularly from a non-root service.
  throw Error('audited egress and privileged identity/supervisor boundary unavailable');
}
