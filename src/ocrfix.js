// OCR 文本的二次校准：用文本模型修掉识别错字（下标、希腊字母、符号），不改结构、不补充内容。
//
// 为什么需要：视觉模型 / 本机 OCR 在公式、上下标、全角符号上仍会出错，
// 例如 ε_t 识别成 Ei、φ1 识别成中1、X_{t-1} 识别成 Xt-l。这些错字会直接影响检索命中。
//
// 安全约束（宁可放弃校准也不能污染原文）：
//   · 分块处理，每块单独校验
//   · 校验页标记数量不变、正文长度不塌缩（<70% 视为失败，保留原块）
//   · 模型不可用（mock / 无 key）时直接跳过

const PAGE_MARK = /^##\s*第\s*(\d+)\s*页\s*$/gm;

const SYSTEM = `你在校对一个由 OCR 识别出来的数学讲义文本。

任务：修正明显的识别错误，不要改写内容。

必须遵守：
1. 只修正「明显是识别错误」的地方：
   - 上下标：X4 → X_t、Xt-l → X_{t-1}、中1 → \\phi_1、Ei → \\varepsilon_t 这类
   - 希腊字母与数学符号：a 与 α、q 与 σ、u 与 μ、< 与 ≤
   - 全角符号、粘连的公式：$\\mathrm{X}$ 之类不要臆造
   - 中文错字：己知→已知、滯后→滞后、买际→实际
2. **不要**改写句子、不要补充缺失内容、不要添加解释、不要调整段落顺序。
3. 保留所有原有的行结构，尤其是恰好形如「## 第 N 页」的行，必须原样保留且数量不变。
4. 保留题目编号（如「1.(10分)」「16.证明…」）不变。
5. 拿不准时保持原样——错误留着比改错更安全。
6. 只输出校正后的正文，不要任何前言、说明或代码块包装。`;

function splitChunks(text, maxChars = 3500) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > maxChars && cur.length) {
      chunks.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

const countPages = (t) => (String(t).match(PAGE_MARK) || []).length;

/**
 * 校准整篇 OCR 文本。
 * @returns {{ text: string, changed: number, failed: number, skipped: boolean }}
 */
export async function fixOcrText(raw, llm, { maxChars = 3500, onProgress } = {}) {
  const text = String(raw || '');
  if (!text.trim()) return { text, changed: 0, failed: 0, skipped: true };
  if (!llm || llm.provider === 'mock') return { text, changed: 0, failed: 0, skipped: true };

  const chunks = splitChunks(text, maxChars);
  const out = [];
  let changed = 0;
  let failed = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const src = chunks[i];
    if (onProgress) onProgress(i + 1, chunks.length);
    try {
      const r = await llm.complete({ system: SYSTEM, user: src, maxTokens: Math.min(8000, 800 + src.length * 2) });
      const fixed = String(r.text || '')
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      const okPages = countPages(fixed) === countPages(src);
      const okLen = fixed.length >= src.length * 0.7;
      if (!fixed || !okPages || !okLen) {
        failed += 1;
        out.push(src);
        continue;
      }
      if (fixed !== src) changed += 1;
      out.push(fixed);
    } catch {
      failed += 1;
      out.push(src);
    }
  }

  return { text: out.join('\n'), changed, failed, skipped: false };
}
