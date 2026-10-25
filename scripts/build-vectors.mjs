#!/usr/bin/env node
// 构建向量索引。默认全量；--only-stale 只重建讲义改过的章节（监听模式用的就是它）。
import { loadCourseConfig, loadPacks } from '../src/pack.js';
import { EMBED_DIM, EMBED_MODEL } from '../src/embed.js';
import { buildVectorsFor } from '../src/vectors.js';

const onlyStale = process.argv.includes('--only-stale');
const config = loadCourseConfig();

for (const course of config.courses.filter((c) => c.enabled)) {
  const packs = loadPacks(course.id);
  if (!packs.length) {
    console.log(`- ${course.id}：还没有知识包，先跑 build-packs`);
    continue;
  }
  console.log(`\n▶ ${course.id}（${course.name}）${onlyStale ? '［增量］' : ''}`);
  const r = await buildVectorsFor(course.id, { packs, onlyStale, log: (m) => console.log(m) });
  if (!r.built) {
    console.log(`  全部复用，无需重建（${r.reused} 章）`);
  } else {
    console.log(`  ✓ 新建 ${r.built} 章${r.reused ? `，复用 ${r.reused} 章` : ''}（模型 ${EMBED_MODEL}，${EMBED_DIM} 维）`);
  }
}
