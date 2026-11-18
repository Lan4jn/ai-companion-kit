import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';

// Exercise the actual inherited stream and HTTP agent, not a mock broker.
test('queued broker requests have a deadline even while another response trickles', {timeout:15000}, async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type':'application/json'});
    res.write(' ');
    const timer = setInterval(() => res.write(' '), 300);
    res.on('close', () => clearInterval(timer));
  });
  const source = `import {createInheritedBrokerClient} from './src/douyin-inherited-broker-client.js';
    const client=createInheritedBrokerClient(3);
    client.request({}).catch(()=>{});
    client.request({}).then(()=>process.exit(2),()=>{client.close();process.exit(0)});
    setTimeout(()=>process.exit(3),12000).unref();`;
  const child = spawn(process.execPath, ['--input-type=module','-e',source], {stdio:['ignore','ignore','pipe','pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  server.emit('connection', child.stdio[3]);
  child.stdio[3].resume();
  try {
    const result = await new Promise((resolve,reject) => {child.once('error',reject); child.once('exit',(code,signal)=>resolve({code,signal}));});
    assert.deepEqual(result,{code:0,signal:null}, `queued request did not expire: ${stderr}`);
  } finally { child.kill('SIGKILL'); child.stdio[3].destroy(); server.closeAllConnections(); server.close(); }
});
