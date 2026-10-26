// OCR 文本清洗：只在 .ocr.md 上使用，普通 Markdown 一律不动。
//
// 本机 Vision 识别中文数学讲义时常见问题：
//   · 公式里的下标被识别成汉字或字母（X_t → X4、X红_1）
//   · 全角括号、全角字母数字（｛X｝（2）ＡＲ）
//   · 中文字之间插入空格（自 协 方 差 函 数）
//   · 每页重复的页眉、单独成行的页码
//
// 这里只做「不改语义、纯规范化」的清洗，避免把能用的内容改坏。

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff';

/** 全角转半角 + 去掉零宽字符 + 中文字之间多余空格 */
export function sanitizeOcr(text) {
  let s = String(text || '');

  // 1) 零宽字符、BOM
  s = s.replace(/[\u200b-\u200d\ufeff]/g, '');

  // 2) NFKC：｛｝（）［］ＡＲ１２ 等全角/兼容字符 → 半角
  s = s.normalize('NFKC');

  // 3) 中文之间的空格：OCR 常把一个词拆开
  // 只处理水平空白；用 \\s 会把换行也吃掉，导致相邻两行被粘成一行
  const cjkSpace = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');
  for (let i = 0; i < 3; i += 1) s = s.replace(cjkSpace, '$1');

  // 4) 去掉单独成行的页码
  s = s
    .split('\n')
    .filter((line) => !/^\s*\d{1,3}\s*$/.test(line))
    .join('\n');

  // 5) 常见 OCR 错字（只处理数学语境下高频、且几乎不会误伤的）
  s = s
    .replace(/([A-Za-z])红(?=_|\d)/g, '$1t') // X红_1 → Xt_1
    .replace(/己知/g, '已知')
    .replace(/滯后/g, '滞后')
    .replace(/买际/g, '实际')
    .replace(/米自/g, '来自')
    .replace(/・/g, '·');

  // 6) 页码标记统一成「## 第 N 页」，页码加权检索依赖这个格式
  s = s.replace(/^##\s*第\s*(\d+)\s*页\s*$/gm, '## 第 $1 页');

  // 7) 压缩空行
  s = s.replace(/\n{3,}/g, '\n\n');

  return s;
}

/** 去掉在文件里重复出现 >= 3 次的短行（典型是每页页眉）。 */
export function dropRepeatedHeaders(text) {
  const lines = String(text || '').split('\n');
  const count = new Map();
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.length > 40) continue;
    count.set(t, (count.get(t) || 0) + 1);
  }
  const repeated = new Set([...count.entries()].filter(([, n]) => n >= 3).map(([t]) => t));
  if (!repeated.size) return text;
  return lines.filter((l) => !repeated.has(l.trim())).join('\n');
}

/** OCR 文件的完整清洗流程 */
export function cleanOcrDocument(text) {
  return dropRepeatedHeaders(sanitizeOcr(text));
}
