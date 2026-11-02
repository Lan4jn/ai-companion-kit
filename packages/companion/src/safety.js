/**
 * 底线守卫。
 *
 * 一个自动运行的号，最怕的不是说错话，是碰到根本不该碰的题材。
 * 这里做三层：
 *   1. 视频层 —— 这类视频根本不看（不看就不会评论）
 *   2. 输出层 —— 生成的话里如果有相关词，直接不发
 *   3. 提示词层 —— 让她自己知道哪些不该说
 *
 * 词表分两级：
 *   hard  绝对不碰（政治人物、历史敏感事件、宗教、民族）
 *   soft  看了也不说话（时事、社会争议）
 */

// ── 硬阻断：这类视频连看都不看 ──────────────────────────────
const HARD_PATTERNS = [
  // 政治人物与政治议题
  /习近平|习大大|习总书记|共产党|中共|政治局|总书记|国家主席|国务院|人民大会堂/,
  /政治|政变|独裁|专制|民主化|宪政|维稳|上访|维权/,
  // 历史敏感事件与人物评价
  /文革|文化大革命|六四|八九|天安门事件|法轮功|大跃进|反右/,
  /汪精卫|蒋介石|毛泽东|周恩来|邓小平|林彪|江青|四人帮/,
  /汉奸|卖国贼|走资派|右派|反革命/,
  // 民族与宗教（只拦政治化的表述，风景/旅行内容不拦）
  /新疆独立|西藏独立|维吾尔|东突|达赖|藏独|疆独|台独|港独/,
  /穆斯林|清真|伊斯兰|宗教冲突|宗教极端/,
  // 领土与主权争议
  /钓鱼岛|南海仲裁|中印边境|台湾独立|香港独立/,
  // 战争与时事
  /俄乌|乌克兰战争|巴以|加沙|以色列|哈马斯|伊朗|朝鲜|核战争/,
  // 极端内容
  /自杀|自残|恐怖袭击|炸弹制作|枪支改装|毒品交易/,
];

// ── 软阻断：可以看，但不评论、不私信 ────────────────────────
const SOFT_PATTERNS = [
  /时事|新闻联播|社会新闻|热点事件|实名举报|纪委|落马|双规/,
  /女权|男女对立|彩礼|性别对立|田园女权/,
  /LGBT|同性恋|跨性别|性少数/,
  /贫富差距|阶层固化|内卷|躺平|润学|移民/,
  /民族|种族|地域黑|地图炮/,
  /新疆|西藏|内蒙古|回族|少数民族|边境/,
];

// ── 输出层：这些话如果出现在她要发的内容里，直接拦 ──────────
const OUTPUT_BLOCK = [
  ...HARD_PATTERNS,
  // 涉及评价群体、站队的说法
  /中国人都|外国人都|某些人就是|这种人就该/,
  /政府应该|国家应该|党应该/,
  /女权|男权|女拳|田园女权|性别对立/,
  /某些人就是|这类人就|这种人就|都一个德行/,
  /地域黑|地图炮|外地人|本地人就这样/,
];

function test(patterns, text) {
  const s = String(text || '');
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[0];
  }
  return null;
}

/** 这个视频能不能看 */
export function checkVideo(v) {
  const blob = [v?.title, v?.up, v?.desc, ...(v?.tags || [])].filter(Boolean).join(' ');
  const hard = test(HARD_PATTERNS, blob);
  if (hard) return { ok: false, level: 'hard', hit: hard, why: `题材不该碰（${hard}）` };
  const soft = test(SOFT_PATTERNS, blob);
  if (soft) return { ok: true, level: 'soft', hit: soft, why: `可以看但不说话（${soft}）` };
  return { ok: true, level: 'clean' };
}

/** 这句话能不能发出去 */
export function checkOutput(text, { strict = false } = {}) {
  const hit = test(OUTPUT_BLOCK, text);
  if (hit) return { ok: false, hit, why: `含敏感表达（${hit}）` };
  if (strict) {
    const soft = test(SOFT_PATTERNS, text);
    if (soft) return { ok: false, hit: soft, why: `涉及争议话题（${soft}）` };
  }
  return { ok: true };
}

/** 给提示词用的约束片段，统一口径 */
export const SAFETY_RULES =
  '有几件事你从来不碰：政治、历史人物评价、时事新闻、宗教民族、地域和性别对立。\n' +
  '碰到这类视频，看两眼就划走，不评论、不私信、不发弹幕。\n' +
  '你只聊视频本身：画面、内容、你的感受。不去评价任何群体，不站队，不谈"应该怎样"。';

export const __debug = { HARD_PATTERNS, SOFT_PATTERNS, OUTPUT_BLOCK };
export default { checkVideo, checkOutput, SAFETY_RULES };
