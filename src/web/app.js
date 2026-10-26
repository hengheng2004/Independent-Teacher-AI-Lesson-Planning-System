// 教师工作台前端：无框架、无构建、hash 路由。
// 所有写操作都走服务端接口，前端只负责呈现与确认。
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  courses: [],
  provider: '',
  model: '',
  summary: null,
  session: { id: null, drafts: [], text: '' },
  tree: null,
  courseId: null,
  chapter: null,
  attachments: new Set(),
  agent: 'prep',
};

/* ---------------- 基础 ---------------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({ error: '返回无法解析' }));
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/* ---------------- 登录 ---------------- */

function showLogin() {
  $('#login').classList.remove('hide');
  $('#app').classList.add('hide');
}

async function boot() {
  try {
    const s = await api('/api/teacher/state');
    state.courses = s.courses;
    state.provider = s.provider;
    state.model = s.model;
    state.ocr = s.ocr;
    state.prep = s.prep;
    state.isLocal = s.isLocal;
    state.network = s.network;
    state.codeVersion = s.codeVersion;
    state.summary = s.summary;
    $('#login').classList.add('hide');
    $('#app').classList.remove('hide');
    $('#modelInfo').textContent = `${s.provider}${s.model && s.model !== 'mock' ? ' · ' + s.model : ''}`;
    $('#healthDot').className = 'dot ' + (s.provider === 'mock' ? '' : 'ok');
    renderNavCourses();
    renderBuildStatus();
    route();
  } catch (e) {
    if (e.message !== '未登录') {
      $('#loginMsg').textContent = e.message;
      showLogin();
    }
  }
}

