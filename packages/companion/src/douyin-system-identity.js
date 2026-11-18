// Opt-in local shadow-utils identity allocation. This is not an OS-wide range
// reservation: the administrator MUST reserve the range from all other allocators
// and NSS sources, including subordinate IDs, for the lifetime of these accounts.
// Accounts and groups are intentionally never deleted, even on launch failure.
import {spawnSync} from 'node:child_process';

export function allocateSystemIdentity({enabled=false, first, last}={}) {
  if (!enabled) throw Error('system identity allocator disabled');
  if (process.geteuid?.() !== 0) throw Error('root required');
  // Bound synchronous NSS/shadow work; each successful session permanently burns
  // one account, so operators must also impose an external allocation quota.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1000 || last < first || last > 2147483646 || last - first >= 64) throw Error('invalid reserved range');
  const run=(cmd,args)=>{
    const p=spawnSync(cmd,args,{encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:65536,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C'}});
    if(p.error || p.signal || p.status === null) throw Error('identity system command failed');
    return p.status;
  };
  for(let uid=first;uid<=last;uid++) {
    // A group is created first and is never removed: an interrupted useradd
    // burns that number even if the account was never created.
    const name='dys'+uid;
    const p=run('/usr/bin/getent',['passwd',String(uid)]);
    if (p === 0) continue;
    if (p !== 2) throw Error('NSS lookup failed');
    const group=run('/usr/sbin/groupadd',['-g',String(uid),name]);
    if (group === 4 || group === 9) continue;
    if (group !== 0) throw Error('cannot reserve session group');
    const user=run('/usr/sbin/useradd',['-r','-M','-N','-l','-u',String(uid),'-g',String(uid),'-d','/nonexistent','-s','/sbin/nologin',name]);
    if (user === 4 || user === 9) continue;
    if (user !== 0) throw Error('cannot reserve session account');
    return {uid,gid:uid};
  }
  throw Error('reserved identity range exhausted');
}
