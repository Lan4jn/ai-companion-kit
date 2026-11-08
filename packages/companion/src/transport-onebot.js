/**
 * 传输层 · OneBot v11 适配
 * ─────────────────────────────────────────────────────────────
 * 支持：
 *   - 普通文字、表情、图片（含多模态提取）
 *   - 合并转发聊天记录（多层嵌套套娃转发、content 节点数组、QQ Ark multimsg、resid 自动解析）
 *   - 引用回复消息自动追溯
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkOutput, cleanAllToolArtifacts } from './safety.js';

/** 从消息段里提取所有图片 URL / 本地文件路径（支持段对象与 CQ 码字符串） */
function extractImages(segs) {
  if (!Array.isArray(segs)) {
    if (typeof segs === 'string') {
      const urls = [];
      const urlMatches = segs.matchAll(/\[CQ:image,[^\]]*url=([^,\]]+)/g);
      for (const m of urlMatches) urls.push(m[1]);
      const fileMatches = segs.matchAll(/\[CQ:image,[^\]]*file=([^,\]]+)/g);
      for (const m of fileMatches) {
        if (!urls.includes(m[1])) urls.push(m[1]);
      }
      return urls;
    }
    return [];
  }
  const urls = [];
  for (const s of segs) {
    if (!s) continue;
    if (s.type === 'image') {
      const u = s.data?.url || s.data?.file;
      if (u) urls.push(String(u));
    } else if (s.type === 'mface') {
      const u = s.data?.url || s.data?.file;
      if (u) urls.push(String(u));
    } else if (s.type === 'forward') {
      const subNodes = s.data?.content || s.data?.messages;
      if (Array.isArray(subNodes)) {
        for (const sub of subNodes) {
          urls.push(...extractImages(sub.message || sub.content));
        }
      }
    }
  }
  return urls;
}

/** 把 OneBot 消息段数组拼成纯文本（递归支持嵌套转发） */
function segsToText(segs, depth = 0, selfId = '', nameCache = null) {
  if (!segs) return '';
  if (typeof segs === 'string') return segs.trim();
  if (!Array.isArray(segs)) return String(segs);

  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text':
        out.push(s.data?.text || '');
        break;
      case 'at': {
        const targetQq = String(s.data?.qq || '');
        if (targetQq === 'all') {
          out.push('[@全体成员]');
        } else if (selfId && targetQq === String(selfId)) {
          out.push('[@小鱼]');
        } else {
          const cachedName = nameCache ? nameCache.get(targetQq) : '';
          const name = s.data?.name || s.data?.text || cachedName || '';
          if (name) {
            out.push(`[@${name}]`);
          } else {
            out.push(`[@群友(QQ:${targetQq})]`);
          }
        }
        break;
      }
      case 'image': {
        const isSticker = Number(s.data?.sub_type ?? s.data?.subType ?? 0) === 1 ||
                          String(s.data?.file || '').toLowerCase().includes('.gif') ||
                          Boolean(s.data?.is_animated) ||
                          Number(s.data?.face_type ?? s.data?.faceType ?? 0) > 0;
        out.push(isSticker ? '[表情包]' : '[图片]');
        break;
      }
      case 'mface':
        out.push('[表情包]');
        break;
      case 'face':
        out.push('[表情]');
        break;
      case 'record':
        out.push('[语音消息]');
        break;
      case 'reply':
        break; // 引用单独异步解析
      case 'forward': {
        const subNodes = s.data?.content || s.data?.messages;
        if (Array.isArray(subNodes) && subNodes.length > 0 && depth < 3) {
          const innerLines = [];
          for (const item of subNodes.slice(0, 10)) {
            const who = item.sender?.card || item.sender?.nickname || item.sender?.user_id || '群友';
            const body = segsToText(item.message || item.content, depth + 1, selfId, nameCache) || item.raw_message || '[聊天记录]';
            innerLines.push(`${who}: ${body}`);
          }
          out.push(`[合并转发: ${innerLines.join(' | ')}]`);
        } else {
          out.push('[聊天记录]');
        }
        break;
      }
      case 'json': {
        try {
          const j = typeof s.data?.data === 'string' ? JSON.parse(s.data.data) : s.data?.data;
          if (j?.app === 'com.tencent.multimsg') {
            const news = j.meta?.detail?.news;
            if (Array.isArray(news) && news.length > 0) {
              const lines = news.map(n => n.text).filter(Boolean);
              out.push(`[聊天记录: ${lines.join(' | ')}]`);
              break;
            }
          }
          let title = '';
          let desc = '';
          let appSource = '';
          if (j?.meta?.detail_1) {
            title = j.meta.detail_1.title || '';
            desc = j.meta.detail_1.desc || '';
            appSource = j.meta.detail_1.show_name || j.desc || j.prompt || '小程序';
          } else if (j?.meta?.music) {
            title = j.meta.music.title || '';
            desc = j.meta.music.desc || '';
            appSource = j.meta.music.tag || '音乐';
          } else if (j?.meta?.news) {
            title = j.meta.news.title || '';
            desc = j.meta.news.desc || '';
            appSource = j.meta.news.tag || '分享';
          }
          if (!title) {
            title = j?.prompt || j?.desc || '卡片消息';
          }
          title = String(title).replace(/^\[(?:QQ小程序|分享)\]/, '').trim();
          appSource = String(appSource).replace(/[\[\]]/g, '').trim();
          const descPart = desc && desc !== title ? ` (${desc})` : '';
          out.push(`[群友分享了卡片/小程序: 《${title}》 - 来源:${appSource}${descPart}]`);
        } catch {
          out.push('[群友分享了卡片消息]');
        }
        break;
      }
      case 'xml': {
        try {
          const xml = String(s.data?.data || '');
          const titleMatch = xml.match(/<title[^>]*>([^<]+)<\/title>/);
          const summaryMatch = xml.match(/<summary[^>]*>([^<]+)<\/summary>/);
          const sourceMatch = xml.match(/<source[^>]*name="([^"]+)"/);
          const title = titleMatch ? titleMatch[1] : '卡片消息';
          const summary = summaryMatch ? summaryMatch[1] : '';
          const source = sourceMatch ? sourceMatch[1] : '分享';
          const descPart = summary && summary !== title ? ` (${summary})` : '';
          out.push(`[群友分享了卡片/小程序: 《${title}》 - 来源:${source}${descPart}]`);
        } catch {
          out.push('[群友分享了卡片消息]');
        }
        break;
      }
      default:
        if (s.data?.text) out.push(s.data.text);
        break;
    }
  }
  return out.join('').trim();
}