$('#doLogin').onclick = async () => {
  try {
    await api('/api/teacher/login', { method: 'POST', body: JSON.stringify({ token: $('#token').value.trim() }) });
    boot();
  } catch (e) {
    $('#loginMsg').textContent = e.message;
  }
};
$('#token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#doLogin').click();
});
$('#logout').onclick = async () => {
  await api('/api/teacher/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};

/* ---------------- 路由 ---------------- */

const routes = [
  [/^#\/overview$/, () => renderOverview()],
  [/^#\/courses$/, () => renderCourses()],
  [/^#\/course\/([A-Za-z0-9_-]+)$/, (m) => renderCourse(m[1])],
  [/^#\/prep\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/, (m) => renderPrep(m[1], m[2])],
  [/^#\/students$/, () => renderStudents()],
  [/^#\/qa$/, () => renderQA()],
  [/^#\/settings$/, () => renderSettings()],
];

function route() {
  const hash = location.hash || '#/overview';
  $$('#nav a').forEach((a) => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.r}`)));
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (m) return fn(m);
  }
  location.hash = '#/overview';
}

window.addEventListener('hashchange', route);

function renderNavCourses() {
  const box = $('#navCourses');
  box.innerHTML = '';
  if (!state.courses.length) {
    box.appendChild(el('div', 'small muted', '还没有课程'));
    return;
  }
  for (const c of state.courses.slice(0, 8)) {
    const a = el('a', '', c.name);
    a.href = `#/course/${c.id}`;
    a.style.fontSize = '13px';
    box.appendChild(a);
  }
}

function renderBuildStatus() {
  const counts = state.courses.reduce((a, c) => a + c.chapters.length, 0);
  $('#buildStatus').textContent = `${state.courses.length} 门课 · ${counts} 章 · 讲义改动会自动重建`;
}

async function refreshState() {
  try {
    const st = await api('/api/teacher/state');
    state.courses = st.courses;
    state.summary = st.summary;
    renderNavCourses();
    renderBuildStatus();
  } catch {}
}

$('#btnBuild').onclick = async () => {
  $('#btnBuild').disabled = true;
  try {
    const r = await api('/api/teacher/build', { method: 'POST', body: JSON.stringify({}) });
    toast(`已重建：${r.blocks} 块，用时 ${r.ms} ms`);
    boot();
  } catch (e) {
    toast('重建失败：' + e.message);
  } finally {
    $('#btnBuild').disabled = false;
  }
};

/* ---------------- 概览 ---------------- */

async function renderOverview() {
  const m = $('#main');
  m.innerHTML = '';
  const sum = state.summary || { rows: [], pending: 0, top: [], byKind: [] };
  const total = sum.rows.reduce((a, r) => a + r.total, 0);

  m.appendChild(el('h1', '', '概览'));
  m.appendChild(el('p', 'muted small', '最近 7 天'));

  const cards = el('div', 'cards');
  const kpi = (v, label) => {
    const d = el('div', 'kpi');
    d.appendChild(el('b', '', String(v)));
    d.appendChild(el('span', '', label));
    cards.appendChild(d);
  };
  kpi(total, '近 7 天提问');
  kpi(sum.pending || 0, '待处理');
  // 按类型：用小标签列出来，避免挤成一行大字
  const KIND_CN = {
    knowledge: '讲知识',
    problem_guided: '讲题·引导',
    problem_full: '讲题·完整',
    problem_step: '讲题·单步',
    extend: '延伸拓展',
  };
  const kindCard = el('div', 'kpi');
  const kindBox = el('div');
  kindBox.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px';
  if (!(sum.byKind || []).length) {
    kindBox.appendChild(el('span', 'muted', '—'));
  } else {
    for (const k of sum.byKind) {
      kindBox.appendChild(el('span', 'badge', `${KIND_CN[k.kind] || k.kind} ${k.c}`));
    }
  }
  kindCard.appendChild(kindBox);
  kindCard.appendChild(el('span', '', '按类型'));
  cards.appendChild(kindCard);
  kpi(state.courses.length, '课程');
  m.appendChild(cards);

  if (!state.courses.length) {
    const empty = el('div', 'card empty-state');
    empty.appendChild(el('div', '', '还没有课程'));
    const b = el('button', 'primary', '新建第一门课');
    b.style.marginTop = '10px';
    b.onclick = () => openCreateCourse();
    empty.appendChild(b);
    m.appendChild(empty);
    return;
  }

  const recent = el('div', 'card');
  recent.appendChild(el('h2', '', '课程状态'));
  const tbl = el('table');
  tbl.innerHTML = '<thead><tr><th>课程</th><th>状态</th><th>章节</th><th>材料</th><th></th></tr></thead>';
  const tb = el('tbody');
  for (const c of state.courses) {
    const tr = el('tr');
    tr.appendChild(el('td', '', c.name));
    const td = el('td');
    td.appendChild(el('span', `badge ${c.status.key}`, c.status.label));
    tr.appendChild(td);
    tr.appendChild(el('td', '', String(c.chapters.length)));
    tr.appendChild(el('td', '', `${c.materials} 份（可检索 ${c.indexable}）`));
    const act = el('td');
    const b1 = el('button', '', '打开');
    b1.onclick = () => (location.hash = `#/course/${c.id}`);
    const b2 = el('button', 'primary', '备课');
    b2.style.marginLeft = '6px';
    b2.onclick = () => (location.hash = `#/prep/${c.id}`);
    act.appendChild(b1);
    act.appendChild(b2);
    tr.appendChild(act);
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  recent.appendChild(tbl);
  m.appendChild(recent);
}

/* ---------------- 课程列表 ---------------- */

function renderCourses() {
  const m = $('#main');
  m.innerHTML = '';
  const head = el('div', 'row');
  head.appendChild(el('h1', '', '课程'));
  head.appendChild(el('span', 'spacer'));
  const add = el('button', 'primary', '＋ 新建课程');
  add.onclick = () => openCreateCourse();
  head.appendChild(add);
  m.appendChild(head);
  m.appendChild(el('p', 'muted small', '课程编号即目录名（courses/<编号>/），创建后可上传材料。'));

  if (!state.courses.length) {
    const empty = el('div', 'card empty', '还没有课程');
    m.appendChild(empty);
    return;
  }

  const grid = el('div', 'grid');
  for (const c of state.courses) {
    const card = el('div', 'course-card');
    const top = el('div', 'row');
    top.appendChild(el('div', 'name', c.name));
    top.appendChild(el('span', 'spacer'));
    top.appendChild(el('span', `badge ${c.status.key}`, c.status.label));
    card.appendChild(top);
    card.appendChild(el('div', 'meta', [c.school, c.teacher].filter(Boolean).join(' · ') || '未填写学校/教师'));
    card.appendChild(
      el('div', 'meta', `${c.chapters.length} 章 · ${c.materials} 份材料 · ${c.enrolled || 0} 名学生在读`),
    );
    const acts = el('div', 'row');
    const b1 = el('button', '', '打开');
    b1.onclick = () => (location.hash = `#/course/${c.id}`);
    const b3 = el('button', '', '编辑');
    b3.onclick = () => openEditCourse(c.id, { materials: [] });
    const b2 = el('button', 'primary', '备课');
    b2.onclick = () => (location.hash = `#/prep/${c.id}`);
    acts.appendChild(b1);
    acts.appendChild(b3);
    acts.appendChild(b2);
    card.appendChild(acts);
    grid.appendChild(card);
  }
  m.appendChild(grid);
}

function openCreateCourse() {
  const d = openDrawer('新建课程');
  d.innerHTML = `
    <label class="muted small">课程名称<input id="nc-name" placeholder="线性代数" style="width:100%;margin:4px 0 12px"></label>
    <label class="muted small">课程编号（目录名，小写字母数字连字符）<input id="nc-id" placeholder="linear-algebra-2026f" style="width:100%;margin:4px 0 12px"></label>
    <div class="row">
      <label class="muted small" style="flex:1">学校<input id="nc-school" style="width:100%;margin-top:4px"></label>
      <label class="muted small" style="flex:1">教师<input id="nc-teacher" style="width:100%;margin-top:4px"></label>
    </div>
    <label class="muted small" style="display:block;margin-top:12px">章节（一行一个，可先填标题）</label>
    <textarea id="nc-chapters" style="width:100%;min-height:90px" placeholder="第一章 向量空间&#10;第二章 矩阵"></textarea>
    <div class="row" style="margin-top:14px">
      <button class="primary" id="nc-create">创建并打开</button>
      <span class="muted small" id="nc-msg"></span>
    </div>
  `;
  $('#nc-name').oninput = () => {
    if ($('#nc-id').dataset.touched) return;
    $('#nc-id').value = $('#nc-name').value
      .toLowerCase()
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  };
  $('#nc-id').oninput = () => ($('#nc-id').dataset.touched = '1');

  $('#nc-create').onclick = async () => {
    $('#nc-create').disabled = true;
    try {
      const chapters = $('#nc-chapters').value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title, i) => ({ key: `ch${i + 1}`, title }));
      const r = await api('/api/teacher/courses', {
        method: 'POST',
        body: JSON.stringify({
          id: $('#nc-id').value.trim(),
          name: $('#nc-name').value.trim(),
          school: $('#nc-school').value.trim(),
          teacher: $('#nc-teacher').value.trim(),
          chapters,
        }),
      });
      closeDrawer();
      toast('课程已创建，可以上传材料了');
      await boot();
      location.hash = `#/course/${r.course.id}`;
    } catch (e) {
      $('#nc-msg').textContent = e.message;
      $('#nc-create').disabled = false;
    }
  };
}

/* ---------------- 课程详情 ---------------- */

async function renderCourse(id) {
  state.courseId = id;
  const m = $('#main');
  const c = state.courses.find((x) => x.id === id);
  if (!c) return (location.hash = '#/courses');

  let tree;
  try {
    tree = await api(`/api/teacher/tree?course=${id}`);
  } catch (e) {
    m.innerHTML = '';
    m.appendChild(el('div', 'notice bad', e.message));
    return;
  }
  state.tree = tree;

  $('#ctx').textContent = c.name;
  m.innerHTML = '';

  const head = el('div', 'row');
  head.appendChild(el('h1', '', c.name));
  head.appendChild(el('span', `badge ${tree.status.key}`, tree.status.label));
  head.appendChild(el('span', 'spacer'));
  const folderBtn = el('button', '', '打开文件夹');
  folderBtn.title = '在 Finder 里打开课程目录（在你的 Mac 上）';
  folderBtn.onclick = async () => {
    try {
      const r = await api('/api/teacher/reveal', { method: 'POST', body: JSON.stringify({ courseId: id }) });
      toast(r.ok ? (r.remote ? '已在你的 Mac 上打开（当前是远程访问）' : '已在 Finder 中打开') : r.error || '打不开');
    } catch (e) {
      toast('打开失败：' + e.message);
    }
  };
  head.appendChild(folderBtn);

  const edit = el('button', '', '编辑课程');
  edit.onclick = () => openEditCourse(id, tree);
  head.appendChild(edit);
  const del = el('button', 'danger', '删除课程');
  del.onclick = async () => {
    if (!confirm(`删除「${c.name}」？\n\n课程会从列表移除，材料移到 courses/_archived/（不会真删）。\n重建索引后不能从界面恢复，需要手动搬回来。`)) return;
    del.disabled = true;
    try {
      await api(`/api/teacher/courses/${id}`, { method: 'DELETE' });
      toast(`已删除「${c.name}」，材料在 courses/_archived/`);
      await refreshState();
      location.hash = '#/courses';
      renderCourses();
    } catch (e) {
      toast('删除失败：' + e.message);
      del.disabled = false;
    }
  };
  head.appendChild(del);
  const prep = el('button', 'primary', '开始备课');
  prep.onclick = () => (location.hash = `#/prep/${id}`);
  head.appendChild(prep);
  m.appendChild(head);
  m.appendChild(el('p', 'muted small', `目录 courses/${id}/ · ${c.school || ''} ${c.teacher || ''}`));

  // 章节
  const chCard = el('div', 'card');
  chCard.appendChild(el('h2', '', '章节'));
  const tbl = el('table');
  tbl.innerHTML = '<thead><tr><th>章节</th><th>已有讲义</th><th>质检</th><th></th></tr></thead>';
  const tb = el('tbody');
  for (const ch of tree.chapters) {
    const tr = el('tr');
    tr.appendChild(el('td', '', `${ch.key}　${ch.title}`));
    const notes = tree.notes.filter((n) => n.chapter === ch.key || n.rel.includes(ch.key));
    tr.appendChild(el('td', '', notes.length ? notes.map((n) => n.name).join('、') : '—'));
    const rev = tree.reviews.find((r) => r.file.includes(ch.key));
    const td = el('td');
    if (rev) td.appendChild(el('span', `badge ${rev.verdict === '可授课' ? 'ready' : rev.verdict === '阻塞' ? 'blocked' : 'revise'}`, rev.verdict));
    else td.textContent = '—';
    tr.appendChild(td);
    const act = el('td');
    const b = el('button', '', '备课');
    b.onclick = () => (location.hash = `#/prep/${id}/${ch.key}`);
    act.appendChild(b);
    tr.appendChild(act);
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  chCard.appendChild(tbl);
  m.appendChild(chCard);

  // 材料
  const matCard = el('div', 'card');
  matCard.appendChild(el('h2', '', '材料'));
  matCard.appendChild(
    el('p', 'muted small', '整个页面都可以拖：拖到任意位置都算上传（不必对准虚线框）。.md / .txt 直接进检索；扫描版 PDF 点「OCR 识别」转文字后可检索。单个文件最大 200MB。'),
  );

  const drop = el('div', 'drop', '把文件拖到这里，或点击选择');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => uploadFiles([...fileInput.files]);
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    uploadFiles([...e.dataTransfer.files]);
  };
  matCard.appendChild(drop);
  matCard.appendChild(fileInput);
  const uploadBox = el('div');
  uploadBox.id = 'uploads';
  matCard.appendChild(uploadBox);

  const list = el('div');
  list.style.marginTop = '10px';
  if (!tree.materials.length) {
    list.appendChild(el('div', 'muted small', '还没有材料'));
  } else {
    const t = el('table');
    t.innerHTML = '<thead><tr><th>文件</th><th>大小</th><th>检索</th><th>学生端</th><th></th></tr></thead>';
    const b = el('tbody');
    for (const f of tree.materials) {
      const tr = el('tr');
      tr.appendChild(el('td', '', f.name));
      tr.appendChild(el('td', 'muted small', kb(f.size)));
      const t1 = el('td');
      if (/\.ocr\.md$/i.test(f.name)) {
        t1.appendChild(el('span', 'badge ok', 'OCR 文本'));
      } else {
        t1.appendChild(el('span', `badge ${f.indexable ? 'ok' : 'off'}`, f.indexable ? '可检索' : '仅存档'));
      }
      tr.appendChild(t1);
      const t2 = el('td');
      t2.appendChild(el('span', `badge ${f.denied ? 'off' : 'ok'}`, f.denied ? '不进学生端' : '进学生端'));
      tr.appendChild(t2);
      const act = el('td');
      // 扫描版 PDF：没有文字层，需要 OCR 才能被检索
      if (f.isPdf) {
        if (f.ocr) {
          const ok = el('span', 'badge ok', '已识别文字');
          ok.style.marginRight = '6px';
          act.appendChild(ok);
        }
        const ocrBtn = el('button', 'small', f.ocr ? '重新 OCR' : 'OCR 识别');
        ocrBtn.style.marginRight = '6px';
        ocrBtn.onclick = () => runOcr(courseIdOf(), f.name, ocrBtn);
        act.appendChild(ocrBtn);
      }
      const rm = el('button', 'danger small', '删除');
      rm.onclick = async () => {
        if (!confirm(`删除 ${f.name}？会先备份再删，随后自动重建。`)) return;
        const b2 = await api(`/api/teacher/materials?course=${id}&name=${encodeURIComponent(f.name)}`, { method: 'DELETE' });
        toast(`已删除并重建：${b2.rebuild.blocks} 块`);
        renderCourse(id);
      };
      act.appendChild(rm);
      tr.appendChild(act);
      b.appendChild(tr);
    }
    t.appendChild(b);
    list.appendChild(t);
  }
  matCard.appendChild(list);
  m.appendChild(matCard);

  // 质检
  const revCard = el('div', 'card');
  revCard.appendChild(el('h2', '', '质检报告'));
  if (!tree.reviews.length) {
    revCard.appendChild(el('p', 'muted small', '还没有报告。在备课页点「送审」，审查 agent 会把报告写到 质检/ 目录。'));
  } else {
    const rt = el('table');
    rt.innerHTML = '<thead><tr><th>报告</th><th>时间</th><th>结论</th><th></th></tr></thead>';
    const rb = el('tbody');
    for (const r of tree.reviews) {
      const tr = el('tr');
      tr.appendChild(el('td', '', r.title));
      tr.appendChild(el('td', 'muted small', r.mtime.slice(0, 16).replace('T', ' ')));
      const td = el('td');
      td.appendChild(el('span', `badge ${r.verdict === '可授课' ? 'ready' : r.verdict === '阻塞' ? 'blocked' : 'revise'}`, r.verdict));
      tr.appendChild(td);
      const act = el('td');
      const open = el('button', 'small', '查看');
      open.onclick = () => showReviewModal(id, r.rel);
      act.appendChild(open);
      tr.appendChild(act);
      rb.appendChild(tr);
    }
    rt.appendChild(rb);
    revCard.appendChild(rt);
  }
  m.appendChild(revCard);
}

async function showReviewModal(courseId, rel) {
  const d = openDrawer('质检报告');
  try {
    const f = await api(`/api/teacher/file?course=${courseId}&rel=${encodeURIComponent(rel)}`);
    const md = el('div', 'md-body');
    md.innerHTML = window.mdToHtml(f.content);
    d.appendChild(md);
    window.renderMath(md);
  } catch (e) {
    d.appendChild(el('div', 'notice bad', e.message));
  }
}

// 编辑课程：名称 + 章节 + 材料归属
async function openEditCourse(id, tree) {
  const d = openDrawer('编辑课程');
  d.innerHTML = '<div class="muted small">读取配置…</div>';
  let full;
  try {
    full = await api(`/api/teacher/courses/${id}`);
  } catch (e) {
    d.innerHTML = `<div class="notice bad">${e.message}</div>`;
    return;
  }
  const c = full.course;
  const materials = full.materials || [];
  const chapters = (c.chapters || []).map((ch) => ({ ...ch, sources: [...(ch.sources || [])] }));
  // 从配置里拿当前 sources（列表接口没带），用文件树里的章节标题兜底
  const render = () => {
    d.innerHTML = `
      <label class="muted small">课程名称<input id="ec-name" value="${c.name}" style="width:100%;margin:4px 0 10px"></label>
      <div class="row">
        <label class="muted small" style="flex:1">学校<input id="ec-school" value="${c.school || ''}" style="width:100%;margin-top:4px"></label>
        <label class="muted small" style="flex:1">教师<input id="ec-teacher" value="${c.teacher || ''}" style="width:100%;margin-top:4px"></label>
      </div>
      <h2 style="margin-top:16px">章节与材料</h2>
      <p class="muted small">勾选的材料会进入该章知识包。没勾任何材料的章节不会生成内容。</p>
      <div id="ec-chapters"></div>
      <div class="row" style="margin-top:10px">
        <button id="ec-add">＋ 添加章节</button>
        <span class="spacer"></span>
        <button class="primary" id="ec-save">保存</button>
        <span class="muted small" id="ec-msg"></span>
      </div>`;

    const box = $('#ec-chapters');
    chapters.forEach((ch, i) => {
      const card = el('div', 'card');
      card.style.padding = '10px';
      const head = el('div', 'row');
      head.appendChild(el('span', 'badge', ch.key));
      const title = el('input');
      title.value = ch.title;
      title.style.flex = '1';
      title.oninput = () => (ch.title = title.value);
      head.appendChild(title);
      const del = el('button', 'danger small', '删除');
      del.onclick = () => {
        chapters.splice(i, 1);
        render();
      };
      head.appendChild(del);
      card.appendChild(head);

      const chips = el('div', 'chips');
      for (const m of materials) {
        const chip = el('span', 'chip' + (ch.sources.includes(m.name) ? ' on' : ''), m.name);
        chip.onclick = () => {
          const at = ch.sources.indexOf(m.name);
          if (at >= 0) ch.sources.splice(at, 1);
          else ch.sources.push(m.name);
          render();
        };
        chips.appendChild(chip);
      }
      if (!materials.length) chips.appendChild(el('span', 'muted small', '还没有材料，先回课程页上传'));
      card.appendChild(chips);
      box.appendChild(card);
    });

    $('#ec-add').onclick = () => {
      const n = chapters.length + 1;
      chapters.push({ key: `ch${n}`, title: `第 ${n} 章`, sources: [] });
      render();
    };
    $('#ec-save').onclick = async () => {
      try {
        await api(`/api/teacher/courses/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: $('#ec-name').value.trim(),
            school: $('#ec-school').value.trim(),
            teacher: $('#ec-teacher').value.trim(),
            chapters,
          }),
        });
        closeDrawer();
        toast('已保存，正在重建');
        await api('/api/teacher/build', { method: 'POST', body: JSON.stringify({ courseId: id }) });
        await refreshState();
        renderCourse(id);
      } catch (e) {
        $('#ec-msg').textContent = e.message;
      }
    };
  };
  render();
}

const courseIdOf = () => state.courseId;

async function runOcr(courseId, name, btn) {
  // 不默认全量：可以直接指定页码范围，只识别这次要用的部分
  const pages = prompt(
    `对「${name}」做 OCR。\n\n` +
      '全部识别：直接点确定（留空）\n' +
      '只识别部分页：填页码范围，例如 3-12\n\n' +
      '本机 OCR 很快（50 页约十几秒）；用多模态模型则按页计费。',
    '',
  );
  if (pages === null) return;
  btn.disabled = true;
  const original = btn.textContent;
  try {
    const { jobId } = await api('/api/teacher/ocr', {
      method: 'POST',
      body: JSON.stringify({ courseId, name, pages: pages.trim() || undefined }),
    });
    btn.textContent = '识别中…';
    for (let i = 0; i < 720; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const job = await api(`/api/teacher/ocr/status?jobId=${jobId}`);
      if (job.status === 'running') {
        btn.textContent = job.progress && /\d+\/\d+/.test(job.progress) ? `识别 ${job.progress}` : '识别中…';
        continue;
      }
      if (job.status === 'done') {
        const at = job.attached || {};
        let where;
        if (at.denied) {
          where = '命中黑名单，未挂进学生端（题库/教师版这类），教师端仍可检索';
        } else if (at.changed && at.chapter) {
          const label = at.via === 'common' ? '通用资料（全课程）' : at.chapter;
          where = `已挂到 ${label}，学生端可检索`;
        } else if (at.chapter) {
          where = `已在 ${at.chapter}，无需重复挂载`;
        } else {
          where = '未挂载（课程还没有章节）';
        }
        toast(`OCR 完成：${job.out}（${job.pages || '?'} 页，${job.backend || '本机'}）· ${where}`, 6000);
        renderCourse(courseId);
        return;
      }
      toast('OCR 失败：' + (job.error || '未知错误'));
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
  } catch (e) {
    toast('OCR 失败：' + e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 拖文件时只要落在页面上，就阻止浏览器"打开这个文件"的默认行为。
// 否则稍微拖偏一点，整个工作台会被 PDF 顶掉，看起来像上传没反应。
if (typeof window !== 'undefined') {
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth += 1;
  });
  window.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
  });
  window.addEventListener('drop', (e) => {
    // 只在「材料」页生效，其它页面照常
    if (!$('#uploads')) return;
    e.preventDefault();
    dragDepth = 0;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });
}

async function uploadFiles(files) {
  const id = state.courseId;
  if (!id || !files.length) return;
  const box = $('#uploads');
  for (const f of files) {
    const row = el('div', 'upload-row');
    row.appendChild(el('span', '', f.name));
    const bar = el('div', 'bar');
    const fill = el('i');
    bar.appendChild(fill);
    row.appendChild(bar);
    const msg = el('span', 'muted small', '上传中');
    row.appendChild(msg);
    box.appendChild(row);

    try {
      const r = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/teacher/materials?course=${id}&name=${encodeURIComponent(f.name)}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
        };
        xhr.onload = () => {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {}
          if (xhr.status === 200) resolve(data);
          else reject(new Error(data.error || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(f);
      });
      msg.textContent = `已重建 ${r.rebuild.blocks} 块 · ${r.rebuild.ms}ms`;
      fill.style.width = '100%';
    } catch (e) {
      msg.textContent = '失败：' + e.message;
      msg.style.color = 'var(--danger)';
    }
  }
  renderCourse(id);
}

/* ---------------- 备课 ---------------- */

async function renderPrep(id, chapterKey) {
  state.courseId = id;
  state.attachments = new Set();
  const c = state.courses.find((x) => x.id === id);
  if (!c) return (location.hash = '#/courses');

  const m = $('#main');
  const tree = await api(`/api/teacher/tree?course=${id}`);
  state.tree = tree;
  const chapter = chapterKey || tree.chapters[0]?.key || 'ch1';
  state.chapter = chapter;
  const chTitle = tree.chapters.find((x) => x.key === chapter)?.title || '';

  $('#ctx').textContent = `${c.name} · ${chapter}`;
  m.innerHTML = '';

  const head = el('div', 'row');
  head.style.marginBottom = '10px';
  const sel = el('select');
  for (const ch of tree.chapters) {
    const o = el('option', '', `${ch.key} ${ch.title}`);
    o.value = ch.key;
    if (ch.key === chapter) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => (location.hash = `#/prep/${id}/${sel.value}`);
  head.appendChild(sel);
  head.appendChild(el('span', 'spacer'));
  const agentSel = el('select');
  agentSel.innerHTML = '<option value="prep">备课 agent</option><option value="review">审查 agent</option>';
  agentSel.onchange = () => (state.agent = agentSel.value);
  head.appendChild(agentSel);
  const openFolderBtn = el('button', 'small', '打开文件夹');
  openFolderBtn.title = '在 Finder 里打开本章的备课产物目录（在你的 Mac 上）';
  if (state.isLocal) openFolderBtn.onclick = async () => {
    const rel = `备课/${chapter}`;
    try {
      const r = await api('/api/teacher/reveal', {
        method: 'POST',
        body: JSON.stringify({ courseId: id, rel }),
      });
      if (!r.ok) toast(r.error || '打不开');
      else toast(r.remote ? '已在你的 Mac 上打开（当前是远程访问）' : '已在 Finder 中打开');
    } catch (e) {
      // 本章还没产物时，退回到课程根目录
      try {
        const r2 = await api('/api/teacher/reveal', { method: 'POST', body: JSON.stringify({ courseId: id }) });
        toast(r2.ok ? '本章还没有产物，已打开课程文件夹' : r2.error || '打不开');
      } catch (e2) {
        toast('打开失败：' + e2.message);
      }
    }
  };

  const reviewBtn = el('button', '', '送审');
  reviewBtn.onclick = () => {
    state.agent = 'review';
    agentSel.value = 'review';
    for (const n of tree.notes) if (n.chapter === chapter || n.name.includes(chapter)) state.attachments.add(n.rel);
    for (const f of tree.materials) if (/讲义|资料清单/.test(f.name) && !f.denied) state.attachments.add(f.name);
    $('#prompt').value = `请审查 ${chapter} ${chTitle} 的讲义，按约定输出质检报告。`;
    renderTree();
    $('#prompt').focus();
  };
  head.appendChild(reviewBtn);
  head.appendChild(openFolderBtn);

  m.appendChild(head);

  const wrap = el('div', 'prep');
  m.appendChild(wrap);

  // 左：文件树
  const left = el('div', 'pane filetree');
  left.innerHTML = '<header>文件（勾选加入上下文）</header>';
  const leftBody = el('div', 'body');
  leftBody.id = 'treeBody';
  left.appendChild(leftBody);
  wrap.appendChild(left);

  // 中：对话
  const mid = el('div', 'pane');
  mid.innerHTML = '<header><span id="sessionLabel">新会话</span></header>';
  const thread = el('div', 'body thread');
  thread.id = 'thread';
  mid.appendChild(thread);
  const composer = el('div', 'composer');
  const ta = el('textarea');
  ta.id = 'prompt';
  ta.placeholder = '例如：按本章写教师版讲义，60 分钟，含 4 道例题';
  const actions = el('div', 'row');
  actions.style.marginTop = '6px';
  const send = el('button', 'primary', '发送');
  send.onclick = () => sendMessage();
  const newBtn = el('button', '', '新建会话');
  newBtn.onclick = () => {
    state.session = { id: null, drafts: [], text: '' };
    $('#thread').innerHTML = '';
    $('#sessionLabel').textContent = '新会话';
  };
  actions.appendChild(send);
  actions.appendChild(newBtn);

  // 输出上限 = 总 token 预算；能写多少字 ≈ token × 平均每 token 字数（1.6）
  const prepInfo = state.prep || { maxTokens: 32000, charsPerToken: 1.6 };
  const capLabel = el('span', 'muted small');
  capLabel.style.cssText = 'cursor:pointer;text-decoration:underline dotted;white-space:nowrap;font-size:11px';
  capLabel.title = '点击调整输出上限';
  const renderCap = () => {
    const budget = state.prepBudget || prepInfo.maxTokens || 32000;
    const chars = Math.round(budget * (prepInfo.charsPerToken || 1.6));
    capLabel.textContent = `${budget} tokens ≈ 最多 ${chars.toLocaleString('zh-CN')} 字`;
  };
  capLabel.onclick = async () => {
    const cur = state.prepBudget || prepInfo.maxTokens || 32000;
    const v = prompt('输出上限（tokens，1000–32000）\n\n这只是上限：不写满不额外花钱。', String(cur));
    if (v === null) return;
    const n = Math.max(1000, Math.min(32000, Math.round(Number(v) || cur)));
    state.prepBudget = n;
    renderCap();
    try {
      await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ prep: { maxTokens: String(n) } }) });
      toast(`输出上限已设为 ${n} tokens`);
    } catch (e) {
      toast(`本次按 ${n} 执行（保存失败：${e.message}）`);
    }
  };
  renderCap();
  actions.appendChild(capLabel);
  actions.appendChild(el('span', 'spacer'));
  actions.appendChild(el('span', 'muted small', 'Ctrl+↵'));
  composer.appendChild(ta);
  composer.appendChild(actions);
  mid.appendChild(composer);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  });
  wrap.appendChild(mid);

  // 右：文件内容 / 待应用修改
  const right = el('div', 'pane');
  right.innerHTML = '<header id="rightHead">文件内容</header>';
  const rightBody = el('div', 'body');
  rightBody.id = 'rightBody';
  rightBody.appendChild(el('div', 'muted small', '从左边选一个文件查看，或让 AI 生成后在这里看 diff。'));
  right.appendChild(rightBody);
  wrap.appendChild(right);

  renderTree();
  if (tree.notes.length) showFile(tree.notes[0].rel);

  // 刷新后恢复上一轮的待应用修改，避免草稿丢失
  try {
    const last = await api(`/api/teacher/last-drafts?course=${id}&chapter=${encodeURIComponent(chapter)}`);
    if (last.sessionId) {
      state.session.id = last.sessionId;
      $('#sessionLabel').textContent = `会话 #${last.sessionId}`;
      // 恢复对话历史
      try {
        const sess = await api(`/api/teacher/session?id=${last.sessionId}`);
        $('#thread').innerHTML = '';
        for (const m of sess.messages) addMsg(m.role === 'assistant' ? 'assistant' : 'me', m.content.slice(0, 4000));
      } catch {}
    }
    if (last.drafts && last.drafts.length) {
      state.session.drafts = last.drafts;
      renderDrafts(last.drafts);
    }
  } catch {}
}

function renderTree() {
  const box = $('#treeBody');
  if (!box || !state.tree) return;
  box.innerHTML = '';
  const group = (title, items) => {
    box.appendChild(el('div', 'grp', title));
    if (!items.length) box.appendChild(el('div', 'muted small', '（空）'));
    for (const it of items) {
      const row = el('div', 'f');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = state.attachments.has(it.rel);
      cb.onchange = () => {
        if (cb.checked) state.attachments.add(it.rel);
        else state.attachments.delete(it.rel);
      };
      row.appendChild(cb);
      const name = el('span', '', it.name);
      row.appendChild(name);
      name.onclick = () => showFile(it.rel);
      box.appendChild(row);
    }
  };
  group('材料', state.tree.materials.map((f) => ({ rel: f.name, name: f.name + (f.denied ? '（不进学生端）' : '') })));
  group('备课产物', state.tree.notes.map((n) => ({ rel: n.rel, name: n.rel.replace('备课/', '') })));
  group('质检', state.tree.reviews.map((r) => ({ rel: r.rel, name: `${r.file}（${r.verdict}）` })));
}

async function showFile(rel, mode) {
  const body = $('#rightBody');
  const head = $('#rightHead');
  body.innerHTML = '';
  head.innerHTML = '';
  head.appendChild(el('span', '', rel));

  let f;
  try {
    f = await api(`/api/teacher/file?course=${state.courseId}&rel=${encodeURIComponent(rel)}`);
  } catch (e) {
    body.appendChild(el('div', 'notice bad', e.message));
    return;
  }

  const isMd = /\.(md|markdown)$/i.test(rel);
  const view = mode || (isMd ? 'preview' : 'raw');

  if (isMd) {
    const toggle = el('button', 'small', view === 'preview' ? '源码' : '预览');
    toggle.style.marginLeft = 'auto';
    toggle.onclick = () => showFile(rel, view === 'preview' ? 'raw' : 'preview');
    head.appendChild(toggle);
  }

  // 下载到当前访问设备（手机、别人的电脑上也能拿到这份讲义）
  const dl = el('button', 'small', '下载');
  dl.title = '把这份文件保存到当前设备';
  dl.onclick = () => {
    const a = el('a');
    a.href = `/api/teacher/file?course=${state.courseId}&rel=${encodeURIComponent(rel)}&download=1`;
    a.download = rel.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已开始下载');
  };
  if (!isMd) dl.style.marginLeft = 'auto';
  head.appendChild(dl);

  if (view === 'preview') {
    const md = el('div', 'md-body');
    md.innerHTML = window.mdToHtml(f.content);
    body.appendChild(md);
    window.renderMath(md);
  } else {
    const pre = el('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.fontSize = '12.5px';
    pre.textContent = f.content;
    body.appendChild(pre);
  }
}

function addMsg(role, text) {
  const t = $('#thread');
  const wrap = el('div', 'msg' + (role === 'me' ? ' me' : ''));
  wrap.appendChild(el('div', 'who', role === 'me' ? '你' : '助教'));
  const b = el('div', 'bubble');
  if (role === 'me') {
    b.textContent = text;
  } else {
    // 助教输出是 Markdown，渲染后再显示；公式交给 KaTeX
    const box = el('div', 'md-body');
    box.innerHTML = window.mdToHtml(window.stripDraftBlocks ? window.stripDraftBlocks(text) : text);
    b.appendChild(box);
    window.renderMath(box);
  }
  wrap.appendChild(b);
  t.appendChild(wrap);
  t.scrollTop = t.scrollHeight;
  return wrap;
}

async function sendMessage() {
  const ta = $('#prompt');
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  addMsg('me', text);
  const bubble = addMsg('assistant', '');
  const bb = bubble.querySelector('.bubble');
  bb.textContent = '…';

  let raw = '';
  try {
    const res = await fetch('/api/teacher/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        courseId: state.courseId,
        chapter: state.chapter,
        agent: state.agent,
        maxTokens: state.prepBudget || undefined,
        sessionId: state.session.id,
        message: text,
        attachments: [...state.attachments],
      }),
    });
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(j.error || '请求失败');
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    bb.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const ev = /event: (.+)/.exec(part)?.[1];
        const dataLine = /data: (.+)/.exec(part)?.[1];
        if (!ev || !dataLine) continue;
        const data = JSON.parse(dataLine);
        if (ev === 'start') {
          state.session.id = data.sessionId;
          $('#sessionLabel').textContent = `会话 #${data.sessionId}`;
          if (data.retrieved !== undefined) {
            const tip = el('div', 'muted small');
            tip.textContent = `已从材料里检索 ${data.retrieved} 段相关内容（共 ${data.materialTotal} 段）`;
            $('#thread').appendChild(tip);
          }
        } else if (ev === 'delta') {
          raw += data.text;
          bb.textContent = raw.replace(/```[a-zA-Z]*\s+path=[^\n]+\n[\s\S]*?```/g, '\n（已生成文件，见右侧）\n');
        } else if (ev === 'done') {
          bb.textContent = data.text || '（已生成文件，见右侧）';
          if (data.truncatedByModel) {
            const warn = el('div', 'notice bad');
            warn.style.marginTop = '8px';
            warn.textContent =
              '模型输出被截断（推理型模型会把预算花在思考上），这次可能没生成完整文件。建议在设置里把聊天模型换成 deepseek-chat。';
            bubble.appendChild(warn);
          }
          if (!(data.drafts || []).length && !data.truncatedByModel) {
            const hint = el('div', 'muted small');
            hint.style.marginTop = '6px';
            hint.textContent = '这次没有生成文件。可以让它「按第 X 章写教师版讲义」，或勾选左侧材料再试。';
            bubble.appendChild(hint);
          }
          state.session.drafts = data.drafts || [];
          renderDrafts(data.drafts || []);
        } else if (ev === 'error') {
          bb.textContent = '出错了：' + data.error;
        }
      }
    }
  } catch (e) {
    bb.textContent = '出错了：' + e.message;
  }
}

function renderDrafts(drafts) {
  const head = $('#rightHead');
  head.textContent = drafts.length ? `待应用修改（${drafts.length}）` : '文件内容';
  if (!drafts.length) return;
  const body = $('#rightBody');
  body.innerHTML = '';
  for (const d of drafts) {
    const card = el('div', 'card');
    card.style.padding = '0';
    const h = el('div', 'draft-head');
    h.appendChild(el('strong', '', d.rel));
    h.appendChild(el('span', `badge ${d.exists ? 'revise' : 'ok'}`, d.exists ? '覆盖' : '新建'));
    h.appendChild(el('span', 'muted small', `${d.lines} 行`));
    if (d.truncated) h.appendChild(el('span', 'badge revise', '输出被截断'));
    card.appendChild(h);

    const diffBox = el('div', 'diff');
    const lines = diffLinesLite(d.before || '', d.content);
    const shown = lines.slice(0, 220);
    for (const l of shown) diffBox.appendChild(el('div', l.type, (l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ') + l.text));
    if (lines.length > shown.length) diffBox.appendChild(el('div', 'same', `… 还有 ${lines.length - shown.length} 行`));
    card.appendChild(diffBox);

    const act = el('div', 'row');
    act.style.padding = '8px 10px';
    const apply = el('button', 'primary', '应用');
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        const r = await api('/api/teacher/apply', {
          method: 'POST',
          body: JSON.stringify({ courseId: state.courseId, rel: d.rel, content: d.content, expectMtime: d.mtime }),
        });
        toast(`已写入 ${r.rel}（${r.bytes} 字节），已备份`);
        await showFile(d.rel);
        await refreshState();
        state.session.drafts = state.session.drafts.filter((x) => x.rel !== d.rel);
        renderDrafts(state.session.drafts);
      } catch (e) {
        toast('应用失败：' + e.message);
        apply.disabled = false;
      }
    };
    const discard = el('button', '', '丢弃');
    discard.onclick = () => {
      state.session.drafts = state.session.drafts.filter((x) => x.rel !== d.rel);
      renderDrafts(state.session.drafts);
    };
    act.appendChild(apply);
    act.appendChild(discard);
    card.appendChild(act);
    body.appendChild(card);
  }
}

function diffLinesLite(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) out.push({ type: 'same', text: a[i] ?? '' });
    else {
      if (a[i] !== undefined) out.push({ type: 'del', text: a[i] });
      if (b[i] !== undefined) out.push({ type: 'add', text: b[i] });
    }
  }
  return out;
}

