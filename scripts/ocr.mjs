#!/usr/bin/env node
// CLI 入口：PDF → 文本。真正的实现在 src/ocr.js（本机 OCR / 多模态模型两条路）。
//
// 用法：node scripts/ocr.mjs <课程编号> <文件名> [页码]
//   例：node scripts/ocr.mjs regression-analysis lec1.pdf            # 全部
//       node scripts/ocr.mjs regression-analysis lec1.pdf 3-12       # 只识别第 3–12 页
import { ocrPdf } from '../src/ocr.js';
import { createLLM } from '../src/llm.js';

const [courseId, name, pages] = process.argv.slice(2);
if (!courseId || !name) {
  console.error('用法：node scripts/ocr.mjs <课程编号> <文件名> [起始页-结束页]');
  process.exit(1);
}

let last = '';
ocrPdf({
  courseId,
  name,
  pages,
  llm: createLLM(),
  onProgress: (p, meta) => {
    const t = meta ? `${meta.done}/${meta.total}` : `第 ${p} 页`;
    if (t !== last) {
      last = t;
      process.stdout.write(`\r  ${t}`);
    }
  },
})
  .then((r) => console.log(`\n完成：${r.out}（${r.from}–${r.to} 页，方式 ${r.backend}）`))
  .catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
