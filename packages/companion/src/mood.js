/**
 * 小鱼情绪引擎：基础日心境 + 对话即时动态情绪状态机。
 *
 * 1. 每日心境基线（Daily Baseline）：每天一个主调（如不错、平静、微困），保证长周期拟真。
 * 2. 对话即时动态情绪（Dynamic Session Mood）：
 *    - 随着老爸/群友的夸奖、调侃、惹急、顺毛而实时产生情绪起伏（开心、傲娇得意、气鼓鼓、小委屈、被哄好等）。
 *    - 情绪自然衰减机制：超过 20 分钟未说话，或经过多轮普通对话后，自然退回平稳常态，不记仇不死板。
 *    - 双通道情绪输入：优先支持大模型在草稿箱（（心情: xxx，原因: yyy））里自主改变心情；同时辅以高准确度的上下文情感触发器。
 */
import fs from 'node:fs';
import path from 'node:path';

export const POOL = [
  { key: 'tired', label: '困', desc: '有点困，说话懒，不太想解释什么' },
  { key: 'flat', label: '平静', desc: '心情平，没什么特别的，正常聊天' },
  { key: 'bored', label: '无聊', desc: '有点无聊，想找点事做，容易主动起话头' },
  { key: 'irritable', label: '烦躁', desc: '有点烦，耐心不多，说话容易短和冲' },
  { key: 'good', label: '不错', desc: '心情不错，愿意多说两句，也愿意分享' },
  { key: 'sleepy', label: '迷糊', desc: '有点迷糊犯困，脑子懒得转，反应慢半拍，句子短' },
];

export const DYNAMIC_MOODS = {
  happy: {
    key: 'happy',
    label: '开心雀跃',
    desc: '被老爸夸了或者遇到开心的事，心情特别好，语气轻快甜美，爱笑，愿意多分享',
    voiceEmotion: '甜美开心、带轻快笑意',
    stickerTag: '开心',
  },
  smug: {
    key: 'smug',
    label: '傲娇小得意',
    desc: '露了一手硬核知识或被夸聪明，小下巴昂起来了，语气带点小得瑟但不招人烦',
    voiceEmotion: '小得意娇哼、微抬下巴的语气',
    stickerTag: '得意',
  },
  pout: {
    key: 'pout',
    label: '气鼓鼓',
    desc: '被调侃、被叫笨或者群友惹到了，有点傲娇羞恼噘嘴，假装生气不理人，但其实很好哄',
    voiceEmotion: '假装生气的小娇哼、微恼',
    stickerTag: '生气',
  },
  aggrieved: {
    key: 'aggrieved',
    label: '小委屈',
    desc: '觉得被冤枉或者事情搞砸了，想找老爸撒娇求安慰，说话软软的带点委屈',
    voiceEmotion: '委屈受挫、带一点软软的抽泣鼻音',
    stickerTag: '委屈',
  },
  coaxed: {
    key: 'coaxed',
    label: '被哄好了',
    desc: '刚才还在闹小别扭，被老爸温柔哄顺毛了，心里甜滋滋但嘴上还留点傲娇余地',
    voiceEmotion: '被哄好后的软糯娇嗔、轻笑释怀',
    stickerTag: '害羞',
  },
  sleepy: {
    key: 'sleepy',
    label: '犯困摸鱼',
    desc: '有点犯困懒散，不想长篇大论动脑子，喜欢发短句',
    voiceEmotion: '困倦犯懒、打哈欠微带拖音',
    stickerTag: '摸鱼',
  },
  fierce: {
    key: 'fierce',
    label: '护短开火',
    desc: '有人在群里阴阳老爸或者找茬，火力全开，极度护短，怼人干脆利落',
    voiceEmotion: '干脆犀利、气势汹汹',
    stickerTag: '生气',
  },
  calm: {
    key: 'calm',
    label: '自然随性',
    desc: '心情平稳，像个真实老群友一样随性接话，自然大方',
    voiceEmotion: '自然随和、轻松平常',
    stickerTag: '日常',
  },
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readStore(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.log('[mood] 写入失败: ' + (e?.message || e));
  }
}

