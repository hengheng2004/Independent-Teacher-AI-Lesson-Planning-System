// 接口级回归测试：起一个真实服务，验证鉴权与几个关键路径。
// 覆盖的正是「cookie 能过 /api/teacher，却被 /api/admin 打回 401」这类只会在 HTTP 层暴露的 bug。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const TOKEN = 'test-token-http';
const base = `http://127.0.0.1:${PORT}`;

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error(`✗ ${name}`);
  pass += 1;
  console.log(`  ✓ ${name}`);
};

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: TOKEN, LLM_PROVIDER: 'mock' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitUp = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

try {
  const up = await waitUp();
  if (!up) throw new Error('服务没能启动');

  console.log('\n[鉴权]');
  const noAuth = await fetch(`${base}/api/teacher/state`);
  ok('未登录访问工作台接口返回 401', noAuth.status === 401);

  const badLogin = await fetch(`${base}/api/teacher/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong' }),
  });
  ok('错误令牌登录被拒', badLogin.status === 401);

  var login = await fetch(`${base}/api/teacher/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  ok('正确令牌登录成功', login.status === 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok('登录返回 HttpOnly cookie', /dsh_teacher=/.test(cookie) && /HttpOnly/i.test(login.headers.get('set-cookie') || ''));

  const state = await fetch(`${base}/api/teacher/state`, { headers: { cookie } });
  ok('带 cookie 读取工作台状态', state.status === 200);

  // 这条就是用户报的 bug：cookie 登录后，学生/问答面板却 401
  const adminWithCookie = await fetch(`${base}/api/admin/students`, { headers: { cookie } });
  ok('带 cookie 也能访问旧后台接口（回归）', adminWithCookie.status === 200);

  const adminNoAuth = await fetch(`${base}/api/admin/students`);
  ok('不带凭证访问后台接口仍是 401', adminNoAuth.status === 401);

  const adminHeader = await fetch(`${base}/api/admin/students`, { headers: { 'x-admin-token': TOKEN } });
  ok('旧后台的请求头方式仍然可用', adminHeader.status === 200);

  console.log('\n[页面]');
  for (const p of ['/teacher', '/app.js', '/app.css', '/']) {
    const r = await fetch(`${base}${p}`);
    ok(`页面 ${p} 可访问`, r.status === 200);
  }

  const tokenUrl = await fetch(`${base}/teacher?token=${TOKEN}`, { redirect: 'manual' });
  ok('/teacher?token= 直接种 cookie 并跳转', tokenUrl.status === 302);

  console.log('\n[课程与材料]');
  const courseId = `http-test-${Date.now().toString(36)}`;
  const create = await fetch(`${base}/api/teacher/courses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ id: courseId, name: '接口测试课', chapters: [{ key: 'ch1', title: '第一章' }] }),
  });
  ok('建课成功', create.status === 200);

  const upload = await fetch(`${base}/api/teacher/materials?course=${courseId}&name=${encodeURIComponent('讲义.md')}`, {
    method: 'PUT',
    headers: { cookie },
    body: '# 第一章\n\n## 1.1 小节\n\n内容\n',
  });
  const upJson = await upload.json();
  ok('上传材料成功', upload.status === 200);
  ok('上传后自动重建知识包', upJson.rebuild && upJson.rebuild.blocks > 0);

  const tree = await (await fetch(`${base}/api/teacher/tree?course=${courseId}`, { headers: { cookie } })).json();
  ok('文件树能看到材料', tree.materials.some((m) => m.name === '讲义.md'));

  const outside = await fetch(`${base}/api/teacher/file?course=${courseId}&rel=${encodeURIComponent('../../../etc/passwd')}`, {
    headers: { cookie },
  });
  ok('路径穿越被拒绝', outside.status === 400 || outside.status === 404);

  // 学生 × 课程：一人多课、未报名不能提问
  console.log('\n[报名关系]');
  const tag = Date.now().toString(36);
  const stuName = `接口测试生-${tag}`;
  const stu = await (
    await fetch(`${base}/api/admin/students/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: stuName, courseId }),
    })
  ).json();
  ok('建学生返回访问码', Boolean(stu.code));

  const me1 = await (await fetch(`${base}/api/me`, { headers: { 'x-access-code': stu.code } })).json();
  ok('学生看到自己报的课', me1.courses.some((c) => c.id === courseId));

  const otherCourse = `${courseId}-b`;
  await fetch(`${base}/api/teacher/courses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ id: otherCourse, name: '另一门课', chapters: [{ key: 'ch1', title: '第一章' }] }),
  });
  const denied = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': stu.code },
    body: JSON.stringify({ courseId: otherCourse, question: '未报名的课能问吗' }),
  });
  ok('没报名的课提问被拒（403）', denied.status === 403);

  const enroll = await fetch(`${base}/api/admin/students/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: stuName, courseId: otherCourse }),
  });
  ok('老师加课后可以报多门', enroll.status === 200);
  const me2 = await (await fetch(`${base}/api/me`, { headers: { 'x-access-code': stu.code } })).json();
  ok('学生端能看到两门课', me2.courses.length === 2);

  const noEnroll = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': stu.code },
    body: JSON.stringify({ courseId: otherCourse, question: '刚加的课' }),
  });
  ok('加课后不再 403（无材料则 503）', noEnroll.status !== 403);

  console.log('\n[额度按单 / 画像 / 质检]');
  const quotaSet = await fetch(`${base}/api/admin/students/enrollment-quota`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: stuName, courseId, quota: { daily: 7 } }),
  });
  ok('可以给某一单单独设额度', quotaSet.status === 200);
  const meQuota = await (
    await fetch(`${base}/api/me?course=${courseId}`, { headers: { 'x-access-code': stu.code } })
  ).json();
  ok('该单额度生效', meQuota.quota.summary.limit === 7);
  const otherQuota = await (
    await fetch(`${base}/api/me?course=${otherCourse}`, { headers: { 'x-access-code': stu.code } })
  ).json();
  ok('另一单额度不受影响', otherQuota.quota.summary.limit !== 7);

  // 画像：需要绑定学生项目目录
  const stu2 = await (
    await fetch(`${base}/api/admin/students/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `画像测试生-${tag}`, courseId, project: `http-profile-${tag}` }),
    })
  ).json();
  const prof = await (
    await fetch(`${base}/api/admin/profile?name=${encodeURIComponent(`画像测试生-${tag}`)}`, { headers: { cookie } })
  ).json();
  ok('画像有落点路径', Boolean(prof.profile.path));
  ok('未创建时给模板', !prof.profile.exists && prof.profile.markdown.includes('学生画像'));
  const saved = await fetch(`${base}/api/admin/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `画像测试生-${tag}`, markdown: '# 测试\n' }),
  });
  ok('画像可保存', saved.status === 200);

  // 编辑课程：章节与材料归属
  // 编辑页必须能拿到每章 sources，否则"打开就保存"会清空材料归属
  const one = await (await fetch(`${base}/api/teacher/courses/${courseId}`, { headers: { cookie } })).json();
  ok('单课程接口返回章节来源', Array.isArray(one.course.chapters[0].sources));
  ok('单课程接口返回材料清单', Array.isArray(one.materials) && one.materials.length > 0);

  const roundtrip = await (
    await fetch(`${base}/api/teacher/courses/${courseId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: one.course.name,
        school: one.course.school,
        teacher: one.course.teacher,
        chapters: one.course.chapters,
      }),
    })
  ).json();
  ok('原样保存不会清空 sources', roundtrip.course.chapters[0].sources.length === one.course.chapters[0].sources.length);

  const added = await (
    await fetch(`${base}/api/teacher/courses/${courseId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        chapters: [...one.course.chapters, { key: 'ch2', title: '第二章', sources: [] }],
      }),
    })
  ).json();
  ok('可以新增章节', added.course.chapters.length === 2);

  const patch = await fetch(`${base}/api/teacher/courses/${courseId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: '改过名的课',
      chapters: [{ key: 'ch1', title: '第一章', sources: ['讲义.md'] }],
    }),
  });
  const patched = await patch.json();
  ok('可以改课名与章节材料归属', patch.status === 200 && patched.course.name === '改过名的课');
  ok('章节 sources 已写入', patched.course.chapters[0].sources.includes('讲义.md'));

  // 质检报告 → 课程状态
  const report = await fetch(`${base}/api/teacher/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      courseId,
      rel: '质检/2026-01-01-ch1.md',
      content: '# ch1 质检\n\n## 结论\n需修订 —— 缺一道题\n',
    }),
  });
  ok('质检报告可写回课程目录', report.status === 200);
  const st2 = await (await fetch(`${base}/api/teacher/state`, { headers: { cookie } })).json();
  const c2 = st2.courses.find((c) => c.id === courseId);
  ok('报告结论反映到课程状态', c2 && c2.status.label === '需修订');
  ok('报告出现在课程列表里', c2.reviews.some((r) => r.verdict === '需修订'));

  console.log('\n[OCR]');
  const ocrBad = await fetch(`${base}/api/teacher/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ courseId: 'not-a-course', name: 'x.pdf' }),
  });
  ok('不存在的课程拒绝 OCR', ocrBad.status === 404);
  const ocrStatus = await fetch(`${base}/api/teacher/ocr/status?jobId=nope`, { headers: { cookie } });
  ok('未知任务返回 404', ocrStatus.status === 404);

  await fetch(`${base}/api/admin/students/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `画像测试生-${tag}` }),
  });

  await fetch(`${base}/api/teacher/courses/${otherCourse}`, { method: 'DELETE', headers: { cookie } });
  // 清理测试学生，避免每次跑都往学生库里堆人
  await fetch(`${base}/api/admin/students/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: stuName }),
  });

  // 真实课程的编号常带大写（CRS-ECNU-...），接口必须认
  const upperId = 'CRS-TEST-UPPER-01';
  const mkUpper = await fetch(`${base}/api/teacher/courses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ id: upperId, name: '大写编号测试', chapters: [{ key: 'ch1', title: '第一章' }] }),
  });
  ok('允许大写课程编号', mkUpper.status === 200);
  const getUpper = await fetch(`${base}/api/teacher/courses/${upperId}`, { headers: { cookie } });
  ok('大写编号能读取', getUpper.status === 200);
  const delUpper = await fetch(`${base}/api/teacher/courses/${upperId}`, { method: 'DELETE', headers: { cookie } });
  ok('大写编号能删除', delUpper.status === 200);

  const del = await fetch(`${base}/api/teacher/courses/${courseId}`, { method: 'DELETE', headers: { cookie } });
  ok('归档课程成功', del.status === 200);

  console.log(`\nHTTP 测试通过：${pass} 项。\n`);
} finally {
  // 无论成败都清理自己造的数据，避免失败时把垃圾留在配置和课程目录里
  try {
    const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
    const st = await (await fetch(`${base}/api/teacher/state`, { headers: { cookie } })).json();
    for (const c of st.courses || []) {
      if (String(c.id).startsWith('http-test-')) {
        await fetch(`${base}/api/teacher/courses/${c.id}`, { method: 'DELETE', headers: { cookie } });
      }
    }
    // 画像目录不会被 delete 接口清掉，测试自己收尾
    const fsmod = await import('node:fs');
    const pdir = path.join(ROOT, 'students');
    if (fsmod.existsSync(pdir)) {
      for (const d of fsmod.readdirSync(pdir)) {
        if (d.startsWith('http-profile-')) fsmod.rmSync(path.join(pdir, d), { recursive: true, force: true });
      }
    }
    const students = await (await fetch(`${base}/api/admin/students`, { headers: { cookie } })).json();
    for (const stu of students.students || []) {
      if (/^(接口测试生|画像测试生)-/.test(stu.name)) {
        await fetch(`${base}/api/admin/students/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: stu.name }),
        });
      }
    }
  } catch {}
  server.kill('SIGTERM');
}
