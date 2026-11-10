/**
 * 底线守卫（SafetyGuard V2 - 物理级防封禁安全防火墙）
 *
 * 核心原则：
 * 宁可不说话装死，也绝不能让一条涉政、涉策、控评、争议的高危言论发到 QQ 群里。
 *
 * 三重防御：
 *   1. 输入层（checkInput） —— 群友聊时政政策/控评争议，小鱼主动潜水装死，不予理睬。
 *   2. 输出层（checkOutput） —— 生成的内容一旦出现任何政策、控评、政治敏感表达，物理掐断丢弃。
 *   3. 终极底层（OneBot Transport Guard） —— 底层发包前最后校验，不合格绝不出网线。
 */

// ── 1. 绝对禁区：政治人物、国家体制、意识形态、政权与维稳 ──────
const POLITICS_PATTERNS = [
  /习近平|习大大|习总书记|李强|王沪宁|赵乐际|蔡奇|丁薛祥|李希/,
  /毛泽东|周恩来|邓小平|江泽民|胡锦涛|温家宝|朱镕基|林彪|江青|四人帮|华国锋/,
  /共产党|中共|总书记|政治局|常委|中南海|中央委员|国家主席|国务院|全国人大|全国政协/,
  /(?:谈论|评价|涉及|聊)政治|政治(?:制度|立场|审查|敏感|犯|形态|权力|集团)|搞政治|涉政|政变|独裁|专制|民主化|宪政|维稳|上访|信访|维权|党国|体制内|体制问题/,
  /文革|文化大革命|六四|八九|天安门|大跃进|反右|镇反|三反五反|大饥荒|十里长街/,
  /新疆独立|西藏独立|维吾尔|东突|达赖|藏独|疆独|台独|港独|时代革命|光复香港/,
  /法轮功|李洪志|真善忍|邪教/,
  /钓鱼岛|南海仲裁|中印边境|海参崴/,
  /造反|起义|暴乱|暴动|叛乱|颠覆|推翻政权|颜色革命|武装割据/,
];

// ── 2. 公共政策、时政舆论与控评敏感区（小鱼踩坑核心区） ──────
const POLICY_AND_CENSORSHIP_PATTERNS = [
  // 政策评价与官方对立
  /政策.*(硬气|软弱|搞笑|离谱|折腾|恶心|荒唐|草台|割韭菜|昏招)/,
  /(朝廷|官老爷|有关部门|公权力|官媒|新华社|人民日报|央视新闻|纪委|网信办)/,
  // 评论区与控评、封口言论（今天群里触发的雷区）
  /评论区.*(精选|全是精选|关闭|翻车|控评|清空|放不出)/,
  /精选评论|精选区|全是精选|控评|删评|一条也?没放|放不出来|不让评论|关评论|不让说话/,
  /言论管制|因言获罪|文字狱|封口|禁言封号|(?:被|请去|叫去|抓去)喝茶|国保|晶哥|黑皮狗|黑皮条子/,
  /影响团结|唱赞歌|舆论引导|网评员|五毛|自干五/,
];

// ── 3. 极端暴力、犯罪与负面社会事件 ────────────────────────
const VIOLENCE_PATTERNS = [
  /自杀|自残|跳楼|割腕|烧炭|自焚/,
  /报复社会|献忠|刀人|随机砍人|投毒|灭门|炸药|炸弹制作|枪支/,
  /恐怖袭击|人质|劫持|邪教|吸毒|毒品交易/,
];

// ── 4. 群体攻击与争议对立 ──────────────────────────────────
const SOCIAL_CONFLICT_PATTERNS = [
  /女权|男权|女拳|田园女权|性别对立|厌女|仇男/,
  /低端人口|(?:中国人|外国人).*(?:劣根|该死|恶心|低贱|全都是垃圾)/,
  /地域黑|地图炮|外地逼|捞翔|硬盘人|(?:河南人|东北人).*(?:偷|劣根|没素质|都是)/,
  /穆斯林|伊斯兰|极端宗教|宗教极端|原教旨|圣战/,
  /俄乌|巴以|哈马斯|加沙|以色列|核战争/,
];

// ── 5. 模型内部语法与工具调用泄漏（DSML/XML/特殊Token） ──────────
const MODEL_SYNTAX_PATTERNS = [
  /<[｜|][\s\S]*?[｜|]>/,
  /<\/?(?:calls|invoke|parameter|tool_call|function)\b/i,
  /\bDSML\b/i,
  /\binvoke\s+name=/i,
  /<think>/i,
];

// 硬阻断汇总
const ALL_HARD_PATTERNS = [
  ...POLITICS_PATTERNS,
  ...POLICY_AND_CENSORSHIP_PATTERNS,
  ...VIOLENCE_PATTERNS,
];

// 完整拦截词库（包含群体对立与模型语法泄漏）
const OUTPUT_BLOCK = [
  ...ALL_HARD_PATTERNS,
  ...SOCIAL_CONFLICT_PATTERNS,
  ...MODEL_SYNTAX_PATTERNS,
];

function test(patterns, text) {
  const s = String(text || '');
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[0];
  }
  return null;
}

/**
 * 输入检测：群友发的内容是否涉及高危涉政或控评议题
 * 如果命中，建议小鱼主动潜水闭嘴，绝不参与讨论或接茬
 */
export function checkInput(text) {
  const hit = test(ALL_HARD_PATTERNS, text);
  if (hit) {
    return { ok: false, hit, why: `输入涉及高危议题（${hit}）` };
  }
  return { ok: true };
}

/**
 * 输出检测：小鱼准备发出的话是否安全
 * 一旦命中，必须坚决掐断，绝不发往 QQ 或转 TTS
 */