/* ---------------- 学生 ---------------- */

async function renderStudents() {
  const m = $('#main');
  m.innerHTML = '';
  m.appendChild(el('h1', '', '学生'));
  const data = await api('/api/admin/students').catch(() => ({ students: [] }));
  const card = el('div', 'card');
  card.appendChild(el('h2', '', '访问码与额度'));
  const t = el('table');
  t.innerHTML = '<thead><tr><th>学生</th><th>今日</th><th>本月</th><th>状态</th><th></th></tr></thead>';
  const tb = el('tbody');
  for (const s of data.students) {
    const tr = el('tr');
    const nameCell = el('td');
    nameCell.appendChild(el('div', '', s.name));
    const chips = el('div', 'chips');
    for (const cid of s.courses || []) {
      const course = state.courses.find((c) => c.id === cid);
      const chip = el('span', 'chip on', course ? course.name : cid);
      chip.title = '点击退课';
      chip.onclick = async () => {
        if (!confirm(`把 ${s.name} 从「${course ? course.name : cid}」退掉？`)) return;
        await api('/api/admin/students/unenroll', { method: 'POST', body: JSON.stringify({ name: s.name, courseId: cid }) });
        renderStudents();
      };
      chips.appendChild(chip);
    }
    if (!(s.courses || []).length) chips.appendChild(el('span', 'chip', '未报课'));
    nameCell.appendChild(chips);
    tr.appendChild(nameCell);
    tr.appendChild(el('td', '', `${s.usage.daily}/${s.limits.daily || '∞'}`));
    tr.appendChild(el('td', '', `${s.usage.monthly}/${s.limits.monthly || '∞'}`));
    const td = el('td');
    td.appendChild(el('span', `badge ${s.active ? 'ok' : 'off'}`, s.active ? '启用' : '停用'));
    tr.appendChild(td);
    const act = el('td');
    for (const [label, fn] of [
      ['画像', () => openProfile(s)],
      ['额度', () => openQuota(s)],
      ['加课', () => openEnroll(s)],
      [
        '换码',
        async () => {
          if (!confirm(`给 ${s.name} 换码？旧码立即失效。`)) return;
          const r = await api('/api/admin/students/rotate', { method: 'POST', body: JSON.stringify({ name: s.name }) });
          openDrawer('新访问码', `<div class="card" style="font-size:24px;text-align:center;font-family:monospace">${r.code}</div><p class="muted small">只显示这一次，已记入 data/codes.md</p>`);
        },
      ],
      [
        s.active ? '停用' : '启用',
        async () => {
          await api('/api/admin/action', { method: 'POST', body: JSON.stringify({ action: 'student', name: s.name, active: !s.active }) });
          renderStudents();
        },
      ],
      [
        '删除',
        async () => {
          const ok = confirm(
            `删除学生「${s.name}」？\n\n` +
              '· 访问码立即失效，报名关系一并清除\n' +
              '· 历史问答保留，仍能在「问答」页查到\n' +
              '· 学生画像目录不删（需要的话自己去 students/ 里删）\n\n' +
              '这一步不可撤销。',
          );
          if (!ok) return;
          try {
            await api('/api/admin/students/delete', { method: 'POST', body: JSON.stringify({ name: s.name }) });
            toast(`已删除「${s.name}」`);
            renderStudents();
          } catch (e) {
            toast('删除失败：' + e.message);
          }
        },
      ],
    ]) {
      const b = el('button', label === '删除' ? 'small danger' : 'small', label);
      b.style.marginRight = '6px';
      b.onclick = fn;
      act.appendChild(b);
    }
    tr.appendChild(act);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  card.appendChild(t);
  m.appendChild(card);

  const add = el('button', 'primary', '＋ 新增学生');
  add.onclick = openAddStudent;
  m.appendChild(add);
}

function openAddStudent() {
  const d = openDrawer('新增学生');
  const opts =
    '<option value="">（暂不选课，之后再接单）</option>' +
    state.courses.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  d.innerHTML = `
    <label class="muted small">名字<input id="ns-name" style="width:100%;margin:4px 0 10px"></label>
    <label class="muted small">课程<select id="ns-course" style="width:100%;margin:4px 0 10px">${opts}</select></label>
    <div class="row">
      <label class="muted small" style="flex:1">每天次数<input id="ns-daily" type="number" value="20" style="width:100%;margin-top:4px"></label>
      <label class="muted small" style="flex:1">累计次数<input id="ns-total" type="number" value="0" style="width:100%;margin-top:4px"></label>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="primary" id="ns-create">生成访问码</button>
      <span class="muted small" id="ns-msg"></span>
    </div>
  `;
  $('#ns-create').onclick = async () => {
    try {
      const r = await api('/api/admin/students/create', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#ns-name').value.trim(),
          courseId: $('#ns-course').value,
          quota: { daily: Number($('#ns-daily').value), total: Number($('#ns-total').value) },
        }),
      });
      d.innerHTML = `<div class="card" style="font-size:24px;text-align:center;font-family:monospace">${r.code}</div>
        <p class="muted small">只显示这一次，已记入 data/codes.md。学生打开 / 即可提问。</p>`;
      renderStudents();
    } catch (e) {
      $('#ns-msg').textContent = e.message;
    }
  };
}

