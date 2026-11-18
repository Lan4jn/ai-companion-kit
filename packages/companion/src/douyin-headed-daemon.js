// The official-domain policy and full host isolation have not been validated.
// This entry remains unconditionally disabled, regardless of configuration.
import { runHeadedLifecycle } from './douyin-headed-lifecycle.js';

throw new Error('Headed Douyin login disabled: browser egress isolation unavailable');

if (!process.send || !process.env.DOUYIN_LOGIN_SESSION_DIR) throw Error('Private parent channel required');
const controller = new AbortController();
const stop = () => controller.abort();
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  await runHeadedLifecycle({sessionDir:process.env.DOUYIN_LOGIN_SESSION_DIR,signal:controller.signal,
    onDisplay:details=>process.send({type:'display',...details})});
} catch {
  process.exitCode=1;
} finally {
  stop();
  if (process.connected) process.disconnect();
}
