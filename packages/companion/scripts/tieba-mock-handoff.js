// Explicit local mock only. Never use with real accounts or expose to the internet.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTiebaMockHandoff } from '../src/tieba-mock-handoff.js';

if (process.env.TIEBA_MOCK_HANDOFF !== '1' || !process.env.TMPDIR || !process.env.TIEBA_MOCK_TOKEN) throw Error('set TIEBA_MOCK_HANDOFF=1, TMPDIR and TIEBA_MOCK_TOKEN');
const root = await mkdtemp(join(process.env.TMPDIR, 'tieba-web-handoff-'));
let handoff;
try { handoff = createTiebaMockHandoff({ enabled: true, root, accessToken: process.env.TIEBA_MOCK_TOKEN }); }
catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
const server = http.createServer((req,res) => { if (!handoff.handle(req,res)) { res.writeHead(404); res.end(); } });
server.on('upgrade', (req,socket,head) => { if (!handoff.upgrade(req,socket,head)) socket.destroy(); });
server.listen(0, '127.0.0.1', () => console.log(`Mock only: http://127.0.0.1:${server.address().port}/handoff (Basic username: room)`));
let closing = false;
async function close() { if (closing) return; closing = true; await handoff.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, {recursive:true,force:true}); }
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
