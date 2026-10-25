#!/usr/bin/env node
// 打包成"解压双击即用"的绿色包（macOS）。
//
//   npm run pack
//   → dist/独立教师AI工作台-<版本>-macOS-<arch>.zip
//
// 包内自带：Node 运行时、依赖（已裁掉其它平台与浏览器版运行时）、向量模型、示例课程、
// 双击启动脚本、首启配置。目标是对方机器上不需要装任何东西。
//
// 为什么不用 Homebrew 的 node：它依赖 /opt/homebrew 下的 libnode 等 dylib，
// 换台机器就找不到；官方 dist 的二进制是自包含的。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const NAME = `独立教师AI工作台-${pkg.version}-macOS-${ARCH}`;
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, NAME);
const NODE_TARBALL = `/tmp/node-v26.12.1-darwin-${ARCH}.tar.gz`;
const NODE_DIR = `/tmp/node-v26.12.1-darwin-${ARCH}`;

const log = (s) => console.log(`  ${s}`);
const size = (p) => {
  const r = spawn('du', ['-sh', p], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  r.stdout.on('data', (d) => (out += d));
  return new Promise((res) => r.on('exit', () => res(out.split('\t')[0])));
};
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true });

function ensureNode() {
  if (fs.existsSync(path.join(NODE_DIR, 'bin/node'))) return;
  if (!fs.existsSync(NODE_TARBALL)) {
    throw new Error(
      `缺少 Node 运行时：${NODE_TARBALL}\n` +
        `先下载：curl -L -o ${NODE_TARBALL} https://nodejs.org/dist/latest-v26.x/node-v26.12.1-darwin-${ARCH}.tar.gz\n` +
        `然后：tar xzf ${NODE_TARBALL} -C /tmp`,
    );
  }
  spawn('tar', ['xzf', NODE_TARBALL, '-C', '/tmp'], { stdio: 'inherit' });
}

async function main() {
  console.log(`\n打包 ${NAME}\n`);
  ensureNode();

  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });

  // 1) 运行时
  fs.mkdirSync(path.join(APP, 'runtime'), { recursive: true });
  copy(path.join(NODE_DIR, 'bin/node'), path.join(APP, 'runtime/node'));
  fs.chmodSync(path.join(APP, 'runtime/node'), 0o755);
  log(`Node 运行时 ${await size(path.join(APP, 'runtime/node'))}`);

  // 2) 代码与资源（不带 .git、测试、构建产物）
  const include = ['src', 'scripts', 'agents', 'package.json', 'README.md', 'LICENSE', 'docs/配置指南.html', '.env.example'];
  for (const rel of include) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) continue;
    copy(from, path.join(APP, rel));
  }
  // 打包脚本自己不需要（对方不开发）
  fs.rmSync(path.join(APP, 'scripts/pack.mjs'), { force: true });
  fs.rmSync(path.join(APP, 'scripts/ocr/ocr.swift'), { force: true }); // 编译不了就别留，OCR 走视觉模型
  log('代码与文档');

  // 3) 依赖：只留当前平台，删掉浏览器版运行时
  const nm = path.join(APP, 'node_modules');
  copy(path.join(ROOT, 'node_modules'), nm);
  const prune = [
    'node_modules/onnxruntime-web',
    'node_modules/onnxruntime-node/bin/napi-v6/linux',
    'node_modules/onnxruntime-node/bin/napi-v6/win32',
    'node_modules/@img/sharp-linux-x64',
    'node_modules/@img/sharp-linux-arm64',
    'node_modules/@img/sharp-win32-x64',
    'node_modules/@img/sharp-darwin-x64',
  ];
  let saved = 0;
  for (const rel of prune) {
    const p = path.join(APP, rel);
    if (!fs.existsSync(p)) continue;
    const before = fs.statSync(p).isDirectory() ? fs.readdirSync(p).length : 1;
    fs.rmSync(p, { recursive: true, force: true });
    saved += before;
  }
  log(`依赖（已裁剪 ${saved} 个目录）${await size(nm)}`);

  // 4) 向量模型 + 示例课程 + 配置模板
  copy(path.join(ROOT, 'data/models'), path.join(APP, 'data/models'));
  log(`向量模型 ${await size(path.join(APP, 'data/models'))}`);
  fs.mkdirSync(path.join(APP, 'courses'), { recursive: true });
  copy(path.join(ROOT, 'courses/linear-algebra-demo'), path.join(APP, 'courses/linear-algebra-demo'));
  fs.mkdirSync(path.join(APP, 'config'), { recursive: true });
  copy(path.join(ROOT, 'config/courses.json'), path.join(APP, 'config/courses.json'));
  copy(path.join(ROOT, 'config/students.example.json'), path.join(APP, 'config/students.example.json'));

  // 5) 启动脚本
  fs.writeFileSync(path.join(APP, '启动.command'), LAUNCHER, { mode: 0o755 });
  fs.writeFileSync(path.join(APP, '停止.command'), STOPPER, { mode: 0o755 });
  fs.writeFileSync(path.join(APP, '使用说明.txt'), READ_ME);

  log(`总大小 ${await size(APP)}`);

  // 6) 压缩（用 ditto 保留可执行权限与中文文件名）
  const zip = path.join(DIST, `${NAME}.zip`);
  fs.rmSync(zip, { force: true });
  console.log('\n  压缩中…');
  await new Promise((resolve, reject) => {
    const p = spawn('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, zip], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('ditto 压缩失败'))));
  });
  console.log(`\n完成：${path.relative(ROOT, zip)}（${await size(zip)}）\n`);
}

