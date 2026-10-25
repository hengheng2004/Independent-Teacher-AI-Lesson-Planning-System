#!/usr/bin/env node
// 讲义一变就自动重建：知识包（毫秒级）+ 向量（只重建改过的章节）。
// 用法：npm run watch —— 和 npm start 并行跑，或者由 start.sh 一起拉起来。
import fs from 'node:fs';
import path from 'node:path';
import { COURSE_LIB, WORKSPACE, loadCourseConfig, loadPacks, buildCoursePacks } from '../src/pack.js';
import { buildVectorsFor } from '../src/vectors.js';

const DEBOUNCE_MS = Number(process.env.WATCH_DEBOUNCE_MS || 1500);

// 这些是构建产物，改了不该触发重建，否则自己触发自己（无限循环）
const IGNORE = [/\/助教\//, /知识包清单\.md$/, /\.tmp-/, /~$/, /\.DS_Store$/];

let timer = null;
let running = false;
let dirty = false;

async function rebuild(reason) {
  if (running) {
    dirty = true;
    return;
  }
  running = true;
  dirty = false;
  const t0 = Date.now();
  try {
    const config = loadCourseConfig();
    for (const course of config.courses.filter((c) => c.enabled)) {
      const r = buildCoursePacks(course);
      const packs = r.packs;
      if (!packs.length) continue;
      console.log(
        `[watch] ${course.id}：${packs.length} 章知识包重建完成，向量增量更新中…（${reason}）`,
      );
      const v = await buildVectorsFor(course.id, { packs, onlyStale: true });
      console.log(
        `[watch] ${course.id}：向量 ${v.built ? `新建 ${v.built} 章` : '全部复用'}${v.reused ? `，复用 ${v.reused} 章` : ''}（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
      );
    }
  } catch (e) {
    console.error(`[watch] 重建失败：${e.message}`);
  } finally {
    running = false;
    if (dirty) schedule('有排队中的改动');
  }
}

function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(reason), DEBOUNCE_MS);
}

function ensureDir() {
  if (!fs.existsSync(COURSE_LIB)) {
    fs.mkdirSync(COURSE_LIB, { recursive: true });
    console.log(`[watch] 已创建课程目录 ${path.relative(WORKSPACE, COURSE_LIB)}`);
  }
}

ensureDir();
console.log(`[watch] 监听 ${path.relative(WORKSPACE, COURSE_LIB)}/ 下的讲义改动（防抖 ${DEBOUNCE_MS}ms）`);
console.log('[watch] 改完文件保存即可，无需手动重建；Ctrl+C 停止');

// 先跑一次增量，避免启动时状态就是旧的
await rebuild('启动检查');

fs.watch(COURSE_LIB, { recursive: true }, (event, filename) => {
  if (!filename) return;
  const p = filename.toString();
  if (IGNORE.some((re) => re.test(p))) return;
  schedule(p);
});

process.on('SIGINT', () => {
  console.log('\n[watch] 停止监听');
  process.exit(0);
});
