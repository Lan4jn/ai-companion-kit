import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCandidateRequest, resolveCandidateDestination } from '../src/douyin-egress-candidate-policy.js';

test('candidate denies unverified paths, methods and disguised authorities', () => {
  assert.equal(authorizeCandidateRequest('GET','https://www.douyin.com/'), 'https://www.douyin.com/');
  for (const [method,url] of [
    ['POST','https://www.douyin.com/'], ['CONNECT','https://www.douyin.com/'],
    ['GET','http://www.douyin.com/'], ['GET','https://www.douyin.com:443/'],
    ['GET','https://www.douyin.com.evil.test/'], ['GET','https://www.douyin.com@evil.test/'],
    ['GET','https://www.douyin.com/%2e%2e/'], ['GET','https://www.douyin.com/other'],
    ['GET','https://www.douyin.com/?next=https://evil.test/'], ['GET','https://127.0.0.1/'],
    ['GET','https://www.douyin.com/#fragment'], ['GET','https://www.douyin.com\\@evil.test/'],
  ]) assert.equal(authorizeCandidateRequest(method,url), null, `${method} ${url}`);
});

test('candidate validates every DNS answer and returns a pinned immutable address', async () => {
  let calls=0;
  const lookup = async (name, options) => { calls++; assert.equal(name,'www.douyin.com'); assert.deepEqual(options,{all:true,verbatim:true}); return [{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}]; };
  const result=await resolveCandidateDestination('www.douyin.com',lookup);
  assert.deepEqual(result,{address:'8.8.8.8',family:4}); assert.ok(Object.isFrozen(result)); assert.equal(calls,1);
  for (const answers of [[], [{address:'127.0.0.1',family:4}], [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}], [{address:'::ffff:127.0.0.1',family:6}], [{address:'8.8.8.8',family:6}], [{address:'fc00::1',family:6}]]) {
    await assert.rejects(resolveCandidateDestination('www.douyin.com',async()=>answers));
  }
  await assert.rejects(resolveCandidateDestination('evil.test',lookup));
  await assert.rejects(resolveCandidateDestination('www.douyin.com',async()=>{throw Error('DNS failure')}));
});
