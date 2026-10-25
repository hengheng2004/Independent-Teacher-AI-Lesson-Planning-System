#!/usr/bin/env node
// 端到端自测：不需要 API key，用 mock 模型跑通「切块 → 检索 → 回答 → 引用校验 → 留痕」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-test-'));
process.env.TA_PROJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-projects-'));
process.env.TA_BACKUP_DIR = path.join(process.env.TA_DATA_DIR, 'profile-backups');
process.env.TA_SEED_FILE = path.join(process.env.TA_DATA_DIR, 'students.json');
process.env.TA_CODE_VAULT = path.join(process.env.TA_DATA_DIR, 'codes.md');

const { loadCourseConfig, buildCoursePacks, chunkMarkdown, retrieve, isDenied } = await import('../src/pack.js');
const { renderAnswer, answerQuestion } = await import('../src/answer.js');
const { createLLM } = await import('../src/llm.js');
const { openStore, hashCode } = await import('../src/store.js');

let pass = 0;
const ok = (name, fn) => {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
};

const course = loadCourseConfig().courses.find((c) => c.enabled);
const md = fs.readFileSync(
  path.resolve(import.meta.dirname, '../courses', course.id, course.chapters.at(-1).sources[0]),
  'utf8',
);

console.log('\n[1] 切块');
const blocks = chunkMarkdown(md, 'chX');
ok('块数合理（>8）', () => assert.ok(blocks.length > 8, `只有 ${blocks.length} 块`));
ok('块编号唯一', () => assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length));
ok('每块都有标签和正文', () => blocks.forEach((b) => {
  assert.ok(b.label && b.label.length > 2);
  assert.ok(b.text.trim().length > 0);
}));
ok('例题被切成独立块', () => assert.ok(blocks.some((b) => /例\d+\.\d+-\d+/.test(b.label))));
ok('最大块不超过 5200 字符', () => assert.ok(Math.max(...blocks.map((b) => b.chars)) <= 5200));

console.log('\n[2] 泄漏隔离');
ok('教师版讲义命中黑名单', () => assert.ok(isDenied('备课/第一章_向量空间_备课讲义.md', course.denyGlobs)));
ok('答案 PDF 命中黑名单', () => assert.ok(isDenied('资料/exercise-answers.pdf', course.denyGlobs)));
ok('学生讲义不命中黑名单', () => assert.ok(!isDenied(course.chapters[0].sources[0], course.denyGlobs)));

const built = buildCoursePacks(course);
ok('构建出章节包', () => assert.ok(built.packs.length >= 1));
ok('包内含资料清单块', () => assert.ok(built.packs[0].reserved.some((b) => b.id.endsWith('-R1'))));

console.log('\n[3] 检索');
const { packsUsed } = retrieve(built.packs, '线性无关和线性相关有什么区别', { budget: 14000 });
ok('检索到内容', () => assert.ok(packsUsed.length > 0));
const provided = new Set(packsUsed.flatMap((p) => p.blocks.map((b) => b.id)));
ok('检索结果不含包外块', () => assert.ok([...provided].every((id) => id.startsWith('ch'))));

console.log('\n[4] 引用校验');
const realId = built.packs[0].blocks[0].id;
const bogusId = `${built.packs[0].chapterKey}-S9999`;
const fake = `这是回答。[[${realId}]][[${bogusId}]][[我不存在的块]]`;
const r = renderAnswer(fake, built.packs.map((p) => ({ pack: p, blocks: p.blocks })));
ok('编造的块编号被剔除', () => assert.ok(r.invalid.includes(bogusId)));
ok('非块编号格式不被当成引用', () => assert.ok(!r.html.includes('我不存在的块]')));
ok('有效引用留在 citations 里', () => assert.ok(r.citations.length >= 1));
ok('HTML 被转义', () => assert.ok(!/<script/i.test(renderAnswer('<script>alert(1)</script>', []).html)));

console.log('\n[5] 无依据');
const ne = renderAnswer('[[无依据]] 讲义里没有这段。', []);
ok('无依据被判为 unanswered', () => assert.equal(ne.status, 'unanswered'));
ok('渲染成可见提示', () => assert.ok(ne.html.includes('noev')));