/** 从消息段里找引用 ID */
function findReply(segs) {
  if (!Array.isArray(segs)) return null;
  for (const s of segs) if (s?.type === 'reply') return String(s.data?.id || '');
  return null;
}

export class OneBot {
  constructor({ wsUrl, httpUrl, accessToken = '', onMessage, dataDir = './data' }) {
    this.wsUrl = wsUrl;
    this.httpUrl = (httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.onMessage = onMessage;
    this.dataDir = dataDir || './data';
    this.selfId = '';
    this.nameCache = new Map();
    this.groupMembers = new Map();   // groupId -> Map(qq -> { name, card, role })
    this.memberSyncedAt = new Map(); // groupId -> ms
    this.pendingFriendRequests = new Map(); // userId -> { flag, time, comment }
    this.myGroupCards = new Map(); // groupId -> card
    this.ws = null;
    this.connected = false;
    this.#connect();
  }

  /** 群成员表落盘路径 */
  #membersFile() {
    return path.join(this.dataDir, 'group-members.json');
  }

  /** 重启后把上次拉到的群成员读回内存，避免每条消息都打单查接口 */
  loadGroupMembers() {
    try {
      const file = this.#membersFile();
      if (!fs.existsSync(file)) return 0;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      let n = 0;
      for (const [gid, members] of Object.entries(raw.groups || {})) {
        const map = new Map();
        for (const m of members) {
          if (!m || !m.qq) continue;
          map.set(String(m.qq), { name: m.name || '', card: m.card || '', role: m.role || 'member' });
          n++;
        }
        this.groupMembers.set(String(gid), map);
      }
      return n;
    } catch (e) {
      console.warn('   [OneBot] 群成员表读取失败：' + e.message);
      return 0;
    }
  }