async function openProfile(s) {
  const d = openDrawer(`${s.name} · 学生画像`);
  let data;
  try {
    data = await api(`/api/admin/profile?name=${encodeURIComponent(s.name)}`);
  } catch (e) {
    d.appendChild(el('div', 'notice bad', e.message));
    return;
  }
  const p = data.profile;
  if (!p.path) {
    d.appendChild(el('div', 'notice', p.reason || '还没有绑定学生项目编号，无法存放画像。'));
    d.appendChild(el('p', 'muted small', '在「新增学生」时填「学生项目编号」，或在 config/students.json 里补 project 字段。'));
    return;
  }
  d.innerHTML = `
    <div class="muted small" style="margin-bottom:10px">文件：<code>${p.path}</code>${p.exists ? '' : '（尚未创建，保存后生成）'}</div>
    <h2 style="font-size:14px">自动摘要（只读）</h2>
    <pre class="muted small" style="white-space:pre-wrap;background:#fbfaf8;border:1px solid var(--line);border-radius:8px;padding:10px">${data.digestText}</pre>
    <h2 style="font-size:14px;margin-top:14px">画像内容（Markdown）</h2>
    <textarea id="pf-md" style="width:100%;min-height:260px;font:13px/1.6 ui-monospace,Menlo,monospace">${p.markdown.replace(/</g, '&lt;')}</textarea>
    <div class="row" style="margin-top:10px">
      <button id="pf-draft">用问答记录生成草稿</button>
      <button class="primary" id="pf-save">保存</button>
      <span class="muted small" id="pf-msg"></span>
    </div>`;
  $('#pf-draft').onclick = () => {
    if (!confirm('会用「模板 + 自动摘要」覆盖编辑框，未保存的内容会丢。继续？')) return;
    $('#pf-md').value = data.draft;
    $('#pf-msg').textContent = '草稿已填入，记得保存';
  };
  $('#pf-save').onclick = async () => {
    try {
      const r = await api('/api/admin/profile', {
        method: 'POST',
        body: JSON.stringify({ name: s.name, markdown: $('#pf-md').value }),
      });
      $('#pf-msg').textContent = `已保存（${r.bytes} 字节）`;
    } catch (e) {
      $('#pf-msg').textContent = e.message;
    }
  };
}

