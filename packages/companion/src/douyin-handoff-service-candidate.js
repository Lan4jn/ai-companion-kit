// In-process composition for the disabled-by-default handoff candidate.
// Synthetic mode is deliberately limited to tests; the official-domain policy
// and production sandbox are not approved. Never source these hooks from HTTP.
import {createLoginService} from './room-login-service.js';
import {createHandoffBridge} from './douyin-handoff-bridge.js';
import {createIsolatedHeadedLauncher} from './douyin-isolated-launcher-candidate.js';
import {allocateSystemIdentity} from './douyin-system-identity.js';

// Explicit opt-in only; caller must supply a separately validated sandbox and
// reserve the range host-wide. This does not enable official-site login.
export function createSystemIdentityLauncher({enabled=false, first, last, launcher}={}) {
  if (!enabled) throw Error('system identity launcher disabled');
  if (!launcher || launcher.allocateIdentity !== undefined) throw Error('invalid system identity launcher');
  return createIsolatedHeadedLauncher({...launcher, allocateIdentity:()=>allocateSystemIdentity({enabled:true,first,last})});
}

export function createDouyinHandoffServiceCandidate({enabled=false, accessToken, launcher, systemIdentity, loginOptions={}, bridgeOptions={}}={}) {
  if (enabled && (!process.env.NODE_TEST_CONTEXT || !launcher)) throw Error('synthetic candidate unavailable');
  const forkHeaded=enabled ? (systemIdentity ? createSystemIdentityLauncher({...systemIdentity, launcher}) : createIsolatedHeadedLauncher(launcher)) : undefined;
  const service=createLoginService({...loginOptions, headedDouyin:enabled, ...(enabled ? {forkHeaded} : {})});
  const bridge=createHandoffBridge({...bridgeOptions, enabled, accessToken, service});
  return {service, bridge, close:async()=>{await bridge.close(); await service.cancelHeadedDouyin();}};
}
