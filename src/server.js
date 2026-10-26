// 学生自助答疑服务：一人一码、按课程检索讲义、回答必须带出处、按人计额度、全程留痕。
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { COURSE_LIB, SERVICE_DIR, isDenied, loadCourseConfig, loadPacks } from './pack.js';
import { answerQuestion } from './answer.js';
import { KINDS, KIND_HINT, KIND_LABEL, classifyIntent } from './intent.js';
import { vectorStatus } from './search.js';
import { createLLM } from './llm.js';
import { openStore } from './store.js';
import { DEFAULT_QUOTA, evaluateQuota, periodStarts, quotaView, resolveQuota } from './quota.js';
import {
  buildDigest,
  digestMarkdown,
  profileDraft,
  profilePath,
  readProfile,
  writeProfile,
} from './profile.js';
import { createStudent, deleteStudent, rotateCode } from './students.js';
import {
  archiveCourse,
  createCourse,
  deleteMaterial,
  getCourse,
  listCourses,
  listMaterials,
  readCourseFile,
  resolveInCourse,
  attachToChapter,
  saveMaterial,
  updateCourse,
  writeCourseFile,
} from './courses.js';
import { buildAttachmentBlock, buildSystemPrompt, diffLines, parseDrafts, stripDrafts } from './agent.js';
import { buildVectorsFor } from './vectors.js';
import { applySettings, maskedSettings, readSettings, writeSettings } from './settings.js';
import { backendStatus, testVision } from './ocr.js';
import { ocrPdf } from './ocr.js';
import { renderMaterialBlock, searchMaterialsSmart } from './materialindex.js';
import { pagesFromText } from './ocr.js';

const ocrJobs = new Map();
import { buildCoursePacks } from './pack.js';

