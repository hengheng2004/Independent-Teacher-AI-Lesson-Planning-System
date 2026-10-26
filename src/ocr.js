// 扫描版 PDF 的取字：两条路，跨平台可切换。
//
//   local  —— 本机 OCR（macOS 用 Vision，Linux/其他用 tesseract），不花钱、离线、快
//   vision —— 把页面渲染成图，交给多模态大模型转写；跨平台、公式表格更准，但按 token 计费
//
// 默认 auto：macOS 有 Vision 走 local，否则有视觉模型走 vision，都没有就明确报错。
//
// 关键设计：**不默认全量**。可以只识别用到的页（--pages 3-12），
// 或由对话里提到的页码驱动，边聊边识别。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageCount as pdfPageCount, renderPages as pdfRenderPages } from './pdfrender.js';
import { ocrVisionClient } from './visionclient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COURSES = path.join(ROOT, 'courses');
const OCR_SWIFT = path.join(ROOT, 'scripts/ocr/ocr.swift');
const OCR_BIN = path.join(ROOT, 'data/bin/ocr');

const has = (cmd) =>
  new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    p.on('exit', (c) => resolve(c === 0));
  });

export function parsePages(spec, total) {
  if (!spec) return { from: 1, to: total };
  const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(String(spec).trim());
  if (!m) return { from: 1, to: total };
  const from = Math.max(1, Number(m[1]));
  const to = Math.min(total, Number(m[2] || m[1]));
  return { from, to };
}

/** 从一句话里认出"第 3 页 / 第 10–15 页 / p12"这类页码提示。 */
export function pagesFromText(text) {
  const s = String(text || '');
  const m = /第\s*(\d{1,3})\s*(?:[-–~到至]\s*(\d{1,3}))?\s*页/.exec(s) || /p(?:age)?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2] || m[1]);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

async function pdfPages(pdf) {
  // 用 PDFium（WASM）读页数：不依赖 Spotlight、poppler 或任何外部命令，
  // macOS / Linux / Windows 同一套代码。
  try {
    return await pdfPageCount(pdf);
  } catch {
    return null;
  }
}

function compile(src, bin) {
  // 预编译二进制（打包时生成）优先：只要它存在且不比源码旧，就不需要 swiftc
  if (fs.existsSync(bin)) {
    const srcOk = fs.existsSync(src);
    if (!srcOk || fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve();
  }
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('swiftc 编译失败'))));
  });
}

/* ---------------- local：本机 OCR ---------------- */

async function localAvailable() {
  // macOS：优先用随包附带的预编译二进制；没有才尝试用 swiftc 现编。
  // 这样买家不装 Xcode 命令行工具也能用本机 OCR。
  if (process.platform === 'darwin') {
    if (fs.existsSync(OCR_BIN)) return true;
    return has('swiftc');
  }
  return has('tesseract');
}

async function ocrLocal({ pdf, from, to, onProgress }) {
  if (process.platform === 'darwin') {
    await compile(OCR_SWIFT, OCR_BIN);
    const part = pdf.replace(/\.pdf$/i, '.local.md');
    await new Promise((resolve, reject) => {
      const p = spawn(OCR_BIN, [pdf, part, String(from), String(to)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => {
        const s = String(d);
        for (const m of s.matchAll(/PAGE (\d+)/g)) onProgress?.(Number(m[1]));
        if (!/PAGE/.test(s)) err += s;
      });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`本机 OCR 失败（${c}）${err}`))));
    });
    const text = fs.readFileSync(part, 'utf8');
    fs.rmSync(part, { force: true });
    return text;
  }

  // 其他平台：pdfium 渲染 + tesseract（不再需要 poppler）
  const { pages } = await pdfRenderPages(pdf, from, to);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  let out = '';
  for (const item of pages) {
    const img = path.join(tmp, `p-${item.page}.jpg`);
    fs.writeFileSync(img, item.jpeg);
    const txt = await new Promise((resolve, reject) => {
      const p = spawn('tesseract', [img, 'stdout', '-l', 'chi_sim+eng']);
      let o = '';
      p.stdout.on('data', (d) => (o += d));
      p.on('exit', (c) => (c === 0 ? resolve(o) : reject(new Error('需要安装 tesseract-ocr 与中文语言包'))));
    });
    out += `\n## 第 ${item.page} 页\n\n${txt.trim()}\n`;
    onProgress?.(item.page);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

/* ---------------- command：用户自带的本地 OCR ---------------- */

/**
 * 自定义 OCR 命令。占位符：
 *   {img}  单页图片（JPEG）路径
 *   {page} 页码
 *   {pdf}  原始 PDF 路径
 *   {from} {to} 本次页码范围
 * 命令的 stdout 视为该页的文字。
 */
function commandTemplate() {
  return String(process.env.OCR_COMMAND || '').trim();
}

function runCommandLine(tpl, vars) {
  const cmd = tpl.replace(/\{(img|page|pdf|from|to)\}/g, (_, k) => String(vars[k] ?? ''));
  return new Promise((resolve, reject) => {
    const p = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`自定义 OCR 命令失败（退出码 ${code}）：${err.trim().slice(0, 200) || cmd.slice(0, 120)}`));
    });
  });
}

