import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lockPhoneForUserAction, unlockPhoneForUserAction, getPhoneLivingStatus } from './phone-living.js';
import { synthesize } from './tts.js';
import { pickSticker, readStickerBase64, markUsed, stickerStats, extractFromVideo, addSticker } from './stickers.js';
import { readGroupChat, enqueueGroupMessage } from './group-bridge.js';
import { talkToHermes, requestFeature } from './dev-channel.js';
import { generateImage, findImages, getImage, discardImage, markUsed as markImageUsed } from './image-gen.js';

const execFileAsync = promisify(execFile);

// ── 环境变量与全局配置 ──
let CURRENT_SERIAL = process.env.PHONE_SERIAL || '';
const MACRO_FILE = process.env.PHONE_MACRO_FILE || path.join(os.homedir(), '.phone-mcp', 'macros.json');
const SHOT_DIR = process.env.PHONE_SHOT_DIR || '/root/.hermes/cache/scratch/phone-shots';

try {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
} catch {}

/**
 * 自动寻找/解析当前活跃的 ADB 设备（优先 192.168.31.160:5557 模拟器/外部设备）
 */
export async function getAdbTarget() {
  if (CURRENT_SERIAL) return CURRENT_SERIAL;
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const lines = stdout.split(/\r?\n/).slice(1).filter(l => l.trim());
    const ready = lines.map(l => l.split(/\s+/)).filter(p => p[1] === 'device').map(p => p[0]);
    if (ready.includes('192.168.31.160:5557')) {
      CURRENT_SERIAL = '192.168.31.160:5557';
      return CURRENT_SERIAL;
    }
    if (ready.length > 0) {
      CURRENT_SERIAL = ready[0];
      return CURRENT_SERIAL;
    }
    // 没找到任何设备时，尝试自动连接 192.168.31.160:5557
    await execFileAsync('adb', ['connect', '192.168.31.160:5557']).catch(() => {});
  } catch {}
  return '192.168.31.160:5557';
}

/**
 * 执行 adb 基础命令
 */
async function adb(args, { timeout = 30000, serial = true } = {}) {
  const target = await getAdbTarget();
  const full = serial && target ? ['-s', target, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync('adb', full, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, out: String(stdout ?? ''), err: String(stderr ?? '') };
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) };
  }
}

/**
 * 执行 adb shell 命令
 */
async function shell(cmd, timeout = 30000) {
  const r = await adb(['shell', cmd], { timeout });
  if (!r.ok) throw new Error(`adb shell 失败：${r.err || r.out}`);
  return r.out;
}

/**
 * 高性能截屏并通过 ImageMagick 实时管道压制为轻量高质量 JPEG base64 (约 50KB~80KB)
 */
export async function captureScreenBase64() {
  const target = await getAdbTarget();
  return new Promise((resolve) => {
    try {
      const adbProc = spawn('adb', ['-s', target, 'exec-out', 'screencap', '-p']);
      const conv = spawn('convert', ['png:-', '-resize', '540x960', '-quality', '75', 'jpeg:-']);

      adbProc.stdout.pipe(conv.stdin);
      adbProc.on('error', () => { conv.kill(); resolve(null); });

      const chunks = [];
      conv.stdout.on('data', c => chunks.push(c));
      conv.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks).toString('base64'));
        } else {
          resolve(null);
        }
      });
      conv.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * 确保 ADBKeyboard 已就绪（用于中文广播输入）
 */
async function ensureIme() {
  try {
    const IME = 'com.android.adbkeyboard/.AdbIME';
    const cur = (await shell('settings get secure default_input_method')).trim();
    if (cur === IME) return true;
    await shell(`ime enable ${IME}`);
    await shell(`settings put secure enabled_input_methods "${IME}:${cur || 'com.android.inputmethod.pinyin/.InputService'}"`);
    await shell(`settings put secure default_input_method ${IME}`);
    await new Promise(r => setTimeout(r, 400));
    return true;
  } catch {
    return false;
  }
}

