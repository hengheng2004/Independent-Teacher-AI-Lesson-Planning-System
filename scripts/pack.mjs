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
// 目标平台：--win 打 Windows 包，默认 macOS
const TARGET = process.argv.includes('--win') ? 'win32' : 'darwin';
const ARCH = process.arch === 'arm64' && TARGET === 'darwin' ? 'arm64' : 'x64';
const PLATFORM_LABEL = TARGET === 'win32' ? 'Windows' : 'macOS';
const NAME = `独立教师AI工作台-${pkg.version}-${PLATFORM_LABEL}-${ARCH}`;
const NODE_VER = 'v26.12.1';
const RUNTIME_EXE = TARGET === 'win32' ? 'node.exe' : 'node';
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, NAME);
const NODE_ARCHIVE =
  TARGET === 'win32'
    ? `/tmp/node-${NODE_VER}-win-${ARCH}.zip`
    : `/tmp/node-${NODE_VER}-darwin-${ARCH}.tar.gz`;
const NODE_DIR =
  TARGET === 'win32' ? `/tmp/node-${NODE_VER}-win-${ARCH}` : `/tmp/node-${NODE_VER}-darwin-${ARCH}`;

const log = (s) => console.log(`  ${s}`);
const size = (p) => {
  const r = spawn('du', ['-sh', p], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  r.stdout.on('data', (d) => (out += d));
  return new Promise((res) => r.on('exit', () => res(out.split('\t')[0])));
};
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true });

function ensureNode() {
  const probe = TARGET === 'win32' ? path.join(NODE_DIR, 'node.exe') : path.join(NODE_DIR, 'bin/node');
  if (fs.existsSync(probe)) return;
  if (!fs.existsSync(NODE_ARCHIVE)) {
    const url =
      TARGET === 'win32'
        ? `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-${ARCH}.zip`
        : `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${ARCH}.tar.gz`;
    throw new Error(`缺少 Node 运行时：${NODE_ARCHIVE}\n先下载：curl -L -o ${NODE_ARCHIVE} ${url}`);
  }
  if (TARGET === 'win32') {
    spawn('unzip', ['-q', NODE_ARCHIVE, '-d', '/tmp'], { stdio: 'inherit' });
  } else {
    spawn('tar', ['xzf', NODE_ARCHIVE, '-C', '/tmp'], { stdio: 'inherit' });
  }
}

