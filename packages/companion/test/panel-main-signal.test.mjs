import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`isolated real main ${signal} waits for producers then transport and closes room sockets`, { timeout: 15000 }, async t => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'main-shutdown-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/panel.mjs'), path.join(dir, 'scripts/panel.mjs'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(path.resolve(root, '../../node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(dir, 'role.md'), 'fixture');
    fs.mkdirSync(path.join(dir, 'data'));
    const reservation = net.createServer();
    await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({room:{port}, dataDir:'data', roleCard:'role.md', dryRun:true, bili:{enabled:false}, douyin:{enabled:false}, web:{enabled:false}, ownerIds:[]}));
    const ws = new URL('./memory-brain-fake-ws.js', import.meta.url).href;
    fs.writeFileSync(path.join(dir, 'loader.mjs'), `
      import {readFile} from 'node:fs/promises';
      export async function resolve(s,c,next) {
        if(s==='ws') return {url:${JSON.stringify(ws)},shortCircuit:true};
        if(s.endsWith('/web-living.js') || s==='./web-living.js') return {url:'mock:web',shortCircuit:true};
        return next(s,c);
      }
      export async function load(url,c,next) {
        if(url==='mock:web') return {format:'module',shortCircuit:true,source:\`export function startWebLiving(){}; export async function stopWebLiving(){console.log('TEST producer-start'); await new Promise(r=>setTimeout(r,180)); console.log('TEST producer-end')}; export function browseWebTopic(){}; export function getWebLivingStatus(){}; export function renderWebKnowledge(){}\`};
        if(url.endsWith('/transport-onebot.js')) { const source=await readFile(new URL(url),'utf8'); return {format:'module',shortCircuit:true,source:source+\`\nconst testDrain=OneBot.prototype.drain; OneBot.prototype.drain=async function(){console.log('TEST drain-start'); await testDrain.call(this); console.log('TEST drain-end')};\`}; }
        return next(url,c);
      }
    `);
    fs.writeFileSync(path.join(dir, 'preload.mjs'), "import net from 'node:net';\nconst listen = net.Server.prototype.listen;\nnet.Server.prototype.listen = function (...args) { setTimeout(() => listen.apply(this, args), 250); return this; };\nglobalThis.fetch = async () => { throw new Error('external network disabled by test'); };\n");
    const child = spawn(process.execPath, ['--no-warnings', '--import', './preload.mjs', '--loader', './loader.mjs', 'src/index.js', '--config', './config.json', '--dry-run'], { cwd:dir, env:{PATH:process.env.PATH, HOME:dir, TMPDIR:dir}, stdio:['ignore','pipe','pipe'] });
    let output='';
    child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    const exited = new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',(code,sig)=>resolve({code,sig})); });
    t.after(async () => { if (child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await exited; } });
    const deadline=Date.now()+7000;
    while (!output.includes('[VirtualRoom] 小肥鱼 2.5D 等距居室已启动:') && Date.now()<deadline && child.exitCode===null && child.signalCode===null) await new Promise(r=>setTimeout(r,25));
    assert.ok(output.includes('[VirtualRoom] 小肥鱼 2.5D 等距居室已启动:'), `room did not listen: ${output}`);
    const socket=net.connect(port,'127.0.0.1');
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)});
    socket.write('GET /panel/ HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await new Promise((resolve,reject)=>{socket.once('data',resolve);socket.once('error',reject)});
    const closed=new Promise(resolve=>socket.once('close',resolve));
    child.kill(signal);
    assert.deepEqual(await exited, {code:0,sig:null}, output);
    await closed;
    assert.ok(output.includes('TEST producer-end'), output);
    assert.ok(output.indexOf('TEST producer-end') < output.indexOf('TEST drain-start'), output);
    assert.ok(output.includes('TEST drain-end'), output);
    const probe=net.createServer();
    await new Promise((resolve,reject)=>probe.once('error',reject).listen(port,'127.0.0.1',resolve));
    await new Promise(resolve=>probe.close(resolve));
  });
}