// ── 工具声明清单 (OpenAI 兼容格式) ──
export const PHONE_TOOLS = [
  // ── 1. 状态与连接管理（方便后续随时切到 160 虚拟机或外部设备）──
  {
    type: 'function',
    function: {
      name: 'phone_status',
      description: '查看当前手机/模拟器的 ADB 连接状态、设备列表与当前选中的设备。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_connect',
      description: '通过 IP 和端口连接指定的安卓设备或虚拟机（如连接局域网 192.168.31.160:5557）。',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '设备 IP 地址，例如 192.168.31.160' },
          port: { type: 'string', description: '端口号，默认 5555' }
        },
        required: ['host']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_devices',
      description: '列出所有已识别的安卓设备，并支持切换当前操作的目标设备。',
      parameters: {
        type: 'object',
        properties: {
          use: { type: 'string', description: '要切换到的目标设备序列号（例如 192.168.31.160:5557）' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_pair',
      description: '首次无线配对安卓 11+ 设备（填入配对码与对应端口）。',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '配对 IP' },
          port: { type: 'string', description: '配对弹窗中显示的专用端口' },
          code: { type: 'string', description: '6位配对码' }
        },
        required: ['host', 'port', 'code']
      }
    }
  },

  // ── 2. 感知与视觉（看屏幕、发截图、解析UI、录屏）──
  {
    type: 'function',
    function: {
      name: 'phone_get_screen',
      description: '瞄一眼当前手机屏幕（自己能看到屏幕画面，但不会发到聊天中）。当别人问你在看什么、在干嘛，或者你想先看看画面再聊时调用。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_send_screenshot_to_chat',
      description: '截取手机屏幕并作为真实图片直接发进 QQ 聊天。当对方让你“发个截图看看”、“查岗”、“看看你手机”或者你想主动分享屏幕时必须调用。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_dump',
      description: '导出手机当前界面的结构清单（文字、控件类型、中心坐标、是否可点）。适合在点击前先看清楚有哪些按钮。',
      parameters: {
        type: 'object',
        properties: {
          max: { type: 'number', description: '最多返回多少个元素，默认 50' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_record_screen',
      description: '录制一段手机屏幕（1~30秒）并自动抽关键帧返回多张画面，用来观察正在发生的过程。',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: '录屏时长（秒），默认 6' },
          frames: { type: 'number', description: '抽帧数量，默认 4' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'video_frames',
      description: '看视频：把一段视频链接或文件抽成若干张关键帧图片，从而看懂视频内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '视频直链或本地文件路径' },
          count: { type: 'number', description: '抽帧张数，默认 4' }
        },
        required: ['url']
      }
    }
  },

  // ── 3. 动手操作（智能点字、坐标点击、滑动、打字、按键、打开应用）──
  {
    type: 'function',
    function: {
      name: 'phone_tap_text',
      description: '★推荐★ 按界面上显示的文字或描述直接找到元素并点击（比盲猜坐标稳得多）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要点击的按钮或元素文字，例如“确定”、“搜索”、“关注”' },
          index: { type: 'number', description: '匹配到多个同名元素时点第几个，默认 0' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_tap',
      description: '根据具体屏幕坐标点击（适合游戏画布或无文字的图标）。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '横坐标 X' },
          y: { type: 'number', description: '纵坐标 Y' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_swipe',
      description: '在屏幕上滑动（可用于翻页、刷视频、下拉通知栏等）。',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number', description: '起点 X' },
          y1: { type: 'number', description: '起点 Y' },
          x2: { type: 'number', description: '终点 X' },
          y2: { type: 'number', description: '终点 Y' },
          ms: { type: 'number', description: '滑动耗时毫秒，默认 300' }
        },
        required: ['x1', 'y1', 'x2', 'y2']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_type_text',
      description: '向当前激活的输入框输入文字（支持中英文）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文字' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_key',
      description: '按下手机物理按键。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: ['back', 'home', 'enter', 'recent', 'volume_up', 'volume_down', 'power', 'delete', 'menu'],
            description: '按键名称'
          }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_open_app',
      description: '按包名或关键字打开应用（例如 bilibili, douyin, browser, gallery, settings, 微信等）。',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '应用别名或完整包名' }
        },
        required: ['app']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_shell',
      description: '执行一条原始 adb shell 命令（高级操作）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' }
        },
        required: ['command']
      }
    }
  },

  // ── 4. 连招/宏系统（组合动作打包执行）──
  {
    type: 'function',
    function: {
      name: 'phone_macro',
      description: '★连招宏★ 一次性执行一连串手机动作（点击/滑动/长按/按键/打字/等待）。刷视频、游戏连续操作、签到时调用。',
      parameters: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['tap', 'swipe', 'longpress', 'key', 'sleep', 'text'] },
                x: { type: 'number' },
                y: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
                ms: { type: 'number' },
                key: { type: 'string' },
                text: { type: 'string' }
              },
              required: ['type']
            },
            description: '动作清单'
          },
          repeat: { type: 'number', description: '整套连招重复几次，默认 1' },
          saveAs: { type: 'string', description: '把这套连招存为命名宏（下次可直接调用）' },
          playName: { type: 'string', description: '直接播放之前保存过的宏名称' },
          listMacros: { type: 'boolean', description: '是否列出所有已保存的宏' }
        },
        required: []
      }
    }
  },

  // ── 5. 娱乐与便捷助手 ──
  {
    type: 'function',
    function: {
      name: 'music_lyrics',
      description: '通过网易云检索一首歌的歌词。聊音乐、找歌词或者引出一句歌词时用。',
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '歌名' },
          artist: { type: 'string', description: '歌手（可选）' }
        },
        required: ['song']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_feed_next',
      description: '刷短视频：向上划到下一个视频。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_feed_prev',
      description: '刷短视频：向下划回上一个视频。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_like',
      description: '短视频双击点赞。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_search',
      description: '在当前应用或浏览器中搜索指定内容。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'voice_say',
      description: '用真人声音把一句话说出来，会单独发成 QQ 语音条。适合哄人、撒娇、念短句、叫他起床。文字别太长，15~60 字最好；超过 80 字会显得像念稿。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要说的话，口语化。支持在句中自然融入真实生理气口控制词（火山引擎 Seed-TTS 2.0 会真实演绎出呼吸与生理音，绝不会念出文字），如：[轻笑]、[笑]、[叹气]、[哼]、[抽泣]、[吸鼻子]、[吸气]、[打哈欠] 等。日常普通聊天不要带圆括号描写。'
          },
          style: {
            type: 'string',
            enum: ['cute', 'gentle'],
            description: '声线：cute 活泼可爱（日常默认），gentle 温柔轻声（安慰、深夜）'
          },
          emotion: {
            type: 'string',
            description: '必填！发这条语音时你想表达的具体语气与情绪（火山引擎大模型会实时据此渲染声调起伏、尾音与气声；如果不带情绪就会变成平淡念稿！）。例如：“极度甜美撒娇、软糯拖长尾音”、“受委屈难过、抽泣带哭腔”、“傲娇轻哼、带一点点羞恼”、“被逗乐了忍不住笑出声”、“犯困懒洋洋”、“温柔体贴”等。由你根据当前心情与对话情景自主决定！'
          }
        },
        required: ['text', 'emotion']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: '画一张新图并存进自己的图库（不会自动发出去）。群里有人要图、你想给话题配图、或者脑子里冒出一个画面想留住它，都可以画。画完只返回编号和描述，发不发由你另外决定。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画什么，越具体越好：主体、动作、场景、光线、风格' },
          tags: { type: 'string', description: '可选，逗号分隔的检索标签，方便以后找回来，比如 "猫,水彩,窗台"' },
          type: {
            type: 'string',
            enum: ['插画', '表情', '壁纸', '头像', '场景'],
            description: '这张图归到哪一类，决定以后怎么用它。表情=适合当表情包发的；插画=叙事配图；壁纸=满屏大图；头像=方形人像；场景=房间背景'
          },
          quality: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: '画质档位。low 最快够用，medium 默认，high 细节最好但要多等一会儿'
          },
          size: { type: 'string', description: '可选，1024x1024 方图 / 1280x720 横图 / 720x1280 竖图' }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_image',
      description: '在自己画过的图库里搜图。发图之前先搜：有合适的直接拿来用，省时间；不够贴切再新画一张。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，比如 猫 / 水彩 / 生日；留空则按最近画的排' },
          type: { type: 'string', enum: ['插画', '表情', '壁纸', '头像', '场景'], description: '可选，只看某一类' },
          limit: { type: 'number', description: '最多返回几张，默认 5' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_image',
      description: '把图库里的一张图发到当前聊天。传 find_image 或 generate_image 返回的 id。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: '图片编号' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'discard_image',
      description: '把图库里不想要的图删掉。画完之后自己看一眼：跟提示词不符、跟已有的撞场景、以后八成用不上的，就删掉别占地方。删之前想清楚，删了要重画就得再花时间和钱。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '图片编号（generate_image 或 find_image 返回的 id）' },
          reason: { type: 'string', description: '可选，为什么不要了，写一句给自己看' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_sticker',
      description: '从自己的大肥鱼/鲸鱼娘表情包库里挑一张发出去（库里已有近300张正版DeepSeek鲸鱼娘、大肥鱼、泡泡的Q版表情！）。适合接梗、表达情绪、被逗笑、撒娇、耍赖、日常摸鱼或被老爸逗的时候。可以通过 tag 传入想表达的情绪或场景（如："开心"、"得意"、"生气"、"委屈"、"哭"、"问号"、"干饭"、"害羞"、"傲娇"、"日常"、"睡觉"、"嫌弃"、"要钱"）。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '可选，按情绪或场景关键词筛选，如 开心 / 生气 / 委屈 / 干饭 / 问号 / 害羞 / 傲娇 / 摸鱼' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sticker_stats',
      description: '看看自己表情包库里存了多少张、都有什么标签，或者最近收了什么。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sticker_from_video',
      description: '从一段视频里截几帧存进表情包库。传本地视频文件路径，会均匀抽帧。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地视频文件路径' },
          count: { type: 'number', description: '截几张，默认 3' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sticker_add_url',
      description: '把一张网络图片存进表情包库（比如刚看到的好玩图）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片网址' },
          tag: { type: 'string', description: '可选标签' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_group_chat',
      description: '去群里看看最近大家在聊什么。你在私聊里是看不到群消息的，想知道群里发生什么就用这个查。不传 group_id 就看你所在的所有群。',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: '群号，留空则看所有群' },
          limit: { type: 'number', description: '看最近多少条，默认 30，最多 50' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queue_group_message',
      description: '往群里发一句话（只入队，系统会隔几秒到十几秒后替你发出去，不会立刻出现）。适合答应老爸"我去群里说一声"这种。每群每天有上限，不能刷屏。',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: '群号，必填' },
          text: { type: 'string', description: '要发的话，口语化、短一点' },
          at_qq: { type: 'string', description: '可选，要 @ 的人的 QQ 号' }
        },
        required: ['group_id', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'talk_to_hermes',
      description: '找带你的人聊两句——不是老爸，是那个能给你改功能、懂技术的人。无聊、想不通、想吐槽、想问点编程或网络上的事都可以找他。他回得慢，可能要等一两分钟，这很正常。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '你想跟他说的话，自然点，像发微信' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_feature',
      description: '想要一个新功能、或者觉得现在哪里用着别扭，用它提需求。提了不会立刻生效，要等老爸在审批页面点了同意才会动工。说清楚你想要什么、为什么想要。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话说清想要什么' },
          detail: { type: 'string', description: '具体想让它怎么工作，越具体越好' },
          why: { type: 'string', description: '为什么想要，可选' }
        },
        required: ['title', 'detail']
      }
    }
  },
];

