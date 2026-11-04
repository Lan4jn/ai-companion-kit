/**
 * 虚拟居室角色渲染器 (Room Character Renderer)
 *
 * 负责在 #stage 舞台内挂载 #room-character 元素，
 * 消费 window 'room:state' 事件与初始 /api/status，管理双缓冲视频与海报降级，
 * 响应点击/键盘互动反馈，配合 prefers-reduced-motion 与 stage.calib 标注模式。
 */

import {
  DEFAULT_ROOM_STATE,
  calculateAnchorTransform,
  calculateHitTargetRect,
  CharacterStateMachine,
} from './model.js?v=20261104-1';

/**
 * 创建角色渲染器实例
 * @param {object} options
 * @param {HTMLElement} [options.stage] - 宿主舞台容器 (默认 document.getElementById('stage'))
 * @param {object} [options.manifest] - 角色描述清单，如未提供则从 manifestUrl 加载
 * @param {string} [options.manifestUrl='/room_assets/character/manifest.json'] - manifest 请求路径
 * @param {string} [options.baseUrl='/room_assets/character/'] - 资源相对基准路径
 * @param {string} [options.statusUrl='/api/status'] - 初始状态查询接口
 * @param {boolean} [options.autoFetch=true] - 是否自动拉取初始状态
 * @param {Window} [options.window=globalThis.window] - 窗口环境引用
 * @param {Document} [options.document=globalThis.document] - 文档环境引用
 * @returns {object} 渲染器实例
 */
