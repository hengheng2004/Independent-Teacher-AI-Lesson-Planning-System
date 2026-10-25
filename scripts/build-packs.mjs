#!/usr/bin/env node
// 构建学生端知识包：只收录白名单里的学生版讲义 + 资料清单 + 勘误。
import { loadCourseConfig, buildCoursePacks, writeCourseManifest } from '../src/pack.js';

const config = loadCourseConfig();
let total = 0;
let failed = 0;

for (const course of config.courses.filter((c) => c.enabled)) {
  console.log(`\n▶ ${course.id}（${course.name}）`);
  try {
    const result = buildCoursePacks(course, { log: (m) => console.log(m) });
    const manifest = writeCourseManifest(course, result);
    for (const p of result.packs) {
      const chars = p.blocks.reduce((a, b) => a + b.chars, 0);
      console.log(`  ✓ ${p.chapterKey.padEnd(7)} ${p.blocks.length} 块 / ${chars} 字符 / 版本 ${p.packVersion}`);
      total += 1;
    }
    for (const e of result.excluded) console.log(`  - 跳过 ${e.chapter}：${e.reason}`);
    console.log(`  清单：${manifest}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${err.message}`);
  }
}

console.log(`\n完成：${total} 个章节包${failed ? `，${failed} 门课失败` : ''}。`);
if (failed) process.exitCode = 1;