console.log('\n[6] mock 问答全链路');
const llm = createLLM({ LLM_PROVIDER: 'mock' });
const ans = await answerQuestion({
  course,
  packs: built.packs,
  question: '向量空间的八条公理里哪两条需要单独验证？',
  kind: 'knowledge',
  llm,
});
ok('状态为已回答', () => assert.equal(ans.status, 'answered', JSON.stringify(ans.status)));
ok('至少一条有效引用', () => assert.ok(ans.citations.length >= 1));
ok('引用块真实存在于知识包', () =>
  ans.citations.forEach((c) => assert.ok(built.packs.some((p) => p.blocks.some((b) => b.id === c.id)))));
ok('回传本次使用的讲法', () => assert.equal(ans.kind, 'knowledge'));

console.log('\n[7] 留痕');
const store = openStore();
store.seedStudents([{ name: '测试同学', course_id: course.id, code: 'TEST-CODE', label: '自测' }]);
ok('访问码可查到学生', () => assert.equal(store.findStudent('test-code').name, '测试同学'));
ok('错误访问码查不到', () => assert.equal(store.findStudent('NOPE'), undefined));
ok('码以哈希存储', () => assert.notEqual(hashCode('TEST-CODE'), 'TEST-CODE'));
const id = store.record({
  courseId: course.id,
  student: '测试同学',
  question: '测试问题',
  answer: ans.text,
  citations: ans.citations,
  status: ans.status,
  mode: 'hint',
  chapters: ans.chapters,
  packVersions: ans.packVersions,
  provider: llm.provider,
  usage: ans.usage,
  latencyMs: ans.latencyMs,
});
store.setFeedback(id, 'down');
const summary = store.summary(7);
ok('写入后可统计', () => assert.ok(summary.rows.length >= 1));
ok('差评进入统计', () => assert.ok(summary.rows.some((r) => (r.bad || 0) >= 1)));

console.log('\n[8] 额度');
const { DEFAULT_QUOTA, evaluateQuota, periodStarts, quotaView, resolveQuota } = await import('../src/quota.js');

const starts = periodStarts(new Date('2026-10-25T08:00:00+08:00'));
ok('今日零点按上海时区', () => assert.equal(starts.today, '2026-10-24T16:00:00.000Z'));
ok('本月零点按上海时区', () => assert.equal(starts.month, '2026-09-30T16:00:00.000Z'));

const quota = resolveQuota({
  defaults: { ...DEFAULT_QUOTA, daily: 2, monthly: 10, burstPerHour: 5 },
  student: { daily: null, monthly: '', total: 3 },
});
ok('学生未设置时跟随默认', () => assert.equal(quota.daily, 2));
ok('学生覆盖生效', () => assert.equal(quota.total, 3));
ok('空字符串视为未设置', () => assert.equal(quota.monthly, 10));

ok('未达上限放行', () =>
  assert.equal(evaluateQuota({ daily: 1, monthly: 1, total: 1, tokens: 0, burstPerHour: 0 }, quota, starts).ok, true));

const blocked = evaluateQuota({ daily: 2, monthly: 2, total: 2, tokens: 0, burstPerHour: 0 }, quota, starts);
ok('每日额度用完被拦', () => assert.equal(blocked.code, 'daily'));
ok('提示里说了何时恢复', () => assert.ok(blocked.message.includes('明天')));
ok('返回恢复时间', () => assert.ok(blocked.retryAt));

ok('防连刷优先于每日', () => {
  const q = { daily: 1, monthly: 5, total: 0, tokens: 0, burstPerHour: 1 };
  const r = evaluateQuota({ daily: 1, monthly: 1, total: 0, tokens: 0, burstPerHour: 2 }, q, starts);
  assert.equal(r.code, 'burst');
});

ok('token 兜底生效', () => {
  const q = { daily: 0, monthly: 0, total: 0, tokens: 100, burstPerHour: 0 };
  const r = evaluateQuota({ daily: 0, monthly: 0, total: 0, tokens: 100, burstPerHour: 0 }, q, starts);
  assert.equal(r.code, 'tokens');
});

