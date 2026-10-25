// 向量索引构建：脚本和文件监听共用同一套逻辑。
// 支持增量：只给 packVersion 变了的章节重新算向量，没改过的章节直接复用。
import fs from 'node:fs';
import { EMBED_DIM, EMBED_MODEL, embed, loadVectors, vectorsPath } from './embed.js';

const BATCH = 8;

/**
 * 为单门课程建索引。
 * @param {string} courseId
 * @param {{packs: object[], onlyStale?: boolean, log?: Function}} opts
 *   onlyStale=true 时，只处理 packVersion 与现有 vectors.json 不一致的章节。
 */
export async function buildVectorsFor(courseId, { packs, onlyStale = false, log = () => {} } = {}) {
  if (!packs || !packs.length) return { built: 0, reused: 0, skipped: 0 };

  const existing = onlyStale ? loadVectors(courseId) : null;
  const out = {
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    builtAt: new Date().toISOString(),
    chapters: {},
  };
  let built = 0;
  let reused = 0;

  for (const pack of packs) {
    const prev = existing?.chapters?.[pack.chapterKey];
    // 复用的前提：讲义没变，**且**向量模型没变。
    // 只比对 packVersion 会漏掉换模型的情况——维度不同，点积出来的分数是垃圾。
    const sameModel = existing?.model === EMBED_MODEL;
    if (onlyStale && sameModel && prev && prev.packVersion === pack.packVersion) {
      out.chapters[pack.chapterKey] = prev;
      reused += 1;
      continue;
    }

    const items = [...pack.blocks, ...pack.reserved];
    const vectors = {};
    const t0 = Date.now();

    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      // 文档侧不加查询指令前缀。
      // 只嵌「标题 + 正文前 600 字」：整块正文会把标题的语义稀释掉，
      // 实测问“反函数组定理”时整块得分 0.514，截断后 0.551，只用标题 0.671。
      const texts = batch.map((b) => `${b.label}\n${b.text.slice(0, 600)}`);
      const vecs = await embed(texts);
      batch.forEach((b, j) => {
        vectors[b.id] = vecs[j].map((x) => Math.round(x * 1e5) / 1e5);
      });
    }

    out.chapters[pack.chapterKey] = {
      packVersion: pack.packVersion,
      title: pack.chapterTitle,
      vectors,
    };
    built += 1;
    log(`  ${pack.chapterKey.padEnd(8)} ${items.length} 块 → 向量完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }

  if (!built) return { built: 0, reused, skipped: packs.length - reused };

  fs.writeFileSync(vectorsPath(courseId), JSON.stringify(out));
  return { built, reused, skipped: 0 };
}
