// 抖音登录门户：手机浏览器打开即可看实时二维码 + 输短信验证码 + 一键重开登录。
// 验证码只写入本机临时文件交给登录守护进程，服务端不打印、不回显、不记录内容。
import http from 'node:http';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const PORT = 18080;
const SMS_FILE = '/tmp/douyin_sms_code.txt';
const STATUS_FILE = '/tmp/douyin_qr_status.json';
const QR_FILE = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/public/room_assets/douyin_qr_live.png';
const COMP_DIR = '/root/ai-companion-xiaoyu/ai-companion-kit/packages/companion';

function readStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return s;
  } catch {
    return { status: 'unknown', msg: '' };
  }
}

function daemonRunning() {
  try {
    execSync('pgrep -f "node src/douyin-qr-daemon.js" > /dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

function startDaemon() {
  if (daemonRunning()) return false;
  try { fs.unlinkSync(SMS_FILE); } catch {}
  const child = spawn('node', ['src/douyin-qr-daemon.js'], {
    cwd: COMP_DIR,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return true;
}

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鱼 · 抖音登录</title>
<style>
 *{box-sizing:border-box}
 body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0b0b0d;color:#eee;margin:0;padding:20px;display:flex;justify-content:center}
 .card{background:#17171a;border-radius:18px;padding:22px 20px;width:min(94vw,380px);box-shadow:0 10px 40px rgba(0,0,0,.5)}
 h1{font-size:16px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
 h1 i{width:8px;height:8px;border-radius:50%;background:#666;display:inline-block}
 .sub{font-size:12.5px;color:#8b8b93;margin:0 0 16px;line-height:1.55}
 .dot-ok{background:#22c55e!important;box-shadow:0 0 8px #22c55e88}
 .dot-wait{background:#f59e0b!important;box-shadow:0 0 8px #f59e0b88}
 .dot-sms{background:#3b82f6!important;box-shadow:0 0 8px #3b82f688}
 .qrbox{background:#fff;border-radius:14px;padding:10px;text-align:center}
 .qrbox img{width:100%;display:block;border-radius:8px}
 .hint{font-size:12px;color:#8b8b93;text-align:center;margin:10px 0 0}
 .row{margin-top:16px;display:none}
 .row.show{display:block}
 input{width:100%;font-size:26px;letter-spacing:8px;text-align:center;padding:13px 10px;border-radius:12px;border:1px solid #2e2e33;background:#0b0b0d;color:#fff}
 input::placeholder{letter-spacing:2px;font-size:15px;color:#555}
 button{width:100%;margin-top:12px;padding:14px;font-size:16px;border:0;border-radius:12px;background:#fe2c55;color:#fff;font-weight:600}
 button.ghost{background:#26262b;color:#bbb;font-weight:500;font-size:14px;margin-top:14px}
 button:disabled{opacity:.5}
 .toast{margin-top:12px;font-size:13.5px;text-align:center;min-height:18px}
 .ok{color:#22c55e}.err{color:#ef4444}
 .foot{margin-top:14px;font-size:11px;color:#5a5a62;line-height:1.6;text-align:center}
</style></head><body>
<div class="card">
  <h1><i id="dot"></i><span id="title">正在连接…</span></h1>
  <p class="sub" id="msg">读取登录状态中</p>

  <div class="qrbox" id="qrbox"><img id="qr" alt="登录二维码" src="/qr.png?t=0"></div>
  <p class="hint" id="qrhint">用手机抖音 App 扫一扫</p>

  <div class="row" id="smsrow">
    <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="输入短信验证码">
    <button id="btn">提交验证码</button>
  </div>

  <button class="ghost" id="restart">重新生成二维码</button>
  <div class="toast" id="toast"></div>
  <div class="foot">验证码仅写入本机临时文件交给登录进程<br>不会出现在聊天、日志或页面上</div>
</div>
<script>
async function tick(){
  try{
    const s = await (await fetch('/status?t='+Date.now())).json();
    const st = s.status || 'unknown';
    document.getElementById('dot').className =
      st === 'success' ? 'dot-ok' : (st.indexOf('need_sms') === 0 ? 'dot-sms' : 'dot-wait');
    document.getElementById('title').textContent =
      st === 'success' ? '已登录' : (st.indexOf('need_sms') === 0 ? '等待验证码' : '等待扫码');
    document.getElementById('msg').textContent = s.msg || '';
    const needSms = st.indexOf('need_sms') === 0;
    document.getElementById('smsrow').classList.toggle('show', needSms);
    document.getElementById('qrbox').style.display = st === 'success' ? 'none' : 'block';
    document.getElementById('qrhint').style.display = needSms || st === 'success' ? 'none' : 'block';
    // 守护进程每 60 秒换一张新码，页面跟着无脑刷新，永远显示当前有效那张
    if (st === 'ready' || st === 'refreshing') {
      document.getElementById('qr').src = '/qr.png?t=' + Date.now();
    }
    document.getElementById('restart').style.display = st === 'success' ? 'block' : 'none';
  }catch(e){}
}
tick(); setInterval(tick, 3000);

document.getElementById('btn').onclick = async () => {
  const el = document.getElementById('code');
  const toast = document.getElementById('toast');
  const v = el.value.trim();
  if(!/^\\d{4,8}$/.test(v)){ toast.className='toast err'; toast.textContent='请输入 4~8 位数字验证码'; return; }
  const btn = document.getElementById('btn');
  btn.disabled = true;
  try{
    const r = await fetch('/code',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'code='+encodeURIComponent(v)});
    if(r.ok){ toast.className='toast ok'; toast.textContent='已提交，正在验证…'; el.value=''; }
    else { toast.className='toast err'; toast.textContent='提交失败，请重试'; }
  }catch(e){ toast.className='toast err'; toast.textContent='网络错误，请重试'; }
  btn.disabled = false;
};

document.getElementById('restart').onclick = async () => {
  const toast = document.getElementById('toast');
  toast.className='toast ok'; toast.textContent='正在重新生成…';
  try{
    const r = await fetch('/restart',{method:'POST'});
    const j = await r.json();
    toast.className = 'toast ok';
    toast.textContent = j.started ? '已启动，二维码马上出来' : '登录进程已在运行';
  }catch(e){ toast.className='toast err'; toast.textContent='启动失败'; }
};
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }

  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(readStatus()));
    return;
  }

  if (req.method === 'GET' && url === '/qr.png') {
    try {
      const buf = fs.readFileSync(QR_FILE);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end('no qr');
    }
    return;
  }

  if (req.method === 'POST' && url === '/restart') {
    const started = startDaemon();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ started }));
    return;
  }

  if (req.method === 'POST' && url === '/code') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      const m = /code=([0-9]{4,8})/.exec(body);
      if (!m) { res.writeHead(400); res.end('bad'); return; }
      try { fs.writeFileSync(SMS_FILE, m[1], 'utf8'); } catch { res.writeHead(500); res.end('write fail'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log('Douyin login portal on :' + PORT));