const LAUNCHER = `#!/bin/bash
# 双击启动。第一次运行会自动生成配置并打开浏览器。
cd "$(dirname "$0")" || exit 1

# 双击启动时 LANG 可能为空，显式设成 UTF-8，避免中文与变量解析出错
export LANG="\${LANG:-zh_CN.UTF-8}"

APP_URL_FILE=".runtime-url"

# 首次运行：生成 .env
if [ ! -f .env ]; then
  cp .env.example .env 2>/dev/null || true
  echo "已生成 .env —— 如需填 API key，请编辑 .env 后重启。"
fi

# 选一个空闲端口（8787 起，被占用就往后找）
PORT=8787
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done
export PORT

# 首次运行：建知识包与向量（约几秒；模型随包附带）
if [ ! -d packs ] || [ -z "$(ls -A packs 2>/dev/null)" ]; then
  echo "第一次启动，正在建立知识索引…"
  ./runtime/node scripts/build-packs.mjs > /dev/null 2>&1
  ./runtime/node scripts/build-vectors.mjs 2>&1 | tail -3
fi

echo "正在启动（端口 \${PORT}）…"
./runtime/node src/server.js > .runtime.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > .runtime.pid

# 等服务就绪
for i in $(seq 1 40); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

TOKEN=$(cat data/admin-token.txt 2>/dev/null)
URL="http://127.0.0.1:\${PORT}/teacher"
[ -n "$TOKEN" ] && URL="$URL?token=$TOKEN"
echo "$URL" > "$APP_URL_FILE"

echo "工作台：$URL"
open "$URL" 2>/dev/null || echo "请手动打开上面的地址"

echo
echo "服务在运行（PID \${SERVER_PID}）。关掉这个窗口或按 Ctrl+C 停止。"
trap 'kill $SERVER_PID 2>/dev/null; rm -f .runtime.pid' EXIT
wait $SERVER_PID
`;

const STOPPER = `#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [ -f .runtime.pid ]; then
  kill "$(cat .runtime.pid)" 2>/dev/null && echo "已停止"
  rm -f .runtime.pid
else
  echo "没有记录到运行中的服务（可能已关闭）"
fi
`;

const READ_ME = `独立教师 AI 工作台
==================

怎么用
------
1. 双击「启动.command」
2. 等浏览器自动打开（第一次可能会问是否允许，选允许）
3. 用页面上的令牌进入工作台

想填 API key（让 AI 真正回答，而不是占位内容）
------
1. 用文本编辑打开同目录下的 .env（第一次启动后才会出现）
2. 找到 DEEPSEEK_API_KEY= 这一行，把 key 粘贴在后面
3. 关掉启动窗口，重新双击「启动.command」

停止
----
关掉启动窗口，或双击「停止.command」。

数据在哪
--------
courses/    课程材料与讲义
students/   学生画像
data/       数据库、令牌、学生码、向量模型
备份请整体复制这三个目录。

注意
----
- 这个包只支持 macOS ${process.arch === 'arm64' ? 'Apple 芯片' : 'Intel'}。
- 首次启动会生成 data/admin-token.txt，那是你的登录令牌，不要外传。
- 扫描版 PDF 的 OCR 需要多模态模型（在 .env 里配 OPENAI_* 与 OCR_BACKEND=vision）。
`;

main().catch((e) => {
  console.error('\n打包失败：' + e.message);
  process.exit(1);
});