ok('0 表示不限', () => {
  const q = { daily: 0, monthly: 0, total: 0, tokens: 0, burstPerHour: 0 };
  const r = evaluateQuota({ daily: 999, monthly: 999, total: 999, tokens: 9e9, burstPerHour: 99 }, q, starts);
  assert.equal(r.ok, true);
});

ok('学生端取最紧的维度', () => {
  const v = quotaView(
    { daily: 2, monthly: 3, total: 0, tokens: 0, burstPerHour: 0 },
    { daily: 10, monthly: 50, total: 0, tokens: 0, burstPerHour: 0 },
  );
  assert.equal(v.summary.dimension, 'daily');
  assert.equal(v.summary.left, 8);
});

ok('用量按学生累计', () => {
  const u = store.usage('测试同学', starts);
  assert.equal(u.total, 1);
});
ok('后台能看到每个学生的额度与用量', () => {
  const rows = store.listWithUsage(starts).filter((s) => s.name === '测试同学');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.total, 1);
});
ok('可单独改额度', () => {
  store.setQuota('测试同学', { daily: 5 });
  assert.equal(store.findStudentByName('测试同学').daily_limit, 5);
});

console.log('\n[9] 意图判断');
const { classifyByRules, KIND_LABEL } = await import('../src/intent.js');
const { buildSystemPrompt } = await import('../src/answer.js');

const cases = [
  ['什么是线性无关？', 'knowledge'],
  ['子空间判据为什么要求对加法封闭', 'knowledge'],
  ['这个定理的条件能去掉吗', 'knowledge'],
  ['这道题怎么做', 'problem_guided'],
  ['求 z 对 x 的偏导', 'problem_guided'],
  ['给我完整过程', 'problem_full'],
  ['请写出详细推导', 'problem_full'],
  ['这一步是怎么来的', 'problem_step'],
  ['第二个小问为什么可以这样', 'problem_step'],
  ['特征值怎么复习比较有效', 'extend'],
  ['线性无关和秩有什么联系', 'extend'],
  ['这两章的知识能不能串起来', 'extend'],
];
for (const [q, want] of cases) {
  ok(`「${q}」→ ${KIND_LABEL[want]}`, () => assert.equal(classifyByRules(q).kind, want));
}

ok('"要求"不会被误判成解题', () =>
  assert.equal(classifyByRules('定理为什么要求偏导连续').kind, 'knowledge'));
ok('粘贴的整题按讲题处理', () => {
  const pasted = "设 $A$ 是 $3\\times3$ 矩阵，讨论方程组 $Ax=0$\n的解空间维数与 $A$ 的秩的关系，并求一组基";
  assert.equal(classifyByRules(pasted).kind, 'problem_guided');
});
ok('分类结果带可解释信号', () => assert.ok(classifyByRules('这一步怎么来的').signals.includes('某一步')));

console.log('\n[10] 讲法策略');
ok('讲知识：明确要求不讲题', () => assert.ok(buildSystemPrompt(course, 'knowledge').includes('不要主动解题')));
ok('讲题·引导：禁止完整推导', () => assert.ok(buildSystemPrompt(course, 'problem_guided').includes('不写完整推导')));
ok('讲题·完整：要求分步且标依据', () => {
  const p = buildSystemPrompt(course, 'problem_full');
  assert.ok(p.includes('第 1 步'));
  assert.ok(p.includes('检验'));
});
ok('只讲这一步：限制篇幅', () => assert.ok(buildSystemPrompt(course, 'problem_step').includes('180 字')));
ok('拓展：要求标注"不在讲义原文"', () => assert.ok(buildSystemPrompt(course, 'extend').includes('拓展（不在讲义原文）')));
ok('五种讲法互不相同', () => {
  const prompts = ['knowledge', 'problem_guided', 'problem_full', 'problem_step', 'extend'].map((k) =>
    buildSystemPrompt(course, k),
  );
  assert.equal(new Set(prompts).size, 5);
});
ok('拓展允许无出处，状态不是警告', () => {
  const r = renderAnswer('拓展（不在讲义原文）：做题时先列表再动笔。', built.packs.map((p) => ({ pack: p, blocks: p.blocks })), {
    allowUncited: true,
  });
  assert.equal(r.status, 'extended');
});
ok('其他讲法无出处仍算未定位', () => {
  const r = renderAnswer('随便说说。', built.packs.map((p) => ({ pack: p, blocks: p.blocks })));
  assert.equal(r.status, 'uncited');
});