async function ocrCommand({ pdf, from, to, onProgress }) {
  const { pages } = await pdfRenderPages(pdf, from, to);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cmd-'));
  const tpl = commandTemplate();
  let out = '';
  try {
    for (const item of pages) {
      const img = path.join(tmp, `p-${item.page}.jpg`);
      fs.writeFileSync(img, item.jpeg);
      const text = await runCommandLine(tpl, { img, page: item.page, pdf, from, to });
      out += `\n## 第 ${item.page} 页\n\n${String(text).trim()}\n`;
      onProgress?.(item.page);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/* ---------------- vision：交给多模态模型 ---------------- */

async function ocrVision({ pdf, from, to, llm, onProgress }) {
  const { pages } = await pdfRenderPages(pdf, from, to);
  let out = '';
  for (const item of pages) {
    const b64 = item.jpeg.toString('base64');
    const text = await llm.chat({
      messages: [
        {
          role: 'system',
          content:
            '你是课件转写器。把这一页幻灯片转成 Markdown：保留标题层级、公式用 LaTeX、表格用 Markdown 表格、' +
            '图注照抄。看不清的地方写 [?]，不要编造内容。只输出 Markdown，不要解释。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `请转写第 ${item.page} 页。` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          ],
        },
      ],
      maxTokens: 2000,
    });
    out += `\n## 第 ${item.page} 页\n\n${String(text).trim()}\n`;
    onProgress?.(item.page);
  }
  return out;
}

/* ---------------- 对外 ---------------- */

export async function resolveBackend(llm) {
  const want = (process.env.OCR_BACKEND || 'auto').toLowerCase();
  const hasCmd = Boolean(commandTemplate());
  if (want === 'command') return hasCmd ? 'command' : null;
  if (want === 'local') return want;
  if (want === 'vision') return 'vision'; // 具体是否可用由调用方检查，并给出可读错误
  if (hasCmd) return 'command';
  // auto：有独立视觉模型就用它（比本机 OCR 准，尤其公式/表格），否则退回本机
  if (ocrVisionClient()?.supportsVision) return 'vision';
  if (await localAvailable()) return 'local';
  if (llm?.supportsVision) return 'vision';
  return null;
}

/**
 * 冒烟测试：生成一张带文字的小图，让视觉模型读一遍。
 * 用于在 OCR 整本之前确认「端点、key、模型名」三者都对。
 */
export async function testVision(llm) {
  const client = ocrVisionClient() || (llm?.supportsVision ? llm : null);
  if (!client) {
    return { ok: false, error: '还没有可用的视觉模型：请填 OCR_BASE_URL / OCR_MODEL / OCR_API_KEY' };
  }
  const sharp = (await import('sharp')).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="90">
    <rect width="100%" height="100%" fill="white"/>
    <text x="16" y="58" font-family="Helvetica, Arial" font-size="34" fill="black">OCR TEST 12345</text>
  </svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  const t0 = Date.now();
  try {
    const text = await client.chat({
      messages: [
        { role: 'system', content: '只把图片里的文字原样输出，不要解释。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '读出图片里的文字' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ],
        },
      ],
      maxTokens: 100,
    });
    return {
      ok: true,
      model: client.model || null,
      ms: Date.now() - t0,
      sample: String(text).trim().slice(0, 80),
    };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

/** 给界面用：三种方式各自是否可用，以及当前选的是哪个。 */
export async function backendStatus(llm) {
  const localOk = await localAvailable();
  const visionOk = Boolean(ocrVisionClient()?.supportsVision || llm?.supportsVision);
  const chosen = await resolveBackend(llm);
  return {
    chosen,
    localAvailable: localOk,
    visionAvailable: visionOk,
    commandAvailable: Boolean(commandTemplate()),
    preferred: (process.env.OCR_BACKEND || 'auto').toLowerCase(),
  };
}

/** OCR 实际使用的客户端：独立视觉模型优先，否则用主模型。 */
export function ocrClient(mainLLM) {
  return ocrVisionClient() || mainLLM;
}

/**
 * 识别 PDF 的指定页（默认全部），写回同名 .ocr.md。
 * 返回 { out, pages, total, backend }。
 */
export async function ocrPdf({ courseId, name, pages, llm, onProgress }) {
  const pdf = path.join(COURSES, courseId, name);
  if (!fs.existsSync(pdf)) throw new Error('文件不存在');

  const total = (await pdfPages(pdf)) || 0;
  if (!total) throw new Error('读不到 PDF 页数');

  const { from, to } = parsePages(pages, total);
  const backend = await resolveBackend(llm);
  const client = ocrClient(llm);

  // 选了视觉模型但没配好时，给一句能照着做的错误，而不是内部的 undefined 报错
  if (backend === 'vision') {
    if (!client) {
      throw new Error(
        '选了「视觉模型」，但还没有可用的视觉模型：请在「设置 → OCR 视觉模型」填 Base URL / 模型名 / API Key（或 .env 里的 OCR_BASE_URL / OCR_MODEL / OCR_API_KEY）。',
      );
    }
    if (client.supportsVision === false) {
      throw new Error(
        `当前聊天模型（${client.provider || '未知'}）不支持图片输入。请单独配置视觉模型：OCR_BASE_URL / OCR_MODEL / OCR_API_KEY。`,
      );
    }
  }
  if (!backend) {
    throw new Error(
      '没有可用的 OCR 方式：macOS 需要 Xcode 命令行工具（xcode-select --install），' +
        'Linux 需要 tesseract-ocr + 中文语言包；或者配置多模态模型并把 OCR_BACKEND 设为 vision',
    );
  }

  const body =
    backend === 'command'
      ? await ocrCommand({ pdf, from, to, onProgress })
      : backend === 'local'
        ? await ocrLocal({ pdf, from, to, onProgress })
        : await ocrVision({ pdf, from, to, llm: client, onProgress });

  const out = pdf.replace(/\.pdf$/i, '') + '.ocr.md';
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';

  // 按页合并：重跑某几页时保留其它页的旧结果，不必全量重来
  const map = new Map();
  for (const src of [prev, `\n${body}`]) {
    const parts = src.split(/\n## 第 (\d+) 页\n/);
    for (let i = 1; i < parts.length; i += 2) map.set(Number(parts[i]), parts[i + 1].trimEnd());
  }
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const header =
    `# OCR 文本（${path.basename(pdf)}）\n\n` +
    `> 由${backend === 'local' ? '本机 OCR' : backend === 'command' ? '自定义 OCR 命令' : '多模态模型'}识别（本次 ${from}–${to} 页，共 ${total} 页），` +
    `可能有错字，引用前请核对原文。\n`;
  fs.writeFileSync(out, header + sorted.map(([p, t]) => `\n## 第 ${p} 页\n\n${t}\n`).join(''));

  const relOut = path.relative(path.join(COURSES, courseId), out).split(path.sep).join('/');
  return { out: path.basename(out), rel: relOut, pages: to - from + 1, total, backend, from, to };
}
