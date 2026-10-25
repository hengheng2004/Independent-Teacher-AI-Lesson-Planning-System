#!/usr/bin/env node
// 把 docs/配置指南.md 生成为单文件 HTML（样式内嵌、截图内联为 base64、可直接发给别人）。
// 只支持本项目用到的 Markdown 子集：标题、表格、代码块、列表、引用、分隔线、加粗、行内代码、链接、图片。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs/配置指南.md');
const OUT = path.join(ROOT, 'docs/配置指南.html');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 行内渲染。顺序很重要：代码 > 图片 > 加粗 > 链接，
// 否则 ![alt](src) 会被链接规则吃掉，变成 !<a>。
function inline(text) {
  const codes = [];
  const images = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0001C${codes.length - 1}\u0001`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    images.push({ alt, src });
    return `\u0001I${images.length - 1}\u0001`;
  });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\u0001C(\d+)\u0001/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  s = s.replace(/\u0001I(\d+)\u0001/g, (_, i) => imageTag(images[Number(i)].alt, images[Number(i)].src));
  return s;
}

function imageTag(alt, src) {
  const abs = path.resolve(ROOT, src);
  if (!fs.existsSync(abs)) return `<span class="missing">（图片缺失：${esc(src)}）</span>`;
  const b64 = fs.readFileSync(abs).toString('base64');
  const type = src.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `<img alt="${esc(alt)}" src="data:${type};base64,${b64}">`;
}

const renderInline = inline;

const slug = (s, used) => {
  let base = s
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  if (!base) base = 'section';
  let id = base;
  let n = 1;
  while (used.has(id)) id = `${base}-${++n}`;
  used.add(id);
  return id;
};

function convert(md) {
  const lines = md.split('\n');
  const out = [];
  const toc = [];
  const usedIds = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(`<pre class="code${lang ? ' lang-' + esc(lang) : ''}"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 分隔线：紧跟着标题时省略，避免和标题的上边框叠成双线
    if (/^---+\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (!/^#{1,4}\s/.test(lines[j] || '')) out.push('<hr>');
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = level === 2 ? slug(text, usedIds) : '';
      if (level === 2) toc.push({ id, text });
      out.push(`<h${level}${id ? ` id="${id}"` : ''}>${renderInline(text)}</h${level}>`);
      continue;
    }

    // 表格
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      const cells = (row) =>
        row
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        body.push(cells(lines[i]));
        i += 1;
      }
      i -= 1;
      out.push('<div class="table-wrap"><table><thead><tr>');
      out.push(head.map((c) => `<th>${renderInline(c)}</th>`).join(''));
      out.push('</tr></thead><tbody>');
      for (const row of body) {
        out.push('<tr>' + row.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table></div>');
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      out.push(`<blockquote>${buf.map((l) => (l.trim() ? `<p>${renderInline(l)}</p>` : '')).join('')}</blockquote>`);
      continue;
    }

    // 列表
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^(\s*)([-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      i -= 1;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${renderInline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) continue;

    // 段落：连续非空行合并
    const buf = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !/^(#{1,4})\s|^```|^\||^>|^(\s*)([-*]|\d+\.)\s|^---+\s*$/.test(lines[i + 1])
    ) {
      i += 1;
      buf.push(lines[i]);
    }
    out.push(`<p>${renderInline(buf.join(' '))}</p>`);
  }

  return { html: out.join('\n'), toc };
}

const css = `
:root{--ink:#1d1d1f;--muted:#6b6b70;--line:#e6e3dd;--bg:#f6f5f2;--card:#fff;--accent:#22543d;--accent-soft:#eaf1ec}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.layout{max-width:1080px;margin:0 auto;padding:32px 20px 80px;display:grid;grid-template-columns:220px 1fr;gap:36px}
@media(max-width:900px){.layout{grid-template-columns:1fr;gap:20px}.toc{position:static!important}}
.toc{position:sticky;top:24px;align-self:start;font-size:13.5px;border-left:2px solid var(--line);padding-left:14px}
.toc strong{display:block;font-size:12px;letter-spacing:.5px;color:var(--muted);margin-bottom:8px}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:3px 0;line-height:1.5}
.toc a:hover{color:var(--accent)}
article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:34px 40px;min-width:0}
h1{font-size:28px;line-height:1.35;margin:0 0 8px}
h2{font-size:20px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:26px 0 8px}
h4{font-size:15px;margin:20px 0 6px}
p{margin:10px 0}
a{color:var(--accent)}
blockquote{margin:16px 0;padding:10px 16px;background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:0 8px 8px 0}
blockquote p{margin:4px 0;color:#2c4d3c}
hr{border:none;border-top:1px solid var(--line);margin:32px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f2f0ec;padding:1.5px 5px;border-radius:4px}
pre.code{background:#1d1d1f;color:#e8e6e3;padding:14px 16px;border-radius:10px;overflow:auto;margin:14px 0}
pre.code code{background:none;color:inherit;padding:0;font-size:12.5px;line-height:1.65}
table{width:100%;border-collapse:collapse;font-size:14px}
.table-wrap{overflow:auto;margin:14px 0;border:1px solid var(--line);border-radius:10px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#fbfaf8;font-weight:600;font-size:13px;color:var(--muted);white-space:nowrap}
tr:last-child td{border-bottom:none}
ul,ol{margin:10px 0;padding-left:22px}
li{margin:4px 0}
img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:10px;margin:10px 0;display:block}
.missing{color:#8a2c2c;font-size:13px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
@media print{
  body{background:#fff}
  .layout{display:block;max-width:none;padding:0}
  .toc{display:none}
  article{border:none;padding:0}
  h2{page-break-after:avoid}
  pre.code{background:#f4f3f0;color:#1d1d1f;border:1px solid var(--line)}
  img{page-break-inside:avoid}
}
`;

const md = fs.readFileSync(SRC, 'utf8');
const { html, toc } = convert(md);
const today = new Date().toISOString().slice(0, 10);

const doc = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>独立教师 AI 工作台 · 配置指南</title>
<style>${css}</style>
</head>
<body>
<div class="layout">
  <nav class="toc">
    <strong>目录</strong>
    ${toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}
  </nav>
  <article>
${html}
    <footer>本文档由 docs/配置指南.md 生成于 ${today}。改内容请改 Markdown，然后运行 <code>npm run docs</code>。</footer>
  </article>
</div>
</body>
</html>
`;

fs.writeFileSync(OUT, doc);
const kb = (Buffer.byteLength(doc) / 1024).toFixed(0);
console.log(`已生成 ${path.relative(ROOT, OUT)}（${kb} KB，目录 ${toc.length} 条）`);
