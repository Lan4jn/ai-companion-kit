import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { interactDouyin } from '../src/douyin-interaction.js';

const executablePath = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
test('a click without a resulting interaction state is unconfirmed', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-e2e="video-player-digg" aria-pressed="false">赞</button>');
    const result = await interactDouyin(page, 'like');
    assert.equal(result.confirmed, false);
    assert.equal(result.status, 'unconfirmed');
  } finally { await browser.close(); }
});

test('explicit state transition confirms a like; an existing like is not toggled', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-e2e="video-player-digg" aria-pressed="false">赞</button>');
    await page.locator('button').evaluate(el => el.addEventListener('click', () => el.setAttribute('aria-pressed', 'true')));
    assert.equal((await interactDouyin(page, 'like')).status, 'confirmed');
    assert.equal((await interactDouyin(page, 'like')).status, 'already');
    assert.equal(await page.locator('button').getAttribute('aria-pressed'), 'true');
  } finally { await browser.close(); }
});

test('follow requires an author-scoped explicit state, not a click', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-e2e="user-info"><button>关注</button></div>');
    assert.equal((await interactDouyin(page, 'follow')).status, 'unconfirmed');
    await page.locator('button').evaluate(el => el.addEventListener('click', () => { el.textContent = '已关注'; }));
    assert.equal((await interactDouyin(page, 'follow')).status, 'confirmed');
    assert.equal((await interactDouyin(page, 'follow')).status, 'already');
  } finally { await browser.close(); }
});

test('conflicting like indicators never confirm or click', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-e2e="video-player-digg" aria-pressed="false"><svg><path style="fill:rgb(255,44,85)" d="M0 0"/></svg>赞</button>');
    await page.locator('button').evaluate(el => el.addEventListener('click', () => { el.dataset.clicked = 'yes'; }));
    assert.equal((await interactDouyin(page, 'like')).status, 'unconfirmed');
    assert.equal(await page.locator('button').getAttribute('data-clicked'), null);
  } finally { await browser.close(); }
});

test('unknown like state and login dialog do not trigger a click', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-e2e="video-player-digg">赞</button>');
    await page.locator('button').evaluate(el => el.addEventListener('click', () => { el.textContent = 'clicked'; }));
    assert.equal((await interactDouyin(page, 'like')).status, 'unconfirmed');
    assert.equal(await page.locator('button').innerText(), '赞');
    await page.setContent('<div id="login-panel-new">请登录</div><button data-e2e="video-player-digg" aria-pressed="true">赞</button>');
    assert.equal((await interactDouyin(page, 'like')).status, 'unconfirmed');
  } finally { await browser.close(); }
});
