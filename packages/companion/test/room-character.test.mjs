import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROOM_STATES,
  resolveStateMapping,
  resolveClip,
  calculateAnchorTransform,
  calculateHitTargetRect,
  CharacterStateMachine,
} from '../public/room_assets/character/model.js';

import {
  createCharacterRenderer,
} from '../public/room_assets/character/renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, '../public/room_assets/character/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

/**
 * 轻量测试依赖注入 DOM 环境（不污染生产代码）
 */
function createTestDOMSeam() {
  function createElement(tag) {
    const listeners = {};
    const classes = new Set();
    const attrs = {};
    const children = [];
    const node = {
      tagName: tag.toUpperCase(),
      id: '',
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(val) {
        classes.clear();
        if (typeof val === 'string') {
          val.trim().split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        }
      },
      style: {},
      dataset: {},
      tabIndex: 0,
      src: '',
      alt: '',
      loop: false,
      autoplay: false,
      muted: false,
      playsInline: false,
      preload: '',
      paused: true,
      ended: false,
      readyState: 0,
      parentNode: null,
      children,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => {
          if (force === undefined) {
            classes.has(c) ? classes.delete(c) : classes.add(c);
          } else if (force) {
            classes.add(c);
          } else {
            classes.delete(c);
          }
          return classes.has(c);
        },
        contains: (c) => classes.has(c),
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] || null,
      appendChild: (child) => {
        child.parentNode = node;
        children.push(child);
        return child;
      },
      removeChild: (child) => {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
        child.parentNode = null;
        return child;
      },
      querySelector: (selector) => {
        const match = (curr) => {
          if (selector.startsWith('.')) {
            if (curr.classList?.contains(selector.slice(1))) return curr;
          } else if (selector.startsWith('#')) {
            if (curr.id === selector.slice(1)) return curr;
          } else if (curr.tagName?.toLowerCase() === selector.toLowerCase()) {
            return curr;
          }
          for (const c of (curr.children || [])) {
            const found = match(c);
            if (found) return found;
          }
          return null;
        };
        for (const c of children) {
          const res = match(c);
          if (res) return res;
        }
        return null;
      },
      addEventListener: (type, fn) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      removeEventListener: (type, fn) => {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      dispatchEvent: (e) => {
        (listeners[e.type] || []).forEach((fn) => fn(e));
      },
      playCalls: 0,
      pauseCalls: 0,
      play: async () => {
        node.playCalls++;
        node.paused = false;
      },
      pause: () => {
        node.pauseCalls++;
        node.paused = true;
      },
    };
    return node;
  }

  const stage = createElement('div');
  stage.id = 'stage';

  const docListeners = {};
  const doc = {
    hidden: false,
    createElement,
    getElementById: (id) => (id === 'stage' ? stage : null),
    addEventListener: (type, fn) => {
      docListeners[type] = docListeners[type] || [];
      docListeners[type].push(fn);
    },
    removeEventListener: (type, fn) => {
      if (!docListeners[type]) return;
      docListeners[type] = docListeners[type].filter((f) => f !== fn);
    },
    dispatchEvent: (e) => {
      (docListeners[e.type] || []).forEach((fn) => fn(e));
    },
  };

  const winListeners = {};
  const win = {
    addEventListener: (type, fn) => {
      winListeners[type] = winListeners[type] || [];
      winListeners[type].push(fn);
    },
    removeEventListener: (type, fn) => {
      if (!winListeners[type]) return;
      winListeners[type] = winListeners[type].filter((f) => f !== fn);
    },
    dispatchEvent: (e) => {
      (winListeners[e.type] || []).forEach((fn) => fn(e));
    },
    matchMedia: (query) => ({
      matches: win.__reducedMotionMatches ?? false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };

  return { stage, doc, win };
}

test('room character model - state mappings and unknown fallback', async (t) => {
  await t.test('must define and correctly map all 5 core room states', () => {
    const phone = resolveStateMapping('bed_phone');
    assert.equal(phone.clip, 'idle');
    assert.deepEqual(phone.position, [680, 690]);

    const sit = resolveStateMapping('bed_sit');
    assert.equal(sit.clip, 'idle');
    assert.deepEqual(sit.position, [560, 640]);

    const sleep = resolveStateMapping('bed_sleep');
    assert.equal(sleep.clip, 'sleep');
    assert.deepEqual(sleep.position, [510, 620]);

    const crawling = resolveStateMapping('crawling');
    assert.equal(crawling.clip, 'move');
    assert.deepEqual(crawling.position, [1080, 690]);

    const desk = resolveStateMapping('desk_laptop');
    assert.equal(desk.clip, 'work');
    assert.deepEqual(desk.position, [1080, 680]);
  });

  await t.test('unknown or empty states must safely fallback to idle', () => {
    for (const unknown of ['unknown_state', 'dancing', '', null, undefined, 123]) {
      const res = resolveStateMapping(unknown);
      assert.equal(res.clip, 'idle', `State '${unknown}' must fallback to 'idle'`);
      assert.ok(Array.isArray(res.position) && res.position.length === 2, 'Must provide default position');
    }
  });

  await t.test('Object.hasOwn protection against prototype pollution or inherited properties', () => {
    for (const dangerous of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const res = resolveStateMapping(dangerous);
      assert.equal(res.clip, 'idle', `Inherited property '${dangerous}' must fallback to idle`);
      assert.equal(res.isFallback, true);
    }
  });
});

test('room character model - anchor layout, bodyBox, and coordinate scaling math regression', async (t) => {
  await t.test('calculateAnchorTransform positions element correctly using feet anchor and relative-to-self percentage', () => {
    // World coordinate: [680, 690]
    // Canvas: [640, 360], Anchor: [320, 330]
    // Full canvas worldWidth: 480, height: 480 * 360 / 640 = 270
    // Anchor X = 320/640 * 480 = 240px from left -> left = 680 - 240 = 440px
    // Anchor Y = 330/360 * 270 = 247.5px from top -> top = 690 - 247.5 = 442.5px
    const transform = calculateAnchorTransform({
      worldX: 680,
      worldY: 690,
      manifest,
      renderWidth: 480,
    });

    assert.equal(transform.renderWidth, 480);
    assert.equal(transform.renderHeight, 270);
    assert.equal(transform.worldLeft, 440);
    assert.equal(transform.worldTop, 442.5);

    // CSS transform translate 百分比是相对于元素自身的尺寸 (480x270)，而非 stage
    // 因此 translateXPercent 必须等于 (worldLeft / 480) * 100，以保证最终在舞台上的像素位移恰好是 worldLeft
    const expectedXPercent = (440 / 480) * 100;
    const expectedYPercent = (442.5 / 270) * 100;
    assert.ok(Math.abs(transform.translateXPercent - expectedXPercent) < 0.001, 'translateXPercent must be relative to renderWidth (480)');
    assert.ok(Math.abs(transform.translateYPercent - expectedYPercent) < 0.001, 'translateYPercent must be relative to renderHeight (270)');
  });

  await t.test('calculateHitTargetRect extracts approximate button dimensions based on bodyBox', () => {
    const rect = calculateHitTargetRect(manifest);
    assert.equal(rect.leftPercent, 33.125);
    assert.ok(Math.abs(rect.topPercent - 16.6667) < 0.01);
    assert.equal(rect.widthPercent, 33.75);
    assert.equal(rect.heightPercent, 75);
  });
});

test('room character model - clip resolution and fallback', async (t) => {
  await t.test('resolves relative clip URLs based on manifest location', () => {
    const idleClip = resolveClip(manifest, 'idle', '/room_assets/character/');
    assert.equal(idleClip.name, 'idle');
    assert.equal(idleClip.src, '/room_assets/character/clips/idle.webm');
    assert.equal(idleClip.poster, '/room_assets/character/clips/idle.webp');
    assert.equal(idleClip.loop, true);

    const greetClip = resolveClip(manifest, 'greet', '/room_assets/character/');
    assert.equal(greetClip.name, 'greet');
    assert.equal(greetClip.loop, false);
  });

  await t.test('missing or invalid clip name falls back to idle', () => {
    const fallbackClip = resolveClip(manifest, 'non_existent_clip', '/room_assets/character/');
    assert.equal(fallbackClip.name, 'idle');
    assert.equal(fallbackClip.src, '/room_assets/character/clips/idle.webm');
  });
});

test('room character state machine - feedback, restore, idempotency, race condition', async (t) => {
  await t.test('initial state defaults to bed_phone and idle', () => {
    const sm = new CharacterStateMachine({ manifest });
    assert.equal(sm.getBusinessState(), 'bed_phone');
    assert.equal(sm.getCurrentClip().name, 'idle');
    assert.equal(sm.isGreeting(), false);
  });

  await t.test('triggerGreet sets greeting state and ignores repeated clicks (idempotent)', () => {
    const sm = new CharacterStateMachine({ manifest });
    assert.equal(sm.isGreeting(), false);

    const triggered = sm.triggerGreet();
    assert.equal(triggered, true);
    assert.equal(sm.isGreeting(), true);
    assert.equal(sm.getCurrentClip().name, 'greet');

    const repeated = sm.triggerGreet();
    assert.equal(repeated, false);
    assert.equal(sm.isGreeting(), true);
    assert.equal(sm.getCurrentClip().name, 'greet');
  });

  await t.test('onGreetEnded restores current business state action', () => {
    const sm = new CharacterStateMachine({ manifest });
    sm.applyRoomState({ state: 'desk_laptop', updatedAt: 100 });
    assert.equal(sm.getCurrentClip().name, 'work');

    sm.triggerGreet();
    assert.equal(sm.getCurrentClip().name, 'greet');

    sm.onGreetEnded();
    assert.equal(sm.isGreeting(), false);
    assert.equal(sm.getCurrentClip().name, 'work');
    assert.equal(sm.getBusinessState(), 'desk_laptop');
  });

  await t.test('new room state cancels active greet immediately', () => {
    const sm = new CharacterStateMachine({ manifest });
    sm.applyRoomState({ state: 'bed_phone', updatedAt: 100 });
    sm.triggerGreet();
    assert.equal(sm.isGreeting(), true);
    assert.equal(sm.getCurrentClip().name, 'greet');

    sm.applyRoomState({ state: 'bed_sleep', updatedAt: 200 });
    assert.equal(sm.isGreeting(), false, 'New room state must cancel greet');
    assert.equal(sm.getBusinessState(), 'bed_sleep');
    assert.equal(sm.getCurrentClip().name, 'sleep');
  });

  await t.test('stale snapshot race condition: older timestamp does not overwrite newer', () => {
    const sm = new CharacterStateMachine({ manifest });
    sm.applyRoomState({ state: 'desk_laptop', updatedAt: 2000 });
    assert.equal(sm.getBusinessState(), 'desk_laptop');

    const accepted = sm.applyRoomState({ state: 'bed_phone', updatedAt: 1500 });
    assert.equal(accepted, false, 'Older timestamp must be rejected');
    assert.equal(sm.getBusinessState(), 'desk_laptop', 'State must not be overwritten by stale snapshot');
  });

  await t.test('version-based race condition: version takes precedence over timestamp', () => {
    const sm = new CharacterStateMachine({ manifest });
    // 后端递增 version: 5, timestamp 1000
    sm.applyRoomState({ state: 'desk_laptop', version: 5, updatedAt: 1000 });
    assert.equal(sm.getBusinessState(), 'desk_laptop');

    // 初始 fetch 返回低版本 version: 4，即使其本地 timestamp 标记为 1200（由于网络或时钟偏差），也必须被丢弃
    const acceptedLowVersion = sm.applyRoomState({ state: 'bed_phone', version: 4, updatedAt: 1200 });
    assert.equal(acceptedLowVersion, false, 'Lower version must be rejected even if timestamp is newer');
    assert.equal(sm.getBusinessState(), 'desk_laptop');

    // 同毫秒时间戳但更高版本 version: 6 必须被接受
    const acceptedHighVersion = sm.applyRoomState({ state: 'bed_sleep', version: 6, updatedAt: 1000 });
    assert.equal(acceptedHighVersion, true, 'Higher version must be accepted');
    assert.equal(sm.getBusinessState(), 'bed_sleep');
  });
});

test('room character renderer - DOM seam & integration contracts', async (t) => {
  await t.test('builds #room-character with correct transform percentage math and clean DOM', () => {
    const { stage, doc, win } = createTestDOMSeam();

    const renderer = createCharacterRenderer({
      stage,
      document: doc,
      window: win,
      manifest,
      autoFetch: false,
      baseUrl: '/room_assets/character/',
    });

    const rootEl = renderer.getElement();
    assert.ok(rootEl, 'Must create root character element');
    assert.equal(rootEl.id, 'room-character');

    // 默认 bed_phone: [680, 690] -> worldLeft = 440, worldTop = 442.5
    // translate3d 必须是相对 480x270 自身的百分比：440/480*100% = 91.6667%, 442.5/270*100% = 163.8889%
    const expectedX = ((440 / 480) * 100).toFixed(4);
    const expectedY = ((442.5 / 270) * 100).toFixed(4);
    assert.ok(
      rootEl.style.transform.includes(`${expectedX}%`) && rootEl.style.transform.includes(`${expectedY}%`),
      `transform must use relative-to-self percentages. Current: ${rootEl.style.transform}`
    );

    const button = rootEl.querySelector('.character-hit-target');
    assert.ok(button, 'Must create hit-target button');
    assert.equal(button.getAttribute('aria-label'), '与深深互动');

    const statusEl = rootEl.querySelector('.character-status');
    assert.ok(statusEl, 'Must create status element for aria-live');
    assert.equal(statusEl.getAttribute('aria-live'), 'polite');
    // 文案修复检查：不能包含重复的“正在在”
    assert.ok(
      !statusEl.textContent.includes('正在在'),
      `Status text should not contain duplicate '正在在'. Current: ${statusEl.textContent}`
    );

    renderer.destroy();
  });

  await t.test('loadGeneration prevents stale canplay / error callback race', () => {
    const { stage, doc, win } = createTestDOMSeam();

    const renderer = createCharacterRenderer({
      stage,
      document: doc,
      window: win,
      manifest,
      autoFetch: false,
      baseUrl: '/room_assets/character/',
    });

    // 触发更新为 desk_laptop (work)
    win.dispatchEvent({ type: 'room:state', detail: { state: 'desk_laptop', updatedAt: 100 } });

    // 模拟快速收到新状态 bed_sleep (sleep)
    win.dispatchEvent({ type: 'room:state', detail: { state: 'bed_sleep', updatedAt: 200 } });

    const sm = renderer.getStateMachine();
    assert.equal(sm.getBusinessState(), 'bed_sleep');
    assert.equal(sm.getCurrentClip().name, 'sleep');

    renderer.destroy();
  });

  await t.test('fallbackToPoster pauses both videos and hides them', () => {
    const { stage, doc, win } = createTestDOMSeam();

    const renderer = createCharacterRenderer({
      stage,
      document: doc,
      window: win,
      manifest,
      autoFetch: false,
    });

    const videos = renderer.getVideos();
    renderer.fallbackToPoster('/room_assets/character/clips/idle.webp');

    assert.equal(videos.activeVideo.pauseCalls > 0, true, 'Active video must be paused');
    assert.equal(videos.standbyVideo.pauseCalls > 0, true, 'Standby video must be paused');
    assert.equal(videos.activeVideo.style.opacity, '0');
    assert.equal(videos.standbyVideo.style.opacity, '0');

    renderer.destroy();
  });

  await t.test('hidden document prevents video autoplay in background', () => {
    const { stage, doc, win } = createTestDOMSeam();
    doc.hidden = true; // 页面隐藏

    const renderer = createCharacterRenderer({
      stage,
      document: doc,
      window: win,
      manifest,
      autoFetch: false,
    });

    const videos = renderer.getVideos();
    const prevPlayCalls = videos.activeVideo.playCalls + videos.standbyVideo.playCalls;

    // 在页面 hidden 期间应用新状态
    win.dispatchEvent({ type: 'room:state', detail: { state: 'desk_laptop', updatedAt: 100 } });

    const newPlayCalls = videos.activeVideo.playCalls + videos.standbyVideo.playCalls;
    assert.equal(newPlayCalls, prevPlayCalls, 'Must not autoplay video while document is hidden');

    renderer.destroy();
  });

  await t.test('disabled hit target when stage is in calibration mode (stage.calib)', () => {
    const { stage, doc, win } = createTestDOMSeam();
    stage.classList.add('calib');

    const renderer = createCharacterRenderer({
      stage,
      document: doc,
      window: win,
      manifest,
      autoFetch: false,
    });

    const isHitDisabled = renderer.isHitTargetDisabled();
    assert.equal(isHitDisabled, true, 'Hit target must be disabled when stage.calib is true');

    renderer.destroy();
  });

  await t.test('motion toggle button respects system reduced-motion and allows user override', () => {
    const { stage, doc, win } = createTestDOMSeam();
    win.__reducedMotionMatches = true; // 模拟 Chromium 默认 prefers-reduced-motion: true

    const renderer = createCharacterRenderer({
      stage,
      document: doc,
      window: win,
      manifest,
      autoFetch: false,
    });

    const rootEl = renderer.getElement();
    const motionBtn = rootEl.querySelector('.character-motion-toggle');
    assert.ok(motionBtn, 'Must create motion toggle button');
    assert.equal(motionBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(motionBtn.textContent, '开启动画');
    assert.equal(renderer.isMotionActive(), false, 'Default respects reduced motion');

    // 用户主动点击开启覆盖
    motionBtn.dispatchEvent({ type: 'click' });
    assert.equal(renderer.isMotionActive(), true, 'User override turns motion on');
    assert.equal(motionBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(motionBtn.textContent, '静态角色');

    // 再次点击关闭覆盖
    motionBtn.dispatchEvent({ type: 'click' });
    assert.equal(renderer.isMotionActive(), false, 'Toggle back turns motion off');
    assert.equal(motionBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(motionBtn.textContent, '开启动画');

    renderer.destroy();
  });
});