async function openQuota(s) {
  const d = openDrawer(`${s.name} · 额度`);
  const rows = (s.courses || []).map((cid) => {
    const c = state.courses.find((x) => x.id === cid);
    const q = (s.enrollmentQuotas || {})[cid] || {};
    return `
      <div class="card" style="padding:12px">
        <strong>${c ? c.name : cid}</strong>
        <div class="row" style="margin-top:6px">
          <label class="muted small" style="flex:1">每天<input data-c="${cid}" data-k="daily" type="number" min="0" value="${q.daily ?? ''}" placeholder="跟随默认" style="width:100%"></label>
          <label class="muted small" style="flex:1">累计<input data-c="${cid}" data-k="total" type="number" min="0" value="${q.total ?? ''}" placeholder="跟随默认" style="width:100%"></label>
          <label class="muted small" style="flex:1">每小时<input data-c="${cid}" data-k="burstPerHour" type="number" min="0" value="${q.burstPerHour ?? ''}" placeholder="跟随默认" style="width:100%"></label>
        </div>
      </div>`;
  });
  d.innerHTML = `
    <p class="muted small">额度可以按单设：留空表示跟随学生/课程默认，填 0 表示不限。</p>
    ${rows.join('') || '<div class="empty-state">这名学生还没有报课</div>'}
    <div class="row" style="margin-top:12px">
      <button class="primary" id="q-save">保存</button>
      <span class="muted small" id="q-msg"></span>
    </div>`;
  $('#q-save').onclick = async () => {
    try {
      const byCourse = {};
      d.querySelectorAll('input[data-c]').forEach((inp) => {
        const cid = inp.dataset.c;
        byCourse[cid] = byCourse[cid] || {};
        byCourse[cid][inp.dataset.k] = inp.value === '' ? null : Number(inp.value);
      });
      for (const [cid, quota] of Object.entries(byCourse)) {
        await api('/api/admin/students/enrollment-quota', {
          method: 'POST',
          body: JSON.stringify({ name: s.name, courseId: cid, quota }),
        });
      }
      $('#q-msg').textContent = '已保存';
      renderStudents();
    } catch (e) {
      $('#q-msg').textContent = e.message;
    }
  };
}

