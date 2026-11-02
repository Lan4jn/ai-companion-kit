/**
 * 实时联网搜索工具 (web_search)
 * ─────────────────────────────────────────────────────────────
 * 让小鱼在面对新游戏、发售日期、最新时事热点、数码硬件等自己拿不准的客观事实时，
 * 能够像真人一样自主上网查一下，杜绝凭空瞎编和跟群友嘴硬。
 */

export const SEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '在互联网上实时搜索最新资讯、游戏发售动态、新闻热点、百科知识或硬件价格。当被问到新游戏（如《影之刃零》等发售情况）、最新动态、具体参数、实时事实或你自己拿不准的现实问题时，优先调用此工具在线搜索，严禁凭空瞎猜。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词，尽量精炼准确，如“影之刃零 发售时间”、“RTX 5080 发售时间”等'
          }
        },
        required: ['query']
      }
    }
  }
];

/**
 * 执行联网搜索
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<{text: string, success: boolean}>}
 */
export async function executeSearchTool(name, args = {}) {
  if (name !== 'web_search') {
    return { success: false, text: `未知搜索工具: ${name}` };
  }

  const query = String(args.query || '').trim();
  if (!query) {
    return { success: false, text: '搜索关键词为空' };
  }

  console.log(`[web_search] 小鱼自主发起网络搜索: "${query}"`);

  // 首选 AnySearch API
  try {
    const apiKey = 'as_sk_d19bd7beb14590d2071c684bcf321715';
    const url = 'https://api.anysearch.com/mcp';
    const currentYear = new Date().getFullYear();
    // 如果查询词包含发售、上线、时间、最新等，自动附带当前年份增强相关度
    let finalQuery = query;
    if (/(发售|上线|上市|几号|时间|最新|出了没)/.test(query) && !query.includes(String(currentYear))) {
      finalQuery += ` ${currentYear} 最新`;
    }

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query: finalQuery, max_results: 5 }
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      const data = await res.json();
      const content = data.result?.content || [];
      const textItem = content.find((c) => c.type === 'text');
      if (textItem && textItem.text) {
        console.log(`[web_search] 搜索成功，返回长度: ${textItem.text.length}`);
        const now = new Date();
        const header = `【互联网实时搜索结果（当前真实时间为 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日，请结合此基准时间理解新闻动态）】：\n\n`;
        return { success: true, text: header + textItem.text };
      }
    }
  } catch (err) {
    console.warn(`[web_search] AnySearch 失败: ${err.message}，尝试备用搜索...`);
  }

  // 备用搜索：DuckDuckGo HTML 提取
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ddgRes = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (ddgRes.ok) {
      const html = await ddgRes.text();
      // 提取结果中的标题和摘要
      const snippets = [];
      const regex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = regex.exec(html)) !== null && snippets.length < 4) {
        const clean = m[1].replace(/<[^>]+>/g, '').trim();
        if (clean) snippets.push(clean);
      }
      if (snippets.length > 0) {
        return { success: true, text: snippets.map((s, i) => `${i + 1}. ${s}`).join('\n\n') };
      }
    }
  } catch (e) {
    console.warn(`[web_search] 备用搜索也失败: ${e.message}`);
  }

  return { success: false, text: `未找到关于 "${query}" 的相关搜索结果或网络连接超时。` };
}

export default { SEARCH_TOOLS, executeSearchTool };
