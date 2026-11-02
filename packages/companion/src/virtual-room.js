/**
 * 小鱼/大肥鱼 虚拟居室（Virtual Room Web App - 2.5D 等距房间深度融合版）
 *
 * 运行在 0.0.0.0:18888 上的高颜值 2.5D 等距卧室交互场景：
 * 1. 底图层：采用 3:2 经典等距插画（大白床、落地全景窗、双屏书桌、蓝鲸地毯）。
 * 2. 动态光影与天气系统：
 *    - 4 时段平滑插值（清晨冷调、中午通透、下午夕照、晚间发蓝微暗），跟随真实系统时间自动流转。
 *    - 天气粒子层：晴天阳光丁达尔光束、雨天水丝淅沥、雪天雪花飘摇。
 *    - 台灯开关联动：暖黄径向柔光与关灯暗化滤镜。
 * 3. 家具点击抽屉系统：
 *    - 🛌 床铺：查看小鱼睡眠/躺平状态、使用设备与作息。
 *    - 💻 书桌电脑：查看当前工作/摸鱼状态、最近刷的抖音/B站视频与吐槽、独立监视器入口。
 *    - 📚 书架：动态调取 diary.jsonl 生活日记本。
 *    - 🐳 鲸鱼地毯：毛绒公仔与互动陪伴羁绊。
 *    - 🪟 落地窗：天色与光照透视。
 * 4. 标注模式（?calib=1）：支持在页面上自由拖动、调整热区位置并持久化保存。
 * 5. HUD 实时对话卡片：保持与 QQ 和后台动作实时 SSE 同步（打字机/渐变气泡、呼吸灯、状态标签）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getLatestScreenBuffer, getObserverStatus } from './browser-observer.js';
import { getDouyinLivingStatus } from './douyin-living.js';

const PORT = 18888;
const ASSETS_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets';
const DATA_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data';

let curState = {
  state: 'bed_phone', // 'bed_phone' | 'bed_sleep' | 'crawling' | 'desk_laptop' | 'bed_sit'
  action: '在床上悠闲躺平看手机',
  message: '正在继续干活呢，别打扰我~',
  recentInput: 'phone',
  updatedAt: Date.now(),
};

const sseClients = new Set();

function broadcastState() {
  const data = `data: ${JSON.stringify(curState)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

export function setRoomState(newState, { action = '', message = '', recentInput = '' } = {}) {
  const prev = curState.state;
  if (newState && newState !== prev) {
    if ((prev === 'bed_phone' || prev === 'bed_sleep' || prev === 'bed_sit') && newState === 'desk_laptop') {
      curState.state = 'crawling';
      curState.action = '上椅子打开电脑';
      curState.message = '正在费劲爬上转椅开电脑……';
      curState.updatedAt = Date.now();
      broadcastState();

      setTimeout(() => {
        curState.state = 'desk_laptop';
        if (action) curState.action = action;
        if (message) curState.message = message;
        if (recentInput) curState.recentInput = recentInput;
        curState.updatedAt = Date.now();
        broadcastState();
      }, 2000);
      return;
    }
  }

  if (newState) curState.state = newState;
  if (action) curState.action = action;
  if (message) curState.message = message;
  if (recentInput) curState.recentInput = recentInput;
  curState.updatedAt = Date.now();
  broadcastState();
}

export function getRoomState() {
  return curState;
}

/**
 * 读取最近的生活日记
 */
function getRecentDiaries(limit = 4) {
  try {
    const diaryPath = path.join(DATA_DIR, 'diary.jsonl');
    if (!fs.existsSync(diaryPath)) return [];
    const lines = fs.readFileSync(diaryPath, 'utf8').trim().split('\n').filter(Boolean);
    const parsed = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
      try {
        const item = JSON.parse(lines[i]);
        parsed.push(item);
      } catch {}
    }
    return parsed;
  } catch {
    return [];
  }
}