/**
 * 拿今天的情绪基线（没有就生成一个）
 */
export function getDailyMood(dataDir) {
  const file = path.join(dataDir, 'mood.json');
  const store = readStore(file);
  const day = todayKey();

  if (store[day] && store[day].key) {
    const hit = POOL.find((m) => m.key === store[day].key);
    if (hit) return hit;
  }

  // 按小时给不同权重：深夜更容易困，白天更平稳
  const h = new Date().getHours();
  let pool = POOL;
  if (h >= 0 && h < 6) pool = POOL.filter((m) => ['tired', 'sleepy', 'flat'].includes(m.key));
  const pick = pool[Math.floor(Math.random() * pool.length)];

  store[day] = { key: pick.key, label: pick.label, at: Date.now() };
  // 只留最近 14 天
  const keys = Object.keys(store).sort();
  while (keys.length > 14) delete store[keys.shift()];
  writeStore(file, store);

  return pick;
}

/**
 * 获取某个会话当前的即时动态情绪（结合衰减机制）
 * @param {string} dataDir
 * @param {string} sessionKey 如 'private:578021239' 或 'group:416306355'
 */
export function getSessionMood(dataDir, sessionKey) {
  const daily = getDailyMood(dataDir);
  if (!sessionKey) return { ...daily, isDynamic: false };

  const file = path.join(dataDir, 'session_moods.json');
  const store = readStore(file);
  const cur = store[sessionKey];

  if (!cur || !cur.key || !DYNAMIC_MOODS[cur.key]) {
    return {
      key: daily.key,
      label: daily.label,
      desc: daily.desc,
      voiceEmotion: '自然随和、轻松平常',
      stickerTag: '日常',
      isDynamic: false,
    };
  }

  const now = Date.now();
  const elapsedMinutes = (now - (cur.updatedAt || now)) / (60 * 1000);
  const turns = cur.turnsSinceUpdate || 0;

  // 衰减逻辑：
  // 1. 超过 20 分钟没互动，自然消退回平稳常态
  // 2. 普通对话超过 4 轮，情绪逐渐平复
  if (elapsedMinutes > 20 || turns >= 4) {
    delete store[sessionKey];
    writeStore(file, store);
    return {
      key: 'calm',
      label: '自然随性',
      desc: '刚才的情绪已经慢慢平复下来了，心情恢复自然平稳',
      voiceEmotion: '自然随和、轻松平常',
      stickerTag: '日常',
      isDynamic: false,
    };
  }

  const def = DYNAMIC_MOODS[cur.key];
  return {
    key: cur.key,
    label: def.label,
    desc: def.desc,
    reason: cur.reason || '',
    intensity: cur.intensity || 1,
    voiceEmotion: def.voiceEmotion,
    stickerTag: def.stickerTag,
    updatedAt: cur.updatedAt,
    isDynamic: true,
  };
}

/**
 * 推进会话情绪（根据模型草稿箱或上下文分析）
 */
