// Explicitly injected candidate launcher. Not configured by production and not
// evidence that the official login policy or host isolation is complete.
// The caller must supply the already-connected FD, broker and OS sandbox.
import fs from 'node:fs';
import {spawn} from 'node:child_process';

export function createIsolatedHeadedLauncher({brokerFd, createBroker, allocateBroker, createBrokerSocket, allocateIdentity, command, args, prepareSession=()=>{}, environment=env=>env, onChild=()=>{}}={}) {
  const socketMode = createBrokerSocket !== undefined;
  const legacy = allocateBroker === undefined && !socketMode;
  if ((socketMode ? (typeof createBrokerSocket !== 'function' || brokerFd !== undefined || createBroker !== undefined || allocateBroker !== undefined) : legacy ? (!Number.isInteger(brokerFd) || brokerFd < 3 || typeof createBroker !== 'function') : (typeof allocateBroker !== 'function' || brokerFd !== undefined || createBroker !== undefined)) || typeof command !== 'string' || typeof args !== 'function' || typeof prepareSession !== 'function' || typeof environment !== 'function' || (allocateIdentity !== undefined && typeof allocateIdentity !== 'function')) throw Error('invalid isolated launcher');
  let used=false;
  return function launch(_daemon, _args, options) {
    if (legacy && used) throw Error('inherited broker stream is single-use');
    used=true;
    let broker, child, fd = legacy ? brokerFd : undefined;
    try {
      const dir=options.env.DOUYIN_LOGIN_SESSION_DIR;
      // Identity allocation is synchronous and single-use. A failed launch burns
      // the identity too; the launcher never assumes descendants are gone.
      const identity=allocateIdentity?.();
      if (allocateIdentity && (!identity || !Number.isSafeInteger(identity.uid) || identity.uid <= 0 || !Number.isSafeInteger(identity.gid) || identity.gid <= 0)) throw Error('invalid session identity');
      prepareSession(dir, identity);
      if (legacy) broker=createBroker();
      else if (!socketMode) {
        const allocated=allocateBroker();
        fd=allocated?.fd; broker=allocated?.broker;
        if (!Number.isInteger(fd) || fd < 3 || !broker || typeof broker.close !== 'function') throw Error('invalid broker allocation');
      }
      child=spawn(command,args(dir,identity),{detached:true,stdio:['ignore','ignore','ignore',socketMode ? 'pipe' : fd,'ipc'],env:environment(options.env,identity)});
      if (socketMode) {
        try {
          broker=createBrokerSocket(child.stdio[3]);
          if (!broker || typeof broker.close !== 'function') throw Error('invalid broker allocation');
        } catch (error) {
          child.stdio[3]?.destroy();
          child.on('error',()=>{});
          try {child.kill('SIGKILL');} catch {}
          throw error;
        }
      }
      let closing=false;
      const closeBroker=()=>{if (!closing) {closing=true; void Promise.resolve().then(()=>broker.close()).catch(()=>{});}};
      child.once('close',closeBroker);
      child.once('error',closeBroker);
      try {onChild(child);} catch { /* observation must not interrupt cleanup */ }
      return child;
    } catch(e) {
      if (broker) void Promise.resolve().then(()=>broker.close()).catch(()=>{});
      throw e;
    } finally {
      if (Number.isInteger(fd) && fd >= 3) try {fs.closeSync(fd);} catch {}
    }
  };
}
