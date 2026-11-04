// 小鱼 ↔ 开发者通道
//
// 两条路，互不干扰：
//   1) 陪聊：talk_to_hermes  —— 同步 POST 到本机 Hermes（8642），拿到回复再返回
//      她自己想聊的时候用，几分钟的等待是正常的（真人也不会秒回）
//   2) 需求：request_feature —— 只写 data/dev-requests.jsonl，
//      老爸在 18080/dev 页面审批，通过了才触发开发
//
// 设计原则：她能提需求，但不能让需求直接生效。审批权在老爸手上。
import fs from 'node:fs';
import path from 'node:path';

let cfg = null;

export function initDevChannel(o = {}) {
  cfg = {
    dataDir: o.dataDir || './data',
    hermesUrl: o.hermesUrl || 'http://127.0.0.1:8642/message',
    apiKey: o.apiKey || '',
    timeoutMs: o.timeoutMs || 240000,
    sessionId: o.sessionId || 'xiaoyu-chat',
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

function reqFile() { return path.join(cfg.dataDir, 'dev-requests.jsonl'); }
function chatFile() { return path.join(cfg.dataDir, 'dev-chat.jsonl'); }

function readJsonl(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* 跳过脏行 */ }
    }
  } catch { /* 文件不存在 */ }
  return out;
}

function appendJsonl(file, rec) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
}

