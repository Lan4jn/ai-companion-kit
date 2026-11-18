import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('验证期间即使挑战界面暂时消失也不刷新或关闭登录页',()=>{
 const source=fs.readFileSync(new URL('../src/douyin-qr-daemon.js',import.meta.url),'utf8');
 assert.match(source,/let challengePending = false/);
 assert.match(source,/challengePending = true/);
 assert.match(source,/if \(challengePending\) continue/);
});
