#!/usr/bin/env bash
# 拉取本地 embedding 模型（一次性，约 23MB）
# 背景：国内直连 huggingface.co 不通；走 hf-mirror 时权重还会 302 到
# cas-bridge.xethub.hf.co，而本机 DNS 解析不了那个域名，所以用公共 DNS 取 IP 后 --resolve。
set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="${EMBED_MODEL:-Xenova/bge-small-zh-v1.5}"
MIRROR="${HF_ENDPOINT:-https://hf-mirror.com}"
OUT="data/models/${MODEL}"
BASE="${MIRROR}/${MODEL}/resolve/main"

mkdir -p "${OUT}/onnx"

CAS_IP="$(dig +short @1.1.1.1 cas-bridge.xethub.hf.co | head -1)"
if [ -z "${CAS_IP}" ]; then
  echo "取不到 cas-bridge.xethub.hf.co 的 IP，改用系统解析（可能失败）"
fi
RESOLVE=()
[ -n "${CAS_IP}" ] && RESOLVE=(--resolve "cas-bridge.xethub.hf.co:443:${CAS_IP}")

fetch() {
  local rel="$1"
  printf "  %-28s " "$rel"
  local code
  code="$(curl -sL --noproxy '*' -m 300 "${RESOLVE[@]}" -o "${OUT}/${rel}" "${BASE}/${rel}" -w '%{http_code}')"
  if [ "$code" = "200" ]; then
    echo "OK $(du -h "${OUT}/${rel}" | cut -f1)"
  else
    rm -f "${OUT}/${rel}"
    echo "跳过（HTTP $code）"
  fi
}

echo "拉取 ${MODEL} → ${OUT}"
fetch config.json
fetch tokenizer.json
fetch tokenizer_config.json
fetch special_tokens_map.json
fetch onnx/model_quantized.onnx

echo
echo "完成。运行期不再联网（embed.js 默认 allowRemoteModels=false）。"
echo "向量化：node scripts/build-vectors.mjs"
