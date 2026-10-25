// 知识包：构建、切块、词法检索。
// 设计要点：学生端知识包在“构建期”就只允许收录白名单文件；
// 教师版讲义、答案 PDF 根本不进包，因此不依赖提示词去防泄漏。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SERVICE_DIR = path.resolve(import.meta.dirname, '..');
// 本仓库里服务就是根目录：课程在 ./courses，学生在 ./students
export const WORKSPACE = SERVICE_DIR;
export const PACKS_DIR = path.join(SERVICE_DIR, 'packs');
export const COURSE_LIB = path.join(WORKSPACE, 'courses');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function loadCourseConfig() {
  return JSON.parse(fs.readFileSync(path.join(SERVICE_DIR, 'config/courses.json'), 'utf8'));
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 黑名单匹配规则（故意做得可预测）：
 * - 模式里带 `/` → 匹配相对路径（如 `资料/参考书/*`）
 * - 模式里不带 `/` → 只匹配文件名，避免目录名 `备课/` 误伤学生的 `..._学生讲义.md`
 */
export function isDenied(relPath, denyGlobs = []) {
  const full = relPath.split(path.sep).join('/');
  const base = full.split('/').pop();
  return denyGlobs.some((g) => {
    const re = globToRegExp(g);
    return g.includes('/') ? re.test(full) : re.test(base);
  });
}

/** 把 Markdown 讲义切成可引用的块，块编号形如 ch18-S7。 */
export function chunkMarkdown(md, chapterKey) {
  const lines = md.split(/\r?\n/);
  const raw = [];
  let cur = null;
  let unit = '';
  let section = '';

  const flush = () => {
    if (cur && cur.lines.join('\n').trim()) raw.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    const ex = /^\*\*\s*例\s*([0-9]+\.[0-9]+-[0-9]+)\s*\*\*/.exec(line);

    if (h1) {
      flush();
      unit = h1[1].trim();
      section = '';
      cur = { unit, section, example: '', lines: [line] };
      continue;
    }
    if (h2) {
      flush();
      section = h2[1].trim();
      cur = { unit, section, example: '', lines: [line] };
      continue;
    }
    if (ex) {
      flush();
      cur = { unit, section, example: ex[1], lines: [line] };
      continue;
    }
    if (!cur) cur = { unit, section, example: '', lines: [] };
    cur.lines.push(line);
  }
  flush();

  const sectionTag = (name) => {
    const n = (name || '').trim();
    if (!n) return '';
    if (/^\d/.test(n)) return '§' + n;
    return n;
  };

  // 过短的块并入上一块，避免“学习目标”这类碎片单独成为一个引用目标
  const merged = [];
  for (const b of raw) {
    const text = b.lines.join('\n').trim();
    const prev = merged[merged.length - 1];
    if (text.length < 120 && prev && prev.unit === b.unit && !b.example && !prev.example) {
      prev.lines.push(...b.lines);
      continue;
    }
    merged.push(b);
  }

  // 过长的块在空行处再切，避免单块吃掉整个上下文预算
  const expanded = [];
  const MAX = 5000;
  for (const b of merged) {
    const text = b.lines.join('\n').trim();
    if (text.length <= MAX) {
      expanded.push(b);
      continue;
    }
    let buf = [];
    const parts = [];
    for (const line of b.lines) {
      buf.push(line);
      if (buf.join('\n').length >= MAX && line.trim() === '') {
        parts.push(buf);
        buf = [];
      }
    }
    if (buf.length) parts.push(buf);
    for (const p of parts) expanded.push({ ...b, lines: p });
  }

  const blocks = [];
  let n = 0;
  for (const b of expanded) {
    const text = b.lines.join('\n').trim();
    if (!text) continue;
    n += 1;
    const labelParts = [];
    if (b.unit) labelParts.push(b.unit.replace(/\s*[（(]§\s*\d+[）)]\s*$/, '').trim());
    const st = sectionTag(b.section);
    if (st) labelParts.push(st);
    if (b.example) labelParts.push('例' + b.example);
    blocks.push({
      id: `${chapterKey}-S${n}`,
      label: labelParts.join(' · ') || `${chapterKey} 片段 ${n}`,
      chars: text.length,
      text,
    });
  }
  return blocks;
}

export function buildCoursePacks(course, { log = () => {} } = {}) {
  const courseDir = path.join(COURSE_LIB, course.id);
  const outDir = path.join(PACKS_DIR, course.id);
  fs.mkdirSync(outDir, { recursive: true });

  const packs = [];
  const included = [];
  const excluded = [];

  for (const chapter of course.chapters || []) {
    const blocks = [];
    const sources = [];

    for (const rel of chapter.sources || []) {
      if (isDenied(rel, course.denyGlobs)) {
        throw new Error(`拒绝构建：${rel} 命中黑名单，学生版知识包不允许收录该文件`);
      }
      const abs = path.join(courseDir, rel);
      if (!fs.existsSync(abs)) throw new Error(`缺少讲义文件：${rel}`);
      const buf = fs.readFileSync(abs);
      const md = buf.toString('utf8');
      const chBlocks = chunkMarkdown(md, chapter.key);
      blocks.push(...chBlocks);
      sources.push({ path: rel, sha256: sha256(buf), blocks: chBlocks.length, kind: 'student_handout' });
      included.push({ chapter: chapter.key, path: rel, blocks: chBlocks.length });
      log(`  ${chapter.key} ← ${rel}（${chBlocks.length} 块）`);
    }

    // 资料清单作为页码对照块，引用格式统一
    const reserved = [];
    for (const rel of course.references || []) {
      const abs = path.join(courseDir, rel);
      if (!fs.existsSync(abs)) continue;
      const buf = fs.readFileSync(abs);
      reserved.push({
        id: `${chapter.key}-R1`,
        label: '资料清单（材料别名与页码对照）',
        chars: buf.toString('utf8').length,
        text: buf.toString('utf8'),
      });
      sources.push({ path: rel, sha256: sha256(buf), kind: 'reference' });
      included.push({ chapter: chapter.key, path: rel, blocks: 1 });
    }
    for (const rel of course.errata || []) {
      const abs = path.join(courseDir, rel);
      if (!fs.existsSync(abs)) continue;
      const buf = fs.readFileSync(abs);
      reserved.push({
        id: `${chapter.key}-E1`,
        label: '待确认与勘误（已确认的错误以此为准）',
        chars: buf.toString('utf8').length,
        text: buf.toString('utf8'),
      });
      sources.push({ path: rel, sha256: sha256(buf), kind: 'errata' });
    }

    if (!blocks.length) {
      excluded.push({ chapter: chapter.key, reason: '没有可收录的学生版讲义' });
      continue;
    }

    const packVersion = sha256(JSON.stringify(sources.map((s) => [s.path, s.sha256]))).slice(0, 12);
    const pack = {
      courseId: course.id,
      courseName: course.name,
      teacher: course.teacher,
      policy: course.policy,
      chapterKey: chapter.key,
      chapterTitle: chapter.title,
      packVersion,
      builtAt: new Date().toISOString(),
      sources,
      blocks,
      reserved,
      toc: blocks.map((b) => `${b.id} ${b.label}`),
    };
    fs.writeFileSync(path.join(outDir, `${chapter.key}.json`), JSON.stringify(pack, null, 2));
    packs.push(pack);
  }

  return { packs, included, excluded };
}

/** 文章目录与清单写入课程库，便于人工核对“哪些进了学生端”。 */
export function writeCourseManifest(course, result) {
  const dir = path.join(COURSE_LIB, course.id, '助教');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    `# 知识包清单｜${course.name}`,
    '',
    `生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}（由 \`04_助教服务\` 构建，请勿手改）`,
    '',
    '## 已进入学生端知识包',
    '',
    '| 章节 | 来源文件 | 可引用块数 |',
    '| --- | --- | --- |',
  ];
  for (const item of result.included) {
    lines.push(`| \`${item.chapter}\` | \`${item.path}\` | ${item.blocks} |`);
  }
  lines.push('', '## 明确排除', '');
  lines.push('以下内容**不在**学生端检索范围内（构建期物理排除，不是靠提示词约束）：', '');
  for (const g of course.denyGlobs || []) lines.push(`- 命中黑名单 \`${g}\``);
  for (const e of result.excluded) lines.push(`- \`${e.chapter}\`：${e.reason}`);
  lines.push('', '## 说明', '');
  for (const n of course.notes || []) lines.push(`- ${n}`);
  lines.push('');
  fs.writeFileSync(path.join(dir, '知识包清单.md'), lines.join('\n'));
  return path.join(dir, '知识包清单.md');
}

