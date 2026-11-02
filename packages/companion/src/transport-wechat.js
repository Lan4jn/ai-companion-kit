/**
 * 传输层 · WeChatFerry (微信小号) 适配器
 * ─────────────────────────────────────────────────────────────
 * 支持：
 *   - 微信私聊、群聊消息双向互通
 *   - 接收文字、图片、拍一拍通知
 *   - 发送文字、图片
 */

import http from 'node:http';

export class WeChatTransport {
  constructor(opts = {}) {
    this.apiUrl = opts.apiUrl || 'http://127.0.0.1:8000';
    this.callbackPort = opts.callbackPort || 9386;
    this.selfWxid = '';
    this.onMessage = opts.onMessage || null;
    this.server = null;
  }

  async start() {
    // 1. 启动本地 Webhook 回调监听服务，接收来自 wechatferry 的消息推送
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, msg: 'ok' }));

          try {
            const parsed = JSON.parse(body);
            this.#handleWebhook(parsed);
          } catch (e) {
            console.error('[wechat] 解析回调数据失败:', e.message);
          }
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WeChatTransport Callback Service is running.');
      }
    });

    this.server.listen(this.callbackPort, '0.0.0.0', () => {
      console.log(`[wechat] Webhook 回调服务已监听在 0.0.0.0:${this.callbackPort}`);
    });

    // 2. 轮询等待登录状态并获取自身 wxid
    this.#checkLoginPeriodically();
  }

  async #checkLoginPeriodically() {
    const check = async () => {
      try {
        const res = await fetch(`${this.apiUrl}/api/GetSelfWXID`, {
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.code === 1 && data.data?.wx_id) {
            this.selfWxid = data.data.wx_id;
            console.log(`[wechat] 微信小号已成功登录！自身 WxID: ${this.selfWxid}`);
            // 设置回调地址
            await fetch(`${this.apiUrl}/api/SetMessageCallbackUrl`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_url: `http://192.168.31.130:${this.callbackPort}/wechat/callback` })
            }).catch(() => {});
            return true;
          }
        }
      } catch {}
      return false;
    };

    const logged = await check();
    if (!logged) {
      const timer = setInterval(async () => {
        if (await check()) clearInterval(timer);
      }, 5000);
    }
  }

  #handleWebhook(payload) {
    const data = payload.data || payload;
    if (!data) return;

    // 过滤自己发送的消息
    if (data.is_self) return;
    if (this.selfWxid && data.wx_id === this.selfWxid) return;

    const isGroup = Boolean(data.is_group);
    const roomId = data.room_id || '';
    const senderWxid = data.wx_id || '';
    const content = String(data.content || '').trim();
    const type = Number(data.type || 1); // 1 文本, 3 图片

    // 拍一拍通知检测
    const isPoke = content.includes('拍了拍') || type === 10000;
    const key = isGroup ? `wx:group:${roomId}` : `wx:private:${senderWxid}`;

    const msg = {
      key,
      isGroup,
      groupId: isGroup ? roomId : '',
      userId: senderWxid,
      name: data.sign || senderWxid,
      text: content,
      images: [],
      raw: data,
      isAtMe: content.includes('@小鱼') || content.includes('@小肥鱼'),
      isPoke,
      replyTo: null,
      messageId: String(data.message_id || Date.now()),
      time: data.ts ? data.ts * 1000 : Date.now(),
    };

    if (this.onMessage) {
      this.onMessage(msg);
    }
  }

  async send(key, text) {
    const isGroup = key.startsWith('wx:group:') || key.startsWith('group:');
    const targetId = key.replace(/^(?:wx:)?(?:group|private):/, '');

    try {
      const res = await fetch(`${this.apiUrl}/api/SendTxt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiver: targetId,
          msg: text,
          aters: ''
        }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      return { ok: data.code === 1, error: data.message };
    } catch (e) {
      console.error('[wechat] 发送文本失败:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async sendImage(key, filePathOrUrl) {
    const targetId = key.replace(/^(?:wx:)?(?:group|private):/, '');
    try {
      const res = await fetch(`${this.apiUrl}/api/SendIMG`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiver: targetId,
          path: filePathOrUrl
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json();
      return { ok: data.code === 1, error: data.message };
    } catch (e) {
      console.error('[wechat] 发送图片失败:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async sendVoice(key, voiceB64) {
    // 微信暂走文本降级，避免非官方语音编码导致封号
    return { ok: false, error: 'voice fallback' };
  }

  async setTyping() {
    return { ok: true };
  }
}

export default WeChatTransport;
