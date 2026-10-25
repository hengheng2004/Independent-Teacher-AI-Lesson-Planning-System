// PDF 页数与页面渲染，跨平台统一实现。
//
// 用 PDFium（WebAssembly）而不是外部命令，原因：
//   1. 换平台不用换工具链 —— macOS / Linux / Windows 同一套代码
//   2. 授权干净 —— PDFium 是 BSD-3、sharp 是 Apache-2，可以随商业产品分发；
//      poppler（pdftoppm）是 GPL-2，随闭源产品打包会有传染风险
//   3. 不依赖 Spotlight（mdls）或 poppler，少一类"环境没配好"的故障
import fs from 'node:fs';
import sharp from 'sharp';
import { PDFiumLibrary } from '@hyzyla/pdfium';

let libPromise = null;
const library = () => {
  if (!libPromise) libPromise = PDFiumLibrary.init();
  return libPromise;
};

/** 读页数。读不到返回 null，由调用方决定怎么降级。 */
export async function pageCount(file) {
  const lib = await library();
  const doc = await lib.loadDocument(fs.readFileSync(file));
  try {
    return doc.getPageCount();
  } finally {
    doc.destroy?.();
  }
}

/**
 * 把指定页渲染成 JPEG Buffer 数组（按页序）。
 * @param {{scale?: number, quality?: number}} opts
 *   图片会直接发给多模态模型，1.6 倍、q0.72 足够；再高只是多花钱。
 */
/**
 * 按页宽算缩放：课件常是 362×272pt 这种小版面，固定 1.6 倍只有 579px，
 * 小字会糊成一团。目标宽度 1400px，夹在 2–4 倍之间。
 */
async function autoScale(page) {
  try {
    const size = page.getOriginalSize ? page.getOriginalSize() : null;
    const w = size?.originalWidth || size?.width || 0;
    if (w > 0) return Math.min(4, Math.max(2, Math.round((1400 / w) * 10) / 10));
  } catch {}
  return 2.5;
}

export async function renderPages(file, from, to, { scale = null, quality = 72 } = {}) {
  const lib = await library();
  const doc = await lib.loadDocument(fs.readFileSync(file));
  const total = doc.getPageCount();
  const start = Math.max(1, from);
  const end = Math.min(total, to);
  const out = [];
  try {
    for (let p = start; p <= end; p += 1) {
      const page = await doc.getPage(p - 1);
      const s2 = scale || (await autoScale(page));
      const img = await page.render({ scale: s2, render: 'bitmap' });
      // PDFium 给的是 RGBA 原始位图，压成 JPEG 体积能小一个数量级
      const jpg = await sharp(Buffer.from(img.data), {
        raw: { width: img.width, height: img.height, channels: 4 },
      })
        .jpeg({ quality })
        .toBuffer();
      out.push({ page: p, jpeg: jpg, width: img.width, height: img.height });
    }
  } finally {
    doc.destroy?.();
  }
  return { pages: out, total, from: start, to: end };
}
