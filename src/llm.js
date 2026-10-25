// 模型调用：deepseek / 任意 OpenAI 兼容端点 / mock。
// 没有 key 时用 mock，链路、引用校验和留痕都能跑通，只是答案是占位内容。
const TIMEOUT_MS = 90_000;

function pickProvider(env) {
  const p = (env.LLM_PROVIDER || 'auto').toLowerCase();
  if (p !== 'auto') return p;
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) return 'openai';
  if (env.DEEPSEEK_API_KEY) return 'deepseek';
  return 'mock';
}

async function postJSON(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型接口 ${res.status}：${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export function createLLM(env = process.env) {
  const provider = pickProvider(env);

  if (provider === 'mock') {
    return {
      provider: 'mock',
      supportsVision: false,
      async complete({ system, user }) {
        const idMatch = /\[\[([a-z0-9]+-S\d+)\]\]/.exec(user);
        const labelMatch = new RegExp(`${idMatch?.[1]}\\s+([^\\n]+)`).exec(user);
        const id = idMatch?.[1] || 'MOCK-S1';
        const label = labelMatch?.[1] || '讲义片段';
        return {
          text: [
            `【提示】这条问题对应讲义里的「${label}」。`,
            '',
            '先别急着算，问自己两件事：这题要用的定理或定义，前提条件是否都满足？你要证的是“存在”还是“算出具体值”？',
            '',
            '下一步建议：把题目条件逐条对照定理前提写下来，缺哪条就先补哪条。',
            '',
            '（当前是 mock 模型，只验证链路，不是真答案。配置 API key 后即为真实回答。）',
            '',
            `[[${id}]]`,
          ].join('\n'),
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
      // 备课对话的 mock：给一份可解析的草稿，用来验证「解析 → diff → 应用」链路
      async chat({ onDelta } = {}) {
        const text = [
          '（mock 模型：这是占位讲义，用来验证界面链路，不是真内容。）',
          '',
          '先说结构：本节要解决什么、先修检查、知识主线、例题、易错点。',
          '',
          '```markdown path=备课/第01章/第01章_教师讲义.md',
          '# 第 01 章 教师讲义（mock）',
          '',
          '## 本节要解决什么',
          '演示用占位内容。',
          '',
          '## 例题',
          '**例 1.1-1**　占位题干。',
          '```',
        ].join('\n');
        if (onDelta) onDelta(text);
        return { text, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }

  const cfg =
    provider === 'deepseek'
      ? {
          url: 'https://api.deepseek.com/chat/completions',
          key: env.DEEPSEEK_API_KEY,
          model: env.DEEPSEEK_MODEL || 'deepseek-chat',
        }
      : {
          url: `${(env.OPENAI_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`,
          key: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL || 'gpt-4o-mini',
        };

  if (!cfg.key) throw new Error(`LLM_PROVIDER=${provider} 但没有配置对应 API key`);
  if (!cfg.url.startsWith('http')) throw new Error('OPENAI_BASE_URL 未配置或格式不对');

  return {
    provider,
    model: cfg.model,
    // DeepSeek 目前没有视觉模型；OpenAI 兼容端点按模型名粗判
    supportsVision: provider !== 'deepseek' && /vl|vision|gpt-4o|gpt-4\.1|gemini|claude/i.test(cfg.model || ''),
    async complete({ system, user, maxTokens = 1300 }) {
      const data = await postJSON(
        cfg.url,
        { authorization: `Bearer ${cfg.key}` },
        {
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
          max_tokens: maxTokens,
          stream: false,
        },
      );
      const text = data?.choices?.[0]?.message?.content ?? '';
      return {
        text,
        usage: {
          input_tokens: data?.usage?.prompt_tokens ?? 0,
          output_tokens: data?.usage?.completion_tokens ?? 0,
        },
      };
    },

    /**
     * 备课对话：多轮消息，可选流式。
     * 流式时每来一段就调 onDelta(text)；厂商不支持 SSE 时自动退回一次性返回。
     */
    async chat({ messages, maxTokens = 2400, stream = false, onDelta }) {
      const body = {
        model: cfg.model,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: Boolean(stream),
      };

      if (!stream || !onDelta) {
        const data = await postJSON(cfg.url, { authorization: `Bearer ${cfg.key}` }, body);
        const text = data?.choices?.[0]?.message?.content ?? '';
        return {
          text,
          streamed: false,
          usage: {
            input_tokens: data?.usage?.prompt_tokens ?? 0,
            output_tokens: data?.usage?.completion_tokens ?? 0,
          },
        };
      }

      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(`模型接口 ${res.status}：${t.slice(0, 300)}`);
      }

      // 有些兼容端点无视 stream 直接返回 JSON，这里兜住
      if (!(res.headers.get('content-type') || '').includes('event-stream')) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content ?? '';
        onDelta(text);
        return { text, streamed: false, usage: {} };
      }

      let acc = '';
      let buffered = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content || '';
            if (delta) {
              acc += delta;
              onDelta(delta);
            }
          } catch {
            // 半包 JSON，等下一块
          }
        }
      }
      return { text: acc, streamed: true, usage: {} };
    },
  };
}
