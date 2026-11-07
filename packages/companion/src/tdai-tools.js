/**
 * TencentDB Agent Memory 长期记忆接入模块（小鱼）
 * ─────────────────────────────────────────────────────────────
 * 供小鱼按需查询团队长期记忆事实，并在对话结束时异步旁路同步对话流（L0）。
 * 纯后台直连 127.0.0.1:8420，零额外延迟，不影响日常聊天与拟人性格。
 */
import fs from 'node:fs';

const CORE_URL = process.env.TDAI_CORE_URL || 'http://127.0.0.1:8420';
let USER_KEY = process.env.TDAI_USER_KEY || '';
if (!USER_KEY) {
  try {
    USER_KEY = fs.readFileSync('/root/TencentDB-Agent-Memory/deploy/global-images/.business-key', 'utf8').trim();
  } catch {}
}

const TEAM_ID = 'team-ar6anv21gr';
const AGENT_ID = 'agt-axt5xg5xev';
const USER_ID = 'usr-axp9xypc2u';

export const TDAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'tdai_search_memories',
      description: '在团队长期记忆库中检索技术决策、开发约定、项目历史或重要备忘。当老爸或群友问起严肃知识、团队规范或备忘事实时调用，日常闲聊严禁调用。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词或提问',
          },
        },
        required: ['query'],
      },
    },
  },
];

export async function executeTdaiTool(name, args = {}) {
  if (name !== 'tdai_search_memories') {
    return { success: false, text: `未知记忆工具: ${name}` };
  }
  const query = String(args.query || '').trim();
  if (!query) {
    return { success: false, text: '检索词为空' };
  }

  try {
    const res = await fetch(`${CORE_URL}/v3/atomic/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${USER_KEY || 'local'}`,
        'x-tdai-user-key': USER_KEY || 'local',
        'x-tdai-service-id': 'default',
      },
      body: JSON.stringify({
        query,
        limit: 5,
        team_id: TEAM_ID,
        agent_id: AGENT_ID,
        user_id: USER_ID,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { success: false, text: `团队记忆检索失败: HTTP ${res.status}` };
    }

    const data = await res.json();
    const items = data?.data?.items || [];
    if (!items.length) {
      const convRes = await fetch(`${CORE_URL}/v3/conversation/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${USER_KEY || 'local'}`,
          'x-tdai-user-key': USER_KEY || 'local',
          'x-tdai-service-id': 'default',
        },
        body: JSON.stringify({
          query,
          limit: 3,
          team_id: TEAM_ID,
          agent_id: AGENT_ID,
          user_id: USER_ID,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (convRes.ok) {
        const cdata = await convRes.json();
        const msgs = cdata?.data?.messages || [];
        if (msgs.length) {
          const lines = msgs.map((m) => `${m.role}：${m.content}`);
          return { success: true, text: '【检索到过往记录】：\n' + lines.join('\n') };
        }
      }
      return { success: false, text: `未检索到关于「${query}」的团队记忆。` };
    }

    const lines = items.map((it) => `· [${it.type || '事实'}] ${it.content}`);
    return { success: true, text: '【检索到团队记忆事实】：\n' + lines.join('\n') };
  } catch (e) {
    return { success: false, text: `检索异常: ${e.message}` };
  }
}

/**
 * 异步旁路归档一轮对话到 TencentDB Agent Memory L0 对话流
 * 纯 fire-and-forget，不阻塞主流程，抛错吞掉
 */
export function syncTurnToTdai({ where, who, text, reply }) {
  if (!text && !reply) return;
  setTimeout(async () => {
    try {
      const now = new Date().toISOString();
      const messages = [];
      if (text) {
        messages.push({
          role: 'user',
          content: `${who ? who + '：' : ''}${text}`,
          timestamp: now,
        });
      }
      if (reply) {
        messages.push({
          role: 'assistant',
          content: reply,
          timestamp: now,
        });
      }
      if (!messages.length) return;

      await fetch(`${CORE_URL}/v3/conversation/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${USER_KEY || 'local'}`,
          'x-tdai-user-key': USER_KEY || 'local',
          'x-tdai-service-id': 'default',
        },
        body: JSON.stringify({
          session_id: `xiaoyu-${where || 'common'}`,
          team_id: TEAM_ID,
          agent_id: AGENT_ID,
          user_id: USER_ID,
          messages,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // 静默忽略
    }
  }, 100);
}
