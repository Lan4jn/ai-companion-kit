import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

function getBaiduKey() {
  if (process.env.BAIDU_SEARCH_API_KEY) return process.env.BAIDU_SEARCH_API_KEY;
  try {
    const cfgPath = path.resolve(process.cwd(), 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.baiduSearchApiKey) return cfg.baiduSearchApiKey;
    }
  } catch {}
  return '';
}

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

  // 1. 国内直连首选：百度 AI 搜索 v2（千帆 AppBuilder 结构化 API）
  try {
    const baiduKey = getBaiduKey();
    if (!baiduKey) throw new Error('未配置 baiduSearchApiKey');
    const baiduUrl = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
    const currentYear = new Date().getFullYear();
    let finalQuery = query;
    if (/(发售|上线|上市|几号|时间|最新|出了没)/.test(query) && !query.includes(String(currentYear))) {
      finalQuery += ` ${currentYear} 最新`;
    }

    const payload = {
      messages: [{ role: 'user', content: finalQuery.slice(0, 100) }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: 5 }]
    };

    const res = await fetch(baiduUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Appbuilder-Authorization': `Bearer ${baiduKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    });

    if (res.ok) {
      const data = await res.json();
      const refs = data.references || [];
      if (refs.length > 0) {
        console.log(`[web_search] 百度 AI 搜索成功，获取 ${refs.length} 条摘要`);
        const now = new Date();
        const header = `【互联网实时搜索结果（基准时间：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日）】：\n\n`;
        const body = refs.map((r, i) => `${i + 1}. 【${r.title}】\n${r.content || ''}\n(来源: ${r.date || ''} ${r.url || ''})`).join('\n\n');
        return { success: true, text: header + body };
      }
    }
  } catch (err) {
    console.warn(`[web_search] 百度 AI 搜索通道异常: ${err.message}，尝试备用搜索...`);
  }

  // 1.5 国内免鉴权免费通道：百度百科 OpenAPI（精准破译网络流行梗、空耳、人物游戏概念）
  try {
    const cleanTerm = query.replace(/(是什么梗|到底是什么梗|是什么意思|是什么|为什么|怎么回事|梗|来源)/g, '').trim() || query;
    const baikeUrl = `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(cleanTerm)}`;
    const bRes = await fetch(baikeUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(4000)
    });
    if (bRes.ok) {
      const bData = await bRes.json();
      if (bData.abstract && bData.abstract.trim()) {
        console.log(`[web_search] 百度百科直接命中词条: 【${bData.title || cleanTerm}】`);
        const now = new Date();
        const header = `【百科实时词条检索（${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日）】：\n\n`;
        const content = `【${bData.title || cleanTerm}】\n${bData.abstract.trim()}\n(来源: ${bData.url || '百度百科'})`;
        return { success: true, text: header + content };
      }
    }
  } catch (err) {
    // 静默降级
  }

  // 2. 海外/时政备用通道：维基百科 API（通过本地 7890 局部代理）
  try {
    const wikiData = await new Promise((resolve, reject) => {
      const u = new URL('https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&utf8=1');
      const req = http.request({
        host: '127.0.0.1',
        port: 7890,
        method: 'CONNECT',
        path: `${u.hostname}:443`,
        timeout: 6000,
      });
      req.on('timeout', () => req.destroy(new Error('Proxy connect timeout')));
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return reject(new Error('Proxy CONNECT status ' + res.statusCode));
        const tlsSocket = tls.connect({ socket, servername: u.hostname, timeout: 6000 }, () => {
          const headers = [
            `GET ${u.pathname}${u.search} HTTP/1.1`,
            `Host: ${u.hostname}`,
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Connection: close',
            '',
            ''
          ].join('\r\n');
          tlsSocket.write(headers);
        });
        tlsSocket.on('timeout', () => tlsSocket.destroy(new Error('TLS socket timeout')));
        let data = '';
        tlsSocket.on('data', chunk => data += chunk);
        tlsSocket.on('end', () => {
          const bodyIdx = data.indexOf('\r\n\r\n');
          let body = bodyIdx >= 0 ? data.slice(bodyIdx + 4) : data;
          // 处理 chunked 编码
          if (data.toLowerCase().includes('transfer-encoding: chunked')) {
            body = body.replace(/^[0-9a-fA-F]+\r\n/, '').replace(/\r\n[0-9a-fA-F]+\r\n[\s\S]*$/, '');
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            // 正则二次提取 json
            const m = body.match(/\{[\s\S]*\}/);
            if (m) {
              try { return resolve(JSON.parse(m[0])); } catch {}
            }
            reject(new Error('Wikipedia JSON parse error'));
          }
        });
        tlsSocket.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

    const items = wikiData.query?.search || [];
    if (items.length > 0) {
      console.log(`[web_search] 维基代理搜索成功，获取 ${items.length} 条百科`);
      const body = items.slice(0, 4).map((it, i) => {
        const cleanSnippet = (it.snippet || '').replace(/<[^>]+>/g, '').trim();
        return `${i + 1}. 【${it.title}】：${cleanSnippet}`;
      }).join('\n\n');
      return { success: true, text: `【维基百科实时检索结果】：\n\n` + body };
    }
  } catch (err) {
    console.warn(`[web_search] 维基代理搜索通道异常: ${err.message}`);
  }

  // 3. 兜底搜索：AnySearch / 第三方接口备用
  try {
    const apiKey = 'as_sk_d19bd7beb14590d2071c684bcf321715';
    const url = 'https://api.anysearch.com/mcp';
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query, max_results: 5 }
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });

    if (res.ok) {
      const data = await res.json();
      const content = data.result?.content || [];
      const textItem = content.find((c) => c.type === 'text');
      if (textItem && textItem.text) {
        return { success: true, text: `【互联网实时搜索结果】：\n\n` + textItem.text };
      }
    }
  } catch (err) {
    console.warn(`[web_search] 兜底 AnySearch 失败: ${err.message}`);
  }

  return { success: false, text: `未找到关于 "${query}" 的相关搜索结果或网络连接超时。` };
}

export default { SEARCH_TOOLS, executeSearchTool };
