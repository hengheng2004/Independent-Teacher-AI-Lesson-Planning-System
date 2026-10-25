// 备课端的材料检索：把课程里的文字材料切块，按提问挑相关的几段喂给模型。
// 学生端用的是"构建好的知识包"；备课端材料更杂（教师版、扫描件 OCR、往期讲义），
// 所以按需即时索引，不依赖 packs/。
import fs from 'node:fs';
import path from 'node:path';
import { COURSE_LIB, WORKSPACE, chunkMarkdown, terms } from './pack.js';
import { EMBED_DIM, EMBED_MODEL, embed } from './embed.js';
import { isIndexable } from './courses.js';

const MAX_CHARS_PER_BLOCK = 1200;
const cache = new Map();

/** 收集课程根目录里可读的文字（.md/.txt，以及 PDF 的 .ocr.md 伴生文件）。 */
function collectFiles(courseId) {
  const dir = path.join(COURSE_LIB, courseId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || d.name.startsWith('.')) continue;
    if (!isIndexable(d.name)) continue;
    // 扫描件 OCR 出来的文本单独标记，便于在提示里说明来源
    const isOcr = /\.ocr\.md$/i.test(d.name);
    const abs = path.join(dir, d.name);
    const st = fs.statSync(abs);
    out.push({ rel: d.name, abs, mtime: st.mtimeMs, isOcr });
  }
  return out;
}

function blocksOf(file) {
  const text = fs.readFileSync(file.abs, 'utf8');
  const chapterKey = file.rel.replace(/[^a-zA-Z0-9]+/g, '-');
  const chunks = chunkMarkdown(text, chapterKey).filter(
    // 丢掉 OCR 文件自带的标题/说明块，避免它们抢占检索结果
    (b) => b.text.length > 60 && !/^#\s*OCR 文本/.test(b.text),
  );
  return chunks.map((b) => ({
    rel: file.rel,
    label: `${file.rel} · ${b.label}`,
    text: b.text.length > MAX_CHARS_PER_BLOCK ? b.text.slice(0, MAX_CHARS_PER_BLOCK) : b.text,
    isOcr: file.isOcr,
  }));
}

/** 建索引（按文件 mtime 缓存，改了文件会自动重建）。 */
export function courseIndex(courseId) {
  const files = collectFiles(courseId);
  const stamp = files.map((f) => `${f.rel}:${f.mtime}`).join('|');
  const hit = cache.get(courseId);
  if (hit && hit.stamp === stamp) return hit.blocks;

  const blocks = [];
  for (const f of files) {
    try {
      blocks.push(...blocksOf(f));
    } catch {
      /* 读不了就跳过，不影响其它材料 */
    }
  }
  cache.set(courseId, { stamp, blocks });
  return blocks;
}

/**
 * 按提问挑出相关段落。
 * 打分：二元组命中数 / 长度归一，标题命中加权。够用且可解释，不需要向量。
 */
