// 本地向量化：bge-small-zh-v1.5（中文检索专用，量化后约 24MB），进程内推理，不走 API。
// 模型只在第一次用到时加载；下载不下来的话调用方会退回纯词法检索，不影响答疑。
import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_DIR } from './pack.js';

export const EMBED_MODEL = process.env.EMBED_MODEL || 'Xenova/bge-small-zh-v1.5';
export const EMBED_DIM = Number(process.env.EMBED_DIM || 512);

// bge 中文模型官方建议：查询侧加指令前缀，文档侧不加
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // 模型文件已预置在 data/models/ 下，运行期完全不联网。
      // 国内直连 huggingface.co 不通，权重还会跳到 cas-bridge.xethub.hf.co，
      // 所以这里默认只读本地；要重新下载用 scripts/fetch-model.sh。
      env.localModelPath = process.env.EMBED_LOCAL_PATH || path.join(SERVICE_DIR, 'data/models');
      env.allowRemoteModels = process.env.EMBED_ALLOW_REMOTE === '1';
      env.cacheDir = process.env.EMBED_CACHE_DIR || path.join(SERVICE_DIR, 'data/models');
      env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
      fs.mkdirSync(env.cacheDir, { recursive: true });
      return pipeline('feature-extraction', EMBED_MODEL, {
        dtype: process.env.EMBED_DTYPE || 'q8',
      });
    })();
  }
  return extractorPromise;
}

/** 返回 L2 归一化后的向量；文档和查询都用它，点积即余弦相似度。 */
/**
 * 嵌入前先洗文本：公式和 Markdown 标记对语义检索是噪声。
 * 实测同一块「§2.5 反函数组定理」，原始 LaTeX 正文相似度 0.529，清洗后 0.639，
 * 只嵌标题能到 0.671——所以既清洗、又把正文截到前 600 字。
 */
export function cleanForEmbed(text) {
  return String(text || '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' 公式 ')
    .replace(/\$[^$\n]{1,200}\$/g, ' 符号 ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/[|>`]/g, ' ')
    .replace(/(符号\s*){2,}/g, '符号 ')
    .replace(/(公式\s*){2,}/g, '公式 ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function embed(texts, { query = false } = {}) {
  const ex = await getExtractor();
  const single = !Array.isArray(texts);
  const input = (single ? [texts] : texts).map((t) => {
    const cleaned = cleanForEmbed(t);
    return query ? QUERY_PREFIX + cleaned : cleaned;
  });
  const out = await ex(input, { pooling: 'mean', normalize: true });
  const list = out.tolist();
  return single ? list[0] : list;
}

export async function embedderAvailable() {
  try {
    await embed('测试', { query: true });
    return true;
  } catch (e) {
    return false;
  }
}

/** 向量文件：packs/<课程>/vectors.json，按章节存，记录 packVersion 以便讲义改动后自动失效。 */
export function vectorsPath(courseId) {
  return path.join(SERVICE_DIR, 'packs', courseId, 'vectors.json');
}

export function loadVectors(courseId) {
  const f = vectorsPath(courseId);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}
