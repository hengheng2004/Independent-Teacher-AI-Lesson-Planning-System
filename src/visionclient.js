// 视觉模型客户端：专门给 OCR 用，和聊天模型解耦。
//
// 为什么单独一份：聊天用 DeepSeek（便宜、长文好），OCR 需要视觉模型（DeepSeek 没有）。
// 如果共用一套配置，开 OCR 就得把聊天也换成 VL 模型，又贵又不擅长长文本。
//
// 配置（.env）：
//   OCR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
//   OCR_API_KEY=sk-xxx
//   OCR_MODEL=qwen-vl-max
// 三个都配了才生效；没配就回退到主模型（若主模型本身支持视觉）。
const strip = (u) => String(u || '').replace(/\/+$/, '');

export function ocrVisionClient(env = process.env) {
  const base = strip(env.OCR_BASE_URL);
  const key = env.OCR_API_KEY || env.OCR_VISION_KEY;
  const model = env.OCR_MODEL;
  if (!base || !key || !model) return null;

  return {
    provider: `vision:${new URL(base).hostname}`,
    model,
    supportsVision: true,
    async chat({ messages, maxTokens = 2000 }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`视觉模型返回 ${res.status}：${text.slice(0, 200)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('视觉模型返回的不是 JSON');
      }
      const content = data?.choices?.[0]?.message?.content ?? '';
      return Array.isArray(content)
        ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
        : content;
    },
  };
}