async function main() {
  console.log(`\n打包 ${NAME}\n`);
  ensureNode();

  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });

  // 1) 运行时
  fs.mkdirSync(path.join(APP, 'runtime'), { recursive: true });
  const srcExe = TARGET === 'win32' ? path.join(NODE_DIR, 'node.exe') : path.join(NODE_DIR, 'bin/node');
  copy(srcExe, path.join(APP, 'runtime', RUNTIME_EXE));
  if (TARGET !== 'win32') fs.chmodSync(path.join(APP, 'runtime', RUNTIME_EXE), 0o755);
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
  // ocr.swift 要留着：macOS 上本机 OCR 靠它现编（没有 Xcode 命令行工具时自动落到视觉模型）
  log('代码与文档');

  // 3) 依赖：只留当前平台，删掉浏览器版运行时
  const nm = path.join(APP, 'node_modules');
  copy(path.join(ROOT, 'node_modules'), nm);

  // sharp 的原生二进制是可选依赖，npm 只装当前平台的。
  // 打其它平台的包时必须手动补，否则对方机器上 import sharp 直接失败。
  const sharpPlatform = TARGET === 'win32' ? 'sharp-win32-x64' : 'sharp-darwin-arm64';
  // 先从临时目录补齐，再校验
  const extraImg = `/tmp/winimg/node_modules/@img/${sharpPlatform}`;
  if (TARGET === 'win32' && fs.existsSync(extraImg) && !fs.existsSync(path.join(nm, '@img', sharpPlatform))) {
    copy(extraImg, path.join(nm, '@img', sharpPlatform));
    const vipsSrc = path.join('/tmp/winimg/node_modules/@img', 'sharp-libvips-win32-x64');
    if (fs.existsSync(vipsSrc)) copy(vipsSrc, path.join(nm, '@img', 'sharp-libvips-win32-x64'));
  }
  if (!fs.existsSync(path.join(nm, '@img', sharpPlatform))) {
    throw new Error(
      `缺少 ${sharpPlatform}：\n` +
        `mkdir -p /tmp/winimg && cd /tmp/winimg && npm init -y\n` +
        `npm install @img/${sharpPlatform} @img/${sharpPlatform.replace('sharp', 'sharp-libvips')} --os=win32 --cpu=x64\n` +
        `然后把这些目录复制到 node_modules/@img/ 再打包`,
    );
  }

  const dropOther =
    TARGET === 'win32'
      ? ['node_modules/onnxruntime-node/bin/napi-v6/linux', 'node_modules/onnxruntime-node/bin/napi-v6/darwin']
      : ['node_modules/onnxruntime-node/bin/napi-v6/linux', 'node_modules/onnxruntime-node/bin/napi-v6/win32'];
  const prune = [
    'node_modules/onnxruntime-web',
    ...dropOther,
    ...(TARGET === 'win32'
      ? ['node_modules/@img/sharp-darwin-arm64', 'node_modules/@img/sharp-libvips-darwin-arm64']
      : []),
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

  // 3.5) 预编译本机 OCR 二进制：买家不装 Xcode 命令行工具也能用 macOS Vision
  if (TARGET === 'darwin') {
    const swiftSrc = path.join(APP, 'scripts/ocr/ocr.swift');
    fs.mkdirSync(path.join(APP, 'data/bin'), { recursive: true });
    await new Promise((resolve) => {
      const p2 = spawn('swiftc', ['-O', swiftSrc, '-o', path.join(APP, 'data/bin/ocr')], { stdio: 'inherit' });
      p2.on('exit', (c) => {
        log(c === 0 ? '本机 OCR 二进制已预编译' : '跳过预编译（本机没有 swiftc）');
        resolve();
      });
    });
  }

  // 4) 向量模型 + 示例课程 + 配置模板
  copy(path.join(ROOT, 'data/models'), path.join(APP, 'data/models'));
  log(`向量模型 ${await size(path.join(APP, 'data/models'))}`);
  fs.mkdirSync(path.join(APP, 'courses'), { recursive: true });
  copy(path.join(ROOT, 'courses/linear-algebra-demo'), path.join(APP, 'courses/linear-algebra-demo'));
  fs.mkdirSync(path.join(APP, 'config'), { recursive: true });
  copy(path.join(ROOT, 'config/courses.json'), path.join(APP, 'config/courses.json'));
  copy(path.join(ROOT, 'config/students.example.json'), path.join(APP, 'config/students.example.json'));

  // 5) 启动脚本
  if (TARGET === 'win32') {
    const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(APP, '启动.bat'), crlf(LAUNCHER_WIN));
    fs.writeFileSync(path.join(APP, '使用说明.txt'), crlf(READ_ME_WIN));
  } else {
    fs.writeFileSync(path.join(APP, '启动.command'), LAUNCHER, { mode: 0o755 });
    fs.writeFileSync(path.join(APP, '停止.command'), STOPPER, { mode: 0o755 });
    fs.writeFileSync(path.join(APP, '使用说明.txt'), READ_ME);
  }

  // 打包前安检：key、学生数据、令牌一律不该出现在包里。
  // 靠"记得删"不可靠，这里直接失败。
  const forbidden = [
    '.env',
    'data/settings.json',
    'data/admin-token.txt',
    'data/codes.md',
    'data/assistant.db',
    'data/assistant.db-wal',
    'config/students.json',
  ];
  for (const rel of forbidden) {
    if (fs.existsSync(path.join(APP, rel))) {
      throw new Error(`包里不该有 ${rel}：${path.join(APP, rel)}`);
    }
  }

  const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.txt', '.html', '.css', '.sh', '.command', '.bat', '.example']);
  const KEY_RE = /sk-[A-Za-z0-9]{16,}/;
  const leaks = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'models' || e.name === 'fonts') continue;
        walk(abs);
      } else if (TEXT_EXT.has(path.extname(e.name))) {
        const src = fs.readFileSync(abs, 'utf8');
        if (KEY_RE.test(src)) leaks.push(path.relative(APP, abs));
      }
    }
  };
  walk(APP);
  if (leaks.length) {
    throw new Error(`包里发现疑似 API key：${leaks.join(', ')}`);
  }
  log('安检通过：无 .env / 无学生数据 / 无 key');

  log(`总大小 ${await size(APP)}`);

  // 6) 压缩（用 ditto 保留可执行权限与中文文件名）
  const zip = path.join(DIST, `${NAME}.zip`);
  fs.rmSync(zip, { force: true });
  console.log('\n  压缩中…');
  await new Promise((resolve, reject) => {
    if (TARGET === 'win32') {
      const p = spawn('zip', ['-qr', zip, NAME], { cwd: DIST, stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('zip 压缩失败'))));
    } else {
      const p = spawn('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, zip], { stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('ditto 压缩失败'))));
    }
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

# 文件监听：用编辑器直接改讲义也能自动重建（网页上传本来就会触发）
./runtime/node scripts/watch.mjs >> .runtime-watch.log 2>&1 &
WATCH_PID=$!
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
trap 'kill $SERVER_PID $WATCH_PID 2>/dev/null; rm -f .runtime.pid' EXIT
wait $SERVER_PID
`;

const LAUNCHER_WIN = String.raw`@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title 独立教师 AI 工作台
cd /d "%~dp0"

if not exist .env if exist .env.example copy .env.example .env >nul

rem 挑一个空闲端口（8787 起）
set PORT=8787
:findport
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 (
  set /a PORT+=1
  if !PORT! gtr 8900 goto portfail
  goto findport
)

rem 第一次启动：建知识包与向量
if not exist packs (
  echo 第一次启动，正在建立知识索引...
  runtime\node.exe scripts\build-packs.mjs
  runtime\node.exe scripts\build-vectors.mjs
)

set TOKEN=
if exist data\admin-token.txt set /p TOKEN=<data\admin-token.txt

echo 正在启动（端口 %PORT%）...
echo 浏览器会自动打开；没打开就手动访问 http://127.0.0.1:%PORT%/teacher
start "" cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:%PORT%/teacher?token=%TOKEN%"

runtime\node.exe src\server.js

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
goto :eof

:portfail
echo 端口 8787-8900 都被占用了，请先关掉占用程序再试。
pause
`;

const READ_ME_WIN = String.raw`独立教师 AI 工作台（Windows）
================================

怎么用
------
1. 双击「启动.bat」
2. 浏览器会自动打开；如果没有，手动访问窗口里显示的地址
3. 用页面上的令牌进入工作台

想填 API key
------------
1. 用记事本打开同目录下的 .env（第一次启动后出现）
2. 找到 DEEPSEEK_API_KEY=，把 key 粘在后面
3. 关掉窗口，重新双击「启动.bat」

停止
----
关掉那个黑色窗口即可。

数据在哪
--------
courses\    课程材料与讲义
students\   学生画像
data\       数据库、令牌、学生码、向量模型
备份请整体复制这三个目录。

注意
----
- OCR：Windows 上只支持视觉模型，需要在 .env 里配 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL，
  并把 OCR_BACKEND 设为 vision。本机 OCR 依赖 macOS 的系统能力，Windows 用不了。
- 首次启动会生成 data\admin-token.txt，那是登录令牌，不要外传。
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