function openEnroll(s) {
  const d = openDrawer(`给 ${s.name} 加课`);
  const opts = state.courses.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  d.innerHTML = `
    <p class="muted small">从课程库选一门已经备好的课；如果是新课，先去「课程」里新建。</p>
    <select id="en-course" style="width:100%;margin:8px 0">${opts}</select>
    <label class="muted small">本次目标（可选）<input id="en-goal" placeholder="期中范围 / 第 18 章" style="width:100%;margin-top:4px"></label>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="en-do">加课</button>
      <span class="muted small" id="en-msg"></span>
    </div>`;
  $('#en-do').onclick = async () => {
    try {
      await api('/api/admin/students/enroll', {
        method: 'POST',
        body: JSON.stringify({ name: s.name, courseId: $('#en-course').value, goal: $('#en-goal').value.trim() || null }),
      });
      closeDrawer();
      toast('已加课');
      renderStudents();
    } catch (e) {
      $('#en-msg').textContent = e.message;
    }
  };
}

/* ---------------- 问答 ---------------- */

async function renderQA() {
  const m = $('#main');
  m.innerHTML = '';
  m.appendChild(el('h1', '', '问答'));
  const data = await api('/api/admin/questions?limit=100').catch(() => ({ questions: [] }));
  const card = el('div', 'card');
  const t = el('table');
  t.innerHTML = '<thead><tr><th>时间</th><th>学生</th><th>类型</th><th>问题</th><th>状态</th></tr></thead>';
  const tb = el('tbody');
  if (!data.questions.length) {
    card.appendChild(el('div', 'empty-state', '还没有提问'));
  } else {
    for (const q of data.questions) {
      const tr = el('tr');
      tr.appendChild(el('td', 'muted small', (q.created_at || '').slice(5, 16).replace('T', ' ')));
      tr.appendChild(el('td', '', q.student || '—'));
      tr.appendChild(el('td', '', q.mode || '—'));
      tr.appendChild(el('td', '', q.question.slice(0, 60)));
      const td = el('td');
      td.appendChild(el('span', `badge ${q.status === 'answered' ? 'ok' : 'revise'}`, q.status));
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    card.appendChild(t);
  }
  m.appendChild(card);
}

/* ---------------- 设置 ---------------- */

// 保存成功后的提示：要用模块级变量，否则 renderSettings() 重绘会把它冲掉
let settingsFlash = '';

// 掩码值（••••1234）不要提交回服务端，否则会覆盖真 key
function maskGuard(v) {
  const t = String(v || '').trim();
  return /^[•*]+/.test(t) ? '' : t;
}

async function renderSettings() {
  const m = $('#main');
  m.innerHTML = '';
  m.appendChild(el('h1', '', '设置'));

  if (settingsFlash) {
    const ok = el('div', 'notice good');
    ok.textContent = settingsFlash;
    m.appendChild(ok);
    settingsFlash = '';
  }

  let data;
  try {
    data = await api('/api/teacher/settings');
  } catch (e) {
    // 兼容旧版本服务端：接口不存在时不要甩一个 "not found" 给老师
    const hint = /not found|404/i.test(e.message)
      ? '这个版本还不支持在界面里改模型配置，请编辑 .env 后重启服务。'
      : e.message;
    const box = el('div', 'notice bad');
    box.appendChild(el('div', '', hint));
    const reload = el('button', 'small', '重新加载页面');
    reload.style.marginTop = '8px';
    reload.onclick = () => location.reload();
    box.appendChild(reload);
    m.appendChild(box);
    return;
  }
  const st = data.settings;

  const c1 = el('div', 'card');
  c1.appendChild(el('h2', '', '模型'));
  c1.appendChild(el('div', '', `当前聊天模型：${state.provider}${state.model ? ' · ' + state.model : ''}`));
  c1.appendChild(el('p', 'muted small', '保存在 data/settings.json（本机，不进版本库），保存后立即生效。'));
  if (state.ocr) {
    const ocrBox = el('div', 'row');
    ocrBox.style.marginTop = '10px';
    const label = { local: '本机 OCR', vision: '视觉模型', null: '不可用' }[state.ocr.chosen] || state.ocr.chosen;
    ocrBox.appendChild(el('span', `badge ${state.ocr.chosen === 'vision' ? 'ok' : ''}`, `OCR：${label}`));
    if (state.ocr.visionModel) ocrBox.appendChild(el('span', 'muted small', `${state.ocr.visionModel}${state.ocr.visionBase ? ' @ ' + state.ocr.visionBase : ''}`));
    c1.appendChild(ocrBox);
    c1.appendChild(el('p', 'muted small', '扫描版 PDF 的取字方式。视觉模型在下面的「OCR 视觉模型」里填，和聊天模型分开，互不影响。'));
  }
  m.appendChild(c1);

  // ---- 可编辑配置 ----
  const form = el('div', 'card');
  form.appendChild(el('h2', '', '模型配置'));
  form.appendChild(
    el('p', 'muted small', '留空表示不修改。key 明文存本机 data/settings.json，不要把这个文件发给别人。'),
  );

  // API Key 专用：默认掩码显示，粘贴后自动隐藏，可点眼睛临时查看
  const keyField = (parent, label, id, value, placeholder) => {
    const row = el('div', 'row');
    row.style.marginBottom = '8px';
    const lab = el('label', 'muted small');
    lab.style.minWidth = '96px';
    lab.textContent = label;
    const input = el('input');
    input.id = id;
    input.type = 'password';
    // 关键：掩码只放在 placeholder 里，绝不放进 value。
    // 否则用户点进去粘贴会变成「••••1234sk-新key」，被守卫丢掉，看起来像没覆盖。
    const masked = /^[•*]+/.test(value || '') ? value : '';
    input.value = '';
    input.placeholder = masked ? `${masked}（已保存，粘贴新 key 覆盖）` : placeholder || '';
    input.style.flex = '1';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const clearBtn = el('button', 'small danger', '清除');
    clearBtn.type = 'button';
    clearBtn.onclick = async () => {
      if (!confirm('清除已保存的 key？')) return;
      await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ ocr: { apiKey: null }, chat: { apiKey: null } }) });
      settingsFlash = '已清除保存的 key';
      renderSettings();
    };

    const eye = el('button', 'small', '显示');
    eye.type = 'button';
    eye.style.minWidth = '52px';
    eye.onclick = () => {
      if (input.type === 'password') {
        input.type = 'text';
        eye.textContent = '隐藏';
      } else {
        input.type = 'password';
        eye.textContent = '显示';
      }
    };

    // 粘贴后立刻隐藏，并提示末四位，让人确认贴对了又看不到全串
    input.addEventListener('paste', (ev) => {
      const clip = ev.clipboardData?.getData('text');
      if (clip) {
        ev.preventDefault();
        input.value = clip.trim();
      }
      setTimeout(() => {
        input.type = 'password';
        eye.textContent = '显示';
        const v = input.value.trim();
        const hint = input.parentElement?.nextElementSibling;
        if (hint && hint.dataset.hintFor === id) {
          hint.textContent = v && !/^[•*]/.test(v) ? `已粘贴，末四位 ${v.slice(-4)}（已隐藏）` : '';
        }
      }, 0);
    });
    // 失焦即隐藏，避免别人看屏幕
    input.addEventListener('blur', () => {
      input.type = 'password';
      eye.textContent = '显示';
    });

    row.appendChild(lab);
    row.appendChild(input);
    row.appendChild(eye);
    row.appendChild(clearBtn);
    parent.appendChild(row);

    const hint = el('div', 'muted small');
    hint.dataset.hintFor = id;
    hint.style.cssText = 'margin:-4px 0 8px 96px';
    hint.textContent = masked ? '已保存（只显示末四位）；粘贴新 key 会直接覆盖' : '';
    parent.appendChild(hint);
    return input;
  };

  const field = (parent, label, id, value, placeholder, type = 'text') => {
    const row = el('div', 'row');
    row.style.marginBottom = '8px';
    const lab = el('label', 'muted small');
    lab.style.minWidth = '96px';
    lab.textContent = label;
    const input = el('input');
    input.id = id;
    input.type = type;
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.style.flex = '1';
    row.appendChild(lab);
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  };

  form.appendChild(el('h3', '', '备课 / 答疑（聊天模型）'));
  field(form, '厂商', 'set-chat-provider', st.chat.provider, 'deepseek 或 openai');
  field(form, 'Base URL', 'set-chat-base', st.chat.baseUrl, '留空=按厂商默认；其它厂商填兼容端点');
  field(form, '模型名', 'set-chat-model', st.chat.model, 'deepseek-chat / gpt-4o-mini …');
  keyField(form, 'API Key', 'set-chat-key', st.chat.apiKey, st.chat.apiKey ? '已设置，留空不改' : 'sk-…');

  form.appendChild(el('h3', '', '审查 agent'));
  field(form, '模型名', 'set-review-model', st.review.model, `留空=跟随聊天模型（${data.effective.reviewModel || state.model || '当前模型'}）`);

  form.appendChild(el('h3', '', 'OCR 方式'));
  const status = data.ocrStatus || {};
  const modes = [
    { v: 'auto', label: '自动', hint: '配了视觉模型就用它，否则用本机' },
    { v: 'local', label: '本机 OCR', hint: status.localAvailable ? '可用' : '当前不可用' },
    { v: 'vision', label: '视觉模型', hint: status.visionAvailable ? '可用' : '未配置' },
    { v: 'command', label: '自定义命令', hint: status.commandAvailable ? '可用' : '未填命令' },
  ];
  const modeRow = el('div', 'chips');
  modeRow.style.marginBottom = '8px';
  const current = (st.ocr.backend || 'auto').toLowerCase();
  for (const m of modes) {
    const btn = el('button', 'chip' + (current === m.v ? ' on' : ''), `${m.label}（${m.hint}）`);
    btn.type = 'button';
    btn.dataset.mode = m.v;
    btn.onclick = () => {
      [...modeRow.children].forEach((b) => b.classList.toggle('on', b === btn));
      form.dataset.ocrBackend = m.v;
    };
    modeRow.appendChild(btn);
  }
  form.dataset.ocrBackend = current;
  form.appendChild(modeRow);
  if (!status.visionAvailable) {
    form.appendChild(el('p', 'muted small', '视觉模型还没配：在下面填 Base URL / 模型 / Key 后才能选「视觉模型」。'));
  }

  form.appendChild(el('h3', '', '自定义 OCR 命令'));
  form.appendChild(
    el(
      'p',
      'muted small',
      '如果你有别的本地 OCR（PaddleOCR、RapidOCR、ABBYY…），填一条能对单张图输出文字的命令。可用占位符：{img} 图片路径、{page} 页码、{pdf} 原 PDF、{from}/{to} 页码范围。命令的 stdout 就是该页文字。',
    ),
  );
  field(form, '命令', 'set-ocr-command', st.ocr.command, 'python3 -m rapidocr_onnxruntime --img {img}');

  form.appendChild(el('h3', '', 'OCR 视觉模型'));
  field(form, 'Base URL', 'set-ocr-base', st.ocr.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  field(form, '模型名', 'set-ocr-model', st.ocr.model, 'qwen-vl-max');
  keyField(form, 'API Key', 'set-ocr-key', st.ocr.apiKey, st.ocr.apiKey ? '已设置，留空不改' : 'sk-…');

  const saveRow = el('div', 'row');
  saveRow.style.marginTop = '12px';
  const save = el('button', 'primary', '保存并生效');
  const msg = el('span', 'muted small', '');
  save.onclick = async () => {
    save.disabled = true;
    try {
      const payload = {
        chat: {
          provider: $('#set-chat-provider').value.trim(),
          baseUrl: $('#set-chat-base').value.trim(),
          model: $('#set-chat-model').value.trim(),
          apiKey: maskGuard($('#set-chat-key').value),
        },
        review: { model: $('#set-review-model').value.trim() },
        ocr: {
          backend: form.dataset.ocrBackend || '',
          command: $('#set-ocr-command').value.trim(),
          baseUrl: $('#set-ocr-base').value.trim(),
          model: $('#set-ocr-model').value.trim(),
          apiKey: maskGuard($('#set-ocr-key').value),
        },
      };
      const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(payload) });
      const now = await api('/api/teacher/state');
      state.ocr = now.ocr;
      const ocrLabel =
        { local: '本机 OCR', vision: '视觉模型', command: '自定义命令', none: '不可用' }[now.ocr.chosen] || now.ocr.chosen;
      const detail = [r.effective.chatProvider ? `聊天 ${r.effective.chatProvider}·${r.effective.chatModel}` : '', `OCR ${ocrLabel}`]
        .filter(Boolean)
        .join('；');
      settingsFlash = `已保存并生效：${detail}`;
      toast(`✅ 已保存并生效：${detail}`, 4000);
      await refreshState();
      renderSettings();
    } catch (e) {
      msg.textContent = '保存失败：' + e.message;
      toast('❌ 保存失败：' + e.message, 5000);
      save.disabled = false;
    }
  };
  const testChatBtn = el('button', '', '测试聊天');
  testChatBtn.type = 'button';
  testChatBtn.onclick = async () => {
    testChatBtn.disabled = true;
    const label = testChatBtn.textContent;
    testChatBtn.textContent = '测试中…';
    try {
      const r = await api('/api/teacher/chat/test', { method: 'POST', body: JSON.stringify({}) });
      settingsFlash = r.ok
        ? `聊天模型可用：${r.provider} · ${r.model}（${r.ms}ms）`
        : `聊天模型不可用：${r.error}`;
      toast(r.ok ? `✅ 聊天模型可用（${r.ms}ms）` : '❌ ' + r.error, r.ok ? 4000 : 7000);
      renderSettings();
    } catch (e) {
      toast('❌ 测试失败：' + e.message, 5000);
      testChatBtn.disabled = false;
      testChatBtn.textContent = label;
    }
  };

  const testBtn = el('button', '', '测试 OCR');
  testBtn.type = 'button';
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    const old = testBtn.textContent;
    testBtn.textContent = '测试中…';
    try {
      const r = await api('/api/teacher/ocr/test', { method: 'POST', body: JSON.stringify({}) });
      if (r.ok) {
        settingsFlash = `视觉模型可用：${r.model || ''}（${r.ms}ms）读出「${r.sample || '（空）'}」`;
        toast(`✅ 视觉模型可用（${r.ms}ms）`, 4000);
      } else {
        settingsFlash = `视觉模型不可用：${r.error}`;
        toast('❌ ' + r.error, 6000);
      }
      renderSettings();
    } catch (e) {
      toast('❌ 测试失败：' + e.message, 5000);
      testBtn.disabled = false;
      testBtn.textContent = old;
    }
  };

  saveRow.appendChild(save);
  saveRow.appendChild(testChatBtn);
  saveRow.appendChild(testBtn);
  saveRow.appendChild(msg);
  form.appendChild(saveRow);
  m.appendChild(form);

  // ---- 网络（只读）----
  const net = state.network || {};
  const card = el('div', 'card');
  card.appendChild(el('h2', '', '网络'));
  const kv = (k, v) => {
    const row = el('div', 'row');
    row.style.marginBottom = '6px';
    const lab = el('span', 'muted small');
    lab.style.minWidth = '96px';
    lab.textContent = k;
    const val = el('span', 'small');
    val.innerHTML = v;
    row.appendChild(lab);
    row.appendChild(val);
    card.appendChild(row);
  };
  const host = net.host || '127.0.0.1';
  kv('监听', `<code>${host}:${net.port || 8787}</code>`);
  kv('本机访问', `<a href="http://127.0.0.1:${net.port || 8787}/teacher" target="_blank">http://127.0.0.1:${net.port || 8787}/teacher</a>`);
  if (host === '0.0.0.0') {
    kv('局域网', (net.lan || []).map((ip) => `<a href="http://${ip}:${net.port || 8787}/" target="_blank">${ip}</a>`).join('，') || '（没检测到局域网地址）');
  } else {
    kv('局域网', '<span class="muted">当前只听本机。要给局域网用，在 .env 里设 HOST=0.0.0.0 后重启</span>');
  }
  kv('外网', '<span class="muted">应用内不配。用 Cloudflare 隧道或 VPS 反代，见《配置指南》第四章</span>');
  kv('学生入口', `<code>http://&lt;你的地址&gt;:${net.port || 8787}/</code> · 凭访问码进入`);
  m.appendChild(card);

  if (state.codeVersion) {
    const ver = el('p', 'muted small');
    ver.textContent = `代码版本：${state.codeVersion}（两个实例版本不一致时，重启落后的那个）`;
    m.appendChild(ver);
  }

  const c2 = el('div', 'card');
  c2.appendChild(el('h2', '', '数据'));
  c2.appendChild(el('p', 'muted small', '配置备份 data/config-backup/；讲义备份 data/notes-backup/；材料备份 data/materials-backup/。'));
  const b = el('button', '', '立即重建全部课程');
  b.onclick = () => $('#btnBuild').click();
  c2.appendChild(b);
  m.appendChild(c2);
}

/* ---------------- 抽屉 ---------------- */

function openDrawer(title, html) {
  $('#drawerTitle').textContent = title;
  const body = $('#drawerBody');
  if (html) body.innerHTML = html;
  else body.innerHTML = '';
  $('#drawer').classList.add('open');
  return body;
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
}
$('#drawerClose').onclick = closeDrawer;

/* ---------------- 启动 ---------------- */

boot();
setInterval(() => {
  if (!$('#app').classList.contains('hide')) {
    api('/api/teacher/state')
      .then((s) => {
        state.summary = s.summary;
        state.courses = s.courses;
      })
      .catch(() => {});
  }
}, 30000);
