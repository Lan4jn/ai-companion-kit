import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { extractForumDOM, extractThreadDOM, validateThreadUrl, isAllowedRequest, createTiebaPlaywrightSource } from '../src/tieba-playwright.js';

const executablePath = process.env.CHROME_PATH || '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';

test('offline DOM fixture distinguishes actual list cards from unrelated links', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="forum-name"><span class="forum-name-main">肥鱼避难所</span><span class="forum-name-suffix">吧</span></div><a class="top-thread-card-item" href="https://tieba.baidu.com/p/123?fr=frs"><div class="thread-title">帖子</div></a><a href="https://tieba.baidu.com/p/456">目录链接</a>`);
    assert.deepEqual(await page.evaluate(extractForumDOM), { forum: '肥鱼避难所吧', urls: ['https://tieba.baidu.com/p/123?fr=frs'] });
  } finally { await browser.close(); }
});

test('offline thread fixture extracts first post, not comment or listing', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="forum-name"><span class="forum-name-main">肥鱼避难所</span><span class="forum-name-suffix">吧</span></div><div class="center-content"><div class="image-text"><div class="desc-info"><span class="post-num">11-11</span></div><div class="pb-title">标题</div><div class="pb-content-wrap"><div class="richtext-item"><span class="pb-text-wrapper" tid="123">正文<span>第二段</span></span></div></div></div></div><div class="comment-content">回复不应混入</div>`);
    const result = await page.evaluate(extractThreadDOM);
    assert.equal(result.forum, '肥鱼避难所吧'); assert.equal(result.id, '123'); assert.equal(result.title, '标题'); assert.equal(result.time, '11-11'); assert.match(result.body, /正文/); assert.doesNotMatch(result.body, /回复不应混入/);
  } finally { await browser.close(); }
});

test('strict canonical thread URL only', () => {
  assert.equal(validateThreadUrl('https://tieba.baidu.com/p/123'), true);
  for (const url of ['http://tieba.baidu.com/p/123','https://tieba.baidu.com.evil/p/123','https://tieba.baidu.com:444/p/123','https://user@tieba.baidu.com/p/123','https://tieba.baidu.com/p/123?fr=frs','https://tieba.baidu.com/p/123/','https://127.0.0.1/p/123']) assert.equal(validateThreadUrl(url), false, url);
});

test("request policy blocks writes, private networks and redirects", () => {
  const expected = "https://tieba.baidu.com/p/123";
  const request = (url, method = "GET", type = "xhr", nav = false) => ({ url: () => url, method: () => method, resourceType: () => type, isNavigationRequest: () => nav });
  assert.equal(isAllowedRequest(request(expected,"GET","document",true), expected), true);
  for (const q of [request("https://tieba.baidu.com/p/456","GET","document",true), request("http://127.0.0.1/"), request("https://tieba.baidu.com/c/c/post/add","POST"), request("https://tieba.baidu.com.evil/c/f/pb/page_pc","POST"), request("https://passport.baidu.com/v2/api/?login","POST")]) assert.equal(isAllowedRequest(q, expected), false);
});

test("rejects wrong forum and untrusted URL before browser launch", async () => {
  const source = createTiebaPlaywrightSource({chromium: {launch() {throw new Error("must not launch")}}});
  await assert.rejects(source.list({forum: "其他吧"}), /forum_not_allowed/);
  await assert.rejects(source.read({forum:"肥鱼避难所吧",url:"https://127.0.0.1/p/123"}), /thread_not_allowed/);
});

test("login or challenge DOM is not interpreted as a thread", async () => {
  const browser = await chromium.launch({executablePath,headless:true,args:["--no-sandbox"]});
  try {const page=await browser.newPage();await page.setContent("<h1>登录后查看</h1><div>请完成验证码验证</div><a href=\"https://tieba.baidu.com/p/123\">目录</a>");const post=await page.evaluate(extractThreadDOM);assert.equal(post.id, "");assert.equal(post.body, "");assert.deepEqual((await page.evaluate(extractForumDOM)).urls, []);} finally {await browser.close();}
});
