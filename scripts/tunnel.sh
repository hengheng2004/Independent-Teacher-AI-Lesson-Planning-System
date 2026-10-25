#!/usr/bin/env bash
# 临时公网隧道（免费、无需域名、关机即失效）
# 链接会同时打印在屏幕上、写进 data/tunnel-url.txt，事后可随时用 scripts/url.sh 找回
# 正式用请换：cloudflared tunnel create + 自有域名，或香港轻量 VPS
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d ' ' || true)"
PORT="${PORT:-8787}"
LOG="$PWD/data/tunnel.log"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "未安装 cloudflared，先执行：brew install cloudflared"
  exit 1
fi

if ! curl -sf -m 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
  echo "本地服务没起来，先在另一个终端运行 scripts/start.sh"
  exit 1
fi

mkdir -p data
: > "$LOG"

echo "正在连接 Cloudflare……"
# 有些网络封了 7844 的 UDP（QUIC），此时用 TUNNEL_PROTOCOL=http2 走 TCP
PROTOCOL="${TUNNEL_PROTOCOL:-quic}"
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --protocol "$PROTOCOL" --no-autoupdate > "$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "40 秒内没拿到链接，最后 10 行日志："
  tail -10 "$LOG"
  exit 1
fi

echo "$URL" > data/tunnel-url.txt

# 等边缘真正连上（quick tunnel 刚建好时访问会返回 1033 / DNS 未生效）
# 注意 --noproxy '*'：系统代理往往不放行 *.trycloudflare.com，会冤枉成"隧道坏了"
HOST="${URL#https://}"
STATUS=""
for _ in $(seq 1 30); do
  STATUS="$(curl -s --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' "${URL}/healthz" 2>/dev/null || true)"
  [ "$STATUS" = "200" ] && break
  # DNS 还没生效时先等，别急着报错
  sleep 3
done

echo
echo "  公网链接： ${URL}"
echo
echo "    学生打开： ${URL}"
echo "    自己打开： ${URL}/admin"
if [ "$STATUS" = "200" ]; then
  echo "    连通性：  已就绪（公网访问返回 200）"
else
  echo "    连通性：  暂未就绪（curl 返回 ${STATUS:-无法解析}）"
  echo
  if ! dscacheutil -q host -a name "$HOST" 2>/dev/null | grep -q ip_address; then
    echo "  本机 DNS 查不到这个域名：quick tunnel 的域名要几十秒才生效，等一下再运行 ./scripts/url.sh 复查。"
    echo "  若一直查不到，清一下本机 DNS 缓存："
    echo "    sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder"
  else
    echo "  域名能解析但访问不通，多半是 Cloudflare 边缘连不上（7844 被封）。依次试："
    echo "    1) 把 TUN / 全局代理关掉再试（TUN 会抢走 cloudflared 的连接）"
    echo "    2) TUNNEL_PROTOCOL=http2 ./scripts/tunnel.sh"
    echo "    3) 换 ngrok（走 443），或把服务放到香港 VPS 上"
  fi
  echo "  连接详情：${LOG}"
fi
echo
echo "  链接已写入 data/tunnel-url.txt；忘了就运行 ./scripts/url.sh"
echo "  这个窗口要一直开着。Ctrl+C 停止隧道，链接随即失效，下次会换一个新的。"
echo "  日志：data/tunnel.log"
echo

wait "$PID"