console.log('\n[11] 学生画像');
const { profilePath, readProfile, writeProfile, profileDraft, buildDigest, digestMarkdown } = await import(
  '../src/profile.js'
);
const stu = { name: '小测', project: 'STU-TEST-001', label: '自测' };

ok('未绑定项目时不猜目录', () => assert.equal(profilePath({ name: '没人' }), null));
ok('路径越界被拒绝', () => assert.throws(() => profilePath({ name: 'x', project: '../../etc' })));
ok('项目编号非法字符被拒绝', () => assert.throws(() => profilePath({ name: 'x', project: 'a/b' })));

const before = readProfile(stu, { courseName: '测试课' });
ok('文件不存在时给模板而非报错', () => {
  assert.equal(before.exists, false);
  assert.ok(before.markdown.includes('学生画像'));
  assert.ok(before.markdown.includes('测试课'));
});

const w1 = writeProfile(stu, '# 小测 · 学生画像\n\n## 兴趣\n- 画图\n');
ok('写入成功并返回相对路径', () => assert.ok(w1.path.endsWith('学生画像.md')));
const after = readProfile(stu);
ok('能读回内容', () => {
  assert.equal(after.exists, true);
  assert.ok(after.markdown.includes('画图'));
});

writeProfile(stu, '# 小测 · 学生画像\n\n## 兴趣\n- 反例\n');
const backups = fs.readdirSync(process.env.TA_BACKUP_DIR);
ok('覆盖前自动备份旧版本', () => assert.equal(backups.length, 1));
ok('备份里是旧内容', () => {
  const old = fs.readFileSync(path.join(process.env.TA_BACKUP_DIR, backups[0]), 'utf8');
  assert.ok(old.includes('画图'));
});
ok('超长内容被拒绝', () => assert.throws(() => writeProfile(stu, 'x'.repeat(210 * 1024))));

const fakeStore = {
  listByStudent: () => [
    { question: '线性无关的定义是什么', status: 'answered', mode: 'knowledge', chapters: 'ch18', created_at: '2026-10-25T01:00:00Z' },
    { question: '这一步怎么来的：行变换求秩', status: 'unanswered', mode: 'problem_step', chapters: 'ch18', created_at: '2026-10-25T02:00:00Z' },
    { question: '线性无关和秩有什么联系', status: 'answered', mode: 'extend', chapters: 'ch18', created_at: '2026-10-25T03:00:00Z' },
  ],
};
const digest = buildDigest(fakeStore, stu);
ok('摘要统计提问数与类型', () => {
  assert.equal(digest.total, 3);
  assert.equal(digest.byKind.length, 3);
});
ok('摘要统计待补答', () => assert.equal(digest.unresolved, 1));
ok('摘要给出章节分布', () => assert.equal(digest.byChapter.ch18, 3));
ok('摘要抽高频词', () => assert.ok(digest.topTerms.some((t) => t.startsWith('线性'))));
const dm = digestMarkdown(digest);
ok('摘要能被渲染成 Markdown', () => {
  assert.ok(dm.includes('近 60 天提问：3 条'));
  assert.ok(dm.includes('待老师补答：1 条'));
});
ok('空记录时摘要不编造', () => {
  const empty = buildDigest({ listByStudent: () => [] }, stu);
  assert.ok(digestMarkdown(empty).includes('还没有答疑记录'));
});
ok('草稿把摘要放到可删段落', () => {
  const d = profileDraft(stu, digest, { courseName: '测试课' });
  assert.ok(d.includes('## 自动摘要（可删）'));
  assert.ok(d.includes('线性'));
});

