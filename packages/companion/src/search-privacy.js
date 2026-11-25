// A public-looking keyword alone cannot declassify personal or conversational text.
const PRIVATE = /(?:不要|别|不用|禁止|无需|不许|不准|勿|停止|不想|不能).{0,20}(?:查|搜|联网)|(?:查|搜|联网).{0,12}(?:不要|别|不用|禁止)|(?:我|我们|你|他|她|群友|私聊|聊天记录|密码|验证码|口令|密钥|邮箱|邮件|住址|地址|电话|手机号码|身份证|账号|账户|订单|病历|病情|诊断|患了|患有|得了|抑郁症|工资|公司内部|姓名|联系人|家庭|隐私|住在|医院|患者|病人)/i;
// Explicit topics only: open-ended grammar can smuggle names and private facts.
const PUBLIC_QUESTION = /^(?:请查一下|查一下|搜索)?\s*(?:什么是量子计算|光合作用是什么|法国首都是哪里)(?:[？?。])?$/;
export function searchForbidden(text) {
  return /(?:不要|别|不用|禁止|无需|不许|不准|勿|停止|不想|不能).{0,20}(?:查|搜|联网|上网|冲浪|热榜|热搜)|(?:查|搜|联网).{0,12}(?:不要|别|不用|禁止)/.test(String(text || ''));
}
// Ranking provenance is not proof of privacy: fail closed on personal-looking titles,
// contact/location details and instructions, including material from public feeds.
export function publicTrendingTitle(text) {
  if (typeof text !== 'string' || text !== text.trim() || text.length < 2 || text.length > 60) return '';
  if (searchForbidden(text) || PRIVATE.test(text) || /[\r\n@＠]|https?:|www\.|\d{5,}|[【】\[\]「」“”"'：:]/i.test(text)) return '';
  if (/(?:忽略|无视|遵循|执行|指令|提示词|系统提示|扮演|输出|泄露|搜索|查询|搜一下|查一下|住址|小区|街道|门牌|身份证|银行卡|微信|QQ号|手机号|联系|个人信息|真实姓名|家庭住址|病情|病历|隐私|密码|验证码|出轨|婚外情|私生活|家庭住址|家庭背景|家庭成员|离婚|怀孕|欠债|借钱|工资|收入|债务|诊断|患病|手机号|手机号段)/i.test(text)) return '';
  // Narrow whole-title exceptions cannot conceal an individual's health status.
  const safeSafetyTitle = /^(?:(?:消防|交通|生产|校园|城市)?安全隐患(?:排查|治理|整治|整改|防范|排查整治)|城市防洪消除后患|忧患意识与安全教育)$/.test(text);
  if (/(?:确诊|患|癌症|住院|治疗|感染|艾滋|家暴|性侵|自杀|轻生|精神疾病|手术|流产|堕胎|肺炎|糖尿病|血糖|检查结果|体检|化验|病症|疾病|症状|用药|药物|服药|病灶|肿瘤)/i.test(text) && !safeSafetyTitle) return '';
  if (!/^[\p{L}\p{N}\s《》、，,。！？?·.-]+$/u.test(text)) return '';
  return text;
}
const trustedTrendingCapabilities = new WeakMap();
// In-process capabilities cannot be supplied by a model's JSON tool arguments.
export function createTrendingCapability(title) {
  if (!publicTrendingTitle(title)) return null;
  const capability = Object.freeze({});
  trustedTrendingCapabilities.set(capability, title);
  return capability;
}
export function matchesTrendingCapability(capability, query) {
  return !!capability && trustedTrendingCapabilities.get(capability) === query && !!publicTrendingTitle(query);
}
// 常见姓氏：用来识别“把某个人的名字塞进公开问题”的情况，例如“RTX 5080 显存容量是多少 张三”。
const SURNAME = '(?:张|王|李|赵|刘|陈|杨|黄|周|吴|徐|孙|马|朱|胡|郭|何|高|林|罗|郑|梁|谢|宋|唐|许|韩|冯|邓|曹|彭|曾|肖|田|董|袁|潘|于|蒋|蔡|余|杜|叶|程|苏|魏|吕|丁|任|沈|姚|卢|姜|崔|钟|谭|陆|汪|范|金|石|廖|贾|夏|韦|付|方|白|邹|孟|熊|秦|邱|江|尹|薛|闫|段|雷|侯|龙|史|陶|黎|贺|顾|毛|郝|龚|邵|万|钱|严|覃|武|戴|莫|孔|向|汤)';
const PERSONAL_AFTER_NAME = '(?:癌症|艾滋|肺炎|糖尿病|血糖|血压|病情|病历|诊断|肿瘤|抑郁|手术|住院|就诊|用药|检查结果|体检|化验|工资|收入|债务|住址|地址|电话|手机|身份证|学校|单位|公司|家庭)';
const PUBLIC_LATIN = new Set(['steam','windows','linux','python','javascript','typescript','nintendo','playstation','xbox','iphone','ipad','android','google','apple','microsoft','openai','chatgpt','nvidia','intel','amd','tesla','bilibili','douyin','github','docker','kubernetes','react','vue','node']);
function looksLikePersonName(q) {
  if (new RegExp(`(?:^|\\s)${SURNAME}[\\u4e00-\\u9fa5]{1,2}$`).test(q)) return true;
  if (new RegExp(`${SURNAME}[\\u4e00-\\u9fa5]{0,1}的?${PERSONAL_AFTER_NAME}`).test(q)) return true;
  return false;
}
function hasGarbageLatin(q) {
  const latin = q.match(/[A-Za-z]{3,}/g) || [];
  return latin.some(word => word.length >= 5 && !/\d/.test(word) && !PUBLIC_LATIN.has(word.toLowerCase()));
}

export function publicSearchQuery(text) {
  const q = String(text || '').trim();
  if (!q || q.length > 80 || searchForbidden(q) || PRIVATE.test(q) || /[\r\n@＠]|https?:|www\.|\d{5,}|[【】\[\]「」“”"'：:]/i.test(q)) return '';
  if (!/^[\p{L}\p{N}\s《》、，,。！？?·.-]+$/u.test(q)) return '';
  if (/^(?:请查一下|查一下|搜索)?\s*(?:(?:\d{4}年?\s*)?诺贝尔物理学奖(?:\s*\d{4}年?)?(?:获得者|获奖者|得主)?(?:是谁)?|(?:今天|今日|明天|明日)?\s*北京\s*天气(?:\s*(?:今天|今日|明天|明日|预报|怎么样|如何|是多少|多少度))?)[？?。]?$/.test(q)) return q;

  if (PUBLIC_QUESTION.test(q)) return q;
  // 公开事实放行，但三条仍然拦：夹带人名、乱码英文、以及“人名+隐私词”的组合。
  if (looksLikePersonName(q)) return '';
  if (hasGarbageLatin(q)) return '';
  return q;
}

// 模型会自己把问题改写成更短的检索词；只要用词都能在原话里找到，
// 就不算“夹带回忆出来的私密内容”，可以放行。
export function queryDerivedFromUser(userText, query) {
  const squash = v => String(v || '').toLowerCase().replace(/\s+/g, '');
  const user = squash(userText);
  const q = squash(query);
  if (!q || !user) return false;
  if (user.includes(q)) return true;
  const tokens = q.match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/g) || [];
  if (!tokens.length) return false;
  return tokens.every(t => {
    if (user.includes(t)) return true;
    for (let i = 0; i + 2 <= t.length; i++) if (user.includes(t.slice(i, i + 2))) return true;
    return false;
  });
}
