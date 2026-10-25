// 备课/审查 agent：组装提示词、解析"带路径的代码块"、算上下文预算。
import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_DIR } from './pack.js';

const AGENTS_DIR = path.join(SERVICE_DIR, 'agents');
const MAX_TOTAL_CHARS = 16000;
const MAX_PER_FILE = 8000;

export const AGENT_LABEL = { prep: '备课', review: '审查' };

export function loadAgentPrompt(kind) {
  const file = path.join(AGENTS_DIR, kind === 'review' ? 'review-agent.md' : 'prep-agent.md');
  if (!fs.existsSync(file)) throw new Error(`缺少 agent 定义：${path.relative(SERVICE_DIR, file)}`);
  return fs.readFileSync(file, 'utf8');
}

/** 附件按段落截断，返回 {text, truncated, used} */
export function buildAttachmentBlock(attachments) {
  let used = 0;
  const parts = [];
  const truncated = [];

  for (const a of attachments) {
    let text = String(a.content || '');
    if (text.length > MAX_PER_FILE) {
      text = text.slice(0, MAX_PER_FILE);
      truncated.push(a.rel);
    }
    const remain = MAX_TOTAL_CHARS - used;
    if (remain <= 200) break;
    if (text.length > remain) {
      text = text.slice(0, remain);
      truncated.push(a.rel);
    }
    used += text.length;
    parts.push(`### 附件：${a.rel}\n${text}`);
  }

  return {
    text: parts.length ? `【已附加材料】\n${parts.join('\n\n')}` : '',
    truncated: [...new Set(truncated)],
    used,
    budget: MAX_TOTAL_CHARS,
  };
}

export function buildSystemPrompt({ kind, course, chapter, chapterTitle, target }) {
  const base = loadAgentPrompt(kind);
  const lines = [
    base,
    '',
    '---',
    '',
    '## 本次工作环境',
    `课程：${course.name}（目录 courses/${course.id}/）`,
    chapter ? `章节：${chapter}${chapterTitle ? ` ${chapterTitle}` : ''}` : '章节：未指定',
    target ? `老师的目标：${target}` : '',
    '',
    `产出文件请放在 \`备课/${chapter || '第01章'}/\` 下，或用 \`质检/\` 存放报告。`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 解析模型输出里带 path= 的代码块。
 * 只接受课程目录内的相对 .md 路径。
 */
export function parseDrafts(text) {
  const src = String(text || '');
  const out = [];
  const push = (relRaw, body, truncated) => {
    const rel = relRaw.trim().replace(/^\.?\//, '');
    if (!/\.md$/i.test(rel)) return;
    if (rel.startsWith('/') || rel.includes('..')) return;
    if (!/^(备课|质检)\//.test(rel) && rel.includes('/')) return;
    const content = body.replace(/\s+$/, '') + '\n';
    out.push({ rel, content, lines: content.split('\n').length - 1, truncated });
  };

  // 完整的围栏
  const re = /```[a-zA-Z]*\s+path=([^\s`]+)\s*\r?\n([\s\S]*?)```/g;
  let m;
  const consumed = [];
  while ((m = re.exec(src))) {
    push(m[1], m[2], false);
    consumed.push([m.index, m.index + m[0].length]);
  }

  // 被 max_tokens 截断、结尾没闭合的围栏：把剩余内容也当草稿，并标记 truncated
  const openRe = /```[a-zA-Z]*\s+path=([^\s`]+)\s*\r?\n([\s\S]*)$/g;
  while ((m = openRe.exec(src))) {
    const at = m.index;
    if (consumed.some(([a, b]) => at >= a && at < b)) continue;
    push(m[1], m[2], true);
  }
  return out;
}

/** 去掉代码块后的聊天正文，用于界面展示。 */
export function stripDrafts(text) {
  return String(text || '')
    .replace(/```[a-zA-Z]*\s+path=[^\s`]+\s*\r?\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 简单行级 diff，供界面展示。 */
export function diffLines(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) out.push({ type: 'same', text: a[i] ?? '' });
    else {
      if (a[i] !== undefined) out.push({ type: 'del', text: a[i] });
      if (b[i] !== undefined) out.push({ type: 'add', text: b[i] });
    }
  }
  return out;
}
