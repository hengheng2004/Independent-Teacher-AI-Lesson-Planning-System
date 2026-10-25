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
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs > fs.statSync(src).mtimeMs) return Promise.resolve();
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('swiftc 编译失败'))));
  });
}

/* ---------------- local：本机 OCR ---------------- */

async function localAvailable() {
  // macOS 走系统 Vision，但需要 swiftc 现编一个小工具；没装 Xcode 命令行工具就用不了
  if (process.platform === 'darwin') return has('swiftc');
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
  if (want === 'local' || want === 'vision') return want;
  if (await localAvailable()) return 'local';
  if (llm?.supportsVision) return 'vision';
  return null;
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
  if (!backend) {
    throw new Error(
      '没有可用的 OCR 方式：macOS 需要 Xcode 命令行工具（xcode-select --install），' +
        'Linux 需要 tesseract-ocr + 中文语言包；或者配置多模态模型并把 OCR_BACKEND 设为 vision',
    );
  }

  const body =
    backend === 'local'
      ? await ocrLocal({ pdf, from, to, onProgress })
      : await ocrVision({ pdf, from, to, llm, onProgress });

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
    `> 由${backend === 'local' ? '本机 OCR' : '多模态模型'}识别（本次 ${from}–${to} 页，共 ${total} 页），` +
    `可能有错字，引用前请核对原文。\n`;
  fs.writeFileSync(out, header + sorted.map(([p, t]) => `\n## 第 ${p} 页\n\n${t}\n`).join(''));

  return { out: path.basename(out), pages: to - from + 1, total, backend, from, to };
}