export function createCharacterRenderer(options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const doc = options.document || (typeof document !== 'undefined' ? document : null);

  if (!doc) {
    throw new Error('createCharacterRenderer requires a valid document object');
  }

  const stage = options.stage || doc.getElementById('stage');
  const manifestUrl = options.manifestUrl || '/room_assets/character/manifest.json';
  const baseUrl = options.baseUrl || '/room_assets/character/';
  const statusUrl = options.statusUrl || '/api/status';
  const autoFetch = options.autoFetch !== false;

  let manifest = options.manifest || null;
  let stateMachine = null;
  let destroyed = false;
  let systemReducedMotion = false;
  let userMotionOverride = null; // null: 遵循系统, true: 强制开启动画, false: 强制静态
  let videoSupported = true; // 视频是否可用/未报错
  let currentLoadGeneration = 0;
  let greetTimer = null;

  // DOM 节点引用
  let rootEl = null;
  let canvasBox = null;
  let activeVideo = null;
  let standbyVideo = null;
  let posterImg = null;
  let hitButton = null;
  let motionToggleBtn = null;
  let statusEl = null;

  // 计算当前最终是否应开启动画
  function isMotionActive() {
    if (!videoSupported) return false;
    if (userMotionOverride !== null) {
      return userMotionOverride;
    }
    return !systemReducedMotion;
  }

  function clearGreetTimer() {
    if (greetTimer) {
      clearTimeout(greetTimer);
      greetTimer = null;
    }
  }

  function armGreetFallbackTimer(durationMs = 2000) {
    clearGreetTimer();
    greetTimer = setTimeout(() => {
      greetTimer = null;
      if (stateMachine && stateMachine.isGreeting()) {
        stateMachine.onGreetEnded();
        updateView();
      }
    }, durationMs);
  }

  // 内部辅助：判断是否禁用热区（标注模式 stage.calib）
  function isHitTargetDisabled() {
    if (!stage || !stage.classList) return false;
    return typeof stage.classList.contains === 'function' && stage.classList.contains('calib');
  }

  // 构建纯净 DOM 节点树（不含测试桩）
  function buildDOM() {
    rootEl = doc.createElement('div');
    rootEl.id = 'room-character';
    rootEl.className = 'character-container';

    canvasBox = doc.createElement('div');
    canvasBox.className = 'character-canvas-box';

    // 双缓冲透明视频元素：防闪烁切换
    activeVideo = doc.createElement('video');
    activeVideo.className = 'character-media character-video active-video';
    activeVideo.autoplay = true;
    activeVideo.muted = true;
    activeVideo.playsInline = true;
    activeVideo.preload = 'metadata';

    standbyVideo = doc.createElement('video');
    standbyVideo.className = 'character-media character-video standby-video';
    standbyVideo.autoplay = true;
    standbyVideo.muted = true;
    standbyVideo.playsInline = true;
    standbyVideo.preload = 'metadata';
    standbyVideo.style.opacity = '0';

    // 静态 WebP 海报兜底元素
    posterImg = doc.createElement('img');
    posterImg.className = 'character-media character-poster';
    posterImg.alt = '深深';
    posterImg.style.display = 'none';

    // 角色实体点击热区（基于 bodyBox 近似区域）
    hitButton = doc.createElement('button');
    hitButton.className = 'character-hit-target';
    hitButton.type = 'button';
    hitButton.setAttribute('aria-label', '与深深互动');
    hitButton.tabIndex = 0;

    // 用户动作动画控制开关（默认尊重系统 reduced-motion，支持本页显式 override）
    motionToggleBtn = doc.createElement('button');
    motionToggleBtn.className = 'character-motion-toggle';
    motionToggleBtn.type = 'button';
    motionToggleBtn.tabIndex = 0;
    updateMotionToggleUI();

    // 屏幕阅读器辅助通知
    statusEl = doc.createElement('span');
    statusEl.className = 'character-status';
    statusEl.setAttribute('aria-live', 'polite');

    canvasBox.appendChild(activeVideo);
    canvasBox.appendChild(standbyVideo);
    canvasBox.appendChild(posterImg);
    canvasBox.appendChild(hitButton);

    rootEl.appendChild(canvasBox);
    rootEl.appendChild(motionToggleBtn);
    rootEl.appendChild(statusEl);

    if (manifest) {
      applyBodyBoxStyles();
    }

    if (stage && typeof stage.appendChild === 'function') {
      stage.appendChild(rootEl);
    }
  }

  function applyBodyBoxStyles() {
    if (!manifest || !hitButton || !hitButton.style) return;
    const rect = calculateHitTargetRect(manifest);
    hitButton.style.left = `${rect.leftPercent.toFixed(4)}%`;
    hitButton.style.top = `${rect.topPercent.toFixed(4)}%`;
    hitButton.style.width = `${rect.widthPercent.toFixed(4)}%`;
    hitButton.style.height = `${rect.heightPercent.toFixed(4)}%`;
  }

  function updateMotionToggleUI() {
    if (!motionToggleBtn) return;
    const active = isMotionActive();
    motionToggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    motionToggleBtn.textContent = active ? '静态角色' : '开启动画';
    motionToggleBtn.title = active ? '切换为静态角色省电/防晕眩' : '开启透明动作视频动画';

    if (rootEl && rootEl.classList) {
      rootEl.classList.toggle('character-reduced-motion', !active);
    }
  }

  // 海报回退降级处理（防忙循环，暂停双视频并隐藏）
  function fallbackToPoster(posterSrc) {
    if (activeVideo && typeof activeVideo.pause === 'function') activeVideo.pause();
    if (standbyVideo && typeof standbyVideo.pause === 'function') standbyVideo.pause();
    if (activeVideo && activeVideo.style) activeVideo.style.opacity = '0';
    if (standbyVideo && standbyVideo.style) standbyVideo.style.opacity = '0';

    if (posterImg) {
      if (posterSrc && posterImg.src !== posterSrc) {
        posterImg.src = posterSrc;
      }
      posterImg.style.display = 'block';
      posterImg.onerror = () => {
        if (statusEl) {
          statusEl.textContent = '深深角色素材暂时离线';
        }
      };
    }

    // 若当前正在 greet，海报模式下无法接收 video ended 事件，使用可取消定时器自动结束
    if (stateMachine && stateMachine.isGreeting()) {
      armGreetFallbackTimer();
    }
  }

  // 刷新视图：位置变换与当前动作媒体
  function updateView() {
    if (destroyed || !stateMachine) return;

    // 1. 更新位置变换（CSS transform translate 百分比相对于自身 480x270，严防左上角挤压）
    const [worldX, worldY] = stateMachine.getCurrentPosition();
    const transform = calculateAnchorTransform({
      worldX,
      worldY,
      manifest,
    });

    if (rootEl && rootEl.style) {
      rootEl.style.transform = `translate3d(${transform.translateXPercent.toFixed(4)}%, ${transform.translateYPercent.toFixed(4)}%, 0)`;
    }

    // 2. 更新 ARIA 辅助状态文本（修文案：防“深深正在在床边”重复“在”）
    if (statusEl) {
      const desc = stateMachine.getCurrentDescription() || '';
      const isGreet = stateMachine.isGreeting();
      const cleanDesc = desc.startsWith('在') ? desc.slice(1) : desc;
      statusEl.textContent = isGreet ? '深深正在元气挥手致意' : `深深正在${cleanDesc}`;
    }

    updateMotionToggleUI();

    // 3. 更新媒体 Clip
    const clip = stateMachine.getCurrentClip();
    if (!clip) return;

    // 若处于减弱动画环境，直接静态海报呈现
    const motionActive = isMotionActive();
    if (!motionActive) {
      fallbackToPoster(clip.poster);
      return;
    }

    if (!activeVideo || !standbyVideo) return;

    const targetSrc = clip.src;
    // 若当前活跃视频已经在播放该动作，直接保持
    if (activeVideo.dataset && activeVideo.dataset.currentSrc === targetSrc && !activeVideo.paused && !activeVideo.ended) {
      activeVideo.loop = clip.loop;
      return;
    }

    const generation = ++currentLoadGeneration;

    // 页面处于 hidden 后台状态时，禁止调用 play() 自动播放，仅准备 src
    if (doc.hidden) {
      standbyVideo.src = targetSrc;
      standbyVideo.loop = clip.loop;
      if (standbyVideo.dataset) {
        standbyVideo.dataset.currentSrc = targetSrc;
      }
      return;
    }

    // 准备副缓冲视频加载新动作
    standbyVideo.src = targetSrc;
    standbyVideo.loop = clip.loop;
    if (standbyVideo.dataset) {
      standbyVideo.dataset.currentSrc = targetSrc;
    }

    let swapped = false;
    const performSwap = () => {
      if (swapped || destroyed) return;
      if (generation !== currentLoadGeneration) return; // 代次过期，丢弃旧事件
      swapped = true;

      // 切换可见度
      standbyVideo.style.opacity = '1';
      activeVideo.style.opacity = '0';
      if (posterImg) posterImg.style.display = 'none';

      // 尝试自动播放
      const playPromise = standbyVideo.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((_err) => {
          if (generation !== currentLoadGeneration) return;
          videoSupported = false;
          updateMotionToggleUI();
          fallbackToPoster(clip.poster);
        });
      }

      if (typeof activeVideo.pause === 'function') {
        activeVideo.pause();
      }

      // 交换主副指针
      const temp = activeVideo;
      activeVideo = standbyVideo;
      standbyVideo = temp;
    };

    standbyVideo.oncanplay = performSwap;
    standbyVideo.onerror = (_err) => {
      if (generation !== currentLoadGeneration) return;
      videoSupported = false;
      updateMotionToggleUI();
      fallbackToPoster(clip.poster);
    };

    // 同步准备状态兜底
    if (standbyVideo.readyState >= 2) {
      performSwap();
    }
  }

  // 触发一次 greet 互动
  function handleTriggerGreet() {
    if (isHitTargetDisabled()) return;
    if (!stateMachine) return;
    const ok = stateMachine.triggerGreet();
    if (ok) {
      updateView();
      if (!isMotionActive()) {
        armGreetFallbackTimer();
      }
    }
  }

  // 视频播放完毕（仅接受当前 activeVideo 派发的 ended，防过期副缓冲干扰）
  function handleVideoEnded(e) {
    if (e && e.target && e.target !== activeVideo) return;
    if (!stateMachine) return;
    if (stateMachine.isGreeting()) {
      clearGreetTimer();
      stateMachine.onGreetEnded();
      updateView();
    }
  }

  // 事件监听绑定
  let roomStateListener = null;
  let visibilityListener = null;
  let motionQuery = null;
  let motionListener = null;
  let pageHideListener = null;

  function bindEvents() {
    if (hitButton && typeof hitButton.addEventListener === 'function') {
      hitButton.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        handleTriggerGreet();
      });

      hitButton.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          handleTriggerGreet();
        }
      });
    }

    if (activeVideo) activeVideo.onended = handleVideoEnded;
    if (standbyVideo) standbyVideo.onended = handleVideoEnded;

    if (win && typeof win.addEventListener === 'function') {
      // 消费 window 'room:state' 事件，不额外开启 SSE
      roomStateListener = (e) => {
        const detail = e?.detail;
        if (!detail || !stateMachine) return;
        clearGreetTimer(); // 新业务状态到达，清除 greet 定时器
        const accepted = stateMachine.applyRoomState(detail);
        if (accepted) {
          updateView();
        }
      };
      win.addEventListener('room:state', roomStateListener);

      // prefers-reduced-motion 监听
      if (typeof win.matchMedia === 'function') {
        try {
          motionQuery = win.matchMedia('(prefers-reduced-motion: reduce)');
          systemReducedMotion = Boolean(motionQuery.matches);
          updateMotionToggleUI();

          motionListener = (e) => {
            systemReducedMotion = Boolean(e.matches);
            updateMotionToggleUI();
            updateView();
          };
          if (typeof motionQuery.addEventListener === 'function') {
            motionQuery.addEventListener('change', motionListener);
          }
        } catch {
          // 忽略老旧环境 matchMedia 异常
        }
      }

      // 绑定用户控制开关点击事件
      if (motionToggleBtn && typeof motionToggleBtn.addEventListener === 'function') {
        motionToggleBtn.addEventListener('click', (e) => {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
          // 若当前处于动画状态，则覆盖为 false（静态）；反之覆盖为 true（动画）
          const currentActive = isMotionActive();
          userMotionOverride = !currentActive;
          updateMotionToggleUI();
          updateView();
        });
      }

      // 页面隐藏/恢复控制（hidden 不自动播放后台媒体）
      if (doc && typeof doc.addEventListener === 'function') {
        visibilityListener = () => {
          if (doc.hidden) {
            if (activeVideo && typeof activeVideo.pause === 'function') activeVideo.pause();
            if (standbyVideo && typeof standbyVideo.pause === 'function') standbyVideo.pause();
          } else {
            if (activeVideo && typeof activeVideo.play === 'function' && isMotionActive()) {
              activeVideo.play().catch(() => {});
            }
          }
        };
        doc.addEventListener('visibilitychange', visibilityListener);
      }

      // pagehide 清理
      pageHideListener = () => {
        destroy();
      };
      win.addEventListener('pagehide', pageHideListener);
    }
  }

  // 初始状态拉取 (/api/status)
  function fetchInitialStatus() {
    if (!autoFetch || typeof fetch === 'undefined') return;
    fetch(statusUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && stateMachine && !destroyed) {
          clearGreetTimer();
          const accepted = stateMachine.applyRoomState(data);
          if (accepted) {
            updateView();
          }
        }
      })
      .catch(() => {
        // 网络/离线时静默，保持默认状态
      });
  }

  // 初始化 Manifest 并启动
  function startWithManifest(loadedManifest) {
    manifest = loadedManifest;
    stateMachine = new CharacterStateMachine({
      manifest,
      baseUrl,
      initialBusinessState: DEFAULT_ROOM_STATE,
    });

    applyBodyBoxStyles();
    updateView();
    fetchInitialStatus();
  }

  // 构建节点并绑定事件
  buildDOM();
  bindEvents();

  if (manifest) {
    startWithManifest(manifest);
  } else if (typeof fetch !== 'undefined') {
    fetch(manifestUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !destroyed) {
          startWithManifest(data);
        }
      })
      .catch(() => {
        startWithManifest({});
      });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearGreetTimer();

    if (activeVideo && typeof activeVideo.pause === 'function') activeVideo.pause();
    if (standbyVideo && typeof standbyVideo.pause === 'function') standbyVideo.pause();

    if (win && typeof win.removeEventListener === 'function') {
      if (roomStateListener) win.removeEventListener('room:state', roomStateListener);
      if (pageHideListener) win.removeEventListener('pagehide', pageHideListener);
    }

    if (doc && typeof doc.removeEventListener === 'function' && visibilityListener) {
      doc.removeEventListener('visibilitychange', visibilityListener);
    }

    if (motionQuery && motionListener && typeof motionQuery.removeEventListener === 'function') {
      motionQuery.removeEventListener('change', motionListener);
    }

    if (rootEl && rootEl.parentNode && typeof rootEl.parentNode.removeChild === 'function') {
      rootEl.parentNode.removeChild(rootEl);
    }
  }

  return {
    getElement: () => rootEl,
    getStateMachine: () => stateMachine,
    getVideos: () => ({ activeVideo, standbyVideo, posterImg }),
    fallbackToPoster,
    isHitTargetDisabled,
    isMotionActive,
    triggerGreet: handleTriggerGreet,
    destroy,
  };
}

/**
 * 浏览器端自执行启动器：在宿主 HTML 加载时自动初始化
 */
export function initCharacter() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  function launch() {
    const stage = document.getElementById('stage');
    if (!stage) return null;
    return createCharacterRenderer({ stage });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', launch, { once: true });
    return null;
  }
  return launch();
}

// 浏览器环境中自动挂载
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initCharacter();
}
