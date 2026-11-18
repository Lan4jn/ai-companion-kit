import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { browseDouyinLive, getDouyinLivingStatus } from '../src/douyin-living.js';

test('blocked direct video never claims a watch or writes a diary', async () => {
  const launch = chromium.launch;
  const append = fs.appendFileSync;
  const writes = [];
  chromium.launch = async () => { throw new Error('browser unavailable'); };
  fs.appendFileSync = (...args) => { writes.push(args); };
  const before = getDouyinLivingStatus();
  try {
    const result = await browseDouyinLive({ targetUrl: 'https://www.douyin.com/video/123456' });
    assert.equal(result.success, false);
    assert.equal(writes.length, 0);
    assert.deepEqual(getDouyinLivingStatus().lastVideo, before.lastVideo);
  } finally { chromium.launch = launch; fs.appendFileSync = append; }
});

test('empty feed and missing cache do not fabricate a video or diary', async () => {
  const launch = chromium.launch;
  const exists = fs.existsSync;
  const append = fs.appendFileSync;
  const writes = [];
  chromium.launch = async () => { throw new Error('offline'); };
  fs.existsSync = () => false;
  fs.appendFileSync = (...args) => { writes.push(args); };
  const before = getDouyinLivingStatus();
  try {
    const result = await browseDouyinLive();
    assert.equal(result.success, false);
    assert.equal(writes.length, 0);
    assert.deepEqual(getDouyinLivingStatus().lastVideo, before.lastVideo);
  } finally { chromium.launch = launch; fs.existsSync = exists; fs.appendFileSync = append; }
});

test('cached recommendation blocked by login is not recorded as watched or interacted', async () => {
  const launch = chromium.launch, exists = fs.existsSync, read = fs.readFileSync;
  const append = fs.appendFileSync, write = fs.writeFileSync;
  const writes = [];
  let launches = 0;
  const page = { url: () => 'https://www.douyin.com/video/123456', goto: async () => {}, waitForTimeout: async () => {}, screenshot: async () => { throw Error(); }, evaluate: async fn => String(fn).includes('loginPanel:') ? { loginPanel: true } : undefined };
  chromium.launch = async () => {
    if (++launches === 1) throw Error('feed offline');
    return { newContext: async () => ({ routeWebSocket: async () => {}, route: async () => {}, newPage: async () => page }), close: async () => {} };
  };
  fs.existsSync = p => String(p).endsWith('douyin-feed.json');
  fs.readFileSync = p => String(p).endsWith('douyin-feed.json') ? JSON.stringify([{ title: 'cached title', author: 'test', url: 'https://www.douyin.com/video/123456' }]) : read(p);
  fs.appendFileSync = (...args) => writes.push(args);
  fs.writeFileSync = (...args) => writes.push(args);
  const before = getDouyinLivingStatus();
  try {
    const result = await browseDouyinLive();
    assert.equal(result.success, false);
    assert.equal(result.needLogin, true);
    assert.equal(writes.length, 0);
    assert.deepEqual(getDouyinLivingStatus().lastVideo, before.lastVideo);
  } finally { chromium.launch = launch; fs.existsSync = exists; fs.readFileSync = read; fs.appendFileSync = append; fs.writeFileSync = write; }
});
