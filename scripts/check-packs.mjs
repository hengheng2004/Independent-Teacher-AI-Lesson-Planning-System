#!/usr/bin/env node
// 构建产物体检：块编号、来源哈希、黑名单文件是否意外入包、上下文预算。
import fs from 'node:fs';
import path from 'node:path';
import { loadCourseConfig, loadPacks, isDenied, PACKS_DIR, WORKSPACE } from '../src/pack.js';

const config = loadCourseConfig();
let problems = 0;
const fail = (m) => {
  problems += 1;
  console.error(`  ✗ ${m}`);
};

for (const course of config.courses.filter((c) => c.enabled)) {
  const dir = path.join(PACKS_DIR, course.id);
  if (!fs.existsSync(dir)) {
    fail(`${course.id} 还没有构建产物，先运行 npm run build`);
    continue;
  }
  const packs = loadPacks(course.id);
  console.log(`\n▶ ${course.id}：${packs.length} 个章节包`);

  for (const pack of packs) {
    const ids = [...pack.blocks, ...pack.reserved].map((b) => b.id);
    const label = `${pack.chapterKey}`;
    if (new Set(ids).size !== ids.length) fail(`${label} 块编号重复`);
    if (!pack.blocks.length) fail(`${label} 没有正文块`);
    if (!pack.packVersion) fail(`${label} 缺版本号`);

    for (const src of pack.sources || []) {
      if (isDenied(src.path, course.denyGlobs)) fail(`${label} 收录了黑名单文件：${src.path}`);
      const abs = path.join(WORKSPACE, 'courses', course.id, src.path);
      if (!fs.existsSync(abs)) fail(`${label} 来源文件已不存在：${src.path}`);
    }

    const chars = pack.blocks.reduce((a, b) => a + b.chars, 0);
    const biggest = Math.max(...pack.blocks.map((b) => b.chars));
    console.log(`  ${label.padEnd(8)} ${pack.blocks.length} 块 / ${chars} 字符 / 最大块 ${biggest} / 版本 ${pack.packVersion}`);
    if (chars > 260000) console.log(`  ! ${label} 单章正文偏大，检索预算可能吃紧`);
  }
}

console.log(problems ? `\n发现 ${problems} 个问题。` : '\n体检通过：所有包来源可追溯、无黑名单泄漏。');
if (problems) process.exitCode = 1;
