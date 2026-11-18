// Offline acceptance probe: real Linux mount/network namespaces and UID drop.
// This is NOT a production launcher or evidence of same-UID isolation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const probe = String.raw`
import os, socket, sys
assert os.getuid() == 65534 and os.getgid() == 65534
assert os.getgroups() == [] or os.getgroups() == [65534]
assert not os.path.exists('/root')
assert not os.path.exists(sys.argv[1])
assert not os.path.exists('/etc/passwd')
try:
 open('/usr/namespace-probe-must-not-exist', 'w')
 raise AssertionError('host runtime writable')
except OSError: pass
with open('/tmp/namespace-probe','w') as f: f.write('fixture')
s=socket.socket(); s.settimeout(1)
try:
 s.connect(('127.0.0.1',int(sys.argv[2])))
 raise AssertionError('host loopback reachable')
except OSError: pass
`;

test('candidate system boundary: mount, principal and loopback are isolated', async (t) => {
  if (process.getuid?.() !== 0) return t.skip('requires root');
  const capability=spawnSync('/usr/bin/bwrap',['--unshare-all','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--','/usr/bin/true'],{encoding:'utf8'});
  if (capability.status !== 0) throw Error('required namespace capability unavailable');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-boundary-'));
  const marker=path.join(dir,'host-only');
  fs.writeFileSync(marker,'fixture');
  const server=net.createServer();
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    const result=spawnSync('/usr/bin/bwrap',[
      '--unshare-all','--die-with-parent','--new-session',
      '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
      '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--uid','65534','--gid','65534',
      '--clearenv','--setenv','PATH','/usr/bin',
      '--','/usr/bin/python3','-c',probe,marker,String(port)
    ],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,`boundary probe failed: ${result.stderr}`);
    assert.equal(fs.existsSync('/tmp/namespace-probe'),false);
    assert.equal(fs.existsSync(marker),true);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
