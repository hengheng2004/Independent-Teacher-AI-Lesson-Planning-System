// 混合检索：词法排序 + 向量排序，用 RRF 融合。
// 两者互补：词法擅长精确术语和公式，向量擅长同义改写和跨语言；
// 任一不可用时自动退回另一路，不影响答疑。
import fs from 'node:fs';
import { packScored, rankBlocks } from './pack.js';
import { dot, embed, loadVectors, vectorsPath } from './embed.js';

const RRF_K = 60;

// 缓存 must 跟文件 mtime 走：重建向量后服务要立刻用新的，不能一直抱着旧索引
const vectorCache = new Map();
function vectorsFor(pack) {
  const courseId = pack.courseId;
  let mtime = 0;
  try {
    mtime = fs.statSync(vectorsPath(courseId)).mtimeMs;
  } catch {
    return null;
  }
  const hit = vectorCache.get(courseId);
  if (!hit || hit.mtime !== mtime) {
    vectorCache.set(courseId, { mtime, all: loadVectors(courseId) });
  }
  const all = vectorCache.get(courseId).all;
  if (!all) return null;
  const ch = all.chapters?.[pack.chapterKey];
  // 讲义改过之后向量已过期，宁可不用于是就不会拿旧语义误导
  if (!ch || ch.packVersion !== pack.packVersion) return null;
  return ch.vectors;
}

/** 纯向量排序，返回 [{pack, block, score}]，按余弦降序。 */
export async function rankByVector(packs, question, { topK = 40 } = {}) {
  const usable = packs.filter((p) => vectorsFor(p));
  if (!usable.length) return [];
  const qv = await embed(question, { query: true });

  const scored = [];
  for (const pack of usable) {
    const vectors = vectorsFor(pack);
    for (const block of [...pack.blocks, ...pack.reserved]) {
      const bv = vectors[block.id];
      if (!bv) continue;
      scored.push({ pack, block, score: dot(qv, bv) });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // 单元/章标题这类「枢纽块」语义最泛，向量上会吸走所有查询（实测把 Top1 从 35% 拉到 15%）。
  // 它们仍可被词法命中，只是不参与向量排序。
  const content = scored.filter((s) => /§|例/.test(s.block.label));
  const ranked = content.length >= 8 ? content : scored;
  return ranked.slice(0, topK);
}

/**
 * Reciprocal Rank Fusion：只看名次不看分数，避免两套分数量纲不一致。
 * 默认 0.5/0.5，可用 FUSION_VEC_WEIGHT 调整：
 *   术语密集、公式多的课（数学分析）→ 调低到 0.4，词法更准
 *   口语化、英文提问多的课          → 调高到 0.6，向量更稳
 * 改完跑 `npm run eval` 看三条指标，别凭感觉。
 */
export function fuse(lex, vec, opts = {}) {
  const wVec = Number(opts.wVec ?? process.env.FUSION_VEC_WEIGHT ?? 0.5);
  const wLex = Number(opts.wLex ?? 1 - wVec);
  const meta = new Map();
  const score = new Map();
  const bump = (list, weight) => {
    list.forEach((s, i) => {
      const id = s.block.id;
      if (!meta.has(id)) meta.set(id, { pack: s.pack, block: s.block });
      score.set(id, (score.get(id) || 0) + weight / (RRF_K + i + 1));
    });
  };
  bump(lex, wLex);
  bump(vec, wVec);
  return [...score.entries()]
    .map(([id, sc]) => ({ ...meta.get(id), score: sc }))
    .sort((a, b) => b.score - a.score);
}

export function vectorStatus(packs) {
  const ok = packs.filter((p) => vectorsFor(p)).map((p) => p.chapterKey);
  return { hasVectors: ok.length > 0, chapters: ok };
}

/**
 * 供答疑使用：有向量就走混合，没有就纯词法。
 * 返回 mode 便于后台观察到底哪条路在生效。
 */
export async function retrieveForPrompt(packs, question, opts = {}) {
  const lex = rankBlocks(packs, question);
  let vec = [];
  let mode = 'lexical';
  let note = '';

  try {
    vec = await rankByVector(packs, question);
    if (vec.length) mode = 'hybrid';
    else note = 'no-vectors';
  } catch (e) {
    note = `vector-failed:${e.message}`;
  }

  const ranked = vec.length ? fuse(lex, vec, opts) : lex;
  const out = packScored(ranked, opts);
  return { ...out, mode, note, lexCount: lex.length, vecCount: vec.length };
}