// ── 陪聊 ──────────────────────────────────────────────
export async function talkToHermes({ text } = {}) {
  if (!cfg) return { status: 'error', message: '开发者通道没接上' };
  const t = String(text || '').trim().slice(0, 1500);
  if (!t) return { status: 'error', message: '说点什么' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  const startedAt = Date.now();
  try {
    const r = await fetch(cfg.hermesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ message: t, session_id: cfg.sessionId, platform: 'api_server' }),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    const reply = String(j.reply || j.message || j.response || '').trim();
    if (!reply) {
      appendJsonl(chatFile(), { at: startedAt, ms: Date.now() - startedAt, me: t, reply: '', err: 'HTTP ' + r.status });
      return { status: 'error', message: '他没回话（HTTP ' + r.status + '）' };
    }
    appendJsonl(chatFile(), { at: startedAt, ms: Date.now() - startedAt, me: t, reply: reply.slice(0, 4000) });
    return { status: 'ok', reply: reply.slice(0, 2000) };
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    appendJsonl(chatFile(), { at: startedAt, ms: Date.now() - startedAt, me: t, reply: '', err: timedOut ? 'timeout' : e.message });
    return {
      status: 'error',
      message: timedOut ? '他还在忙，等了' + Math.round(cfg.timeoutMs / 1000) + '秒都没回，晚点再找他吧' : ('连不上他：' + e.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 需求 ──────────────────────────────────────────────
export function requestFeature({ title, detail, why = '' } = {}) {
  if (!cfg) return { status: 'error', message: '开发者通道没接上' };
  const t = String(title || '').trim().slice(0, 80);
  const d = String(detail || '').trim().slice(0, 1200);
  if (!t || !d) return { status: 'error', message: '标题和说明都得写，不然老爸看不懂你想要什么' };

  const rec = {
    id: 'r' + Date.now().toString(36),
    at: Date.now(),
    title: t,
    detail: d,
    why: String(why || '').trim().slice(0, 300),
    status: 'pending',
  };
  appendJsonl(reqFile(), rec);
  return { status: 'ok', message: `需求递上去了（${rec.id}），等老爸审批通过之后才能动工` };
}

export function listRequests({ status, limit = 50 } = {}) {
  if (!cfg) return [];
  const merged = new Map();
  for (const rec of readJsonl(reqFile())) {
    if (!rec.id) continue;
    const prev = merged.get(rec.id);
    if (!prev) merged.set(rec.id, { ...rec });
    else merged.set(rec.id, { ...prev, ...rec, title: rec.title || prev.title, detail: rec.detail || prev.detail });
  }
  let list = [...merged.values()];
  if (status) list = list.filter((r) => r.status === status);
  return list.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

export function reviewRequest({ id, action, note = '' } = {}) {
  if (!cfg) return { status: 'error', message: 'no cfg' };
  const target = listRequests().find((r) => r.id === id);
  if (!target) return { status: 'error', message: '没有这条需求' };
  const act = String(action || '').toLowerCase();
  if (!['approve', 'reject', 'done'].includes(act)) return { status: 'error', message: 'action 只能是 approve/reject/done' };
  const status = act === 'approve' ? 'approved' : act === 'reject' ? 'rejected' : 'done';
  appendJsonl(reqFile(), { id, at: Date.now(), status, note: String(note || '').slice(0, 300) });
  return { status: 'ok', id, newStatus: status };
}

export function listChat({ limit = 30 } = {}) {
  if (!cfg) return [];
  return readJsonl(chatFile()).slice(-limit).reverse();
}

export function devChannelReady() {
  return !!cfg;
}

// ── 审批通过 → 叫醒开发者（异步，不阻塞页面）──────────────
export async function triggerDev(id) {
  console.log('[dev] triggerDev 开始：' + id + '，cfg=' + (cfg ? 'ok' : 'null'));
  if (!cfg) return { status: 'error', message: 'no cfg' };
  const req = listRequests().find((r) => r.id === id);
  if (!req) { console.warn('[dev] 找不到需求 ' + id); return { status: 'error', message: '没有这条需求' }; }
  console.log('[dev] 准备通知开发者：' + req.title);
  const text = [
    '【小鱼的需求，老爸已批准】',
    '编号：' + req.id,
    '标题：' + req.title,
    '详情：' + req.detail,
    '理由：' + (req.why || '（未写）'),
    '请实现，改完之后把这条需求的状态标成 done。',
  ].join('\n');
  try {
    const r = await fetch(cfg.hermesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ message: text, session_id: 'xiaoyu-dev', platform: 'api_server' }),
      signal: AbortSignal.timeout(600000),
    });
    console.log('[dev] 已通知开发者处理 ' + id + ' (HTTP ' + r.status + ')');
    return { status: 'ok' };
  } catch (e) {
    console.warn('[dev] 通知开发者失败 ' + id + '：' + e.message);
    return { status: 'error', message: e.message };
  }
}

export function markDone(id) {
  return reviewRequest({ id, action: 'done' });
}

// ── 审批页面（挂在 18888，和小鱼监视页同一个服务）──────────
export const DEV_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>小鱼的需求箱</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#0f1115;color:#e6e6e6;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 4px}.sub{color:#888;font-size:13px;margin:0 0 20px}
a.back{color:#5a8fd8;font-size:13px;text-decoration:none}
.card{background:#181b22;border:1px solid #262b36;border-radius:12px;padding:16px;margin-bottom:12px}
.t{font-weight:600;margin-bottom:6px}.d{color:#c8ccd4;white-space:pre-wrap;margin-bottom:8px}
.w{color:#7d8590;font-size:13px;margin-bottom:10px}.meta{color:#5c6370;font-size:12px}
.btn{border:0;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;margin-right:8px}
.ok{background:#1f6f43;color:#fff}.no{background:#3a2a2a;color:#d99}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#232833;color:#9aa4b2;margin-left:8px}
.pending{border-color:#2d4a35}.chat{background:#14171d;border:1px solid #222732;border-radius:12px;padding:14px;margin-top:20px}
.chat .me{color:#7fb1ff}.chat .him{color:#9ee6b0}.chat div{margin-bottom:10px;white-space:pre-wrap}
h2{font-size:15px;color:#9aa4b2;margin:24px 0 10px}
</style></head><body>
<h1>小鱼的需求箱</h1>
<p class="sub">她提的需求先到这儿，你同意之后才会动工 · <a class="back" href="/">回房间</a> · <a class="back" href="/monitor">看屏幕</a></p>
<div id="list">加载中…</div>
<div class="chat"><h2 style="margin-top:0">她最近找开发者说的话</h2><div id="chat">—</div></div>
<script>
const S={pending:'待审批',approved:'已批准',rejected:'已驳回',done:'已完成'};
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
async function load(){
  var j=await (await fetch('/dev/list')).json();
  var list=document.getElementById('list');
  if(!j.requests.length){list.innerHTML='<p class="sub">还没有需求。</p>';}
  else{
    list.innerHTML=j.requests.map(function(r){
      var cls=r.status==='pending'?'card pending':'card';
      var btns=r.status==='pending'
        ? '<button class="btn ok" onclick="act(\''+r.id+'\',\'approve\')">批准</button><button class="btn no" onclick="act(\''+r.id+'\',\'reject\')">驳回</button>'
        : '';
      return '<div class="'+cls+'"><div class="t">'+esc(r.title)+'<span class="tag">'+(S[r.status]||r.status)+'</span></div>'
        + '<div class="d">'+esc(r.detail)+'</div>'
        + (r.why?'<div class="w">为什么：'+esc(r.why)+'</div>':'')
        + '<div class="meta">'+new Date(r.at).toLocaleString('zh-CN')+' · '+r.id+'</div>'
        + '<div style="margin-top:10px">'+btns+'</div></div>';
    }).join('');
  }
  var c=document.getElementById('chat');
  if(!j.chat.length){c.innerHTML='<div class="sub">还没聊过。</div>';}
  else{
    c.innerHTML=j.chat.map(function(x){
      return '<div><span class="me">小鱼：</span>'+esc(x.me)+'</div>'
        + (x.reply?'<div><span class="him">开发者：</span>'+esc(x.reply)+'</div>':'<div class="meta">（'+esc(x.err||'没回')+'）</div>');
    }).join('');
  }
}
async function act(id,action){
  if(action==='approve'&&!confirm('批准后开发者会开始改小鱼，确定？'))return;
  await fetch('/dev/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,action:action})});
  load();
}
load();setInterval(load,15000);
</script></body></html>`;
