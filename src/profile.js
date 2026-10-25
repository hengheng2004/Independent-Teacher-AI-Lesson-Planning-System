// 学生画像：文件是唯一真相，服务只负责读写与提供素材。
// 画像落在 students/<学生目录>/学生画像.md，任何编辑器都能改；
// 后台只是编辑入口，删掉服务也不会丢数据。
import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_DIR, WORKSPACE } from './pack.js';
import { KIND_LABEL } from './intent.js';

// 测试可用 TA_PROJECTS_DIR / TA_BACKUP_DIR 指到临时目录
const PROJECTS_DIR = process.env.TA_PROJECTS_DIR || path.join(WORKSPACE, 'students');
const PROFILE_FILE = '学生画像.md';
const BACKUP_DIR = process.env.TA_BACKUP_DIR || path.join(SERVICE_DIR, 'data/profile-backups');
const MAX_BYTES = 200 * 1024;

export function profileTemplate(student, courseName = '') {
  return `# ${student.name} · 学生画像

> 老师手动维护。服务只在后台读写这个文件，不自动改写内容。
> 自动摘要（可选，来自答疑记录）只是一份素材，删掉不影响任何功能。

更新：${new Date().toISOString().slice(0, 10)}

## 基本情况

- 学校 / 课程：${courseName}
- 年级 / 专业：
- 基础（先修课掌握情况）：
- 目标与时间：${student.label || ''}

## 兴趣与动机

- 对什么反应快、愿意多聊：
- 什么情况下会放弃或走神：
- 学这门课的真实目的（考试 / 保研 / 转专业 / 工作）：

## 教学中的问题

- 反复出现的错误类型（概念 / 方法选择 / 运算 / 证明 / 表达）：
- 哪个知识点反复讲不通：
- 有效的讲法（例子 / 画图 / 反例 / 类比）：
- 无效或引起反感的讲法：

## 互动特点

- 提问方式（一上来就要答案 / 先说自己的思路 / 只发截图）：
- 节奏与情绪：
- 需要提醒的习惯（书写规范、检查、时间分配）：

## 待验证

-
`;
}

/** 学生 → 画像文件路径；没配 project 就返回 null，不猜目录。 */
export function profilePath(student) {
  const project = String(student?.project || '').trim();
  if (!project) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(project)) throw new Error(`学生项目编号不合法：${project}`);
  const dir = path.resolve(PROJECTS_DIR, project);
  if (!dir.startsWith(path.resolve(PROJECTS_DIR) + path.sep)) throw new Error('画像路径越界');
  return path.join(dir, PROFILE_FILE);
}

export function readProfile(student, { courseName = '' } = {}) {
  const file = profilePath(student);
  if (!file) {
    return {
      exists: false,
      path: null,
      markdown: '',
      reason: '这名学生还没有绑定学生项目编号，先在 add-student 时加 --project，或直接改 config/students.json 的 project 字段。',
    };
  }
  const exists = fs.existsSync(file);
  return {
    exists,
    path: path.relative(WORKSPACE, file),
    markdown: exists ? fs.readFileSync(file, 'utf8') : profileTemplate(student, courseName),
  };
}

/** 原子写入：先写临时文件再 rename，避免写一半被 iCloud 同步截断；旧版本留一份备份。 */
export function writeProfile(student, markdown) {
  const file = profilePath(student);
  if (!file) throw new Error('这名学生还没有绑定学生项目编号');
  const text = String(markdown ?? '');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('画像内容超过 200KB，请精简');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(BACKUP_DIR, `${student.name}-${stamp}.md`));
  }

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { path: path.relative(WORKSPACE, file), bytes: Buffer.byteLength(text) };
}

// ---------- 自动摘要：只统计、不判断，给老师提供事实素材 ----------

const STOP = new Set([
  '怎么','什么','为什','么样','这个','那个','可以','是不','不是','老师','一下','请问','帮我','这道','道题','我们','就是',
  '还是','没有','时候','如果','所以','因为','但是','然后','现在','应该','需要','一个','这样','那样','多少','如何','哪里','的时',
]);

function terms(text) {
  const clean = String(text).replace(/\\[a-zA-Z]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  const out = [];
  for (let i = 0; i + 2 <= clean.length; i += 1) out.push(clean.slice(i, i + 2));
  return out;
}

export function buildDigest(store, student, { days = 60 } = {}) {
  const rows = store.listByStudent(student.name, { sinceDays: days, limit: 300 });
  const byKind = {};
  const byChapter = {};
  const freq = new Map();
  let unresolved = 0;

  for (const r of rows) {
    byKind[r.mode] = (byKind[r.mode] || 0) + 1;
    for (const ch of String(r.chapters || '').split(',').filter(Boolean)) byChapter[ch] = (byChapter[ch] || 0) + 1;
    if (r.status === 'unanswered' || r.status === 'uncited') unresolved += 1;
    const seen = new Set();
    for (const t of terms(r.question)) {
      if (seen.has(t) || STOP.has(t)) continue;
      seen.add(t);
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }

  const topTerms = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t, c]) => `${t}（${c}）`);

  return {
    days,
    total: rows.length,
    byKind: Object.entries(byKind).map(([k, c]) => ({ kind: k, label: KIND_LABEL[k] || k, count: c })),
    byChapter,
    unresolved,
    topTerms,
    recent: rows.slice(0, 6).map((r) => ({
      date: r.created_at.slice(0, 10),
      kind: KIND_LABEL[r.mode] || r.mode,
      status: r.status,
      question: r.question.length > 60 ? r.question.slice(0, 60) + '…' : r.question,
    })),
  };
}

/** 把统计结果渲染成一段可直接粘进画像的 Markdown。 */
export function digestMarkdown(digest) {
  if (!digest.total) return '_近 60 天还没有答疑记录。_';
  const kinds = digest.byKind.map((k) => `${k.label} ${k.count}`).join('，') || '—';
  const chapters = Object.entries(digest.byChapter)
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${k} ${c}`)
    .join('，');
  const lines = [
    `- 近 ${digest.days} 天提问：${digest.total} 条（${kinds}）`,
    `- 章节分布：${chapters || '—'}`,
    `- 待老师补答：${digest.unresolved} 条`,
    digest.topTerms.length ? `- 高频词：${digest.topTerms.join('、')}` : '',
    '',
    '最近提问：',
    ...digest.recent.map((r) => `- ${r.date}［${r.kind}］${r.question}`),
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/** 生成草稿：模板 + 自动摘要（明确标注可删）。 */
export function profileDraft(student, digest, { courseName = '' } = {}) {
  const base = profileTemplate(student, courseName);
  return `${base}
## 自动摘要（可删）

> 下面这段由答疑记录统计生成，只陈述事实，不含判断。看完可以把有用的挪到上面，然后删掉这段。

${digestMarkdown(digest)}
`;
}
