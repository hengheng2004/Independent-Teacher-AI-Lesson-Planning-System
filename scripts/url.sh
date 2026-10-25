#!/usr/bin/env bash
# 找回当前隧道的公网链接：优先问运行中的 cloudflared（最准），其次读 data/tunnel-url.txt
set -euo pipefail
cd "$(dirname "$0")/.."

PID="$(pgrep -x cloudflared | head -1 || true)"

if [ -n "$PID" ]; then
  # cloudflared 的本地指标端口是随机分配的，从监听端口反查
  MPORT="$(lsof -nP -p "$PID" -a -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | head -1)"
  if [ -n "${MPORT:-}" ]; then
    JSON="$(curl -s -m 3 "http://127.0.0.1:${MPORT}/quicktunnel" || true)"
    URL="$(printf '%s' "$JSON" | sed -n 's/.*"hostname":"\([^"]*\)".*/\1/p')"
    if [ -n "${URL:-}" ]; then
      READY="$(curl -s -m 3 "http://127.0.0.1:${MPORT}/ready" || true)"
      HTTP="$(curl -s --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' "https://${URL}/healthz" 2>/dev/null || true)"
      echo "https://${URL}"
      echo "隧道进程：在跑"
      echo "边缘连接：${READY:-未知}"
      case "$HTTP" in
        200) echo "公网访问：200，可以发给学生" ;;
        000|"") echo "公网访问：本机解析不了（DNS 可能还没生效）。清缓存：sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder" ;;
        *) echo "公网访问：HTTP ${HTTP}，还不可用" ;;
      esac
      exit 0
    fi
  fi
fi

if [ -f data/tunnel-url.txt ]; then
  echo "（隧道进程不在运行，以下是上次的链接，多半已失效）"
  cat data/tunnel-url.txt
  exit 0
fi

echo "没有找到链接。先运行 ./scripts/tunnel.sh"
exit 1