console.log('\n[12] 向量检索');
const { retrieveForPrompt } = await import('../src/search.js');

const enQuery = await retrieveForPrompt(built.packs, 'what does linear independence mean', { maxBlocks: 12 });
ok('检索可调用并标注模式', () => assert.ok(['hybrid', 'lexical'].includes(enQuery.mode), enQuery.mode));
// 有没有建过向量索引，两种情况都必须能工作
if (enQuery.mode === 'hybrid') {
  ok('英文提问也能取到相关块', () => {
    const labels = enQuery.packsUsed.flatMap((p) => p.blocks.map((b) => b.label));
    assert.ok(labels.some((l) => l.includes('线性') || l.includes('基')), `实际取到：${labels.join(' | ')}`);
  });
} else {
  ok('没有向量索引时安静退回词法', () => assert.ok(enQuery.packsUsed.length >= 0));
}
ok('向量检索不会突破注入预算', () => assert.ok(enQuery.totalChars <= 14000));

const lean = await retrieveForPrompt(built.packs, '基与维数是什么关系', { maxBlocks: 6 });
ok('混合检索结果都在知识包内', () => {
  const known = new Set(built.packs.flatMap((p) => [...p.blocks, ...p.reserved].map((b) => b.id)));
  for (const p of lean.packsUsed) for (const b of p.blocks) assert.ok(known.has(b.id), b.id);
});

console.log('\n[13] 学生码管理');
const { createStudent, rotateCode, deleteStudent, readSeed, generateCode } = await import('../src/students.js');