// ---------- .env（零依赖） ----------
function loadEnv() {
  const file = path.join(SERVICE_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const WEB_DIR = path.join(SERVICE_DIR, 'src/web');

// 配置文件热加载：新建/归档课程后无需重启
const CONFIG_FILE = path.join(SERVICE_DIR, 'config/courses.json');
let config = loadCourseConfig();
let configMtime = fs.existsSync(CONFIG_FILE) ? fs.statSync(CONFIG_FILE).mtimeMs : 0;
function refreshConfig() {
  try {
    const m = fs.statSync(CONFIG_FILE).mtimeMs;
    if (m !== configMtime) {
      config = loadCourseConfig();
      configMtime = m;
    }
  } catch {
    /* 配置读不到就沿用上一份 */
  }
}
const store = openStore();
applySettings();
let llm = createLLM();

// 额度优先级：内置默认 < .env < config.courses[].quota < 学生个人覆盖
const globalQuota = {
  ...DEFAULT_QUOTA,
  burstPerHour: Number(process.env.RATE_LIMIT_PER_HOUR || DEFAULT_QUOTA.burstPerHour),
  ...(config.quotaDefaults || {}),
};

function quotaFor(student, courseArg) {
  const course = courseArg || config.courses.find((c) => c.id === student.course_id);
  const defaults = { ...globalQuota, ...(course?.quota || {}) };

  // 每单覆盖优先于学生覆盖：一张单可以单独设次数
  const enr = course ? store.getEnrollment(student.name, course.id) : null;
  const studentOverrides = {
    daily: enr?.daily_limit ?? student.daily_limit,
    monthly: enr?.monthly_limit ?? student.monthly_limit,
    total: enr?.total_limit ?? student.total_limit,
    tokens: enr?.token_limit ?? student.token_limit,
    burstPerHour: enr?.burst_limit ?? student.burst_limit,
  };
  return resolveQuota({
    defaults,
    student: studentOverrides,
  });
}

// 学生码种子：config/students.json 只存哈希，明文码在生成时一次性输出
const studentsFile = path.join(SERVICE_DIR, 'config/students.json');
if (fs.existsSync(studentsFile)) {
  const seed = JSON.parse(fs.readFileSync(studentsFile, 'utf8'));
  if (Array.isArray(seed.students)) store.seedStudents(seed.students);
}

const adminToken = (() => {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const f = path.join(SERVICE_DIR, 'data/admin-token.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
})();

// ---------- 教师工作台：会话鉴权 ----------
// 代码版本：用服务端文件的修改时间，方便一眼看出某个实例是不是旧代码
const CODE_VERSION = (() => {
  try {
    const t = fs.statSync(path.join(SERVICE_DIR, 'src/server.js')).mtime;
    // 用本地时间：toISOString() 是 UTC，界面上会看成「服务还没重启」
    const z = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${z(t.getMonth() + 1)}-${z(t.getDate())} ${z(t.getHours())}:${z(t.getMinutes())}`;
  } catch {
    return '';
  }
})();

const clampTokens = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(32000, Math.max(1000, Math.round(v)));
};

// 推理型模型会先消耗预算思考，实际能写正文的量约为一半
const isReasoningModel = (name) => /reason|flash|r1|thinking|qwq|o1|o3/i.test(String(name || ''));

// 请求是否来自本机：只有本机访问时，「在文件夹中打开」才是「在用户自己的电脑上」
const isLocalReq = (req) => {
  // 经隧道/反代进来时，服务看到的对端仍是 127.0.0.1（cloudflared 在本机转发），
  // 所以必须看转发头：带了转发头就说明请求来自外部。
  const fwd = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
  if (fwd && String(fwd).trim() && String(fwd).trim() !== '127.0.0.1') return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

const safeHost = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return String(u || '').slice(0, 40);
  }
};

const COOKIE = 'dsh_teacher';
const loginFails = new Map(); // ip -> {n, until}

function cookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isTeacher = (req) =>
  cookies(req)[COOKIE] === adminToken || req.headers['x-admin-token'] === adminToken;

const readRaw = (req, limit = 42 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // 不要直接 destroy：那样客户端只看到连接断了，看不到任何提示。
        // 停掉收集、把剩余数据排空，让上层能正常返回 4xx。
        req.removeAllListeners('data');
        req.resume();
        reject(new Error(`文件过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const sseOpen = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
};

const sseSend = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// ---------- 知识包缓存 ----------
const packCache = new Map();
function getPacks(courseId) {
  const dir = path.join(SERVICE_DIR, 'packs', courseId);
  if (!fs.existsSync(dir)) return [];
  const newest = Math.max(
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => fs.statSync(path.join(dir, f)).mtimeMs),
    0,
  );
  const hit = packCache.get(courseId);
  if (hit && hit.mtime === newest) return hit.packs;
  const packs = loadPacks(courseId);
  packCache.set(courseId, { mtime: newest, packs });
  return packs;
}

// ---------- 额度 ----------
/** 当前额度状态：学生端只显示最紧的一维，后台显示全部。 */
function quotaStatus(student, course) {
  const starts = periodStarts();
  const usage = store.usage(student.name, starts, course ? course.id : null);
  const quota = quotaFor(student, course);
  const view = quotaView(usage, quota);
  return { starts, usage, quota, view, summary: view.summary };
}

// ---------- HTTP 小工具 ----------
const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(buf);
};

const readBody = (req, limit = 64 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

const VENDOR_DIR = path.join(WEB_DIR, 'vendor');
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** KaTeX 走本地托管：学生手机在国内访问 jsdelivr 不稳，公式渲染是体感第一关。 */
const serveVendor = (res, urlPath) => {
  const rel = decodeURIComponent(urlPath.slice('/vendor/'.length));
  const file = path.resolve(VENDOR_DIR, rel);
  if (!file.startsWith(VENDOR_DIR + path.sep) || !fs.existsSync(file)) {
    return json(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
};

const serveFile = (res, file, type) => {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
};

const publicCourses = () =>
  config.courses
    .filter((c) => c.enabled)
    .map((c) => ({
      id: c.id,
      name: c.name,
      school: c.school,
      policy: { defaultMode: c.policy?.defaultMode || 'hint', allowFullSolution: c.policy?.allowFullSolution !== false },
      chapters: (c.chapters || []).map((ch) => ({ key: ch.key, title: ch.title })),
    }));

// ---------- 教师工作台 ----------

/** 重建某门课：知识包 + 只重建改过的章节向量 */
async function rebuildCourse(courseId) {
  const t0 = Date.now();
  const cfg = loadCourseConfig();
  const targets = courseId ? cfg.courses.filter((c) => c.id === courseId) : cfg.courses.filter((c) => c.enabled);
  const result = { courses: [], ms: 0, blocks: 0, vectorChapters: 0 };
  for (const course of targets) {
    const built = buildCoursePacks(course);
    result.blocks += built.packs.reduce((a, p) => a + p.blocks.length, 0);
    const v = await buildVectorsFor(course.id, { packs: built.packs, onlyStale: true });
    result.vectorChapters += v.built;
    result.courses.push({ id: course.id, chapters: built.packs.length, rebuiltVectors: v.built, reused: v.reused });
  }
  result.ms = Date.now() - t0;
  return result;
}

/** 质检报告：扫 courses/<id>/质检/*.md，解析结论 */
function listReviews(courseId) {
  const dir = path.join(COURSE_LIB, courseId, '质检');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(dir, f);
      const text = fs.readFileSync(full, 'utf8').slice(0, 4000);
      const verdict = /(可授课|需修订|阻塞)/.exec(text)?.[1] || '未判定';
      return {
        file: f,
        rel: `质检/${f}`,
        mtime: fs.statSync(full).mtime.toISOString(),
        verdict,
        title: (text.match(/^#\s+(.+)$/m) || [, f])[1],
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function handleTeacher(req, res, url, p) {
  const method = req.method;
  const body = async () => {
    const raw = await readRaw(req, 4 * 1024 * 1024);
    if (!raw.length) return {};
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  };

  try {
    // ---- 登录 ----
    if (p === '/api/teacher/login' && method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      const f = loginFails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now()) return json(res, 429, { error: `尝试过多，请 ${Math.ceil((f.until - Date.now()) / 1000)} 秒后再试` });
      const { token } = await body();
      if (token !== adminToken) {
        f.n += 1;
        if (f.n >= 5) {
          f.until = Date.now() + 60_000;
          f.n = 0;
        }
        loginFails.set(ip, f);
        return json(res, 401, { error: '令牌无效' });
      }
      loginFails.delete(ip);
      res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(adminToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/teacher/logout' && method === 'POST') {
      res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }

    // 其余接口都要鉴权
    if (!isTeacher(req)) return json(res, 401, { error: '未登录' });

    if (p === '/api/teacher/state') {
      const courses = listCourses().map((c) => ({
        ...c,
        enrolled: store.enrollmentCount(c.id),
        reviews: listReviews(c.id).slice(0, 3),
        status: courseStatus(c),
      }));
      const { resolveBackend } = await import('./ocr.js');
      return json(res, 200, {
        courses,
        provider: llm.provider,
        model: llm.model || 'mock',
        codeVersion: CODE_VERSION,
        isLocal: isLocalReq(req),
        prep: {
          maxTokens: Number(process.env.PREP_MAX_TOKENS) || 32000,
          model: llm.model,
          reasoning: isReasoningModel(llm.model),
          // 经验值：DeepSeek 中文正文约 1 token ≈ 1.6 字（实测 13308 字 / 8297 token）
          charsPerToken: 1.6,
        },
        ocr: {
          ...(await backendStatus(llm)),
          visionModel: process.env.OCR_MODEL || (llm.supportsVision ? llm.model : null),
          visionBase: process.env.OCR_BASE_URL ? safeHost(process.env.OCR_BASE_URL) : null,
        },
        adminUrl: `/teacher`,
        summary: store.summary(7),
      });
    }

    // ---- 课程 ----
    if (p === '/api/teacher/courses' && method === 'POST') {
      const b = await body();
      const course = createCourse(b);
      return json(res, 200, { ok: true, course: { ...course, materials: 0 } });
    }
    const courseMatch = /^\/api\/teacher\/courses\/([A-Za-z0-9_-]+)$/.exec(p);
    if (courseMatch) {
      const id = courseMatch[1];
      // 编辑页必须拿完整配置（含每章 sources），列表接口是精简版
      if (method === 'GET') {
        const full = getCourse(id);
        if (!full) return json(res, 404, { error: '课程不存在' });
        return json(res, 200, {
          course: full,
          materials: listMaterials(id),
        });
      }
      if (method === 'PATCH') return json(res, 200, { ok: true, course: updateCourse(id, await body()) });
      if (method === 'DELETE') return json(res, 200, { ok: true, ...archiveCourse(id) });
    }

    // ---- 材料 ----
    if (p === '/api/teacher/materials') {
      const courseId = url.searchParams.get('course');
      if (!getCourse(courseId)) return json(res, 404, { error: '课程不存在' });

      if (method === 'GET') {
        return json(res, 200, { materials: listMaterials(courseId).map((m) => ({ ...m, denied: isDenied(m.name, getCourse(courseId).denyGlobs) })) });
      }
      if (method === 'PUT') {
        const name = url.searchParams.get('name') || 'material.md';
        const buf = await readRaw(req, 210 * 1024 * 1024);
        const saved = saveMaterial(courseId, name, buf);
        const rebuild = await rebuildCourse(courseId);
        return json(res, 200, { ok: true, ...saved, rebuild });
      }
      if (method === 'DELETE') {
        const name = url.searchParams.get('name');
        const r = deleteMaterial(courseId, name);
        const rebuild = await rebuildCourse(courseId);
        return json(res, 200, { ok: true, ...r, rebuild });
      }
    }

    // ---- 工作台设置（模型与 key，存 data/settings.json）----
    if (p === '/api/teacher/settings') {
      if (method === 'GET') {
        return json(res, 200, {
          settings: maskedSettings(),
          ocrStatus: await backendStatus(llm),
          effective: {
            chatProvider: llm.provider,
            chatModel: llm.model,
            reviewModel: process.env.REVIEW_MODEL || llm.model,
            ocrModel: process.env.OCR_MODEL || null,
            ocrBackend: (await import('./ocr.js')).resolveBackend
              ? await (await import('./ocr.js')).resolveBackend(llm)
              : null,
          },
        });
      }
      if (method === 'PUT' || method === 'PATCH') {
        const patch = await body();
        writeSettings(patch);
        applySettings();
        // 重建客户端，立即生效，无需重启进程
        llm = createLLM();
        return json(res, 200, {
          ok: true,
          effective: { chatProvider: llm.provider, chatModel: llm.model },
        });
      }
    }

    // ---- 聊天模型冒烟测试：模型名写错时能立刻发现 ----
    if (p === '/api/teacher/chat/test' && method === 'POST') {
      const t0 = Date.now();
      try {
        const r = await llm.chat({ messages: [{ role: 'user', content: '回复两个字：可用' }], maxTokens: 16 });
        return json(res, 200, { ok: true, provider: llm.provider, model: llm.model, ms: Date.now() - t0, sample: String(r).slice(0, 60) });
      } catch (e) {
        return json(res, 200, { ok: false, provider: llm.provider, model: llm.model, ms: Date.now() - t0, error: e.message });
      }
    }

    // ---- OCR 冒烟测试：确认视觉模型配对了没有 ----
    if (p === '/api/teacher/ocr/test' && method === 'POST') {
      const r = await testVision(llm);
      return json(res, 200, r);
    }

    // ---- OCR（扫描版 PDF → 文本），后台任务 + 进度 ----
    if (p === '/api/teacher/ocr' && method === 'POST') {
      const b = await body();
      if (!getCourse(b.courseId)) return json(res, 404, { error: '课程不存在' });
      const jobId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      ocrJobs.set(jobId, { status: 'running', progress: '启动中', startedAt: Date.now() });
      // 不 await：150 页要几十分钟，让前端轮询进度
      ocrPdf({
        courseId: b.courseId,
        name: b.name,
        pages: b.pages || undefined,
        llm,
        onProgress: (page, meta) => {
          const job = ocrJobs.get(jobId);
          if (job) job.progress = meta ? `${meta.done}/${meta.total} 页` : `第 ${page} 页`;
        },
      })
        .then(async (r) => {
          // OCR 产物默认只有老师能看到（备课检索按目录扫）。
          // 要让学生也能检索，必须挂进章节 sources 并重建，否则学生端永远搜不到。
          let attached = null;
          try {
            attached = attachToChapter(b.courseId, r.out, { nearFile: b.name });
            if (attached.changed) await rebuildCourse(b.courseId);
          } catch {
            /* 挂载失败不影响 OCR 结果本身 */
          }
          ocrJobs.set(jobId, {
            status: 'done',
            progress: '完成',
            out: r.out,
            backend: r.backend,
            pages: r.pages,
            attached,
          });
        })
        .catch((e) => {
          ocrJobs.set(jobId, { status: 'error', progress: e.message, error: e.message });
        });
      return json(res, 200, { ok: true, jobId });
    }
    if (p === '/api/teacher/ocr/status') {
      const job = ocrJobs.get(url.searchParams.get('jobId'));
      if (!job) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, job);
    }

    // ---- 手动重建 ----
    if (p === '/api/teacher/build' && method === 'POST') {
      const b = await body().catch(() => ({}));
      return json(res, 200, { ok: true, ...(await rebuildCourse(b.courseId || null)) });
    }

    // ---- 读文件 ----
    if (p === '/api/teacher/file') {
      const courseId = url.searchParams.get('course');
      const rel = url.searchParams.get('rel');
      if (!getCourse(courseId)) return json(res, 404, { error: '课程不存在' });
      const f = readCourseFile(courseId, rel);
      if (url.searchParams.get('download') === '1') {
        // 远程访问时用它把讲义存到本地（浏览器唯一能做的「打开本机文件」）
        const name = String(rel).split('/').pop() || 'file.md';
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'no-store',
        });
        return res.end(f.content);
      }
      return json(res, 200, f);
    }

    // ---- 文件树（材料 + 备课产物 + 质检） ----
    if (p === '/api/teacher/tree') {
      const courseId = url.searchParams.get('course');
      const course = getCourse(courseId);
      if (!course) return json(res, 404, { error: '课程不存在' });
      const notes = [];
      const notesRoot = path.join(COURSE_LIB, courseId, '备课');
      if (fs.existsSync(notesRoot)) {
        for (const d of fs.readdirSync(notesRoot, { withFileTypes: true })) {
          if (d.isDirectory()) {
            for (const f of fs.readdirSync(path.join(notesRoot, d.name))) {
              if (f.endsWith('.md')) notes.push({ rel: `备课/${d.name}/${f}`, chapter: d.name, name: f });
            }
          } else if (d.name.endsWith('.md')) {
            notes.push({ rel: `备课/${d.name}`, chapter: '', name: d.name });
          }
        }
      }
      return json(res, 200, {
        materials: listMaterials(courseId).map((m) => ({ ...m, denied: isDenied(m.name, course.denyGlobs) })),
        notes,
        reviews: listReviews(courseId),
        chapters: course.chapters || [],
        status: courseStatus(course),
      });
    }

    // ---- 最近一次会话里未应用的草稿（刷新后不丢） ----
    if (p === '/api/teacher/last-drafts') {
      const courseId = url.searchParams.get('course');
      if (!getCourse(courseId)) return json(res, 404, { error: '课程不存在' });
      const sessions = store.listSessions(courseId);
      for (const s of sessions) {
        const msgs = store.messages(s.id, 40);
        const last = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (!last) continue;
        // 已应用过的草稿（文件内容与草稿一致）不再算待应用
        const drafts = parseDrafts(last.content).filter((d) => {
          try {
            const cur = readCourseFile(courseId, d.rel).content;
            return cur.trim() !== d.content.trim();
          } catch {
            return true;
          }
        });
        if (!drafts.length) continue;
        return json(res, 200, {
          sessionId: s.id,
          drafts: drafts.map((d) => {
            let before = '';
            let mtime = null;
            try {
              const f = readCourseFile(courseId, d.rel);
              before = f.content;
              mtime = f.mtime;
            } catch {
              before = '';
            }
            return { ...d, before, mtime, exists: Boolean(before) };
          }),
        });
      }
      return json(res, 200, { sessionId: null, drafts: [] });
    }

    // ---- 在 Finder 里打开（仅本机可用）----
    if (p === '/api/teacher/reveal' && method === 'POST') {
      const b = await body();
      if (!getCourse(b.courseId)) return json(res, 404, { error: '课程不存在' });
      if (!isLocalReq(req)) {
        return json(res, 200, {
          ok: false,
          remote: true,
          error: '你现在是从别的设备访问，浏览器不允许网页打开那台设备的文件夹；请用「下载」把讲义存到本地。',
        });
      }
      if (process.platform !== 'darwin') {
        return json(res, 200, { ok: false, error: '「在文件夹中打开」只在 macOS 本机可用' });
      }
      let target;
      try {
        target = b.rel ? resolveInCourse(b.courseId, b.rel) : path.join(COURSE_LIB, b.courseId);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      if (!fs.existsSync(target)) return json(res, 404, { error: `路径不存在：${b.rel || b.courseId}` });

      // dry=1 只回目标路径，便于测试不真的弹 Finder
      if (b.dry) return json(res, 200, { ok: true, target, dry: true });

      const isDir = fs.statSync(target).isDirectory();
      spawn('open', isDir ? [target] : ['-R', target], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true, target, isDir });
    }

    // ---- 质检报告 ----
    if (p === '/api/teacher/reviews') {
      const courseId = url.searchParams.get('course');
      if (!getCourse(courseId)) return json(res, 404, { error: '课程不存在' });
      return json(res, 200, { reviews: listReviews(courseId) });
    }

    // ---- 会话列表 ----
    if (p === '/api/teacher/sessions') {
      const courseId = url.searchParams.get('course');
      return json(res, 200, { sessions: store.listSessions(courseId) });
    }
    if (p === '/api/teacher/session') {
      const id = Number(url.searchParams.get('id'));
      const s = store.getSession(id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      return json(res, 200, { session: s, messages: store.messages(id) });
    }

    // ---- 备课对话（SSE） ----
    if (p === '/api/teacher/chat' && method === 'POST') {
      const b = await body();
      const course = getCourse(b.courseId);
      if (!course) return json(res, 404, { error: '课程不存在' });
      if (!String(b.message || '').trim()) return json(res, 400, { error: '消息为空' });

      let sessionId = Number(b.sessionId) || 0;
      if (!sessionId) {
        sessionId = store.createSession({
          courseId: course.id,
          chapter: b.chapter || null,
          agent: b.agent || 'prep',
          title: String(b.message).slice(0, 30),
        });
      }

      const attachments = (b.attachments || []).map((rel) => {
        try {
          return { rel, content: readCourseFile(course.id, rel).content };
        } catch (e1) {
          // 扫描版 PDF 没有文字层：改用它同名 .ocr.md
          const ocrRel = rel.replace(/\.pdf$/i, '') + '.ocr.md';
          try {
            const f = readCourseFile(course.id, ocrRel);
            return { rel: `${rel}（OCR 文本）`, content: f.content };
          } catch {
            return {
              rel,
              content: `（无法读取「${rel}」：${e1.message}。${
                /\.pdf$/i.test(rel) ? '这是扫描版 PDF，没有文字层，请先在材料列表点「OCR 识别」。' : ''
              }）`,
            };
          }
        }
      });
      const attach = buildAttachmentBlock(attachments);



      // 备课端 RAG：按这次提问（含上一轮）自动从课程材料里挑相关段落，不必勾选整份文件
      const retrieved = await searchMaterialsSmart(
        course.id,
        `${b.message} ${store.messages(sessionId, 4).slice(-3).map((m) => m.content).join(' ')}`,
        { k: 6, pages: pagesFromText(b.message) },
      );
      const materialBlock = renderMaterialBlock(retrieved.blocks);

      const history = store.messages(sessionId, 20).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content.slice(0, 6000),
      }));

      const system = buildSystemPrompt({
        kind: b.agent === 'review' ? 'review' : 'prep',
        course,
        chapter: b.chapter,
        chapterTitle: b.chapterTitle,
        target: b.target,
      });

      const messages = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: [materialBlock, attach.text, b.message].filter(Boolean).join('\n\n') },
      ];

      store.addMessage(sessionId, 'user', b.message);

      sseOpen(res);
      sseSend(res, 'start', {
        sessionId,
        attachments: attachments.length,
        used: attach.used,
        truncated: attach.truncated,
        retrieved: retrieved.blocks.length,
        materialTotal: retrieved.total,
        retrieveMode: retrieved.mode,
      });

      let full = '';
      let finishReason = '';
      try {
        const r = await llm.chat({
          messages,
          // 输出上限：请求里带了就用请求的（备课界面可调），否则用配置/默认。
          // 推理型模型会把一部分预算花在思考上，所以默认给到 32000。
          maxTokens:
            b.agent === 'review'
              ? clampTokens(b.maxTokens) || Number(process.env.REVIEW_MAX_TOKENS) || 6000
              : clampTokens(b.maxTokens) || Number(process.env.PREP_MAX_TOKENS) || 32000,
        // 审查可以单独指定模型（例如用更强的模型把质量关），没配就跟随聊天模型
        model: b.agent === 'review' ? process.env.REVIEW_MODEL || undefined : undefined,
          stream: true,
          onDelta: (d) => {
            full += d;
            sseSend(res, 'delta', { text: d });
          },
        });
        finishReason = r.finishReason || '';
        if (!full) full = r.text;
      } catch (e) {
        sseSend(res, 'error', { error: e.message });
        res.end();
        return;
      }

      store.addMessage(sessionId, 'assistant', full);
      const drafts = parseDrafts(full);
      const truncatedByModel = finishReason === 'length';
      sseSend(res, 'done', {
        sessionId,
        truncatedByModel,
        text: stripDrafts(full) || full.slice(0, 2000),
        drafts: drafts.map((d) => {
          let before = '';
          try {
            before = readCourseFile(course.id, d.rel).content;
          } catch {
            before = '';
          }
          let mtime = null;
          try {
            mtime = readCourseFile(course.id, d.rel).mtime;
          } catch {
            mtime = null;
          }
          return { ...d, before, mtime, exists: Boolean(before) };
        }),
      });
      res.end();
      return;
    }

    // ---- 应用修改 ----
    if (p === '/api/teacher/apply' && method === 'POST') {
      const b = await body();
      const course = getCourse(b.courseId);
      if (!course) return json(res, 404, { error: '课程不存在' });
      const written = writeCourseFile(course.id, b.rel, b.content, { expectMtime: b.expectMtime });
      const rebuild = await rebuildCourse(course.id);
      return json(res, 200, { ok: true, ...written, rebuild });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) return json(res, 400, { error: e.message });
    try {
      sseSend(res, 'error', { error: e.message });
      res.end();
    } catch {
      /* 已经断开 */
    }
  }
}

/** 课程状态：从未备课 → 备课中 → 需修订/可授课/阻塞 */
function courseStatus(c) {
  const dir = path.join(COURSE_LIB, c.id, '备课');
  const hasNotes = fs.existsSync(dir) && fs.readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith('.md'));
  const reviews = listReviews(c.id);
  const latest = reviews[0]?.verdict;
  if (latest === '可授课') return { key: 'ready', label: '可授课' };
  if (latest === '需修订') return { key: 'revise', label: '需修订' };
  if (latest === '阻塞') return { key: 'blocked', label: '阻塞' };
  return hasNotes ? { key: 'writing', label: '备课中' } : { key: 'blank', label: '未备课' };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;
  refreshConfig();

  try {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html');
    if (p.startsWith('/vendor/')) return serveVendor(res, p);
    if (p === '/app.js') return serveFile(res, path.join(WEB_DIR, 'app.js'), 'text/javascript');
    if (p === '/md.js') return serveFile(res, path.join(WEB_DIR, 'md.js'), 'text/javascript');
    if (p === '/app.css') return serveFile(res, path.join(WEB_DIR, 'app.css'), 'text/css');
    if (p === '/teacher') {
      // 带令牌的直达链接：/teacher?token=xxx → 种 cookie 后清掉 URL 里的令牌
      const t = url.searchParams.get('token');
      if (t && t === adminToken) {
        res.writeHead(302, {
          'set-cookie': `${COOKIE}=${encodeURIComponent(adminToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
          location: '/teacher',
        });
        return res.end();
      }
      return serveFile(res, path.join(WEB_DIR, 'teacher.html'), 'text/html');
    }
    if (p === '/admin' || p === '/admin.html') return serveFile(res, path.join(WEB_DIR, 'admin.html'), 'text/html');
    if (p.startsWith('/api/teacher/')) return await handleTeacher(req, res, url, p);
    if (p === '/healthz') {
      const course = config.courses.find((c) => c.enabled);
      return json(res, 200, {
        ok: true,
        provider: llm.provider,
        packs: publicCourses().length,
        retrieval: course ? vectorStatus(getPacks(course.id)) : { hasVectors: false, chapters: [] },
      });
    }

    if (p === '/api/courses')
      return json(res, 200, {
        courses: publicCourses(),
        provider: llm.provider,
        kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k], hint: KIND_HINT[k] })),
      });

    if (p === '/api/me') {
      const student = store.findStudent(req.headers['x-access-code']);
      if (!student) return json(res, 401, { error: '访问码无效或已停用，请找老师要新的码。' });

      // 一个学生可能报了多门课，全部返回；学生端据此显示课程切换
      const enrolled = store
        .coursesOf(student.name)
        .map((id) => config.courses.find((c) => c.id === id))
        .filter((c) => c && c.enabled)
        .map((c) => ({
          id: c.id,
          name: c.name,
          chapters: (c.chapters || []).map((ch) => ({ key: ch.key, title: ch.title })),
        }));

      const wanted = url.searchParams.get('course');
      const current = enrolled.find((c) => c.id === wanted) || enrolled[0];
      const qs = quotaStatus(student, current ? config.courses.find((c) => c.id === current.id) : null);
      return json(res, 200, {
        name: student.name,
        label: student.label,
        courses: enrolled,
        // 兼容旧前端
        courseId: enrolled[0]?.id || '',
        courseName: enrolled[0]?.name || '',
        quota: {
          summary: qs.summary,
          limits: qs.quota,
          usage: qs.usage,
          day: qs.starts.day,
        },
      });
    }

    if (p === '/api/ask' && req.method === 'POST') {
      const student = store.findStudent(req.headers['x-access-code']);
      if (!student) return json(res, 401, { error: '访问码无效或已停用，请找老师要新的码。' });

      // 额度先于一切外部调用判断：额度用完就不该再花钱调模型
      const qs = quotaStatus(student);
      const check = evaluateQuota(qs.usage, qs.quota, qs.starts);
      if (!check.ok) {
        return json(res, 429, {
          error: check.message,
          code: check.code,
          quota: check.view,
          retryAt: check.retryAt,
        });
      }

      const body = await readBody(req);
      const enrolledIds = store.coursesOf(student.name);
      const wantedId = body.courseId || enrolledIds[0];
      if (!enrolledIds.includes(wantedId)) {
        return json(res, 403, { error: '这门课不在你的报名列表里，找老师开通。' });
      }
      const course = config.courses.find((c) => c.id === wantedId && c.enabled);
      if (!course) return json(res, 400, { error: '课程不存在或未启用' });

      const packs = getPacks(course.id);
      if (!packs.length) return json(res, 503, { error: '这门课的知识包还没构建，先运行 npm run build。' });

      const chosen =
        body.chapter && body.chapter !== 'auto' ? packs.filter((x) => x.chapterKey === body.chapter) : packs;
      if (!chosen.length) return json(res, 400, { error: '指定的章节没有知识包' });

      const question = String(body.question || '').trim().slice(0, 2000);
      if (!question) return json(res, 400, { error: '问题是空的' });

      // 学生自己指定了讲法就用他的，否则先判断他到底在问什么
      const forced = KINDS.includes(body.kind) ? body.kind : null;
      const intent = forced
        ? { kind: forced, confidence: 1, source: 'user', signals: ['学生指定'] }
        : await classifyIntent({ question, llm });

      // 带上最近两轮问答：学生追问「第四步那个公式」时才有上下文
      const history = store.recent(student.name, course.id, 2);
      const result = await answerQuestion({
        course,
        packs: chosen,
        question,
        kind: intent.kind,
        llm,
        history,
      });

      const id = store.record({
        courseId: course.id,
        student: student.name,
        question,
        answer: result.text,
        citations: result.citations,
        status: result.status,
        mode: result.kind,
        chapters: result.chapters,
        packVersions: result.packVersions,
        provider: result.provider,
        usage: result.usage,
        latencyMs: result.latencyMs,
      });

      const after = quotaStatus(student);
      return json(res, 200, {
        id,
        status: result.status,
        html: result.html,
        citations: result.citations,
        kind: result.kind,
        kindLabel: KIND_LABEL[result.kind],
        offSyllabus: Boolean(result.offSyllabus),
        intent: { confidence: intent.confidence, source: intent.source, signals: intent.signals },
        quota: {
          summary: after.summary,
          usedToday: after.usage.daily,
          leftToday: after.view.daily.left,
        },
      });
    }

    if (p === '/api/feedback' && req.method === 'POST') {
      const student = store.findStudent(req.headers['x-access-code']);
      if (!student) return json(res, 401, { error: '访问码无效' });
      const body = await readBody(req);
      const fb = body.feedback === 'up' ? 'up' : body.feedback === 'down' ? 'down' : null;
      if (!fb || !body.id) return json(res, 400, { error: '参数不完整' });
      store.setFeedback(Number(body.id), fb, body.note);
      return json(res, 200, { ok: true });
    }

    // ---- 教师后台 ----
    // 鉴权只有一套：cookie（工作台登录态）/ x-admin-token 请求头 / ?token= 查询参数，
    // 三者任一有效即可。工作台里的学生、问答面板走的就是 cookie。
    if (p.startsWith('/api/admin/')) {
      const token = req.headers['x-admin-token'] || url.searchParams.get('token');
      if (!isTeacher(req) && token !== adminToken) return json(res, 401, { error: '令牌无效' });

      if (p === '/api/admin/questions') {
        const rows = store.list({
          limit: Number(url.searchParams.get('limit') || 100),
          status: url.searchParams.get('status') || null,
          sinceDays: Number(url.searchParams.get('days') || 0) || null,
        });
        return json(res, 200, {
          questions: rows.map((r) => ({ ...r, citations: JSON.parse(r.citations || '[]') })),
        });
      }
      if (p === '/api/admin/summary') {
        return json(res, 200, store.summary(Number(url.searchParams.get('days') || 7)));
      }
      // ---- 学生码管理 ----
      if (p.startsWith('/api/admin/students/') && req.method === 'POST') {
        const body = await readBody(req);
        try {
          if (p === '/api/admin/students/create') {
            // 课程可以稍后再加：先建学生（学生库），再接单
            const course = body.courseId ? config.courses.find((c) => c.id === body.courseId && c.enabled) : null;
            if (body.courseId && !course) return json(res, 400, { error: '课程不存在或未启用' });
            const quota = {};
            for (const [from, to] of [
              ['daily', 'daily'],
              ['monthly', 'monthly'],
              ['total', 'total'],
              ['tokens', 'tokens'],
              ['burstPerHour', 'burstPerHour'],
            ]) {
              if (body.quota?.[from] !== undefined && body.quota[from] !== '') {
                const n = Number(body.quota[from]);
                if (!Number.isInteger(n) || n < 0) return json(res, 400, { error: '额度必须是非负整数' });
                quota[to] = n;
              }
            }
            const r = createStudent(
              {
                name: body.name,
                courseId: course ? course.id : '',
                label: body.label || null,
                project: body.project || null,
                quota,
              },
              store,
            );
            if (course) store.enroll(body.name, course.id);
            return json(res, 200, { ok: true, ...r, courseId: course ? course.id : null });
          }
          if (p === '/api/admin/students/rotate') {
            return json(res, 200, { ok: true, ...rotateCode(String(body.name || ''), store) });
          }
          if (p === '/api/admin/students/enrollment-quota') {
            store.setEnrollmentQuota(String(body.name || ''), String(body.courseId || ''), body.quota || {});
            return json(res, 200, { ok: true });
          }
          if (p === '/api/admin/students/enroll') {
            const course = config.courses.find((c) => c.id === body.courseId && c.enabled);
            if (!course) return json(res, 400, { error: '课程不存在或未启用' });
            if (!store.findStudentByName(String(body.name || ''))) return json(res, 404, { error: '学生不存在' });
            store.enroll(String(body.name), course.id, body.goal || null);
            return json(res, 200, { ok: true, courses: store.coursesOf(String(body.name)) });
          }
          if (p === '/api/admin/students/unenroll') {
            store.unenroll(String(body.name || ''), String(body.courseId || ''));
            return json(res, 200, { ok: true, courses: store.coursesOf(String(body.name || '')) });
          }
          if (p === '/api/admin/students/delete') {
            return json(res, 200, { ok: true, ...deleteStudent(String(body.name || ''), store) });
          }
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        return json(res, 404, { error: 'not found' });
      }

      if (p === '/api/admin/students') {
        const students = store.listStudents().map((s) => {
          const full = { ...s, ...quotaStatus(s) };
          const enrollmentQuotas = {};
          for (const cid of store.coursesOf(s.name)) {
            const e = store.getEnrollment(s.name, cid);
            enrollmentQuotas[cid] = e
              ? {
                  daily: e.daily_limit,
                  monthly: e.monthly_limit,
                  total: e.total_limit,
                  tokens: e.token_limit,
                  burstPerHour: e.burst_limit,
                }
              : {};
          }
          return {
            name: s.name,
            courses: store.coursesOf(s.name),
            enrollmentQuotas,
            course_id: s.course_id,
            label: s.label,
            project: s.project,
            active: s.active,
            created_at: s.created_at,
            limits: full.quota,
            usage: full.usage,
            view: full.view,
            hasProfile: (() => {
              try {
                const f = profilePath(s);
                return !!(f && fs.existsSync(f));
              } catch {
                return false;
              }
            })(),
          };
        });
        return json(res, 200, { students, day: periodStarts().day });
      }

      // 学生画像：读文件 + 附一段自动统计，写操作原子替换并留备份
      if (p === '/api/admin/profile') {
        const name = req.method === 'GET' ? url.searchParams.get('name') : null;
        const body = req.method === 'POST' ? await readBody(req, 512 * 1024) : null;
        const studentName = name || body?.name;
        const student = store.findStudentByName(String(studentName || ''));
        if (!student) return json(res, 404, { error: '学生不存在' });

        const course = config.courses.find((c) => c.id === student.course_id);
        if (req.method === 'POST') {
          const r = writeProfile(student, body.markdown);
          return json(res, 200, { ok: true, ...r });
        }
        const prof = readProfile(student, { courseName: course?.name || '' });
        const digest = buildDigest(store, student, { days: 60 });
        return json(res, 200, {
          student: {
            name: student.name,
            project: student.project,
            label: student.label,
            course_id: student.course_id,
          },
          profile: prof,
          digest,
          digestText: digestMarkdown(digest),
          draft: profileDraft(student, digest, { courseName: course?.name || '' }),
        });
      }
      if (p === '/api/admin/action' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.action === 'resolve') store.resolve(Number(body.id), body.resolved !== false);
        else if (body.action === 'note') store.addNote(Number(body.id), 'teacher', String(body.body || ''));
        else if (body.action === 'student') store.setStudentActive(body.name, !!body.active);
        else if (body.action === 'quota') store.setQuota(body.name, body.quota || {});
        else return json(res, 400, { error: '未知动作' });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }

    // 引用块原文（学生点角标时按需取，避免一次塞满页面）
    if (p === '/api/block' && req.method === 'POST') {
      if (!store.findStudent(req.headers['x-access-code'])) return json(res, 401, { error: '访问码无效' });
      const body = await readBody(req);
      for (const course of config.courses) {
        for (const pk of getPacks(course.id)) {
          const all = [...pk.blocks, ...pk.reserved];
          const b = all.find((x) => x.id === body.id);
          if (b) return json(res, 200, { id: b.id, label: b.label, chapterTitle: pk.chapterTitle, text: b.text });
        }
      }
      return json(res, 404, { error: '找不到该引用' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[error]', err);
    return json(res, 500, { error: String(err.message || err) });
  }
});

// 默认只听本机；放到 VPS 上需要 HOST=0.0.0.0（配合 Nginx/Caddy 反代）
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`助教服务已启动  http://127.0.0.1:${PORT}`);
  console.log(`  模型提供商：${llm.provider}${llm.model ? `（${llm.model}）` : ''}`);
  console.log(`  课程数：${publicCourses().length}`);
  console.log(
    `  默认额度：每天 ${globalQuota.daily} 次 · 每月 ${globalQuota.monthly} 次 · 每小时防连刷 ${globalQuota.burstPerHour} 次`,
  );
  console.log(`  教师后台：http://127.0.0.1:${PORT}/admin?token=${adminToken}`);
  if (llm.provider === 'mock') {
    console.log('  注意：当前是 mock 模型，答案是占位内容。填 .env 里的 DEEPSEEK_API_KEY 后重启即生效。');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