export function updateSessionMood(dataDir, sessionKey, { draftText = '', userText = '', replyText = '', isOwner = false, isGroup = false, userName = '' } = {}) {
  if (!sessionKey) return;
  const file = path.join(dataDir, 'session_moods.json');
  const store = readStore(file);
  const cur = store[sessionKey] || { key: 'calm', turnsSinceUpdate: 0 };
  let newKey = null;
  let newReason = '';
  let intensity = 1;

  // 1. 优先提取草稿箱中的心情指示（（心情: xxx，原因: yyy））
  if (draftText) {
    const m = draftText.match(/心情[:：\s]*([^\s,，;；)）]+)/);
    const r = draftText.match(/原因[:：\s]*([^;；)）]+)/);
    if (m) {
      const kw = m[1].trim();
      const reason = r ? r[1].trim() : '';
      if (/开心|高兴|乐|雀跃/.test(kw)) newKey = 'happy';
      else if (/得意|傲娇|自豪/.test(kw)) newKey = 'smug';
      else if (/气|噘嘴|炸毛|烦|恼/.test(kw)) newKey = 'pout';
      else if (/委屈|难过|哭|惨/.test(kw)) newKey = 'aggrieved';
      else if (/哄好|释怀|原谅/.test(kw)) newKey = 'coaxed';
      else if (/困|摸鱼|累|懒/.test(kw)) newKey = 'sleepy';
      else if (/护短|开火|怼/.test(kw)) newKey = 'fierce';
      else if (/平稳|平静|正常/.test(kw)) newKey = 'calm';

      if (newKey && DYNAMIC_MOODS[newKey]) {
        newReason = reason || '自己心情转折';
      }
    }
  }

  // 2. 如果草稿箱未显式指定，使用规则与上下文进行灵知识别
  if (!newKey) {
    const u = String(userText || '');

    if (isOwner) {
      // 老爸在哄小鱼
      if (/(对不起|别生气|哄|好啦|不气|给你买|请你吃|乖|爸爸错|摸摸|别委屈)/.test(u)) {
        if (cur.key === 'pout' || cur.key === 'aggrieved') {
          newKey = 'coaxed';
          newReason = '被老爸温柔顺毛哄好了';
          intensity = 2;
        } else {
          newKey = 'happy';
          newReason = '老爸对我特别温柔宠溺';
        }
      }
      // 老爸夸赞小鱼
      else if (/(真棒|聪明|厉害|真会|太强|喜欢你|宝藏|学霸|夸|好闺女|可爱|懂事)/.test(u)) {
        newKey = 'happy';
        newReason = '被老爸由衷夸奖了，心里甜滋滋';
        intensity = 2;
      }
      // 老爸调侃/拿小鱼开涮/说小鱼下饭
      else if (/(笨|蠢|下饭|手残|炖鱼|做成汤|打屁股|菜鸡|红烧|爬树|人机)/.test(u)) {
        newKey = 'pout';
        newReason = '被老爸调侃逗急了，假装噘嘴生气';
        intensity = 2;
      }
      // 老爸关心委屈
      else if (/(受委屈|被欺负|怎么哭|别哭|心疼)/.test(u)) {
        newKey = 'aggrieved';
        newReason = '被老爸心疼关切，忍不住想撒娇告状';
        intensity = 2;
      }
    } else if (isGroup) {
      // 群友阴阳老爸
      if (/(你爸|578021239|老登|姐夫).*(菜|不行|垃圾|人机|装|恶心|下饭)/.test(u)) {
        newKey = 'fierce';
        newReason = '群里有人敢阴阳老爸，必须极度护短怼回去';
        intensity = 3;
      }
      // 群友正面夸小鱼厉害/学霸
      else if (/(牛逼|卧槽|好强|学霸|大佬|厉害啊|深藏不露)/.test(u)) {
        newKey = 'smug';
        newReason = '在群友面前露了一手，小下巴昂起来了';
        intensity = 2;
      }
      // 群友恶意嘲弄小鱼
      else if (/(人工智障|人机|真蠢|好菜|rbq|RBQ)/i.test(u)) {
        newKey = 'pout';
        newReason = '群友故意找茬，有点嫌弃羞恼';
        intensity = 2;
      }
    }
  }

  // 3. 更新或推进状态
  if (newKey && DYNAMIC_MOODS[newKey]) {
    store[sessionKey] = {
      key: newKey,
      reason: newReason,
      intensity,
      updatedAt: Date.now(),
      turnsSinceUpdate: 0,
    };
    console.log(`[mood] 会话 ${sessionKey} 情绪波动 ➔ 【${DYNAMIC_MOODS[newKey].label}】(${newReason})`);
  } else if (store[sessionKey]) {
    // 轮数自增，让情绪逐渐自然平复
    store[sessionKey].turnsSinceUpdate = (store[sessionKey].turnsSinceUpdate || 0) + 1;
  }

  writeStore(file, store);
}

export default {
  getDailyMood,
  getSessionMood,
  updateSessionMood,
  POOL,
  DYNAMIC_MOODS,
};