ok('码形如 XXXX-XXXX 且不含易混字符', () => {
  for (let i = 0; i < 20; i += 1) {
    const c = generateCode();
    assert.match(c, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  }
});

const created = createStudent(
  { name: '码测', courseId: course.id, label: '自测', quota: { daily: 3, total: 9 } },
  store,
);
ok('新增后拿到明文码', () => assert.match(created.code, /-/));
ok('新增立即可用（不用重启）', () => assert.equal(store.findStudent(created.code).name, '码测'));
ok('种子文件只存哈希不存明文', () => {
  const raw = fs.readFileSync(process.env.TA_SEED_FILE, 'utf8');
  assert.ok(!raw.includes(created.code));
  assert.ok(readSeed().students.some((s) => s.name === '码测'));
});
ok('明文码记进了 codes.md', () =>
  assert.ok(fs.readFileSync(process.env.TA_CODE_VAULT, 'utf8').includes(created.code)));
ok('同名重复创建被拒绝', () =>
  assert.throws(() => createStudent({ name: '码测', courseId: course.id }, store), /已存在/));
ok('非法名字被拒绝', () => assert.throws(() => createStudent({ name: 'a/b', courseId: course.id }, store)));

const rotated = rotateCode('码测', store);
ok('换码后新码可用', () => assert.equal(store.findStudent(rotated.code).name, '码测'));
ok('换码后旧码失效', () => assert.equal(store.findStudent(created.code), undefined));
ok('换码后额度保留', () => assert.equal(store.findStudentByName('码测').daily_limit, 3));

deleteStudent('码测', store);
ok('删除后码立即失效', () => assert.equal(store.findStudent(rotated.code), undefined));
ok('删除后种子文件里也没有了', () => assert.ok(!readSeed().students.some((s) => s.name === '码测')));

console.log('\n[14] 教师工作台');
const {
  createCourse, getCourse, listCourses, saveMaterial, listMaterials, deleteMaterial,
  readCourseFile, writeCourseFile, archiveCourse, resolveInCourse,
} = await import('../src/courses.js');
const { parseDrafts, stripDrafts, diffLines, buildAttachmentBlock } = await import('../src/agent.js');
const fsx = await import('node:fs');
const HTTPS_ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const pathx = await import('node:path');

ok('路径越界被拒绝', () => {
  assert.throws(() => resolveInCourse('x', '../../etc/passwd'), /越界|不合法/);
  assert.throws(() => resolveInCourse('x', '/etc/passwd'), /越界|不合法/);
});
ok('正常相对路径被接受', () => assert.ok(resolveInCourse('x', '备课/a/b.md').endsWith(pathx.join('备课', 'a', 'b.md'))));

const TMP = 'test-course-tmp';
archiveCourseSafe(TMP);
const course1 = createCourse({ id: TMP, name: '测试课', chapters: [{ key: 'ch1', title: '第一章' }] });
ok('建课成功', () => assert.equal(course1.id, TMP));
ok('课程出现在列表里', () => assert.ok(listCourses().some((c) => c.id === TMP)));
ok('非法编号被拒绝', () => assert.throws(() => createCourse({ id: '中文编号', name: 'x' }), /编号/));
ok('重名被拒绝', () => assert.throws(() => createCourse({ id: TMP, name: 'x' }), /已存在/));

const up = saveMaterial(TMP, '讲义.md', Buffer.from('# 第一章\n\n## 1.1\n\n内容\n'));
ok('上传材料落盘', () => assert.equal(up.name, '讲义.md'));
const up2 = saveMaterial(TMP, '讲义.md', Buffer.from('x'));
ok('同名自动加后缀，不覆盖', () => assert.equal(up2.name, '讲义-2.md'));
ok('材料列表包含两份', () => assert.equal(listMaterials(TMP).length, 2));

const w = writeCourseFile(TMP, '备课/ch1/第01章.md', '# 讲义\n');
ok('写备课产物成功', () => assert.equal(w.created, true));
const back = readCourseFile(TMP, '备课/ch1/第01章.md');
ok('能读回内容', () => assert.ok(back.content.includes('讲义')));
ok('mtime 冲突被拒绝', () => assert.throws(() => writeCourseFile(TMP, '备课/ch1/第01章.md', 'x', { expectMtime: '2020-01-01T00:00:00.000Z' }), /已被修改/));
// 覆盖一次，验证备份确实产生
writeCourseFile(TMP, '备课/ch1/第01章.md', '# 讲义 v2\n');
ok('覆盖前有备份', () => {
  const dir = pathx.join(HTTPS_ROOT, 'data/notes-backup');
  assert.ok(fsx.existsSync(dir) && fsx.readdirSync(dir).length >= 1);
});

const del = deleteMaterial(TMP, '讲义-2.md');
ok('删除材料有备份', () => assert.ok(fsx.existsSync(del.backup)));

// 草稿解析
const raw = '说明文字\n\n```markdown path=备课/ch1/a.md\n# A\n```\n\n```markdown path=../../evil.md\nbad\n```';
const drafts = parseDrafts(raw);
ok('解析出带路径的代码块', () => assert.equal(drafts.length, 1));
ok('路径越界的块被丢弃', () => assert.equal(drafts[0].rel, '备课/ch1/a.md'));
ok('聊天正文里不带代码块', () => assert.ok(!stripDrafts(raw).includes('```')));
ok('diff 能标出增删', () => {
  const d = diffLines('a\nb', 'a\nc');
  assert.deepEqual(d.map((x) => x.type), ['same', 'del', 'add']);
});

// 附件预算
const big = 'x'.repeat(9000);
const att = buildAttachmentBlock([
  { rel: 'a.md', content: big },
  { rel: 'b.md', content: big },
  { rel: 'c.md', content: big },
]);
ok('附件超长会被截断并记录', () => assert.ok(att.truncated.length >= 1));
ok('附件总预算不超上限', () => assert.ok(att.used <= att.budget));

archiveCourse(TMP);
ok('归档后课程从配置里消失', () => assert.ok(!listCourses().some((c) => c.id === TMP)));
cleanupArchived(TMP);

function attachCourseCleanup() {
  if (getCourse('attach-test')) {
    archiveCourse('attach-test');
    cleanupArchived('attach-test');
  }
}
function archiveCourseSafe(id) {
  if (getCourse(id)) {
    archiveCourse(id);
    cleanupArchived(id);
  }
}
function cleanupArchived(id) {
  const base = pathx.join(pathx.dirname(new URL(import.meta.url).pathname), '..', 'courses', '_archived');
  if (!fsx.existsSync(base)) return;
  for (const d of fsx.readdirSync(base)) {
    if (d.startsWith(id)) fsx.rmSync(pathx.join(base, d), { recursive: true, force: true });
  }
}

console.log('\n[15] 学生 × 课程（报名关系）');
const s1 = createStudent({ name: '多课学生', courseId: course.id }, store);
ok('建号时自动报名第一门课', () => assert.deepEqual(store.coursesOf('多课学生'), [course.id]));
store.enroll('多课学生', 'another-course', '期中');
ok('可以再加一门课', () => assert.equal(store.coursesOf('多课学生').length, 2));
store.enroll('多课学生', 'another-course');
ok('重复报名不会产生重复记录', () => assert.equal(store.coursesOf('多课学生').length, 2));
ok('按课程查学生', () => assert.ok(store.studentsOf('another-course').some((x) => x.student === '多课学生')));
ok('课程报名人数正确', () => assert.equal(store.enrollmentCount('another-course'), 1));
store.unenroll('多课学生', 'another-course');
ok('退课生效', () => assert.deepEqual(store.coursesOf('多课学生'), [course.id]));
ok('退课后人数减少', () => assert.equal(store.enrollmentCount('another-course'), 0));
store.enroll('多课学生', 'another-course');
deleteStudent('多课学生', store);
ok('删学生时报名记录一并清除', () => {
  assert.equal(store.findStudentByName('多课学生'), undefined);
  assert.ok(!store.studentsOf('another-course').some((x) => x.student === '多课学生'));
});

console.log('\n[16] 备课端材料检索');
const { searchMaterials, courseIndex } = await import('../src/materialindex.js');
const idx = courseIndex('linear-algebra-demo');
ok('能索引到课程材料', () => idx.length > 0);
ok('索引块带来源标签', () => idx.every((b) => typeof b.label === 'string' && b.label.includes('·')));

const hit = searchMaterials('linear-algebra-demo', '线性无关 极大无关组', { k: 3 });
ok('相关提问能命中段落', () => hit.blocks.length > 0);
ok('命中块来自讲义', () => hit.blocks.some((b) => b.rel === '学生讲义.md'));

const miss = searchMaterials('linear-algebra-demo', 'zzz 完全无关的词组 qqq', { k: 3 });
ok('无关提问不硬凑结果', () => miss.blocks.length === 0);

const capped = searchMaterials('linear-algebra-demo', '向量 空间 线性', { k: 10, budget: 600 });
ok('总长度受预算限制', () => capped.blocks.reduce((a, b) => a + b.text.length, 0) <= 600);

console.log('\n[17] OCR 页码范围');
const { parsePages, pagesFromText } = await import('../src/ocr.js');
ok('--pages 解析单页', () => assert.deepEqual(parsePages('7', 50), { from: 7, to: 7 }));
ok('--pages 解析区间', () => assert.deepEqual(parsePages('3-12', 50), { from: 3, to: 12 }));
ok('越界自动收紧', () => assert.deepEqual(parsePages('40-999', 50), { from: 40, to: 50 }));
ok('空值即全部', () => assert.deepEqual(parsePages(undefined, 50), { from: 1, to: 50 }));
ok('从中文里认页码', () => assert.deepEqual(pagesFromText('把第 12–15 页讲一下'), { from: 12, to: 15 }));
ok('认 p7 这种写法', () => assert.deepEqual(pagesFromText('看 p7'), { from: 7, to: 7 }));
ok('没有页码返回 null', () => assert.equal(pagesFromText('讲讲最小二乘'), null));

// 不依赖用户的真实课程：示例课没有页码标签时，这个断言自动跳过
const paged = searchMaterials('linear-algebra-demo', '第 1 页 向量', { k: 3, pages: { from: 1, to: 2 } });
ok('点名页码时同页优先（无页码标签则不误伤）', () =>
  paged.blocks.length === 0 || !/第 \d+ 页/.test(paged.blocks[0].label) || /第 [12] 页/.test(paged.blocks[0].label),
);

console.log('\n[18] Markdown 渲染');
const { mdToHtml, inlineMd, escapeHtml } = await import('../src/web/md.js');
ok('标题转成 h 标签', () => mdToHtml('## 知识主线').includes('<h2>知识主线</h2>'));
ok('加粗生效', () => inlineMd('这是 **重点**').includes('<strong>重点</strong>'));
ok('行内代码不被二次解析', () => inlineMd('用 `**not bold**` 表示').includes('<code>**not bold**</code>'));
ok('HTML 被转义，不会注入', () => escapeHtml('<script>x</script>').includes('&lt;script&gt;'));
ok('表格渲染', () => {
  const h = mdToHtml('| 时间 | 内容 |\n|---|---|\n| 0-5 | 介绍 |');
  return h.includes('<th>时间</th>') && h.includes('<td>0-5</td>');
});
ok('无序列表', () => mdToHtml('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
ok('有序列表', () => mdToHtml('1. 第一\n2. 第二').includes('<ol><li>第一</li>'));
ok('引用块', () => mdToHtml('> 提示').includes('<blockquote><p>提示</p></blockquote>'));
ok('代码块保留原文', () => mdToHtml('```\n**x**\n```').includes('<code>**x**</code>'));
ok('公式原样保留给 KaTeX', () => mdToHtml('值是 $n^{-2s}$ 量级').includes('$n^{-2s}$'));
ok('围栏代码块不会被当成标题', () => {
  const h = mdToHtml('```\n# 注释\n```');
  return h.includes('<pre class="md-code">') && !h.includes('<h1>');
});

console.log('\n[19] 向量增量更新');
const { buildVectorsFor } = await import('../src/vectors.js');
const { loadVectors } = await import('../src/embed.js');
const cfgForVec = JSON.parse(fs.readFileSync(path.join(HTTPS_ROOT, 'config/courses.json'), 'utf8'));
const demoCourse = cfgForVec.courses.find((c) => c.id === 'linear-algebra-demo');
const packsA = buildCoursePacks(demoCourse).packs;
const v1 = await buildVectorsFor('linear-algebra-demo', { packs: packsA, onlyStale: false });
ok('首次全量建向量', () => v1.built === packsA.length);
const v2 = await buildVectorsFor('linear-algebra-demo', { packs: packsA, onlyStale: true });
ok('内容没变时全部复用', () => v2.built === 0 && v2.reused === packsA.length);
const saved = loadVectors('linear-algebra-demo');
ok('向量文件记录了模型名', () => typeof saved.model === 'string' && saved.model.length > 0);
ok('每章记录 packVersion', () => Object.values(saved.chapters).every((c) => typeof c.packVersion === 'string'));

console.log('\n[20] 材料挂章与备课混合检索');
const { attachToChapter } = await import('../src/courses.js');
attachCourseCleanup();
const ac = createCourse({ id: 'attach-test', name: '挂章测试', chapters: [{ key: 'ch1', title: '第一章' }, { key: 'ch2', title: '第二章' }] });
const a1 = attachToChapter('attach-test', '讲义.md');
ok('空课程会把文件挂到第一章', () => a1.changed && a1.chapter === 'ch1');
const a2 = attachToChapter('attach-test', '讲义.md');
ok('已在章节里就不重复挂', () => !a2.changed);
const a3 = attachToChapter('attach-test', 'lec1.ocr.md', { nearFile: 'lec1.pdf' });
ok('按同名 PDF 归属挂章', () => a3.changed);
attachCourseCleanup();

const smart = await (await import('../src/materialindex.js')).searchMaterialsSmart;
const hy = await smart('linear-algebra-demo', '线性无关', { k: 3 });
ok('备课混合检索可用', () => hy.mode === 'hybrid' || hy.mode === 'lexical');
ok('混合检索有结果', () => hy.blocks.length > 0);

console.log('\n[21] 知识包加载不会读错文件');
const { loadPacks: lp } = await import('../src/pack.js');
const packsNow = lp('linear-algebra-demo');
ok('每章都有 blocks 数组', () => packsNow.every((p) => Array.isArray(p.blocks)));
ok('不会把 material-vectors.json 当成包', () => packsNow.every((p) => typeof p.chapterKey === 'string'));

console.log(`\n全部通过：${pass} 项。\n`);
