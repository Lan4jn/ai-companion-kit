/**
 * 小鱼/大肥鱼 虚拟居室（Virtual Room Web App）
 *
 * 运行在 0.0.0.0:18888 上的高颜值 2.5D 卧室场景：
 * 1. 完美复刻抖音视频中的日系二次元 Lo-Fi 深夜卧室场景（床铺、冷月光、暖黄书桌台灯、发光笔记本、鱼尾巴爬椅子）。
 * 2. 状态机联动：
 *    - bed_phone: 躺在床上玩手机（手机屏幕光打在脸部与床单上）
 *    - bed_sleep: 躺在床上放空或入睡
 *    - crawling: 从床上滑下、扑腾爬向电脑椅
 *    - desk_laptop: 坐在转椅上面对发光笔记本电脑查资料、刷抖音
 *    - bed_sit: 坐在床沿呆萌看镜头
 * 3. 支持实时 SSE（Server-Sent Events）推送，QQ 说话或刷视频时网页无需刷新毫秒级同步变身！
 * 4. 底部还原视频中的 HUD 状态卡片（通讯已连接、动作标签、输入日志、大肥鱼对话气泡）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getLatestScreenBuffer, getObserverStatus } from './browser-observer.js';

const PORT = 18888;
const ASSETS_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets';

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
    // 如果是从床到电脑，先插播一轮爬椅子的过渡动画
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
      }, 2500);
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

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>欢迎光临大肥鱼的家 - Virtual Room</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background: #070b14;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      overflow: hidden;
      height: 100vh;
      width: 100vw;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }

    #stage {
      position: relative;
      width: 100vw;
      height: 100vh;
      max-width: 177.78vh; /* 16:9 ratio */
      max-height: 56.25vw;
      background: #000;
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,0.8);
    }

    .room-layer {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background-size: cover;
      background-position: center;
      transition: opacity 0.8s ease-in-out;
      opacity: 0;
    }
    .room-layer.active { opacity: 1; }

    /* 顶部信息条 */
    .top-bar {
      position: absolute;
      top: 16px;
      left: 20px;
      right: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 20;
      pointer-events: none;
    }
    .top-title {
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(8px);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.5px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #10b981;
      box-shadow: 0 0 8px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* 底部控制与气泡 HUD */
    .hud-container {
      position: absolute;
      bottom: 20px;
      left: 20px;
      right: 20px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      z-index: 30;
      gap: 16px;
    }

    .dialogue-card {
      background: rgba(13, 19, 33, 0.82);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      padding: 16px 20px;
      max-width: 540px;
      min-width: 320px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      position: relative;
    }
    .bubble-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .avatar-mini {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #3b82f6;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      box-shadow: 0 2px 8px rgba(59, 130, 246, 0.4);
    }
    .char-name {
      font-size: 14px;
      font-weight: 700;
      color: #93c5fd;
    }
    .status-badge {
      font-size: 11px;
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid rgba(96, 165, 250, 0.3);
    }
    .bubble-text {
      font-size: 15px;
      line-height: 1.5;
      color: #f1f5f9;
      min-height: 24px;
    }

    /* 右下角互动控制按钮组 */
    .actions-panel {
      display: flex;
      gap: 10px;
      background: rgba(15, 23, 42, 0.7);
      backdrop-filter: blur(10px);
      padding: 8px 12px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .act-btn {
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #cbd5e1;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .act-btn:hover {
      background: #3b82f6;
      color: #fff;
      border-color: #60a5fa;
      transform: translateY(-2px);
    }
    .act-btn:active { transform: translateY(0); }
  </style>
</head>
<body>
  <div id="stage">
    <div id="layer-bed_phone" class="room-layer active" style="background-image: url('/room_assets/bed_phone.jpg');"></div>
    <div id="layer-bed_sleep" class="room-layer" style="background-image: url('/room_assets/bed_sleep.jpg');"></div>
    <div id="layer-bed_sit" class="room-layer" style="background-image: url('/room_assets/bed_sit.jpg');"></div>
    <div id="layer-crawling" class="room-layer" style="background-image: url('/room_assets/crawling.jpg');"></div>
    <div id="layer-desk_laptop" class="room-layer" style="background-image: url('/room_assets/desk_laptop.jpg');"></div>

    <div class="top-bar">
      <div class="top-title">
        <div class="dot"></div>
        <span>大肥鱼的虚拟居室 · 实时在线</span>
      </div>
      <div class="top-title" id="actionTag">
        <span>当前状态: 在床上悠闲躺平看手机</span>
      </div>
    </div>

    <div class="hud-container">
      <div class="dialogue-card">
        <div class="bubble-header">
          <div class="avatar-mini">🐳</div>
          <span class="char-name">大肥鱼 / 小鱼</span>
          <span class="status-badge" id="badgeTag">通讯已连接</span>
          <span class="status-badge" id="inputTag" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border-color: rgba(52, 211, 153, 0.3);">输入: phone</span>
        </div>
        <div class="bubble-text" id="bubbleText">
          正在继续干活呢，别打扰我~
        </div>
      </div>

      <div class="actions-panel">
        <a href="/monitor" target="_blank" class="act-btn" style="text-decoration:none; background:#1e293b; color:#38bdf8; border-color:#0284c7;">🖥️ 观察小鱼屏幕 (只读)</a>
        <button class="act-btn" onclick="triggerAction('douyin')">📱 去电脑前刷抖音</button>
        <button class="act-btn" onclick="triggerAction('bed')">🛏️ 回床上躺平</button>
        <button class="act-btn" onclick="triggerAction('sleep')">🌙 关灯睡觉</button>
      </div>
    </div>
  </div>

  <script>
    let currentState = 'bed_phone';

    function updateView(data) {
      if (!data) return;
      const { state, action, message, recentInput } = data;

      if (state && state !== currentState) {
        document.querySelectorAll('.room-layer').forEach(el => el.classList.remove('active'));
        const target = document.getElementById('layer-' + state);
        if (target) {
          target.classList.add('active');
          currentState = state;
        }
      }

      if (action) {
        document.getElementById('actionTag').innerHTML = '<span>当前状态: ' + action + '</span>';
      }
      if (message) {
        document.getElementById('bubbleText').innerText = message;
      }
      if (recentInput) {
        document.getElementById('inputTag').innerText = '输入: ' + recentInput;
      }
    }

    // 建立实时 SSE 通信通道
    const evtSource = new EventSource('/events');
    evtSource.onmessage = function(e) {
      try {
        const data = JSON.parse(e.data);
        updateView(data);
      } catch (err) {}
    };

    // 页面初次加载拉取一次状态
    fetch('/api/status').then(r => r.json()).then(updateView).catch(()=>{});

    function triggerAction(type) {
      fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: type })
      }).then(r => r.json()).then(updateView);
    }
  </script>
</body>
</html>
`;

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
      pointer-events: none; /* 严格只读！禁止任何拖拽与点击 */
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
    <a href="/" class="back-btn">← 返回大肥鱼居室</a>
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

    // 每 1.2 秒自动拉取一帧
    setInterval(refreshFrame, 1200);
    refreshFrame();
  </script>
</body>
</html>
`;

export function startVirtualRoomServer({ douyinLiving = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 1. 静态主页
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

    // 1.2 浏览器只读屏幕抓取接口
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

    // 1.3 浏览器只读状态查询
    if (url.pathname === '/api/browser/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getObserverStatus()));
      return;
    }

    // 2. 静态图片资源
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

    // 3. SSE 实时事件流
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

    // 4. 状态查询 API
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(curState));
      return;
    }

    // 5. 交互动作 API
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
    console.log(`[VirtualRoom] 大肥鱼虚拟居室已启动: http://0.0.0.0:${PORT}/ (局域网访问: http://192.168.31.130:${PORT}/)`);
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
