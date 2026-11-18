// A public-looking keyword alone cannot declassify personal or conversational text.
const PRIVATE = /(?:不要|别|不用|禁止|无需|不许|不准|勿|停止|不想|不能).{0,20}(?:查|搜|联网)|(?:查|搜|联网).{0,12}(?:不要|别|不用|禁止)|(?:我|我们|你|他|她|群友|私聊|聊天记录|密码|验证码|口令|密钥|邮箱|邮件|住址|地址|电话|手机号码|身份证|账号|账户|订单|病历|病情|诊断|患了|患有|得了|抑郁症|工资|公司内部|姓名|联系人|家庭|隐私|住在|医院|患者|病人)/i;
const PUBLIC_TOPIC = /(?:影之刃零|怪物猎人荒野|RTX\s*\d{3,4}|显卡|处理器|操作系统|人工智能|太阳系|地球|月球|火星|太阳|光速|水的沸点|中华人民共和国|天气预报|汇率|黄金价格|Steam|Windows|Linux|JavaScript|Python)/i;
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
export function publicSearchQuery(text) {
  const q = String(text || '').trim();
  if (!q || q.length > 80 || searchForbidden(q) || PRIVATE.test(q) || /[\r\n@＠]|https?:|www\.|\d{5,}|[【】\[\]「」“”"'：:]/i.test(q)) return '';
  if (!/^[\p{L}\p{N}\s《》、，,。！？?·.-]+$/u.test(q)) return '';
  if (/^(?:请查一下|查一下|搜索)?\s*(?:(?:\d{4}年?\s*)?诺贝尔物理学奖(?:\s*\d{4}年?)?(?:获得者|获奖者|得主)?(?:是谁)?|(?:今天|今日|明天|明日)?\s*北京\s*天气(?:\s*(?:今天|今日|明天|明日|预报|怎么样|如何|是多少|多少度))?)[？?。]?$/.test(q)) return q;
  if (PUBLIC_QUESTION.test(q)) return q;
  const residue = q.replace(PUBLIC_TOPIC, '').replace(/(?:是多少|最新|最近|目前|现在|今日|今天|实时|今年|新闻|消息|发售|上市|发布|价格|售价|股价|汇率|天气|政策|法规|法律|规定|版本|参数|真假|辟谣|来源|出处|事实|核实|查一下|查查|查询|请查|多少|怎么回事|是否|是不是|有没有|何时|什么时候|哪年|哪天|什么时间|是谁|是什么|为什么|如何|怎么|多少度|的|有|了|吗|呢|请|给|一下|搜索|查|搜|情况|时间|日期|信息|动态|百科|知识|游戏|硬件|显存|容量|温度|速度|距离|质量|天气预报|是什么时候|？|\?|[\s《》、，,。！!·.-])/gi, '');
  return residue === '' && PUBLIC_TOPIC.test(q) ? q : '';
}
