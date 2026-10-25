#!/usr/bin/env node
// 检索评测：同一批问法，比较「纯词法」「纯向量」「混合」三种检索。
// 真值用块编号（ch18-S7 这种），不看标题字符串，避免措辞差异影响判断。
import { loadCourseConfig, loadPacks, rankBlocks } from '../src/pack.js';
import { fuse, rankByVector } from '../src/search.js';

const course = loadCourseConfig().courses.find((c) => c.enabled);
const packs = loadPacks(course.id);

// [问法, 合格的块编号（命中任意一个算对）]
const PROBES = [
  ['什么是向量空间', ['ch1-S3']],
  ['子空间怎么判断', ['ch1-S4']],
  ['怎么判断线性相关', ['ch1-S6']],
  ['基和维数是什么', ['ch1-S7']],
  ['过渡矩阵怎么求', ['ch1-S8']],
  ['直和的维数公式', ['ch1-S9']],
  ['张成空间是什么意思', ['ch1-S5']],
  ['线性无关的定义', ['ch1-S6']],
  ['R^3 里 x+y+z=0 是子空间吗', ['ch1-S11', 'ch1-S4']],
  ['what is linear independence', ['ch1-S6']],
  ['这玩意儿为啥三个向量就相关了啊', ['ch1-S6']],
  ['坐标变换公式怎么写', ['ch1-S8']],
  ['交集维数怎么算', ['ch1-S9']],
  ['判断子空间最容易错在哪', ['ch1-S10']],
  ['行最简形怎么读出基', ['ch1-S7']],
  ['例题里怎么证线性无关', ['ch1-S14']],
  ['八条公理哪几条要单独验证', ['ch1-S3']],
  ['chapter summary', ['ch1-S19', 'ch1-S2']],
];

const hit = (ranked, ids, k) => ranked.slice(0, k).some((s) => ids.includes(s.block.id));

async function evaluate(mode) {
  const rows = [];
  for (const [q, ids] of PROBES) {
    const lex = rankBlocks(packs, q);
    const vec = await rankByVector(packs, q);
    let ranked = lex;
    if (mode === 'vector') ranked = vec.length ? vec : lex;
    if (mode === 'hybrid') ranked = vec.length ? fuse(lex, vec) : lex;

    rows.push({
      q,
      ids,
      top1: hit(ranked, ids, 1),
      top3: hit(ranked, ids, 3),
      top12: hit(ranked, ids, 12),
      got: ranked[0] ? `${ranked[0].block.id} ${ranked[0].block.label.slice(0, 34)}` : '（无结果）',
      empty: ranked.length === 0,
    });
  }

  const n = rows.length;
  const pct = (f) => `${((rows.filter(f).length / n) * 100).toFixed(0)}%`;
  console.log(
    `${mode.padEnd(8)} Top1 ${pct((r) => r.top1).padStart(4)} | Top3 ${pct((r) => r.top3).padStart(4)} | 进注入集 ${pct((r) => r.top12).padStart(4)} | 空结果 ${rows.filter((r) => r.empty).length}`,
  );
  return rows;
}

console.log(`=== 检索评测：${PROBES.length} 条探针 ===`);
const lex = await evaluate('lexical');
const vec = await evaluate('vector');
const hyb = await evaluate('hybrid');

console.log('\n--- 混合模式仍未进前 3 的 ---');
for (const r of hyb.filter((r) => !r.top3)) {
  console.log(`  ✗ ${r.q}\n     期望 ${r.ids.join('/')}，实际第一 ${r.got}`);
}

const better = hyb.filter((r, i) => r.top3 && !lex[i].top3).length;
const worse = hyb.filter((r, i) => !r.top3 && lex[i].top3).length;
console.log(`\n混合 vs 词法：多命中 ${better} 条，丢命中 ${worse} 条。`);