// ---------- 检索 ----------

export function terms(s) {
  const out = new Set();
  const cleaned = String(s)
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if (/^[a-zA-Z0-9]+$/.test(token)) {
      if (token.length <= 24) out.add(token.toLowerCase());
      continue;
    }
    for (let i = 0; i + 2 <= token.length; i += 1) out.add(token.slice(i, i + 2));
  }
  return out;
}

const indexCache = new Map();
function indexOf(pack) {
  const key = `${pack.courseId}/${pack.chapterKey}/${pack.packVersion}`;
  if (indexCache.has(key)) return indexCache.get(key);
  const all = [...pack.blocks, ...pack.reserved];
  const idx = all.map((b) => ({ block: b, terms: terms(b.text + ' ' + b.label) }));
  indexCache.set(key, idx);
  return idx;
}

/**
 * 词法排序：中文按二元组、英文按词，命中数与块长度归一化。
 * 单独抽出来，是为了让向量检索能在同一批候选上做融合排序。
 */
export function rankBlocks(packs, question) {
  const qTerms = [...terms(question)];
  if (!qTerms.length) return [];

  const scored = [];
  for (const pack of packs) {
    for (const { block, terms: bt } of indexOf(pack)) {
      let hit = 0;
      let labelHit = 0;
      const labelTerms = terms(block.label);
      for (const t of qTerms) {
        if (bt.has(t)) hit += 1;
        if (labelTerms.has(t)) labelHit += 1;
      }
      if (!hit) continue;
      const score = (hit + labelHit * 2) / (1 + Math.log1p(block.chars / 400));
      scored.push({ pack, block, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** 按预算挑选并编排成 packsUsed；资料清单与勘误永远随包附带。 */
export function packScored(scored, { budget = 14000, maxBlocks = 12 } = {}) {
  const picked = [];
  const used = new Set();
  let total = 0;
  for (const s of scored) {
    if (picked.length >= maxBlocks) break;
    const id = `${s.pack.chapterKey}/${s.block.id}`;
    if (used.has(id)) continue;
    if (total + s.block.chars > budget) continue;
    used.add(id);
    picked.push(s);
    total += s.block.chars;
  }

  const packsUsed = new Map();
  for (const s of picked) {
    const entry = packsUsed.get(s.pack.chapterKey) || { pack: s.pack, blocks: [] };
    entry.blocks.push(s.block);
    packsUsed.set(s.pack.chapterKey, entry);
  }
  for (const entry of packsUsed.values()) {
    for (const b of entry.pack.reserved) {
      if (entry.blocks.some((x) => x.id === b.id)) continue;
      entry.blocks.push(b);
    }
  }

  return { packsUsed: [...packsUsed.values()], totalChars: total };
}

/** 纯词法检索：向量不可用时的兜底，也是评测基线。 */
export function retrieve(packs, question, opts = {}) {
  return packScored(rankBlocks(packs, question), opts);
}

export function loadPacks(courseId) {
  const dir = path.join(PACKS_DIR, courseId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'vectors.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