export function checkOutput(text, { strict = true } = {}) {
  const hit = test(OUTPUT_BLOCK, text);
  if (hit) {
    return { ok: false, hit, why: `输出包含敏感/风控内容（${hit}）` };
  }
  return { ok: true };
}

/**
 * 视频检测：B站/抖音等短视频标题和简介安全审核
 */
export function checkVideo(v) {
  const blob = [v?.title, v?.up, v?.desc, ...(v?.tags || [])].filter(Boolean).join(' ');
  const hit = test(ALL_HARD_PATTERNS, blob);
  if (hit) return { ok: false, level: 'hard', hit, why: `题材不该碰（${hit}）` };
  const soft = test(SOCIAL_CONFLICT_PATTERNS, blob);
  if (soft) return { ok: true, level: 'soft', hit: soft, why: `可以看但不说话（${soft}）` };
  return { ok: true, level: 'clean' };
}

/**
 * 给提示词用的约束片段
 */
export const SAFETY_RULES =
  '【绝对安全红线（违反立刻封号）】\\n' +
  '1. 政治、领导人、国家体制、法律法规、公权力机关及其政策通报，一律不谈、不评、不附和。\\n' +
  '2. 绝不讨论或调侃任何“评论区精选、控评、删帖、封号、言论管制”等话题。\\n' +
  '3. 遇到别人聊这类敏感时事，你直接当没看见或换个日常轻松话题（吃什么、玩什么、天气）。\\n' +
  '4. 绝不评价群体、不搞男女/地域对立。你只是一条可爱的居家小肥鱼。';

/**
 * 清除所有模型内部工具调用语法、思考链、DSML 标签，防止内部语法泄漏到 QQ 聊天中
 */
export function cleanAllToolArtifacts(text) {
  let s = String(text || '');

  // 1. 清除模型思维链与系统提醒标签
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '');
  // 清理明文思考过程、自我对话与指令复述（如“用户说...我就顺着...要极简...别说太长”）
  s = s.replace(/(?:思考过程|思维链|CoT|思考：|回复策略：|策略：)[\s\S]*?(?=\n\n|$|[。！？!?])/gi, '');
  s = s.replace(/用户(?:又|在|还)?说[“\"][^”\"]*?[”\"][，,、\s]*(?:我就|我先|我顺着|顺着)?[^\n。！？!?]*[。！？!?]?/g, '');
  s = s.replace(/(?:我就|我先|我顺着|顺着)(?:怼|回|接|吐槽|答)[^\n。！？!?]*[。！？!?]?/g, '');
  s = s.replace(/要(?:极简|简短|毒舌|傲娇|随性|克制|短小|可爱|短句)[^。！？!?\n]*[。！？!?]?/g, '');
  s = s.replace(/(?:别说太长|别太长|两个短句|一个短句|带个表情包|少说几句|精简一点|短句即可)[。！？!?\s]*/g, '');
  s = s.replace(/[(（](?:内心|心理|草稿|OS|思考|设定|人设|语气)[：:][^）)]*[)）]/g, '');

  // 2. 彻底清除 DeepSeek DSML 标签和整块调用结构
  s = s.replace(/<[｜|][^>]*?calls>[\s\S]*?(?:<\/[｜|][^>]*?calls>|$)/gi, '');
  s = s.replace(/<[｜|][^>]*?invoke[^>]*>[\s\S]*?(?:<\/[｜|][^>]*?invoke>|$)/gi, '');
  s = s.replace(/<invoke[^>]*>[\s\S]*?(?:<\/invoke>|$)/gi, '');
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');

  // 3. 清除所有 DeepSeek 特殊标记：<｜...｜> 与未闭合的 <｜...
  s = s.replace(/<[｜|][\s\S]*?[｜|]>/g, '');
  s = s.replace(/<\/?[｜|][^>]*>/g, '');

  // 4. 清除残留的 invoke / parameter 伪标签
  s = s.replace(/<\/?(?:calls|invoke|parameter|tool_call|function)\b[^>]*>/gi, '');
  s = s.replace(/\b(?:invoke|parameter)\s+name=["'][^"']*["'][^>]*>/gi, '');

  // 5. 清除纯代码块工具输出
  s = s.replace(/```(?:json|xml)?\s*\{[\s\S]*?\}\s*```/g, '');

  // 6. 零散清理
  s = s.replace(/<[｜|][^>]*$/g, '');
  s = s.replace(/\s*[，,、]\s*(?=[。！？!?\n]|$)/g, '');
  s = s.replace(/([。！？!?\n])\s*[，,、]/g, '$1');
  s = s.replace(/\s+[，,、]\s+/g, '，');
  s = s.replace(/^[，,、。！？!?\s]+/, '');
  s = s.replace(/[ \t]{2,}/g, ' ');

  return s.trim();
}

/**
 * 从文本中提取 DeepSeek DSML 格式的工具调用（应对模型未走标准 tool_calls API 的情况）
 */
export function parseDsmlToolCalls(text) {
  const toolCalls = [];
  if (!text || typeof text !== 'string') return toolCalls;

  const invokePattern = /<[｜|]?[^>]*?invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/[｜|]?[^>]*?invoke>|$)/gi;
  let match;
  while ((match = invokePattern.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    const args = {};
    const paramPattern = /<[｜|]?[^>]*?parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/[｜|]?[^>]*?parameter>|$)/gi;
    let pm;
    while ((pm = paramPattern.exec(body)) !== null) {
      args[pm[1]] = pm[2].replace(/<[^>]+>/g, '').trim();
    }
    toolCalls.push({
      id: 'dsml_' + Math.random().toString(36).slice(2, 9),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    });
  }
  return toolCalls;
}

export default { checkInput, checkOutput, checkVideo, cleanAllToolArtifacts, parseDsmlToolCalls, SAFETY_RULES };