/**
 * 2.5D 等距虚拟居室 Web 页面模板
 */
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>织梦行云 · 小肥鱼的居室 (Virtual Room)</title>
  <style>
    :root {
      --brightness: 1;
      --ambient: #ffffff;
      --sun: .3;
      --primary: #38bdf8;
      --bg: #070a13;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background: var(--bg);
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden;
      height: 100vh;
      width: 100vw;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }

    /* 主舞台容器 (3:2 比例自适应最大化) */
    #stage {
      position: relative;
      width: 100vw;
      height: 100vh;
      max-width: 150vh; /* 3:2 ratio: width = height * 1.5 */
      max-height: 66.67vw; /* height = width / 1.5 */
      background: #000;
      overflow: hidden;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.85);
      border-radius: 12px;
      isolation: isolate;
    }

    #stage svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    /* 滤镜过渡与光色混合 */
    #stage image, #stage .base {
      filter: brightness(var(--brightness)) saturate(var(--saturation, 1));
      transition: filter 3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .color-cast {
      fill: var(--ambient);
      opacity: .18;
      mix-blend-mode: soft-light;
      transition: fill 3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .sunbeam {
      opacity: var(--sun);
      mix-blend-mode: screen;
      transition: opacity 3s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: none;
    }

    /* 交互热区样式 */
    .hz {
      fill: transparent;
      cursor: pointer;
      transition: fill 0.2s, stroke 0.2s;
    }
    .hz:hover {
      fill: rgba(56, 189, 248, 0.12);
      stroke: rgba(56, 189, 248, 0.5);
      stroke-width: 2;
    }
    .calib .hz {
      fill: rgba(244, 63, 94, 0.22);
      stroke: #f43f5e;
      stroke-width: 2.5;
      stroke-dasharray: 6 4;
      cursor: move;
    }

    /* 悬浮提示 Tooltip */
    .hint {
      position: absolute;
      pointer-events: none;
      padding: 6px 12px;
      border-radius: 8px;
      background: rgba(13, 20, 36, 0.88);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: #f8fafc;
      font-size: 13px;
      font-weight: 500;
      opacity: 0;
      transition: opacity 0.15s ease-out;
      white-space: nowrap;
      z-index: 40;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }

    /* 顶部控制栏 */
    .top-bar {
      position: absolute;
      top: 14px;
      left: 18px;
      right: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 30;
      pointer-events: none;
    }
    .top-left {
      display: flex;
      align-items: center;
      gap: 12px;
      pointer-events: auto;
    }
    .top-title {
      background: rgba(15, 23, 42, 0.82);
      backdrop-filter: blur(10px);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13.5px;
      font-weight: 600;
      border: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      align-items: center;
      gap: 8px;
      color: #f1f5f9;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #10b981;
      box-shadow: 0 0 10px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

    .top-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
      flex-wrap: wrap;
    }
    .ctrl-btn {
      background: rgba(15, 23, 42, 0.82);
      backdrop-filter: blur(10px);
      color: #94a3b8;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      padding: 6px 12px;
      font-size: 12.5px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .ctrl-btn:hover { color: #f8fafc; border-color: rgba(56, 189, 248, 0.4); background: rgba(30, 41, 59, 0.88); }
    .ctrl-btn.active { background: rgba(2, 132, 199, 0.35); color: #38bdf8; border-color: rgba(56, 189, 248, 0.6); }

    /* 抽屉面板 */
    .drawer {
      position: absolute;
      width: 330px;
      max-width: 85vw;
      background: rgba(11, 17, 33, 0.94);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 16px;
      padding: 18px 20px;
      display: none;
      z-index: 50;
      box-shadow: 0 16px 40px rgba(0,0,0,0.65);
      animation: fadeIn 0.25s ease-out;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
    .drawer h4 {
      margin: 0 0 4px;
      font-size: 16px;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .drawer .sub {
      color: #94a3b8;
      font-size: 12px;
      margin-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding-bottom: 8px;
    }
    .drawer .kv-list { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
    .drawer .kv {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: #cbd5e1;
      line-height: 1.4;
    }
    .drawer .kv span:first-child { color: #64748b; white-space: nowrap; flex-shrink: 0; }
    .drawer .kv span:last-child { color: #f1f5f9; text-align: right; word-break: break-all; }
    .drawer .close-btn {
      position: absolute;
      right: 14px;
      top: 14px;
      cursor: pointer;
      color: #94a3b8;
      font-size: 18px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: rgba(255,255,255,0.05);
      transition: all 0.2s;
    }
    .drawer .close-btn:hover { color: #fff; background: rgba(255,255,255,0.15); }
    .drawer .extra-box {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }

    /* 底部实时对话与状态 HUD 卡片 */
    .bottom-hud {
      position: absolute;
      bottom: 16px;
      left: 18px;
      right: 18px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      z-index: 30;
      pointer-events: none;
      gap: 16px;
    }
    .dialogue-card {
      pointer-events: auto;
      background: rgba(11, 17, 33, 0.88);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      padding: 14px 18px;
      max-width: 580px;
      min-width: 320px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55);
    }
    .bubble-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .avatar-mini {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4);
    }
    .char-name { font-weight: 600; font-size: 14px; color: #f8fafc; }
    .status-tag {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(56, 189, 248, 0.16);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      font-family: ui-monospace, monospace;
    }
    .bubble-text {
      font-size: 13.5px;
      line-height: 1.55;
      color: #e2e8f0;
      min-height: 22px;
      transition: all 0.2s;
    }

    /* 快捷交互操作条 */
    .actions-bar {
      display: flex;
      gap: 8px;
      pointer-events: auto;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .act-btn {
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(10px);
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      padding: 8px 14px;
      font-size: 12.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      font-family: inherit;
    }
    .act-btn:hover {
      background: rgba(30, 41, 59, 0.95);
      border-color: rgba(56, 189, 248, 0.5);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    @media (max-width: 640px) {
      .bottom-hud { flex-direction: column; align-items: stretch; gap: 10px; }
      .dialogue-card { max-width: 100%; min-width: unset; }
      .actions-bar { justify-content: flex-start; }
    }
  </style>
</head>
<body>

<div id="stage">
  <!-- 顶部控制条 -->
  <div class="top-bar">
    <div class="top-left">
      <div class="top-title">
        <span class="dot"></span>
        <span>织梦行云 · 小肥鱼的居室</span>
      </div>
      <button class="ctrl-btn" id="btn-lamp" onclick="toggleLamp()">
        <span>✦</span><span id="lamp-text">开灯</span>
      </button>
    </div>

    <div class="top-controls">
      <button class="ctrl-btn" data-period="dawn" onclick="setPeriod('dawn')">清晨</button>
      <button class="ctrl-btn" data-period="noon" onclick="setPeriod('noon')">中午</button>
      <button class="ctrl-btn" data-period="afternoon" onclick="setPeriod('afternoon')">下午</button>
      <button class="ctrl-btn" data-period="night" onclick="setPeriod('night')">晚间</button>
      <button class="ctrl-btn active" id="btn-auto" onclick="toggleAutoTime()">自动跟随</button>
      <button class="ctrl-btn" data-weather="clear" onclick="setWeather('clear')">晴天</button>
      <button class="ctrl-btn" data-weather="rain" onclick="setWeather('rain')">雨天</button>
      <button class="ctrl-btn" data-weather="snow" onclick="setWeather('snow')">雪天</button>
      <button class="ctrl-btn" id="btn-calib" onclick="toggleCalib()">标注</button>
      <a class="ctrl-btn" href="/monitor" target="_blank" style="text-decoration:none;">旁观</a>
    </div>
  </div>

  <!-- SVG 场景层 (1536 x 1024) -->
  <svg viewBox="0 0 1536 1024" id="svg">
    <defs>
      <linearGradient id="sunG" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#fff2db" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#ffdcac" stop-opacity="0"/>
      </linearGradient>
      <radialGradient id="lampG">
        <stop offset="0%" stop-color="#ffe6a3" stop-opacity="0.88"/>
        <stop offset="50%" stop-color="#ffd56b" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#ffc93c" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- ① 2.5D 等距卧室底图 -->
    <g class="base">
      <image href="/room_assets/sample-room.png" width="1536" height="1024" preserveAspectRatio="none"/>
    </g>

    <!-- ② 天色氛围与丁达尔光线层 -->
    <rect class="color-cast" width="1536" height="1024"/>
    <path class="sunbeam" d="M1180 370 L1360 450 L910 1024 L690 1024 Z" fill="url(#sunG)"/>

    <!-- ③ 台灯发光柔光层 -->
    <circle id="lamp-light" cx="1270" cy="515" r="240" fill="url(#lampG)" style="opacity: 0; mix-blend-mode: screen; transition: opacity 1.5s; pointer-events: none;" />
    <circle id="lamp-light-bed" cx="440" cy="480" r="160" fill="url(#lampG)" style="opacity: 0; mix-blend-mode: screen; transition: opacity 1.5s; pointer-events: none;" />

    <!-- ④ 天气粒子层 -->
    <g class="rain" id="rain" style="opacity: 0; pointer-events: none;"></g>
    <g class="snow" id="snow" style="opacity: 0; pointer-events: none;"></g>

    <!-- ⑤ 交互热区槽位 -->
    <g id="hz-layer"></g>

    <rect class="color-cast" width="1536" height="1024" style="opacity:.05; pointer-events: none;"/>
  </svg>

  <!-- 悬浮 Tooltip -->
  <div class="hint" id="hint"></div>

  <!-- 抽屉详情弹窗 -->
  <div class="drawer" id="drawer">
    <span class="close-btn" id="drawer-close" onclick="closeDrawer()">×</span>
    <h4 id="d-title">物品详情</h4>
    <div class="sub" id="d-sub">点击热区获取</div>
    <div class="kv-list" id="d-body"></div>
    <div class="extra-box" id="d-extra" style="display:none;"></div>
  </div>

  <!-- 底部 HUD 对话卡片与动作栏 -->
  <div class="bottom-hud">
    <div class="dialogue-card">
      <div class="bubble-header">
        <div class="avatar-mini">✦</div>
        <div class="char-name">小肥鱼</div>
        <div class="status-tag" id="hud-status">在床上悠闲躺平看手机</div>
      </div>
      <div class="bubble-text" id="hud-message">正在继续干活呢，别打扰我~</div>
    </div>

    <div class="actions-bar">
      <button class="act-btn" onclick="triggerAction('bed')">躺平看手机</button>
      <button class="act-btn" onclick="triggerAction('douyin')">去电脑前刷抖音</button>
      <button class="act-btn" onclick="triggerAction('sit')">坐在床沿发呆</button>
      <button class="act-btn" onclick="triggerAction('sleep')">闭眼入睡</button>
    </div>
  </div>
</div>

<script>
/* ───────────────────────── 1. 时间与光影 ───────────────────────── */
const periods = [
  { id: 'dawn',      label: '清晨', hour: 6,  sky: ['#9fb6d8', '#e6d9c8'], ambient: '#b9c9e6', brightness: 0.92, sun: 0.35 },
  { id: 'noon',      label: '中午', hour: 12, sky: ['#8fc4ee', '#dff0fb'], ambient: '#ffffff', brightness: 1.00, sun: 0.12 },
  { id: 'afternoon', label: '下午', hour: 16, sky: ['#a9c6e8', '#ffd8ae'], ambient: '#ffe0c0', brightness: 0.96, sun: 0.55 },
  { id: 'night',     label: '晚间', hour: 20, sky: ['#1b2a4d', '#3d4d78'], ambient: '#2a3760', brightness: 0.70, sun: 0 },
];

const weathers = {
  clear: { label: '晴天', brightness: 1.00 },
  rain:  { label: '雨天', brightness: 0.92 },
  snow:  { label: '雪天', brightness: 0.95 },
};

let isAuto = true;
let manualPeriod = null;
let curWeather = 'clear';
let isLampOn = false;

const lerp = (a, b, t) => a + (b - a) * t;
const mixHex = (a, b, t) => {
  const p = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(lerp(v, B[i], t)).toString(16).padStart(2, '0')).join('');
};

function resolve(hour) {
  const list = periods.map(p => ({ ...p })).sort((x, y) => x.hour - y.hour);
  const ext = [...list, { ...list[0], hour: list[0].hour + 24 }];
  for (let i = 0; i < ext.length - 1; i++) {
    const a = ext[i], b = ext[i + 1];
    const h = hour < a.hour ? hour + 24 : hour;
    if (h >= a.hour && h <= b.hour) {
      const t = b.hour === a.hour ? 0 : (h - a.hour) / (b.hour - a.hour);
      return {
        id: t < 0.5 ? a.id : b.id,
        ambient: mixHex(a.ambient, b.ambient, t),
        brightness: lerp(a.brightness, b.brightness, t),
        sun: lerp(a.sun, b.sun, t),
      };
    }
  }
  return list[0];
}

const stage = document.getElementById('stage');

function renderEnvironment(hour) {
  const s = resolve(hour);
  const w = weathers[curWeather] || weathers.clear;
  const lampDim = (!isLampOn && s.brightness < 0.85) ? 0.86 : 1.0;
  const finalBrightness = (s.brightness * w.brightness * lampDim).toFixed(3);

  stage.style.setProperty('--brightness', finalBrightness);
  stage.style.setProperty('--ambient', s.ambient);
  stage.style.setProperty('--sun', (s.sun * 0.65).toFixed(2));

  document.getElementById('rain').style.opacity = curWeather === 'rain' ? '1' : '0';
  document.getElementById('snow').style.opacity = curWeather === 'snow' ? '1' : '0';
}

function toggleLamp() {
  isLampOn = !isLampOn;
  const op = isLampOn ? '0.85' : '0';
  document.getElementById('lamp-light').style.opacity = op;
  document.getElementById('lamp-light-bed').style.opacity = op;
  document.getElementById('lamp-text').textContent = isLampOn ? '关灯' : '开灯';
  document.getElementById('btn-lamp').classList.toggle('active', isLampOn);
  refreshEnv();
}

function setPeriod(id) {
  isAuto = false;
  manualPeriod = id;
  document.getElementById('btn-auto').classList.remove('active');
  document.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('active', b.dataset.period === id));
  const p = periods.find(x => x.id === id);
  if (p) renderEnvironment(p.hour);
}

function toggleAutoTime() {
  isAuto = true;
  manualPeriod = null;
  document.getElementById('btn-auto').classList.add('active');
  document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
  refreshEnv();
}

function setWeather(w) {
  curWeather = w;
  document.querySelectorAll('[data-weather]').forEach(b => b.classList.toggle('active', b.dataset.weather === w));
  refreshEnv();
}

function refreshEnv() {
  if (isAuto) {
    const d = new Date();
    renderEnvironment(d.getHours() + d.getMinutes() / 60);
  } else if (manualPeriod) {
    const p = periods.find(x => x.id === manualPeriod);
    if (p) renderEnvironment(p.hour);
  }
}

/* ───────────────────────── 2. 天气粒子动画 ───────────────────────── */
function initParticles() {
  const rain = document.getElementById('rain');
  const snow = document.getElementById('snow');
  const NS = 'http://www.w3.org/2000/svg';

  for (let i = 0; i < 90; i++) {
    const l = document.createElementNS(NS, 'line');
    const x = 960 + Math.random() * 260, y = 350 + Math.random() * 320;
    l.setAttribute('x1', x); l.setAttribute('y1', y);
    l.setAttribute('x2', x - 6); l.setAttribute('y2', y + 16);
    l.setAttribute('stroke', '#dbe8f4'); l.setAttribute('stroke-width', '1');
    l.setAttribute('opacity', '0.65');
    rain.appendChild(l);
  }
  for (let i = 0; i < 70; i++) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', 960 + Math.random() * 260);
    c.setAttribute('cy', 350 + Math.random() * 320);
    c.setAttribute('r', (1.2 + Math.random() * 1.8).toFixed(1));
    c.setAttribute('fill', '#eef4fc');
    c.setAttribute('opacity', '0.85');
    snow.appendChild(c);
  }

  let tick = 0;
  setInterval(() => {
    tick += 1;
    [...rain.children].forEach((l, i) => {
      const tx = (Math.sin((tick + i) * 0.2) * 2).toFixed(1);
      const ty = (tick * 7 + i * 3) % 45;
      l.setAttribute('transform', 'translate(' + tx + ', ' + ty + ')');
    });
    [...snow.children].forEach((c, i) => {
      const tx = (Math.sin((tick + i) * 0.25) * 6).toFixed(1);
      const ty = (tick * 1.4 + i * 2) % 55;
      c.setAttribute('transform', 'translate(' + tx + ', ' + ty + ')');
    });
  }, 60);
}

/* ───────────────────────── 3. 热区与抽屉 ───────────────────────── */
const DEFAULT_SLOTS = [
  { id: 'bed',    label: '床铺 · 休息区',   rect: [240, 430, 520, 370] },
  { id: 'desk',   label: '书桌电脑 · 摸鱼区', rect: [960, 400, 340, 360] },
  { id: 'shelf',  label: '书架 · 生活日记', rect: [555, 140, 210, 320] },
  { id: 'rug',    label: '鲸鱼地毯 · 休闲角', rect: [740, 680, 260, 200] },
  { id: 'window', label: '落地全景窗 · 天色', rect: [980, 160, 320, 240] },
];

let slots = JSON.parse(localStorage.getItem('room-hotspots') || 'null') || DEFAULT_SLOTS;
const hzLayer = document.getElementById('hz-layer');
const hint = document.getElementById('hint');
const drawer = document.getElementById('drawer');

function drawSlots() {
  hzLayer.innerHTML = '';
  slots.forEach((s) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', s.rect[0]); r.setAttribute('y', s.rect[1]);
    r.setAttribute('width', s.rect[2]); r.setAttribute('height', s.rect[3]);
    r.setAttribute('class', 'hz');
    r.dataset.id = s.id;

    r.addEventListener('mousemove', (e) => {
      hint.textContent = s.label;
      hint.style.left = (e.clientX + 14) + 'px';
      hint.style.top = (e.clientY + 12) + 'px';
      hint.style.opacity = '1';
    });
    r.addEventListener('mouseleave', () => { hint.style.opacity = '0'; });
    r.addEventListener('click', (e) => {
      if (!stage.classList.contains('calib')) openDrawer(s, e);
    });
    hzLayer.appendChild(r);
  });
}

async function openDrawer(s, e) {
  document.getElementById('d-title').textContent = s.label;
  document.getElementById('d-sub').textContent = '正在获取居室动态……';
  document.getElementById('d-body').innerHTML = '<div style="color:#64748b;font-size:12px;">加载中...</div>';
  document.getElementById('d-extra').style.display = 'none';
  drawer.style.display = 'block';

  // 智能靠窗/靠边定位
  const box = stage.getBoundingClientRect();
  const clickX = e ? e.clientX : box.left + box.width / 2;
  const isLeftHalf = clickX < (box.left + box.width / 2);
  drawer.style.left = isLeftHalf ? (box.width - 350) + 'px' : '20px';
  drawer.style.top = '70px';

  try {
    const res = await fetch('/api/room/inspect?slot=' + s.id);
    const data = await res.json();
    document.getElementById('d-title').textContent = data.title || s.label;
    document.getElementById('d-sub').textContent = data.sub || '';
    if (Array.isArray(data.lines) && data.lines.length > 0) {
      document.getElementById('d-body').innerHTML = data.lines
        .map(([k, v]) => '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>').join('');
    } else {
      document.getElementById('d-body').innerHTML = '<div style="color:#94a3b8;font-size:13px;">暂无相关信息</div>';
    }

    if (data.extraHtml) {
      const extra = document.getElementById('d-extra');
      extra.innerHTML = data.extraHtml;
      extra.style.display = 'block';
    }
  } catch (err) {
    document.getElementById('d-sub').textContent = '连接异常';
    document.getElementById('d-body').innerHTML = '<div style="color:#f43f5e;font-size:12px;">' + err.message + '</div>';
  }
}

function closeDrawer() {
  drawer.style.display = 'none';
}

/* ───────────────────────── 4. 标注模式 ───────────────────────── */
function toggleCalib() {
  const on = stage.classList.toggle('calib');
  const btn = document.getElementById('btn-calib');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '💾 保存标注' : '📐 标注';
  if (on) {
    enableDrag();
  } else {
    localStorage.setItem('room-hotspots', JSON.stringify(slots));
  }
}

function enableDrag() {
  const svg = document.getElementById('svg');
  [...hzLayer.children].forEach((r, idx) => {
    r.onmousedown = (down) => {
      if (!stage.classList.contains('calib')) return;
      const s = slots[idx];
      const start = [down.clientX, down.clientY];
      const orig = [...s.rect];
      const scale = svg.getBoundingClientRect().width / 1536;

      const move = (mv) => {
        s.rect = [
          Math.round(orig[0] + (mv.clientX - start[0]) / scale),
          Math.round(orig[1] + (mv.clientY - start[1]) / scale),
          orig[2],
          orig[3],
        ];
        r.setAttribute('x', s.rect[0]);
        r.setAttribute('y', s.rect[1]);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        localStorage.setItem('room-hotspots', JSON.stringify(slots));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
  });
}

/* ───────────────────────── 5. 实时 SSE 与动作触发 ───────────────────────── */
function initSSE() {
  const evt = new EventSource('/events');
  evt.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      applyRoomState(data);
    } catch {}
  };
}

function applyRoomState(data) {
  if (data.action) document.getElementById('hud-status').textContent = data.action;
  if (data.message) document.getElementById('hud-message').textContent = data.message;
}

function triggerAction(action) {
  fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  }).then(r => r.json()).then(applyRoomState).catch(console.error);
}

/* ───────────────────────── 6. 启动初始化 ───────────────────────── */
initParticles();
drawSlots();
refreshEnv();
initSSE();
setInterval(refreshEnv, 60000);
</script>
</body>
</html>
`;

/**
 * 只读浏览器实况监视器 HTML
 */
const MONITOR_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>小鱼浏览器实况监视器 [只读旁观]</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px;
    }
    .header {
      width: 100%;
      max-width: 1280px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .back-btn {
      color: #94a3b8;
      text-decoration: none;
      font-size: 14px;
      background: #1e293b;
      padding: 6px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.1);
      transition: all 0.2s;
    }
    .back-btn:hover { color: #fff; background: #334155; }
    .title-box { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 16px; }
    .rec-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: blink 1.2s infinite; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
    .badge { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 3px 10px; border-radius: 12px; font-size: 12px; }
    .screen-container {
      position: relative;
      width: 100%;
      max-width: 1280px;
      aspect-ratio: 16/9;
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #334155;
      box-shadow: 0 12px 40px rgba(0,0,0,0.8);
      display: flex;
      justify-content: center;
      align-items: center;
    }
    #screenImg {
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .watermark {
      position: absolute;
      top: 14px;
      right: 16px;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(4px);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      color: #94a3b8;
      letter-spacing: 0.5px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .footer {
      width: 100%;
      max-width: 1280px;
      margin-top: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="back-btn">← 返回小肥鱼居室</a>
    <div class="title-box">
      <div class="rec-dot"></div>
      <span>小鱼浏览器屏幕实况</span>
      <span id="pageBadge" class="badge">检测中...</span>
    </div>
    <div style="font-size: 13px; color: #94a3b8;" id="statusText">帧率: 1 fps (只读旁观)</div>
  </div>

  <div class="screen-container">
    <img id="screenImg" src="/api/browser/screen.jpg" alt="小鱼电脑屏幕">
    <div class="watermark">🔒 只读旁观模式 · 无法干预操作</div>
  </div>

  <div class="footer">
    <div>🛡️ 严格只读保护已开启：本观察窗口不接收任何鼠标或按键交互，纯粹旁观小鱼的自主上网。</div>
    <div id="timeText">刷新时间: --:--:--</div>
  </div>

  <script>
    const img = document.getElementById('screenImg');
    const badge = document.getElementById('pageBadge');
    const timeText = document.getElementById('timeText');

    function refreshFrame() {
      const now = new Date();
      timeText.innerText = '刷新时间: ' + now.toTimeString().split(' ')[0];
      
      const nextImg = new Image();
      nextImg.onload = function() {
        img.src = nextImg.src;
      };
      nextImg.src = '/api/browser/screen.jpg?t=' + Date.now();

      fetch('/api/browser/status').then(r => r.json()).then(data => {
        if (data.isLive) {
          badge.innerText = '🟢 [活动中] ' + (data.title || data.platform);
          badge.style.color = '#34d399';
          badge.style.borderColor = 'rgba(52, 211, 153, 0.4)';
          badge.style.background = 'rgba(52, 211, 153, 0.15)';
        } else {
          badge.innerText = '⚪ 电脑待机休眠中';
          badge.style.color = '#94a3b8';
          badge.style.borderColor = 'rgba(148, 163, 184, 0.3)';
          badge.style.background = 'rgba(148, 163, 184, 0.1)';
        }
      }).catch(()=>{});
    }

    setInterval(refreshFrame, 1200);
    refreshFrame();
  </script>
</body>
</html>
`;

export function startVirtualRoomServer({ douyinLiving = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 1. 静态主页 (2.5D 等距房间)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_TEMPLATE);
      return;
    }

    // 1.1 只读屏幕监视器页面
    if (url.pathname === '/monitor' || url.pathname === '/browser') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MONITOR_HTML_TEMPLATE);
      return;
    }

    // 1.15 抖音扫码登录专用页面
    if (url.pathname === '/login' || url.pathname === '/qrcode') {
      const loginHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>抖音扫码与安全验证 - 小鱼</title>
  <style>
    body { background: #0b0f19; color: #f8fafc; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #1e293b; padding: 24px; border-radius: 16px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 420px; width: 100%; border: 1px solid #334155; }
    h2 { margin: 0 0 10px; font-size: 20px; color: #38bdf8; }
    .qr-box { background: #fff; padding: 12px; border-radius: 12px; display: inline-block; margin: 12px 0; min-width: 220px; min-height: 220px; box-sizing: border-box; }
    #qrImg { max-width: 260px; max-height: 260px; width: 220px; height: 220px; display: block; object-fit: contain; }
    #statusText { font-size: 14px; color: #94a3b8; margin: 10px 0; line-height: 1.5; min-height: 40px; }
    #smsSection { display: none; margin-top: 15px; }
    .sms-input { padding: 10px 14px; font-size: 18px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; width: 160px; text-align: center; letter-spacing: 4px; outline: none; }
    .sms-btn { padding: 10px 20px; font-size: 15px; border-radius: 8px; border: none; background: #f43f5e; color: #fff; font-weight: 600; cursor: pointer; margin-left: 8px; }
    .sms-btn:hover { background: #e11d48; }
    .refresh-btn { margin-top: 10px; background: transparent; border: 1px solid #475569; color: #94a3b8; padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .refresh-btn:hover { background: #334155; color: #f8fafc; }
    .tip { font-size: 12px; color: #64748b; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📱 抖音登录与安全验证</h2>
    <div style="font-size: 13px; color: #cbd5e1;">打开抖音 App ➔ 左上角 ➔ 扫一扫</div>
    <div class="qr-box">
      <img id="qrImg" src="/api/douyin/qr.png" alt="登录二维码">
    </div>
    <div>
      <button class="refresh-btn" onclick="forceRefresh()">🔄 刷新二维码图片</button>
    </div>
    <div id="statusText">正在同步会话...</div>

    <div id="smsSection">
      <input type="text" id="smsCode" class="sms-input" maxlength="6" placeholder="验证码" autocomplete="one-time-code">
      <button class="sms-btn" onclick="submitSms()">提交</button>
    </div>

    <div class="tip">🔒 会话保持常驻中，自动防失效与二次验证联动</div>
  </div>
  <script>
    const qrImg = document.getElementById('qrImg');
    const statusText = document.getElementById('statusText');
    const smsSection = document.getElementById('smsSection');
    const smsCode = document.getElementById('smsCode');

    function forceRefresh() {
      statusText.innerText = '正在向后台请求生成新鲜二维码，请稍候...';
      fetch('/api/douyin/refresh', { method: 'POST' }).catch(()=>{});
      setTimeout(() => {
        fetch('/api/douyin/status').then(r => r.json()).then(data => {
          applyData(data);
        });
      }, 4000);
    }

    function applyData(data) {
      if (data.msg) statusText.innerText = data.msg;
      if (data.qrBase64) {
        qrImg.src = 'data:image/png;base64,' + data.qrBase64;
      }
      if (data.status === 'need_sms') {
        smsSection.style.display = 'block';
        statusText.style.color = '#f59e0b';
      } else if (data.status === 'success') {
        smsSection.style.display = 'none';
        statusText.style.color = '#34d399';
        statusText.innerText = '🎉 登录成功！Cookie 已永久保存。';
      }
    }

    function poll() {
      fetch('/api/douyin/status').then(r => r.json()).then(data => {
        applyData(data);
      }).catch(()=>{});
    }

    setInterval(poll, 3000);
    poll();

    function submitSms() {
      const code = smsCode.value.trim();
      if (!code) return;
      fetch('/api/douyin/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      }).then(r => r.json()).then(res => {
        statusText.innerText = '正在提交验证码: ' + code + ' ...';
      });
    }
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginHtml);
      return;
    }

    // 1.155 接收 SMS 提交 API
    if (url.pathname === '/api/douyin/sms' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { code } = JSON.parse(body);
          if (code) {
            fs.writeFileSync('/tmp/douyin_sms_code.txt', String(code).trim());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, code }));
            return;
          }
        } catch {}
        res.writeHead(400);
        res.end('Bad Request');
      });
      return;
    }

    // 1.1555 触发刷新二维码 API
    if (url.pathname === '/api/douyin/refresh') {
      try {
        fs.writeFileSync('/tmp/douyin_refresh_trigger.txt', '1');
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: 'Refresh signal dispatched' }));
      return;
    }

    // 1.156 直接获取二维码图片接口
    if (url.pathname === '/api/douyin/qr.png') {
      const qrPath = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/douyin_qr_live.png';
      if (fs.existsSync(qrPath)) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        fs.createReadStream(qrPath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('QR Not Ready');
      return;
    }

    // 1.16 抖音登录状态接口（直接内嵌 Base64）
    if (url.pathname === '/api/douyin/status') {
      let statusData = { status: 'waiting', msg: '等待扫码中...' };
      try {
        if (fs.existsSync('/tmp/douyin_qr_status.json')) {
          statusData = JSON.parse(fs.readFileSync('/tmp/douyin_qr_status.json', 'utf8'));
        }
        const qrPath = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/douyin_qr_live.png';
        if (fs.existsSync(qrPath)) {
          statusData.qrBase64 = fs.readFileSync(qrPath).toString('base64');
        }
      } catch {}
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify(statusData));
      return;
    }

    // 1.2 家具热区抽屉数据接口 /api/room/inspect?slot=...
    if (url.pathname === '/api/room/inspect') {
      const slot = url.searchParams.get('slot') || 'bed';
      let data = { title: '居室物品', sub: '', lines: [], extraHtml: '' };

      if (slot === 'bed') {
        data = {
          title: '床铺 · 小鱼休息区',
          sub: '蓬松云朵大白床 · 蓝色小鲸鱼抱枕',
          lines: [
            ['当前姿态', curState.action || '在床上悠闲躺平看手机'],
            ['实时思绪', curState.message || '正在干活呢~'],
            ['手持设备', curState.recentInput === 'phone' ? '手机 (QQ 聊天中)' : '无设备'],
            ['最近变动', new Date(curState.updatedAt).toLocaleTimeString('zh-CN')],
          ],
          extraHtml: `
            <div style="display:flex;gap:8px;">
              <button onclick="triggerAction('bed')" style="flex:1;padding:7px;background:#0284c7;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">躺平看手机</button>
              <button onclick="triggerAction('sleep')" style="flex:1;padding:7px;background:#475569;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">闭眼入睡</button>
            </div>
          `
        };
      } else if (slot === 'desk') {
        const obs = getObserverStatus();
        const dy = getDouyinLivingStatus();
        data = {
          title: '书桌电脑 · 摸鱼工作区',
          sub: '全景靠窗双屏 · 人体工学转椅',
          lines: [
            ['电脑状态', obs.isActive ? '活动中: ' + obs.platform.toUpperCase() : '桌面待机中'],
            ['当前操作', curState.state === 'desk_laptop' ? curState.action : '已离开工位'],
            ['最近刷到', dy.lastVideo ? (dy.lastVideo.title?.slice(0, 22) + '...') : '《3.5w人看过的小鲸鱼房间已开源》'],
            ['小鱼吐槽', dy.summary ? (dy.summary?.slice(0, 25) + '...') : '等距插画加个时钟就算房间了……'],
          ],
          extraHtml: `
            <div style="display:flex;flex-direction:column;gap:8px;">
              <a href="/monitor" target="_blank" style="display:block;text-align:center;padding:7px;background:#0284c7;color:#fff;border-radius:6px;text-decoration:none;font-size:12.5px;font-weight:500;">打开独立实况监视器</a>
              <button onclick="triggerAction('douyin')" style="padding:7px;background:#e11d48;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12.5px;font-weight:500;">立即看一条抖音</button>
            </div>
          `
        };
      } else if (slot === 'shelf') {
        const diaries = getRecentDiaries(4);
        const lines = diaries.map(d => {
          const timeStr = d.t ? new Date(d.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : (d.at ? d.at.slice(11, 16) : '刚才');
          const title = d.title || d.activity || d.category || '生活随笔';
          const thought = d.thought || d.mood || d.details || '';
          return [`[${timeStr}] ${title}`, thought.slice(0, 28) + (thought.length > 28 ? '...' : '')];
        });

        data = {
          title: '原木书架 · 生活日记账',
          sub: '记录小鱼日常摸鱼、看视频与发呆的心声',
          lines: lines.length > 0 ? lines : [['暂无日记', '今天还没记录摸鱼日记哦']],
        };
      } else if (slot === 'rug') {
        data = {
          title: '鲸鱼地毯 · 休闲陪伴角',
          sub: '中心水波圆毯与巨型大肥鱼毛绒公仔',
          lines: [
            ['毛绒公仔', '巨型深蓝大鲸鱼 (小鱼最喜欢趴在上面发呆)'],
            ['陪伴羁绊', '老爸与养女 · 亲密度 99.9%'],
            ['互动提示', '老爸在 QQ 群里拍一拍小鱼头像，她会立刻被唤醒哦~'],
          ],
          extraHtml: `
            <div style="display:flex;gap:8px;">
              <button onclick="triggerAction('sit')" style="flex:1;padding:7px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">坐在床沿发呆</button>
            </div>
          `
        };
      } else if (slot === 'window') {
        const d = new Date();
        const hour = d.getHours();
        const periodName = hour < 6 ? '深夜' : hour < 11 ? '清晨' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚间';
        data = {
          title: '全景落地窗 · 天气透视',
          sub: '窗外自然流转的蓝天白云与晨昏夕照',
          lines: [
            ['当前时间', d.toLocaleTimeString('zh-CN')],
            ['时段光影', periodName],
            ['动态光照', '已跟随真实系统时间自动平滑线性渐变'],
            ['天气切换', '支持在顶部控制栏手动开启雨天、雪天'],
          ]
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    // 1.3 浏览器只读屏幕抓取接口
    if (url.pathname === '/api/browser/screen.jpg') {
      const { buffer } = await getLatestScreenBuffer();
      if (buffer) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(buffer);
      } else {
        res.writeHead(404);
        res.end('No Screen Available');
      }
      return;
    }

    // 1.4 浏览器只读状态查询
    if (url.pathname === '/api/browser/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getObserverStatus()));
      return;
    }

    // 1.5 静态图片与资源
    if (url.pathname.startsWith('/room_assets/')) {
      const filename = path.basename(url.pathname);
      const filePath = path.join(ASSETS_DIR, filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
        const cacheControl = filename.includes('live') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // 2. SSE 实时事件流
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(curState)}\n\n`);
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 3. 状态查询 API
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(curState));
      return;
    }

    // 4. 交互动作 API
    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let action = '';
        try {
          const json = JSON.parse(body);
          action = json.action;
        } catch {}

        if (action === 'douyin') {
          if (douyinLiving) {
            douyinLiving.browseDouyinLive({ isOwner: true }).catch(console.error);
          } else {
            setRoomState('desk_laptop', {
              action: '在电脑前刷抖音',
              message: '收到！正在刷抖音呢~',
              recentInput: 'douyin',
            });
          }
        } else if (action === 'desk' || action === 'laptop') {
          setRoomState('desk_laptop', {
            action: '在电脑前认真工作',
            message: '正在电脑前认真处理事情呢~',
            recentInput: 'desk',
          });
        } else if (action === 'sit') {
          setRoomState('bed_sit', {
            action: '坐在床沿呆萌发呆',
            message: '坐在床上看看周围，找点好玩的~',
            recentInput: 'sit',
          });
        } else if (action === 'bed') {
          setRoomState('bed_phone', {
            action: '回床上悠闲躺平看手机',
            message: '瘫在床上的感觉真好，玩会儿手机~',
            recentInput: 'bed',
          });
        } else if (action === 'sleep') {
          setRoomState('bed_sleep', {
            action: '夜深了，躺平入睡',
            message: '有点困了，闭上眼睛睡大觉，晚安……',
            recentInput: 'sleep',
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(curState));
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[VirtualRoom] 大肥鱼 2.5D 等距居室已启动: http://0.0.0.0:${PORT}/ (局域网访问: http://192.168.31.130:${PORT}/)`);
  });

  return {
    setState: setRoomState,
    getState: getRoomState,
  };
}

export default {
  startVirtualRoomServer,
  setRoomState,
  getRoomState,
};
