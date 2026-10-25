// Markdown → HTML（讲义/报告够用的子集）。纯函数，无依赖，Node 与浏览器共用。
// 不用第三方库：项目原则是零构建、零运行时依赖。


export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function inlineMd(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

// 只支持讲义/报告里会出现的语法：标题、表格、代码块、列表、引用、分隔线、加粗斜体、行内代码、链接
export function mdToHtml(src) {
  const lines = String(src).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(`<pre class="md-code"><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      i += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

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
      out.push(
        '<div class="md-table"><table><thead><tr>' +
          head.map((c) => `<th>${inlineMd(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${buf.map((l) => (l.trim() ? `<p>${inlineMd(l)}</p>` : '')).join('')}</blockquote>`);
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inlineMd(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const buf = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !/^(#{1,6})\s|^```|^\||^\s*>|^\s*([-*]|\d+\.)\s|^\s*---+\s*$/.test(lines[i + 1])
    ) {
      i += 1;
      buf.push(lines[i]);
    }
    out.push(`<p>${inlineMd(buf.join(' '))}</p>`);
    i += 1;
  }
  return out.join('\n');
}

// 模型输出里带 path= 的代码块是"要落盘的文件"，正文里不该展示原文
export function stripDraftBlocks(text) {
  return String(text || '')
    .replace(/```[a-zA-Z]*\s+path=[^\n]*\n[\s\S]*?(?:```|$)/g, '\n（已在右侧生成文件，确认后点「应用」）\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderMath(root) {
  if (!window.renderMathInElement) return;
  try {
    window.renderMathInElement(root, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch {}
}


// 浏览器里以 module 形式加载，但 app.js 是普通脚本，通过 window 取用
if (typeof window !== 'undefined') {
  window.mdToHtml = mdToHtml;
  window.renderMath = renderMath;
  window.inlineMd = inlineMd;
  window.escapeHtml = escapeHtml;
  window.stripDraftBlocks = stripDraftBlocks;
}