export function searchMaterials(courseId, query, { k = 6, budget = 7000, pages = null } = {}) {
  const blocks = courseIndex(courseId);
  if (!blocks.length) return { blocks: [], total: 0 };

  const q = [...terms(query)];
  if (!q.length) return { blocks: [], total: blocks.length };

  const scored = [];
  for (const b of blocks) {
    const bt = terms(b.text + ' ' + b.label);
    let hit = 0;
    let labelHit = 0;
    const lt = terms(b.label);
    for (const t of q) {
      if (bt.has(t)) hit += 1;
      if (lt.has(t)) labelHit += 1;
    }
    if (!hit) continue;
    let score = (hit + labelHit * 2) / (1 + Math.log1p(b.text.length / 400));
    // 对话里点名了页码（"第 12 页"），同页的段落优先
    if (pages) {
      const pm = /第 (\d+) 页/.exec(b.label);
      if (pm) {
        const n = Number(pm[1]);
        if (n >= pages.from && n <= pages.to) score *= 3;
      }
    }
    scored.push({ ...b, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const s of scored) {
    if (picked.length >= k) break;
    if (used + s.text.length > budget) continue;
    picked.push(s);
    used += s.text.length;
  }
  return { blocks: picked, total: blocks.length };
}

/* ---------------- 向量检索（与词法融合） ---------------- */

const VEC_FILE = (courseId) => path.join(WORKSPACE, 'packs', courseId, 'material-vectors.json');

/** 材料索引的指纹：文件列表 + 各自 mtime。变了就重建向量。 */
function indexStamp(courseId) {
  return collectFiles(courseId)
    .map((f) => `${f.rel}:${Math.round(f.mtime)}`)
    .join('|');
}

async function materialVectors(courseId) {
  const stamp = indexStamp(courseId);
  const file = VEC_FILE(courseId);
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (saved && saved.stamp === stamp && saved.model === EMBED_MODEL) return saved.vectors;

  const blocks = courseIndex(courseId);
  const vectors = {};
  for (let i = 0; i < blocks.length; i += 8) {
    const batch = blocks.slice(i, i + 8);
    const vecs = await embed(batch.map((b) => `${b.label}\n${b.text.slice(0, 600)}`));
    batch.forEach((b, j) => {
      vectors[`${b.rel}#${i + j}`] = vecs[j].map((x) => Math.round(x * 1e5) / 1e5);
    });
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ stamp, model: EMBED_MODEL, dim: EMBED_DIM, builtAt: new Date().toISOString(), vectors }));
  } catch {}
  return vectors;
}

/**
 * 词法 + 向量，按 RRF 融合。向量不可用时自动只用词法。
 * 返回 { blocks, total, mode } —— mode 会显示在界面上，方便判断检索是否生效。
 */
export async function searchMaterialsSmart(courseId, query, { k = 6, budget = 7000, pages = null } = {}) {
  const lex = searchMaterials(courseId, query, { k: 30, budget: 1e9, pages });
  const blocks = courseIndex(courseId);
  if (!blocks.length) return { blocks: [], total: 0, mode: 'none' };

  let vecRanked = [];
  try {
    const vectors = await materialVectors(courseId);
    const qv = await embed(query, { query: true });
    const scored = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const v = vectors[`${blocks[i].rel}#${i}`];
      if (!v) continue;
      let dotv = 0;
      for (let d = 0; d < qv.length; d += 1) dotv += qv[d] * v[d];
      scored.push({ block: blocks[i], score: dotv });
    }
    scored.sort((a, b) => b.score - a.score);
    vecRanked = scored.slice(0, 30).map((x) => x.block);
  } catch {
    /* 没有模型或建向量失败：退回纯词法 */
  }

  if (!vecRanked.length) return { ...lex, mode: 'lexical' };

  // RRF：只看名次，不看两套分数
  const K = 60;
  const score = new Map();
  const key = (b) => `${b.rel}#${b.label}`;
  lex.blocks.forEach((b, i) => score.set(key(b), (score.get(key(b)) || 0) + 1 / (K + i + 1)));
  vecRanked.forEach((b, i) => score.set(key(b), (score.get(key(b)) || 0) + 1 / (K + i + 1)));

  const byKey = new Map(blocks.map((b) => [key(b), b]));
  const fused = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k2]) => byKey.get(k2))
    .filter(Boolean);

  const picked = [];
  let used = 0;
  for (const b of fused) {
    if (picked.length >= k) break;
    if (used + b.text.length > budget) continue;
    picked.push(b);
    used += b.text.length;
  }
  return { blocks: picked, total: blocks.length, mode: 'hybrid' };
}

export function renderMaterialBlock(blocks) {
  if (!blocks.length) return '';
  const parts = blocks.map((b, i) => `[[${i + 1}]] ${b.label}${b.isOcr ? '（OCR，可能有错字）' : ''}\n${b.text}`);
  return `【材料检索摘录】（按本次提问自动挑选，共 ${blocks.length} 段）\n\n${parts.join('\n\n')}`;
}
