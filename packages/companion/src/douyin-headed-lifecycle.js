// Shared headed lifecycle. The production entry retains its unconditional gate;
// passing injected routing options here does not authorize live-site access.
import { createHeadedDisplay } from './douyin-headed-display.js';
import { startDaemon } from './douyin-qr-daemon.js';

export async function runHeadedLifecycle({ sessionDir, signal, daemonOptions = {}, displayOptions = {}, onDisplay = () => {} }) {
  if (!sessionDir || !signal || typeof onDisplay !== 'function') throw Error('invalid headed lifecycle');
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  let display;
  try {
    if (controller.signal.aborted) return;
    display = await createHeadedDisplay({ ...displayOptions, root: sessionDir });
    display.closed.then(stop);
    if (controller.signal.aborted) return;
    await onDisplay({ socket: display.socket, token: display.token });
    await startDaemon({ ...daemonOptions, sessionDir, headed: true, displayEnv: display.env, signal: controller.signal });
  } finally {
    stop();
    signal.removeEventListener('abort', stop);
    await display?.close();
  }
}
