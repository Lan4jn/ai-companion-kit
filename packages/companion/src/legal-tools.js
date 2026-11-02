/**
 * 法律知识库工具模块 · 中国核心法律法规速查
 * ─────────────────────────────────────────────────────────────
 * 支持本地全文智能检索：
 *   - 《宪法》公民基本权利与义务
 *   - 《民法典》（总则、物权、合同、人格权、婚姻家庭、继承、侵权责任）
 *   - 《刑法》（正当防卫、故意伤害、盗窃、诈骗、帮信罪、危险驾驶罪）
 *   - 《劳动法》《劳动合同法》（加班费基数、试用期、经济补偿金N/2N、辞退维权）
 *   - 《治安管理处罚法》（行政拘留、殴打他人、寻衅滋事、侵权责任）
 *   - 《消费者权益保护法》（七天无理由退货、退一赔三、食品假一赔十、霸王条款）
 *   - 《个人信息保护法》《网络安全法》（隐私保护、网络侵权证据保全）
 *   - 《道路交通安全法》（酒驾醉驾标准、事故责任划分、逃逸后果）
 *   - 诉讼时效与维权热线（12348、12333、12315、12345）
 */
import fs from 'node:fs';
import path from 'node:path';

const LAW_FILE = path.resolve(new URL('../knowledge/chinese_laws.md', import.meta.url).pathname);

export const LEGAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'legal_lookup',
      description: '检索中国常用法律法规知识库（涵盖民法典、刑法、劳动法/劳动合同法、治安管理处罚法、消费者权益保护法、个人信息保护法、交通法规与维权诉讼指引），获取精准法条、赔偿标准与法律实务建议。当用户询问法律、合同纠纷、劳动仲裁、消费维权或违法处罚时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索主题或关键词，例如：“劳动合同经济补偿金N和2N”、“试用期辞退”、“七天无理由退货”、“退一赔三”、“假一赔十”、“醉驾标准与处罚”、“故意伤害罪轻伤立案标准”、“帮信罪”、“诉讼时效”'
          }
        },
        required: ['query']
      }
    }
  }
];

export async function executeLegalTool(name, args = {}) {
  if (name !== 'legal_lookup') return { status: 'unknown_tool', message: '未知的法律工具' };

  const query = String(args.query || '').trim();
  if (!query) return { status: 'error', message: '查询关键词不能为空' };

  let content = '';
  try {
    content = fs.readFileSync(LAW_FILE, 'utf8');
  } catch (e) {
    return { status: 'error', message: '读取法律知识库文件失败: ' + e.message };
  }

  // 按章节切分文档
  const sections = content.split(/\n(?=##\s+)/);
  const keywords = query.toLowerCase().split(/[\s,，、]+/g).filter(Boolean);

  let bestMatches = [];
  for (const sec of sections) {
    let score = 0;
    const secLower = sec.toLowerCase();
    for (const kw of keywords) {
      if (secLower.includes(kw)) score += 10;
    }
    // 标题加权
    const titleLine = sec.split('\n')[0] || '';
    for (const kw of keywords) {
      if (titleLine.toLowerCase().includes(kw)) score += 30;
    }
    if (score > 0) {
      bestMatches.push({ score, sec });
    }
  }

  bestMatches.sort((a, b) => b.score - a.score);

  if (bestMatches.length > 0) {
    const topSections = bestMatches.slice(0, 2).map(m => m.sec.trim()).join('\n\n---\n\n');
    return {
      status: 'success',
      query,
      result: topSections
    };
  }

  // 如果没有精确匹配，返回目录和常用维权指引
  const fallback = sections[0] + '\n\n' + (sections.find(s => s.includes('司法实务维权小锦囊')) || '');
  return {
    status: 'partial',
    query,
    result: `未能精确匹配到关于「${query}」的特定章节，以下为相关法条总览与常用维权渠道：\n\n${fallback.slice(0, 1500)}`
  };
}

export default { LEGAL_TOOLS, executeLegalTool };