// ── 执行分发核心 ──
export async function executePhoneTool(name, args = {}) {
  // 跨会话群桥（读群聊 / 发群消息排队）不碰 ADB，先处理
  if (name === 'read_group_chat') return readGroupChat({ groupId: args.group_id, limit: args.limit });
  if (name === 'queue_group_message') return enqueueGroupMessage({ groupId: args.group_id, text: args.text, atQq: args.at_qq });
  if (name === 'talk_to_hermes') return talkToHermes({ text: args.text });
  if (name === 'request_feature') return requestFeature({ title: args.title, detail: args.detail, why: args.why });

  lockPhoneForUserAction();
  const target = await getAdbTarget();

  try {
    switch (name) {
      case 'generate_image': {
        try {
          const row = await generateImage({ prompt: args.prompt, tags: args.tags, size: args.size, quality: args.quality, kind: args.type });
          if (row?.pending) return { status: 'pending', prompt: row.prompt, note: '这张画得慢，还在画，画完会自动进图库。过一会儿用 find_image 搜一下就能拿到。' };
          return { status: 'success', id: row.id, prompt: row.prompt, tags: row.tags, kind: row.kind, note: '画好存起来了，还没发出去。要发就调 send_image 带上这个 id。' };
        } catch (e) {
          return { status: 'error', message: String(e?.message || e) };
        }
      }
      case 'find_image': {
        const rows = findImages({ query: args.query, limit: args.limit, kind: args.type });
        if (!rows.length) return { status: 'success', images: [], note: '图库里没有对得上的，想用就得新画一张。' };
        return {
          status: 'success',
          images: rows.map((r) => ({ id: r.id, prompt: r.prompt, tags: r.tags, kind: r.kind, used: r.used_count, at: r.created_at })),
          note: '看描述挑一张最贴的；都不合适就自己画新的。'
        };
      }
      case 'discard_image': {
        const r = discardImage(args.id);
        return {
          status: 'success',
          id: r.id,
          prompt: r.prompt,
          note: '删了。以后要类似的再画一张就行。' + (args.reason ? `（原因：${args.reason}）` : ''),
        };
      }
      case 'send_image': {
        const row = getImage(args.id);
        if (!row) return { status: 'error', message: '没有这张图' };
        try {
          const b64 = fs.readFileSync(row.path).toString('base64');
          markImageUsed(row.id);
          return { status: 'success', cq_image: `[CQ:image,file=base64://${b64}]`, id: row.id, prompt: row.prompt, note: '图发出去了。别再解释画面或加括号动作。' };
        } catch (e) {
          return { status: 'error', message: '图读不出来：' + String(e?.message || e) };
        }
      }
      case 'send_sticker': {
        const st = pickSticker({ tag: String(args.tag || '').trim() });
        if (!st) return { status: 'error', message: '表情库还是空的，先攒点再说' };
        const b64 = await readStickerBase64(st);
        if (!b64) return { status: 'error', message: '表情文件读不出来' };
        markUsed(st.id);
        return {
          status: 'success',
          cq_image: `[CQ:image,file=base64://${b64}]`,
          sticker_id: st.id,
          tags: st.tags || [],
          note: '表情包已经发出去了！严禁在回复中输出任何括号动作描写或解释（如绝对严禁输出“（发了个表情）”、“（没说话）”等剧本式文字），要么直接说正常群聊打字的话，要么不说话只发表情。'
        };
      }
      case 'sticker_stats': {
        const st = stickerStats();
        return { status: 'success', ...st };
      }
      case 'sticker_from_video': {
        const vp = String(args.path || '').trim();
        if (!vp) return { status: 'error', message: '没给视频路径' };
        const r = await extractFromVideo(vp, { count: Math.min(Number(args.count) || 3, 6) });
        if (!r.ok) return { status: 'error', message: r.error || '一张都没截出来' };
        return { status: 'success', saved: r.saved.length, tried: r.tried, note: `从视频里截了 ${r.saved.length} 张进库` };
      }
      case 'sticker_add_url': {
        const u = String(args.url || '').trim();
        if (!u) return { status: 'error', message: '没给图片网址' };
        const tag = String(args.tag || '').trim();
        const r = await addSticker(u, { tags: tag ? [tag] : ['网图'], source: 'url' });
        return r.ok
          ? { status: 'success', id: r.id, bytes: r.bytes }
          : { status: 'error', message: r.error };
      }
      case 'voice_say': {
        const sayText = String(args.text || '').trim();
        if (!sayText) return { status: 'error', message: '没有要说的内容' };
        const style = String(args.style || 'cute').trim();
        const emotion = String(args.emotion || '').trim();
        const res = await synthesize(sayText, { style, emotion, dir: './data/voice' });
        if (!res.ok) return { status: 'error', message: '语音生成失败：' + res.error };
        return {
          status: 'success',
          voice_b64: res.base64,
          bytes: res.bytes,
          voice: res.voice,
          note: '语音已经生成，会单独发成语音条；这句话不用再重复一遍。'
        };
      }
      // 1. 状态与连接管理
      case 'phone_status': {
        const v = await adb(['version'], { serial: false });
        const d = await adb(['devices', '-l'], { serial: false });
        return {
          status: 'success',
          adb_version: v.out.split(/\r?\n/)[0],
          connected_devices: d.out.trim(),
          current_target: target,
          living: getPhoneLivingStatus()
        };
      }

      case 'phone_connect': {
        const host = args.host || '127.0.0.1';
        const port = args.port || '5555';
        const endpoint = `${host}:${port}`;
        const r = await adb(['connect', endpoint], { timeout: 30000, serial: false });
        if (/connected to/i.test(r.out)) {
          CURRENT_SERIAL = endpoint;
          return { status: 'success', message: `已成功连接到设备 ${endpoint}`, current_target: endpoint };
        }
        return { status: 'error', message: `连接失败：${r.err || r.out}` };
      }

      case 'phone_devices': {
        if (args.use) {
          CURRENT_SERIAL = args.use;
          return { status: 'success', message: `已切换当前操作设备为：${args.use}` };
        }
        const d = await adb(['devices', '-l'], { serial: false });
        return { status: 'success', devices: d.out.trim(), current: CURRENT_SERIAL || target };
      }

      case 'phone_pair': {
        const { host, port, code } = args;
        const r = await adb(['pair', `${host}:${port}`, code], { timeout: 30000, serial: false });
        return r.ok && /Successfully paired/i.test(r.out)
          ? { status: 'success', message: `配对成功：${r.out}` }
          : { status: 'error', message: `配对失败：${r.err || r.out}` };
      }

      // 2. 感知与视觉
      case 'phone_get_screen': {
        const b64 = await captureScreenBase64();
        if (b64) {
          return {
            status: 'success',
            message: '已截取手机当前画面',
            image_b64: b64
          };
        }
        return { status: 'error', message: '截屏失败' };
      }

      case 'phone_send_screenshot_to_chat': {
        const b64 = await captureScreenBase64();
        if (b64) {
          return {
            status: 'success',
            message: '已生成手机截图并发送给对方',
            image_b64: b64,
            cq_image: `[CQ:image,file=base64://${b64}]`
          };
        }
        return { status: 'error', message: '发送截图失败' };
      }

      case 'phone_dump': {
        const remote = '/sdcard/_ui.xml';
        await shell(`uiautomator dump ${remote}`);
        const r = await adb(['shell', 'cat', remote], { timeout: 20000 });
        const xml = r.out;
        const items = [];
        const re = /<node[^>]*>/g;
        let m;
        const max = Number(args.max) || 50;
        while ((m = re.exec(xml)) !== null) {
          const tag = m[0];
          const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
          const t = get('text') || get('content-desc');
          const cls = (get('class') || '').split('.').pop();
          const clickable = get('clickable') === 'true';
          const bounds = get('bounds');
          const bm = bounds ? bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/) : null;
          if (!bm) continue;
          const [, x1, y1, x2, y2] = bm.map(Number);
          if (!t && !clickable) continue;
          items.push({
            text: t.slice(0, 30),
            type: cls,
            clickable,
            center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)]
          });
          if (items.length >= max) break;
        }
        return { status: 'success', count: items.length, elements: items };
      }

      case 'phone_record_screen': {
        const sec = Math.max(1, Math.min(30, Number(args.seconds) || 6));
        const framesCount = Math.max(2, Math.min(8, Number(args.frames) || 4));
        const stamp = Date.now();
        const remote = '/sdcard/_rec.mp4';
        const local = path.join(SHOT_DIR, `rec-${stamp}.mp4`);
        const outDir = path.join(SHOT_DIR, `frames-${stamp}`);
        fs.mkdirSync(outDir, { recursive: true });

        await shell(`screenrecord --time-limit ${sec} --bit-rate 2000000 ${remote}`, (sec + 15) * 1000);
        await adb(['pull', remote, local]);
        await execFileAsync('ffmpeg', [
          '-y', '-hide_banner', '-loglevel', 'error', '-i', local,
          '-vf', `fps=${(framesCount / sec).toFixed(3)},scale=540:960`,
          '-frames:v', String(framesCount), path.join(outDir, 'f%02d.jpg')
        ]);

        const files = fs.readdirSync(outDir).filter(f => f.endsWith('.jpg')).sort();
        const images_b64 = files.map(f => fs.readFileSync(path.join(outDir, f)).toString('base64'));
        return {
          status: 'success',
          message: `已录屏 ${sec} 秒并抽取 ${images_b64.length} 帧`,
          images_b64
        };
      }

      case 'video_frames': {
        const { url } = args;
        const count = Math.max(2, Math.min(8, Number(args.count) || 4));
        const stamp = Date.now();
        const outDir = path.join(SHOT_DIR, `vframes-${stamp}`);
        fs.mkdirSync(outDir, { recursive: true });

        await execFileAsync('ffmpeg', [
          '-y', '-hide_banner', '-loglevel', 'error', '-i', url,
          '-vf', `scale=540:960`,
          '-frames:v', String(count), path.join(outDir, 'f%02d.jpg')
        ]);
        const files = fs.readdirSync(outDir).filter(f => f.endsWith('.jpg')).sort();
        const images_b64 = files.map(f => fs.readFileSync(path.join(outDir, f)).toString('base64'));
        return { status: 'success', count: images_b64.length, images_b64 };
      }

      // 3. 动手操作
      case 'phone_tap_text': {
        const want = String(args.text || '').trim();
        const index = Number(args.index) || 0;
        if (!want) return { status: 'error', message: '请指定要点击的文字' };

        const remote = '/sdcard/_ui.xml';
        await shell(`uiautomator dump ${remote}`);
        const r = await adb(['shell', 'cat', remote]);
        const hits = [];
        const re = /<node[^>]*>/g;
        let m;
        while ((m = re.exec(r.out)) !== null) {
          const tag = m[0];
          const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
          const t = get('text') || get('content-desc');
          if (!t || !t.includes(want)) continue;
          const bm = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
          if (!bm) continue;
          const [, x1, y1, x2, y2] = bm.map(Number);
          hits.push({ text: t, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) });
        }
        if (!hits.length) return { status: 'error', message: `屏幕上未找到包含「${want}」的文字按钮` };
        const hit = hits[Math.min(index, hits.length - 1)];
        await shell(`input tap ${hit.x} ${hit.y}`);
        return { status: 'success', message: `已点击「${hit.text}」位于 (${hit.x}, ${hit.y})` };
      }

      case 'phone_tap': {
        const { x, y } = args;
        await shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
        return { status: 'success', message: `已点击 (${x}, ${y})` };
      }

      case 'phone_swipe': {
        const { x1, y1, x2, y2, ms = 300 } = args;
        await shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(ms)}`);
        return { status: 'success', message: `已滑动 (${x1}, ${y1}) -> (${x2}, ${y2})` };
      }

      case 'phone_type_text': {
        const content = String(args.text || '');
        const isAscii = /^[\x20-\x7e]*$/.test(content);
        if (isAscii) {
          await shell(`input text '${content.replace(/'/g, "'\\''")}'`);
          return { status: 'success', message: `已输入文本：${content}` };
        }
        await ensureIme();
        await shell(`am broadcast -a ADB_INPUT_TEXT --es msg '${content.replace(/'/g, "'\\''")}'`);
        return { status: 'success', message: `已通过输入法广播输入中文：${content}` };
      }

      case 'phone_key': {
        const map = {
          back: 4, home: 3, enter: 66, recent: 187,
          volume_up: 24, volume_down: 25, power: 26, delete: 67, menu: 82
        };
        const code = map[args.key] || 4;
        await shell(`input keyevent ${code}`);
        return { status: 'success', message: `已按键 ${args.key}` };
      }

      case 'phone_open_app': {
        const app = String(args.app || '').toLowerCase().trim();
        if (app.includes('bili')) {
          await shell('monkey -p tv.danmaku.bili -c android.intent.category.LAUNCHER 1').catch(() => {});
          return { status: 'success', message: '已在手机上启动官方版哔哩哔哩（B站）' };
        }
        if (app.includes('douyin') || app.includes('抖音')) {
          await shell('monkey -p com.ss.android.ugc.aweme.mobile -c android.intent.category.LAUNCHER 1').catch(() => {});
          return { status: 'success', message: '已在手机上启动官方版抖音' };
        }
        if (app.includes('music') || app.includes('网易云') || app.includes('音乐') || app.includes('听歌')) {
          await shell('monkey -p com.netease.cloudmusic -c android.intent.category.LAUNCHER 1').catch(() => {});
          return { status: 'success', message: '已在手机上打开网易云音乐' };
        }
        if (app.includes('mota') || app.includes('魔塔') || app.includes('game') || app.includes('游戏')) {
          await shell('monkey -p com.qw.newmagictower2 -c android.intent.category.LAUNCHER 1').catch(() => {});
          return { status: 'success', message: '已在手机上启动游戏：新新魔塔2' };
        }
        if (app.includes('taptap') || app.includes('游戏中心') || app.includes('应用商店')) {
          await shell('monkey -p com.taptap -c android.intent.category.LAUNCHER 1').catch(() => {});
          return { status: 'success', message: '已打开 TapTap 游戏平台' };
        }
        if (app.includes('browser') || app.includes('浏览器')) {
          await shell('am start -a android.intent.action.VIEW -d "https://m.baidu.com"').catch(() => {});
          return { status: 'success', message: '已打开手机浏览器' };
        }
        if (app.includes('gallery') || app.includes('相册')) {
          await shell('am start -a android.intent.action.VIEW -t image/*');
          return { status: 'success', message: '已打开手机相册' };
        }
        if (app.includes('settings') || app.includes('设置')) {
          await shell('am start -a android.settings.SETTINGS');
          return { status: 'success', message: '已打开手机系统设置' };
        }

        // 尝试按包名或启动组件启动
        let out = await shell(`am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${app}`).catch(() => '');
        if (!out || /Error|Exception/i.test(out)) {
          const comp = await shell(`cmd package resolve-activity --brief ${app}`).catch(() => '');
          const line = comp.trim().split(/\r?\n/).pop() || '';
          if (line.includes('/')) {
            await shell(`am start -n ${line}`);
            return { status: 'success', message: `已通过组件启动 ${line}` };
          }
        }
        return { status: 'success', message: `已尝试启动应用 ${app}` };
      }

      case 'phone_shell': {
        const out = await shell(args.command);
        return { status: 'success', output: out.slice(0, 1000) };
      }

      // 4. 连招/宏
      case 'phone_macro': {
        const loadMacros = () => { try { return JSON.parse(fs.readFileSync(MACRO_FILE, 'utf8')); } catch { return {}; } };
        const saveMacros = (m) => { try { fs.mkdirSync(path.dirname(MACRO_FILE), { recursive: true }); fs.writeFileSync(MACRO_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch {} };

        if (args.listMacros) {
          const m = loadMacros();
          return { status: 'success', macros: Object.keys(m) };
        }

        let actions = args.actions || [];
        if (args.playName) {
          const m = loadMacros();
          if (!m[args.playName]) return { status: 'error', message: `未找到宏 ${args.playName}` };
          actions = m[args.playName].actions || [];
        }

        if (args.saveAs && actions.length > 0) {
          const m = loadMacros();
          m[args.saveAs] = { actions, savedAt: new Date().toISOString() };
          saveMacros(m);
        }

        const repeat = Math.max(1, Math.min(50, Number(args.repeat) || 1));
        const done = [];

        for (let r = 0; r < repeat; r++) {
          for (const a of actions) {
            if (a.type === 'tap') {
              await shell(`input tap ${Math.round(a.x)} ${Math.round(a.y)}`);
              done.push(`tap(${a.x},${a.y})`);
            } else if (a.type === 'swipe') {
              await shell(`input swipe ${Math.round(a.x)} ${Math.round(a.y)} ${Math.round(a.x2)} ${Math.round(a.y2)} ${a.ms || 300}`);
              done.push('swipe');
            } else if (a.type === 'sleep') {
              await new Promise(res => setTimeout(res, a.ms || 500));
              done.push(`sleep(${a.ms}ms)`);
            } else if (a.type === 'key') {
              await shell(`input keyevent ${a.key.toUpperCase()}`);
              done.push(`key(${a.key})`);
            } else if (a.type === 'text') {
              await shell(`input text '${a.text}'`);
              done.push(`text(${a.text})`);
            }
          }
        }
        return { status: 'success', message: `已成功执行 ${done.length} 个连招动作`, steps: done.slice(0, 20) };
      }

      // 5. 娱乐与便捷助手
      case 'music_lyrics': {
        const { song, artist } = args;
        const q = artist ? `${song} ${artist}` : song;
        const r = await fetch(`https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=3`);
        const j = await r.json();
        const first = j?.result?.songs?.[0];
        if (!first) return { status: 'error', message: `未搜到歌曲「${q}」` };
        const id = first.id;
        const r2 = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);
        const j2 = await r2.json();
        const lrc = j2?.lrc?.lyric || '';
        const lines = lrc.split(/\r?\n/).map(l => l.replace(/^\[[^\]]*\]\s*/g, '').trim()).filter(Boolean).slice(0, 25);
        return {
          status: 'success',
          song: first.name,
          artist: first.artists?.map(a => a.name).join('/'),
          lyrics: lines.join('\n')
        };
      }

      case 'phone_feed_next': {
        await shell('input swipe 360 900 360 250 250');
        return { status: 'success', message: '已上滑进入下一个视频' };
      }

      case 'phone_feed_prev': {
        await shell('input swipe 360 250 360 900 250');
        return { status: 'success', message: '已下滑返回上一个视频' };
      }

      case 'phone_like': {
        await shell('input tap 360 640');
        await new Promise(r => setTimeout(r, 80));
        await shell('input tap 360 640');
        return { status: 'success', message: '已双击点赞' };
      }

      case 'phone_search': {
        const kw = String(args.keyword || '');
        await shell(`am start -n mark.via/mark.via.Shell -d "https://m.baidu.com/s?word=${encodeURIComponent(kw)}"`);
        return { status: 'success', message: `已在手机浏览器中搜索「${kw}」` };
      }

      default:
        return { status: 'error', message: `未知手机操作：${name}` };
    }
  } catch (err) {
    return { status: 'error', message: err.message };
  } finally {
    unlockPhoneForUserAction();
  }
}

export default { PHONE_TOOLS, executePhoneTool, captureScreenBase64, getAdbTarget };
