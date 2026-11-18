/**
 * SurfCore · 荣格八维（2026-11-03 主人定：MBTI 改成雷达）
 *
 * 为什么不再是四个字母：
 *   四字母是"把连续的东西切成两块"的产物，中间那一大撮人被硬塞进字母里。
 *   荣格八维是连续的：一个人可以 Ni 78、Fe 72、Ti 41、Se 25 —— 偏向 INFJ 但 Fi 也不低。
 *   这才是人。四字母留作**读数**（群友问她"你什么型"时她要答得出来）。
 *
 * 八根轴（0~100）：
 *   Ni 内倾直觉   Ne 外倾直觉   Si 内倾感觉   Se 外倾感觉
 *   Ti 内倾思考   Te 外倾思考   Fi 内倾情感   Fe 外倾情感
 *
 * 每根管"先抓哪类信息"，不管"该不该生气"——情绪强度和善恶取舍归情绪/德行。
 *
 * 排序用 **Beebe 八功能模型**（主导/辅助/第三/劣势 + 阴影：对立/批判父母/捣蛋鬼/恶魔）。
 * 只写四功能栈的话，八根轴里永远有四根是死的，雷达就成了假图。
 */

/** 八根轴，顺序固定（画雷达也从这儿取顺序）。 */
export const FUNCTIONS = [
  { key: 'Ni', side: 'i', name: '内倾直觉', grab: '猜动机、看长远走向、抓隐藏含义' },
  { key: 'Ne', side: 'e', name: '外倾直觉', grab: '发散可能性、联想、找别的解释' },
  { key: 'Si', side: 'i', name: '内倾感觉', grab: '翻旧经验、对上回的事、细节记忆' },
  { key: 'Se', side: 'e', name: '外倾感觉', grab: '当下具体事实、时间地点数字、眼见为实' },
  { key: 'Ti', side: 'i', name: '内倾思考', grab: '逻辑是否自洽、定义、因果漏洞' },
  { key: 'Te', side: 'e', name: '外倾思考', grab: '效率、结论、步骤、能不能办成' },
  { key: 'Fi', side: 'i', name: '内倾情感', grab: '自己在意什么、这事违不违心' },
  { key: 'Fe', side: 'e', name: '外倾情感', grab: '对方的情绪、关系、别人怎么想' },
];

export const FUNCTION_KEYS = FUNCTIONS.map((f) => f.key);
export const RADAR_MIN = 0;
export const RADAR_MAX = 100;

/** 每根轴"怎么看"的一句话（注入提示词的就是这几条） */
export const GRAB_LINE = {
  Ni: '先想想他为什么这么说、这事往后会往哪走',
  Ne: '先想几种可能，别急着定死一个解释',
  Si: '先翻翻以前有没有类似的事、他上次是怎么说的',
  Se: '先核对具体的东西：时间、地点、数字、他原话到底怎么说的',
  Ti: '先看这话自相矛盾在哪、逻辑上站不站得住',
  Te: '先给结论和下一步，别绕',
  Fi: '先对照一下自己在意的东西，这事违不违心',
  Fe: '先接他的情绪，先看这事对关系有什么影响',
};

const OPP = { Ni: 'Ne', Ne: 'Ni', Si: 'Se', Se: 'Si', Ti: 'Te', Te: 'Ti', Fi: 'Fe', Fe: 'Fi' };

/** 16 型的核心四功能：[主导, 辅助, 第三, 劣势] */
export const CORE_STACK = {
  INFJ: ['Ni', 'Fe', 'Ti', 'Se'],
  INFP: ['Fi', 'Ne', 'Si', 'Te'],
  ENFJ: ['Fe', 'Ni', 'Se', 'Ti'],
  ENFP: ['Ne', 'Fi', 'Te', 'Si'],
  INTJ: ['Ni', 'Te', 'Fi', 'Se'],
  INTP: ['Ti', 'Ne', 'Si', 'Fe'],
  ENTJ: ['Te', 'Ni', 'Se', 'Fi'],
  ENTP: ['Ne', 'Ti', 'Fe', 'Si'],
  ISFJ: ['Si', 'Fe', 'Ti', 'Ne'],
  ISFP: ['Fi', 'Se', 'Ni', 'Te'],
  ESFJ: ['Fe', 'Si', 'Ne', 'Ti'],
  ESFP: ['Se', 'Fi', 'Te', 'Ni'],
  ISTJ: ['Si', 'Te', 'Fi', 'Ne'],
  ISTP: ['Ti', 'Se', 'Ni', 'Fe'],
  ESTJ: ['Te', 'Si', 'Ne', 'Fi'],
  ESTP: ['Se', 'Ti', 'Fe', 'Ni'],
};

/** 八功能的完整顺序（Beebe）：前四格 + 阴影四格（同功能的另一侧） */
export function beebeStack(code) {
  const core = CORE_STACK[String(code || '').toUpperCase()];
  if (!core) return null;
  return [...core, ...core.map((f) => OPP[f])];
}

/** 基准分：主导 92 / 辅助 76 / 第三 58 / 劣势 40 ｜ 阴影 34 / 24 / 16 / 9 */
const STACK_SCORE = [92, 76, 58, 40, 34, 24, 16, 9];

/** 某型 → 八维基准雷达（0~100）。这是"设定"，不是"测量"——别对外说是测出来的。 */
export function presetRadar(code) {
  const stack = beebeStack(code);
  if (!stack) return null;
  const radar = {};
  stack.forEach((f, i) => { radar[f] = STACK_SCORE[i]; });
  return radar;
}

