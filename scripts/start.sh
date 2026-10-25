#!/usr/bin/env bash
# 启动助教服务（保持不休眠，Ctrl+C 停止）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已生成 .env（从 .env.example）。填好 DEEPSEEK_API_KEY 后重新运行本脚本。"
fi

if [ ! -d packs ] || [ -z "$(ls -A packs 2>/dev/null)" ]; then
  echo "→ 首次运行，构建知识包"
  node scripts/build-packs.mjs
fi

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8787}"

echo
echo "本地地址：http://127.0.0.1:${PORT}"
echo "外网地址：另开一个终端运行 scripts/tunnel.sh"
echo "教师后台：http://127.0.0.1:${PORT}/admin"
echo

# -i 防止空闲休眠，-s 防止接电源时系统睡眠；合盖仍会断，学生夜里提问请用 VPS 方案
exec caffeinate -is node src/server.js