  /** 拉一次整群成员并落盘；同一群默认 6 小时内不重复拉 */
  async syncGroupMembers(groupId, { minIntervalMs = 6 * 3600 * 1000 } = {}) {
    const gid = String(groupId || '');
    if (!gid) return { ok: false, error: 'no groupId' };
    const last = this.memberSyncedAt.get(gid) || 0;
    if (Date.now() - last < minIntervalMs) {
      return { ok: true, skipped: true, count: (this.groupMembers.get(gid) || new Map()).size };
    }
    const res = await this.api('get_group_member_list', { group_id: Number(gid) });
    const list = res.ok ? (res.data?.data ?? res.data) : null;
    if (!Array.isArray(list)) return { ok: false, error: res.error || 'bad response' };
    const map = new Map();
    for (const m of list) {
      const qq = String(m?.user_id || '');
      if (!qq) continue;
      map.set(qq, { name: String(m.nickname || ''), card: String(m.card || ''), role: String(m.role || 'member') });
    }
    this.groupMembers.set(gid, map);
    this.memberSyncedAt.set(gid, Date.now());
    // 顺手预热 nameCache：之后 resolveName 不用再一个个打 API
    for (const [qq, info] of map) {
      const display = info.card || info.name;
      if (display && !this.nameCache.has(qq)) this.nameCache.set(qq, display);
    }
    this.#saveGroupMembers();
    return { ok: true, count: map.size };
  }

