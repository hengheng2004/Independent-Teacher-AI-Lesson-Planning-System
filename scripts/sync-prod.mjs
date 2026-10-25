#!/usr/bin/env node
// 把源码仓库的代码同步到运行目录，并重启两个实例。
// 只同步代码与文档，绝不动 courses/ students/ config/ data/。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.env.TARGET_DIR || '/Volumes/外接硬盘/my/辅导备课系统';
const DIRS = ['src', 'scripts', 'agents', 'test', 'docs', 'deploy'];
const FILES = ['package.json', 'README.md', 'LICENSE', '.env.example'];

if (!fs.existsSync(TARGET)) {
  console.error(`找不到目标目录：${TARGET}`);
  process.exit(1);
}

let n = 0;
for (const dir of DIRS) {
  const from = path.join(SRC, dir);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(TARGET, dir), { recursive: true });
  n += 1;
}
for (const f of FILES) {
  const from = path.join(SRC, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(TARGET, f));
}
console.log(`已同步 ${n} 个目录 + ${FILES.length} 个文件 → ${TARGET}`);

// 重启正式环境（launchd）
try {
  execSync(`launchctl kickstart -k gui/${process.getuid()}/com.teacher.ai`, { stdio: 'inherit' });
  console.log('正式环境已重启（8787）');
} catch {
  console.log('正式环境重启失败，手动执行：launchctl kickstart -k gui/$(id -u)/com.teacher.ai');
}

// 重启演示实例（8799）
try {
  execSync("pkill -f 'PORT=8799' || true", { stdio: 'ignore' });
  execSync(`lsof -ti :8799 | xargs -r kill || true`, { stdio: 'ignore' });
  execSync(`cd "${SRC}" && (PORT=8799 node src/server.js > /tmp/demo.log 2>&1 &)`, { stdio: 'ignore' });
  console.log('演示实例已重启（8799）');
} catch {
  console.log('演示实例重启失败，手动执行：cd 源码目录 && PORT=8799 node src/server.js');
}