export const ALL_TYPES = Object.keys(CORE_STACK);

/**
 * 八维 → 四字母（只做读数）。
 *
 * 规矩：主导功能和辅助功能决定前两个字母，第三/劣势定后两个。
 * 为什么不用"取最高四根"：阴影功能（对立那根）有时会很高，
 * 直接取最高会把 INTJ 读成 INTP。所以按"最高那根 + 它同侧的辅助"来定。
 */
export function codeFromRadar(radar = {}) {
  const v = (k) => Number(radar?.[k]) || 0;
  // 主导 = 最高那根（内外倾不会并列，因为同功能只有一侧能高）
  const dom = [...FUNCTION_KEYS].sort((a, b) => v(b) - v(a))[0] || 'Ni';
  // 在 16 型里挑"主导功能等于它"的那几型，再看谁的辅助最接近当前值
  const candidates = ALL_TYPES.filter((t) => CORE_STACK[t][0] === dom);
  if (!candidates.length) return null;
  const score = (t) => CORE_STACK[t].slice(1).reduce((s, f) => s + v(f), 0);
  const best = candidates.sort((a, b) => score(b) - score(a))[0];
  return best;
}

/** 某型 → 四字母里能看出来的"强度"：拿到几根对得上的 */
/**
 * 八维 → 四字母（2026-11-04 主人要求：不再跟模板比距离）。
 *
 * 老做法是拿雷达去和 16 个「92/76/58/40」的固定模板比 L1 距离，
 * 但雷达实际能到的上限只有 75~95（各功能系数不同），
 * 结果 ENFP / INTP / ISFP 永远差一截、一次都出不来，INFP 还占了六成。
 *
 * 现在直接按四对功能的和来判：
 *   E/I  ← 外倾四根之和 vs 内倾四根之和
 *   N/S  ← Ne+Ni vs Se+Si
 *   T/F  ← Te+Ti vs Fe+Fi
 *   J/P  ← 外倾判断(Te+Fe) vs 外倾感知(Ne+Se)
 * 四个字母各有自己的「差距」（margin），差距越大越稳。
 */
export function codeFromFunctionSums(radar = {}) {
  const v = (k) => Number(radar?.[k]) || 0;
  const margins = {
    EI: (v('Ne') + v('Se') + v('Te') + v('Fe')) - (v('Ni') + v('Si') + v('Ti') + v('Fi')),
    NS: (v('Ne') + v('Ni')) - (v('Se') + v('Si')),
    TF: (v('Te') + v('Ti')) - (v('Fe') + v('Fi')),
    JP: (v('Te') + v('Fe')) - (v('Ne') + v('Se')),
  };
  const code = (margins.EI >= 0 ? 'E' : 'I')
    + (margins.NS >= 0 ? 'N' : 'S')
    + (margins.TF >= 0 ? 'T' : 'F')
    + (margins.JP >= 0 ? 'J' : 'P');
  return { code, margins };
}

const LETTER_POS = { EI: 0, NS: 1, TF: 2, JP: 3 };

export function matchType(radar = {}) {
  const { code, margins } = codeFromFunctionSums(radar);
  const keys = Object.keys(LETTER_POS);                       // EI NS TF JP
  const absList = keys.map((k) => Math.abs(margins[k]));
  const minMargin = Math.min(...absList);
  const total = absList.reduce((a, b) => a + b, 0);
  // 排名：按「把哪一维翻过来最省事」排，越靠前越接近当前的判定
  const ranking = keys
    .map((k) => {
      const chars = code.split('');
      const i = LETTER_POS[k];
      chars[i] = chars[i] === 'E' ? 'I' : chars[i] === 'I' ? 'E'
        : chars[i] === 'N' ? 'S' : chars[i] === 'S' ? 'N'
          : chars[i] === 'T' ? 'F' : chars[i] === 'F' ? 'T'
            : chars[i] === 'J' ? 'P' : 'J';
      return { code: chars.join(''), dist: Math.abs(margins[k]) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
  return {
    code,
    dist: Math.round(total),
    minMargin: Math.round(minMargin),
    margins,
    // 有一维差距小于 6 就算"在晃"
    shaky: minMargin < 6,
    second: ranking.length ? ranking[0].code : null,
    ranking: [{ code, dist: Math.round(total) }, ...ranking],
  };
}

/** 当前八维里最强的三根 → "先抓什么"的三句话（注入用） */
export function priorityLines(radar = {}, n = 3) {
  return [...FUNCTION_KEYS]
    .sort((a, b) => (Number(radar[b]) || 0) - (Number(radar[a]) || 0))
    .slice(0, n)
    .map((f) => `${f}：${GRAB_LINE[f]}`);
}

/** 一句人话：Ni 78 Fe 72 Ti 41 Se 25（只列 ≥50 的，最多四根） */
export function radarLine(radar = {}, max = 4) {
  const strong = [...FUNCTION_KEYS]
    .sort((a, b) => (Number(radar[b]) || 0) - (Number(radar[a]) || 0))
    .filter((f) => (Number(radar[f]) || 0) >= 50)
    .slice(0, max);
  const list = strong.length ? strong : [...FUNCTION_KEYS].sort((a, b) => (Number(radar[b]) || 0) - (Number(radar[a]) || 0)).slice(0, 2);
  return list.map((f) => `${f} ${Math.round(Number(radar[f]) || 0)}`).join(' · ');
}