  #saveGroupMembers() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const groups = {};
      for (const [gid, map] of this.groupMembers) {
        groups[gid] = [...map].map(([qq, info]) => ({ qq, ...info }));
      }
      fs.writeFileSync(this.#membersFile(), JSON.stringify({ updatedAt: Date.now(), groups }, null, 1));
    } catch (e) {
      console.warn('   [OneBot] 群成员表写入失败：' + e.message);
    }
  }

  /** 只在本地群成员表里查名字，不发请求 */
  groupMemberName(qq, groupId) {
    const map = this.groupMembers.get(String(groupId || ''));
    if (!map) return '';
    const info = map.get(String(qq));
    return info ? (info.card || info.name) : '';
  }

  async resolveName(qq, groupId = '') {
    if (!qq || qq === 'all') return '';
    const sid = String(qq);
    if (this.nameCache.has(sid)) return this.nameCache.get(sid);
    const local = this.groupMemberName(sid, groupId);
    if (local) {
      this.nameCache.set(sid, local);
      return local;
    }
    if (groupId) {
      try {
        const res = await this.api('get_group_member_info', { group_id: Number(groupId), user_id: Number(qq) });
        const name = res.data?.card || res.data?.nickname;
        if (name) {
          this.nameCache.set(sid, String(name));
          return String(name);
        }
      } catch {}
    }
    try {
      const res = await this.api('get_stranger_info', { user_id: Number(qq) });
      const name = res.data?.nickname;
      if (name) {
        this.nameCache.set(sid, String(name));
        return String(name);
      }
    } catch {}
    return '';
  }

  async getMyGroupCard(groupId) {
    if (!groupId) return '';
    const gid = String(groupId);
    if (this.myGroupCards.has(gid)) return this.myGroupCards.get(gid);
    try {
      const res = await this.api('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(this.selfId || '1808531252'),
      });
      const card = res.data?.data?.card || res.data?.card || res.data?.data?.nickname || res.data?.nickname || '';
      if (card) {
        this.myGroupCards.set(gid, String(card));
        return String(card);
      }
    } catch {}
    return '';
  }

  #headers() {
    const h = {};
    if (this.accessToken) h.authorization = 'Bearer ' + this.accessToken;
    return h;
  }

  async #connect() {
    const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
    const sock = new WebSocket(this.wsUrl, { headers: this.#headers() });
    this.ws = sock;

    sock.on?.('open', async () => {
      this.connected = true;
      console.log('[onebot] 已连接 ' + this.wsUrl);
      try {
        const login = await this.api('get_login_info');
        if (login.ok && login.data?.data?.user_id) {
          this.selfId = String(login.data.data.user_id);
          console.log('[onebot] 自身账号 ID: ' + this.selfId);
        }
      } catch {}
    });
    sock.on?.('close', () => {
      this.connected = false;
      console.log('[onebot] 断开，5 秒后重连');
      setTimeout(() => this.#connect(), 5000);
    });
    sock.on?.('error', (e) => console.log('[onebot] 出错 ' + (e?.message || e)));
    sock.on?.('message', async (data) => {
      let ev;
      try { ev = JSON.parse(String(data)); } catch { return; }
      if (process.env.ONEBOT_DEBUG) console.log('[RAW] ' + String(data).slice(0, 300));
      try { await this.#handle(ev); } catch (e) { console.error('[handle 出错] ' + (e?.stack || e)); }
    });
  }

  /** 解析合并转发聊天记录，支持原生 content 节点、API 获取及 Ark JSON 回退 */
  async #resolveForwardMessages(segs) {
    if (!Array.isArray(segs)) return { text: '', images: [] };
    const forwardLines = [];
    const forwardImages = [];

    for (const s of segs) {
      if (!s) continue;

      // 1. 处理 forward 类型消息段
      if (s.type === 'forward') {
        let directNodes = s.data?.content || s.data?.messages;
        if (!directNodes || directNodes.length === 0) {
          const forwardId = s.data?.id || s.data?.message_id;
          if (forwardId) {
            try {
              const res = await this.api('get_forward_msg', { message_id: forwardId, id: String(forwardId) });
              directNodes = res.data?.data?.messages || res.data?.messages;
            } catch (e) {}
          }
        }

        if (Array.isArray(directNodes) && directNodes.length > 0) {
          for (const item of directNodes.slice(0, 30)) {
            const sender = item.sender?.card || item.sender?.nickname || item.sender?.user_id || '群友';
            let nodeText = segsToText(item.message || item.content, 0, this.selfId, this.nameCache);
            if (!nodeText) {
              nodeText = item.raw_message || item.preview || '[聊天记录]';
            }
            const nodeImgs = extractImages(item.message || item.content);
            forwardImages.push(...nodeImgs);
            forwardLines.push(`${sender}：${nodeText}`);
          }
        }
      }

      // 2. 处理 json (Ark com.tencent.multimsg) 类型的合并转发卡片
      if (s.type === 'json') {
        try {
          const j = typeof s.data?.data === 'string' ? JSON.parse(s.data.data) : s.data?.data;
          if (j?.app === 'com.tencent.multimsg') {
            const resid = j.meta?.detail?.resid;
            let fetched = false;
            if (resid) {
              try {
                const res = await this.api('get_forward_msg', { message_id: resid, id: String(resid) });
                const list = res.data?.data?.messages || res.data?.messages;
                if (Array.isArray(list) && list.length > 0) {
                  for (const item of list.slice(0, 30)) {
                    const sender = item.sender?.card || item.sender?.nickname || item.sender?.user_id || '群友';
                    let nodeText = segsToText(item.message || item.content, 0, this.selfId, this.nameCache);
                    if (!nodeText) {
                      nodeText = item.raw_message || item.preview || '[聊天记录]';
                    }
                    const nodeImgs = extractImages(item.message || item.content);
                    forwardImages.push(...nodeImgs);
                    forwardLines.push(`${sender}：${nodeText}`);
                  }
                  fetched = true;
                }
              } catch (e) {}
            }
            if (!fetched) {
              const news = j.meta?.detail?.news;
              if (Array.isArray(news) && news.length > 0) {
                for (const item of news) {
                  if (item?.text) forwardLines.push(item.text);
                }
              }
            }
          }
        } catch (e) {}
      }
    }

    if (forwardLines.length > 0) {
      let extraHint = '';
      if (forwardImages.length > 0) {
        extraHint = `\n（注：上面转发的聊天记录中包含 ${forwardImages.length} 张图片，已作为多模态视觉图像输入，请结合画面内容回答）`;
      }
      return {
        text: `\n【你收到了转发的聊天记录，共 ${forwardLines.length} 条】：\n` + forwardLines.join('\n') + extraHint,
        images: forwardImages
      };
    }
    return { text: '', images: [] };
  }

  async #handle(ev) {
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      return;
    }
    if (ev.self_id) this.selfId = String(ev.self_id);

    // 拍一拍/戳一戳通知事件处理 (post_type=notice, notice_type=notify, sub_type=poke)
    if (ev.post_type === 'notice') {
      const isPoke = (ev.notice_type === 'notify' && ev.sub_type === 'poke') || ev.notice_type === 'poke';
      const isTargetMe = String(ev.target_id || '') === this.selfId;
      if (isPoke && isTargetMe) {
        const isGroup = Boolean(ev.group_id);
        const senderName = await this.resolveName(ev.user_id, ev.group_id);
        const msg = {
          key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
          isGroup,
          groupId: isGroup ? String(ev.group_id) : '',
          userId: String(ev.user_id),
          name: senderName || String(ev.user_id),
          text: '[拍了拍你的头像]',
          images: [],
          raw: [],
          isAtMe: false,
          isAtOthers: false,
          isQuoteMe: false,
          isPoke: true,
          replyTo: null,
          messageId: String(ev.time || Date.now()),
          time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
        };
        console.log(`[onebot] 收到来自 ${senderName}(${ev.user_id}) 的拍一拍/戳一戳！`);
        this.onMessage?.(msg);
      }
      return;
    }

    // 好友申请事件处理 (post_type=request, request_type=friend)
    if (ev.post_type === 'request' && ev.request_type === 'friend') {
      const userId = String(ev.user_id || '');
      const comment = String(ev.comment || '');
      const flag = String(ev.flag || '');
      console.log(`[onebot] 收到好友申请: ${userId}, 验证: "${comment}"`);

      // 老爸（578021239）或验证消息带老爸暗号直接免审通过
      if (userId === '578021239' || comment.includes('我是老爸') || comment.includes('织梦行云')) {
        console.log(`[onebot] 符合免审条件，自动通过老爸/熟人好友申请: ${userId}`);
        await this.api('set_friend_add_request', { flag, approve: true });
        return;
      }

      // 策略B：暂存并在私聊向老爸报备（不主动唤醒大模型或发欢迎语）
      this.pendingFriendRequests.set(userId, { flag, time: Date.now(), comment });
      const reportMsg = `老爸，QQ【${userId}】申请加我好友啦~\n验证消息：“${comment || '（无验证消息）'}”\n如果要同意，私聊跟我说“同意 ${userId}”就可以啦`;
      await this.send('private:578021239', reportMsg);
      return;
    }

    if (ev.post_type !== 'message') return;

    // 拦截老爸私聊中的“同意/通过好友”指令
    if (ev.message_type === 'private' && String(ev.user_id) === '578021239') {
      const rawText = segsToText(ev.message, 0, this.selfId, this.nameCache).trim();
      const approveMatch = rawText.match(/^(?:同意|通过|同意好友|通过好友)(?:\s*(\d+))?$/);
      if (approveMatch) {
        let targetUid = approveMatch[1];
        if (!targetUid && this.pendingFriendRequests.size > 0) {
          targetUid = Array.from(this.pendingFriendRequests.keys()).pop();
        }
        if (targetUid && this.pendingFriendRequests.has(targetUid)) {
          const item = this.pendingFriendRequests.get(targetUid);
          const res = await this.api('set_friend_add_request', { flag: item.flag, approve: true });
          this.pendingFriendRequests.delete(targetUid);
          if (res.ok) {
            await this.send('private:578021239', `好嘞老爸，已经通过 ${targetUid} 的好友申请啦！`);
          } else {
            await this.send('private:578021239', `老爸，通过 ${targetUid} 好友申请失败了：${res.error || '未知错误'}`);
          }
          return;
        } else if (targetUid) {
          await this.send('private:578021239', `老爸，没找到 ${targetUid} 的待处理好友申请记录哦（可能已经过期或处理过了）`);
          return;
        }
      }
    }

    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const replyId = findReply(segs);

    const atMe = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) === this.selfId);
    // 这条消息是不是明确 @ 了别的某个人（用来判断"人家在跟别人说话"）
    const atOthers = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) !== this.selfId);
    // 这条消息是否明确 @ 了老爸 (578021239)
    const atOwner = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) === '578021239');

    // 缓存发送者昵称
    if (ev.user_id && (ev.sender?.card || ev.sender?.nickname)) {
      this.nameCache.set(String(ev.user_id), String(ev.sender.card || ev.sender.nickname));
    }

    // 预收集所有 at 目标并尝试预解析群友昵称，避免把裸 QQ 号当成艾特文本给大模型
    const atUids = new Set();
    const collectAts = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const s of arr) {
        if (!s) continue;
        if (s.type === 'at' && s.data?.qq && s.data.qq !== 'all' && String(s.data.qq) !== this.selfId) {
          atUids.add(String(s.data.qq));
        }
      }
    };
    collectAts(segs);

    let replyRef = null;
    if (replyId) {
      try {
        const replyRes = await this.api('get_msg', { message_id: replyId });
        if (replyRes.ok && replyRes.data?.data) {
          replyRef = replyRes.data.data;
          collectAts(replyRef.message);
        }
      } catch (e) {}
    }

    if (atUids.size > 0) {
      await Promise.all(Array.from(atUids).map((uid) => this.resolveName(uid, ev.group_id)));
    }

    let baseText = segsToText(segs, 0, this.selfId, this.nameCache);
    const images = extractImages(segs);
    let isQuoteMe = false;

    // 1. 如果有引用回复消息
    if (replyRef) {
      const refSender = replyRef.sender?.card || replyRef.sender?.nickname || replyRef.sender?.user_id || '对方';
      if (String(replyRef.sender?.user_id) === this.selfId) {
        isQuoteMe = true;
      }
      const refText = segsToText(replyRef.message, 0, this.selfId, this.nameCache);
      const refImages = extractImages(replyRef.message);
      images.push(...refImages);
      baseText = `【引用 ${refSender}：${refText}】\n${baseText}`.trim();
    }

    // 2. 解析合并转发聊天记录 (包括 content 节点、get_forward_msg、Ark news)
    const fwd = await this.#resolveForwardMessages(segs);
    if (fwd.text) {
      baseText = (baseText ? `${baseText}\n` : '') + fwd.text;
      images.push(...fwd.images);
      console.log(`[onebot] 成功解析并提取到转发聊天记录！文本长度: ${fwd.text.length}`);
    }

    let myGroupCard = '';
    if (isGroup && ev.group_id) {
      myGroupCard = await this.getMyGroupCard(ev.group_id);
    }

    const hasUserTypedText = Array.isArray(segs) && segs.some((s) => s?.type === 'text' && s.data?.text && String(s.data.text).trim().length > 0);
    const hasCardSeg = Array.isArray(segs) && segs.some((s) => s?.type === 'json' || s?.type === 'xml');
    const isPureShareCard = Boolean(hasCardSeg && !hasUserTypedText);

    const msg = {
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id),
      name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
      text: baseText,
      images,
      raw: segs,
      isAtMe: atMe,
      isAtOthers: atOthers,
      isAtOwner: atOwner,
      isQuoteMe,
      replyTo: replyId,
      myGroupCard,
      isPureShareCard,
      messageId: String(ev.message_id || ''),
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    };
    this.onMessage?.(msg);
  }

  async api(action, params = {}) {
    if (!this.httpUrl) return { ok: false, error: '没配 httpUrl' };
    try {
      const r = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers() },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok && j.status !== 'failed', data: j, error: j.message || j.wording };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  send(key, text, { atUserId } = {}) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    let message = String(text);

    // 终极清洗：彻底剥除任何 DSML 或模型内部工具语法
    message = cleanAllToolArtifacts(message);
    if (!message) {
      console.warn(`   [OneBot Guard] 消息被工具标签清洗器清空（避免泄漏内部工具语法）：阻止向 ${key} 发送`);
      return Promise.resolve({ ok: true, blocked: true, reason: 'CLEANED_EMPTY' });
    }

    // 终极安全防线：物理发包前校验，如果含敏感涉政/控评，坚决不向 QQ 发送！
    const safeCheck = checkOutput(message);
    if (!safeCheck.ok) {
      console.error(`   [OneBot Guard] 物理终极拦截：阻止向 ${key} 发送敏感内容！(${safeCheck.why}) -> "${message.slice(0, 50)}"`);
      return Promise.resolve({ ok: false, error: 'BLOCKED_BY_SAFETY_GUARD' });
    }

    if (atUserId) message = '[CQ:at,qq=' + atUserId + '] ' + message;
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  sendImage(key, file) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    // NapCat 跑在容器里，看不到宿主机的绝对路径——必须转 base64（跟 sendVoice 同一个坑）
    let ref = String(file || '');
    try {
      if (!ref.startsWith('base64://') && !ref.startsWith('http')) {
        const buf = fs.readFileSync(ref);
        ref = 'base64://' + buf.toString('base64');
      }
    } catch (e) {
      console.log('[onebot] 发图读不到文件：' + (e?.message || e) + ' → ' + file);
      return Promise.resolve(null);
    }
    const message = [{ type: 'image', data: { file: ref } }];
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  // 语音条：NapCat 只认 base64:// 或容器内路径，宿主机路径会被拒
  sendVoice(key, base64Mp3) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = [{ type: 'record', data: { file: 'base64://' + base64Mp3 } }];
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  async setTyping(key, on) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    return this.api('set_input_status', isGroup
      ? { group_id: id, event_type: on ? 1 : 0 }
      : { user_id: id, event_type: on ? 1 : 0 });
  }

  async whoSent(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    return r.ok ? String(r.data?.data?.user_id || '') : '';
  }
}

export { segsToText };
export default OneBot;
