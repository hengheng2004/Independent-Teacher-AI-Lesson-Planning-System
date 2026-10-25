// 课程与材料：建课、改配置、读写课程目录内的文件。
// 所有路径都过 resolveInCourse()，杜绝 ../ 或绝对路径跳出课程目录。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COURSE_LIB, WORKSPACE, loadCourseConfig } from './pack.js';
import { SERVICE_DIR } from './pack.js';

const CONFIG_FILE = path.join(SERVICE_DIR, 'config/courses.json');
const BACKUP_DIR = path.join(SERVICE_DIR, 'data/config-backup');
const MATERIAL_BACKUP = path.join(SERVICE_DIR, 'data/materials-backup');

/** 会进向量库、能被检索的扩展名 */
const INDEXABLE = new Set(['.md', '.markdown', '.txt']);

export const isIndexable = (name) => INDEXABLE.has(path.extname(String(name)).toLowerCase());

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{1,40}$/;

export function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/** 写配置前备份，原子替换。 */
export function writeConfig(cfg) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(CONFIG_FILE, path.join(BACKUP_DIR, `courses-${stamp}.json`));
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 把相对路径钉死在课程目录内；拒绝 ../、绝对路径、指向外部的符号链接。 */
export function resolveInCourse(courseId, rel) {
  const courseDir = path.resolve(COURSE_LIB, courseId);
  if (!courseDir.startsWith(path.resolve(COURSE_LIB) + path.sep)) throw new Error('课程编号不合法');
  const abs = path.resolve(courseDir, String(rel || ''));
  if (abs !== courseDir && !abs.startsWith(courseDir + path.sep)) throw new Error('路径越界');
  return abs;
}

export function listCourses() {
  const cfg = readConfig();
  return cfg.courses.map((c) => {
    const dir = path.join(COURSE_LIB, c.id);
    const materials = fs.existsSync(dir) ? listMaterials(c.id) : [];
    return {
      ...publicCourse(c),
      materials: materials.length,
      indexable: materials.filter((m) => m.indexable).length,
      exists: fs.existsSync(dir),
    };
  });
}

const publicCourse = (c) => ({
  id: c.id,
  name: c.name,
  school: c.school || '',
  teacher: c.teacher || '',
  enabled: c.enabled !== false,
  chapters: (c.chapters || []).map((ch) => ({ key: ch.key, title: ch.title })),
  policy: c.policy || {},
});

export function getCourse(id) {
  return readConfig().courses.find((c) => c.id === id) || null;
}

export function createCourse({ id, name, school, teacher, chapters }) {
  const slug = String(id || '').trim();
  if (!SLUG.test(slug)) throw new Error('课程编号只能用 2–41 位小写字母、数字和连字符，且以字母或数字开头');
  const cfg = readConfig();
  if (cfg.courses.some((c) => c.id === slug)) throw new Error(`课程 ${slug} 已存在`);
  if (!String(name || '').trim()) throw new Error('课程名称不能为空');

  const dir = path.join(COURSE_LIB, slug);
  fs.mkdirSync(dir, { recursive: true });

  const chapterList = (chapters || [])
    .map((ch, i) => ({
      key: String(ch.key || `ch${i + 1}`).trim(),
      title: String(ch.title || '').trim(),
      sources: [],
    }))
    .filter((ch) => ch.title);

  // 材料在章节建好之后再挂：默认把目录里所有可检索文件当本课材料
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && isIndexable(d.name))
    .map((d) => d.name);
  if (chapterList.length && files.length) chapterList[0].sources = files;

  cfg.courses.push({
    id: slug,
    name: String(name).trim(),
    school: school || '',
    teacher: teacher || '',
    enabled: true,
    quota: { daily: 20, monthly: 200 },
    policy: { defaultMode: 'hint', allowFullSolution: true },
    denyGlobs: ['*备课*', '*教师*', '*答案*', '*解答*', '资料/*'],
    chapters: chapterList.length ? chapterList : [{ key: 'ch1', title: '第一章', sources: [] }],
    references: files.includes('资料清单.md') ? ['资料清单.md'] : [],
    errata: [],
    notes: [],
  });
  writeConfig(cfg);
  return getCourse(slug);
}

export function updateCourse(id, patch) {
  const cfg = readConfig();
  const c = cfg.courses.find((x) => x.id === id);
  if (!c) throw new Error('课程不存在');
  for (const k of ['name', 'school', 'teacher']) if (patch[k] !== undefined) c[k] = String(patch[k]);
  if (patch.chapters) {
    c.chapters = patch.chapters.map((ch, i) => ({
      key: String(ch.key || `ch${i + 1}`),
      title: String(ch.title || ''),
      sources: (ch.sources || []).filter((s) => typeof s === 'string'),
    }));
  }
  writeConfig(cfg);
  return getCourse(id);
}

/** 归档：目录移到 _archived/，配置里移除。不真删任何材料。 */
export function archiveCourse(id) {
  const cfg = readConfig();
  const i = cfg.courses.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('课程不存在');
  const dir = path.join(COURSE_LIB, id);
  if (fs.existsSync(dir)) {
    const dest = path.join(COURSE_LIB, '_archived', `${id}-${Date.now()}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(dir, dest);
  }
  cfg.courses.splice(i, 1);
  writeConfig(cfg);
  // 构建产物随之清理，否则 packs/ 会堆满已归档课程的索引
  const packsDir = path.join(WORKSPACE, 'packs', id);
  if (fs.existsSync(packsDir)) fs.rmSync(packsDir, { recursive: true, force: true });
  return { ok: true };
}

// ---------- 材料 ----------

/** 课程根目录下的材料（不下钻 备课/ 质检/ 等子目录）。 */
export function listMaterials(courseId) {
  const dir = path.join(COURSE_LIB, courseId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => {
      const st = fs.statSync(path.join(dir, d.name));
      // 扫描版 PDF 没有文字层，靠同名 .ocr.md 提供可检索文本
      const ocrName = d.name.replace(/\.pdf$/i, '') + '.ocr.md';
      return {
        name: d.name,
        size: st.size,
        mtime: st.mtime.toISOString(),
        indexable: isIndexable(d.name),
        isPdf: /\.pdf$/i.test(d.name),
        ocr: fs.existsSync(path.join(dir, ocrName)) ? ocrName : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 同名自动加 -2/-3，绝不覆盖。 */
function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}

export function saveMaterial(courseId, originalName, buffer) {
  const course = getCourse(courseId);
  if (!course) throw new Error('课程不存在');
  const safe = path.basename(String(originalName || 'material')).replace(/[/\\]/g, '_').slice(0, 120);
  if (!safe || safe.startsWith('.')) throw new Error('文件名不合法');
  if (buffer.length > 200 * 1024 * 1024) throw new Error('单个文件不能超过 200MB（教材 PDF 通常够用）');

  const dir = path.join(COURSE_LIB, courseId);
  fs.mkdirSync(dir, { recursive: true });
  const name = freeName(dir, safe);
  fs.writeFileSync(path.join(dir, name), buffer);

  // 可检索的新文件自动挂到第一章（若该章还没有来源列表）
  if (isIndexable(name)) {
    const cfg = readConfig();
    const c = cfg.courses.find((x) => x.id === courseId);
    const ch = (c.chapters || []).find((x) => !x.sources || !x.sources.length) || c.chapters[0];
    if (ch && !ch.sources.includes(name)) {
      ch.sources = [...(ch.sources || []), name];
      writeConfig(cfg);
    }
  }
  return { name, indexable: isIndexable(name), size: buffer.length };
}

/**
 * 把某个文件挂进章节的 sources（已在就别重复加）。
 * 优先挂到引用了同源 PDF 的章节，其次第一个空章，最后第一章。
 */
export function attachToChapter(courseId, fileName, { nearFile } = {}) {
  const cfg = readConfig();
  const c = cfg.courses.find((x) => x.id === courseId);
  if (!c) throw new Error('课程不存在');
  const chapters = c.chapters || [];
  const has = (ch) => (ch.sources || []).includes(fileName);
  if (chapters.some(has)) return { changed: false, chapter: chapters.find(has).key };

  const near = nearFile
    ? chapters.find((ch) => (ch.sources || []).some((s) => s.replace(/\.pdf$/i, '') === nearFile.replace(/\.pdf$/i, '')))
    : null;
  const target = near || chapters.find((ch) => !(ch.sources || []).length) || chapters[0];
  if (!target) return { changed: false, chapter: null };

  target.sources = [...(target.sources || []), fileName];
  writeConfig(cfg);
  return { changed: true, chapter: target.key };
}

export function deleteMaterial(courseId, name) {
  const abs = resolveInCourse(courseId, name);
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  fs.mkdirSync(MATERIAL_BACKUP, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(abs, path.join(MATERIAL_BACKUP, `${courseId}-${stamp}-${path.basename(abs)}`));
  fs.unlinkSync(abs);

  const cfg = readConfig();
  const c = cfg.courses.find((x) => x.id === courseId);
  if (c) {
    for (const ch of c.chapters || []) ch.sources = (ch.sources || []).filter((s) => s !== name);
    c.references = (c.references || []).filter((s) => s !== name);
    writeConfig(cfg);
  }
  return { ok: true, backup: path.join(MATERIAL_BACKUP, `${courseId}-${stamp}-${path.basename(abs)}`) };
}

// ---------- 课程内任意文件读写（备课产物、质检报告） ----------

export function readCourseFile(courseId, rel) {
  const abs = resolveInCourse(courseId, rel);
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  const st = fs.statSync(abs);
  if (st.size > 2 * 1024 * 1024) throw new Error('文件过大（>2MB），请用本机编辑器打开');
  return {
    path: path.relative(WORKSPACE, abs),
    rel,
    mtime: st.mtime.toISOString(),
    content: fs.readFileSync(abs, 'utf8'),
  };
}

const NOTE_BACKUP = path.join(SERVICE_DIR, 'data/notes-backup');

/**
 * 写课程内文件。expectMtime 给定时比对，不一致说明期间被外部改过，拒绝写入。
 * 原子写 + 备份。
 */
export function writeCourseFile(courseId, rel, content, { expectMtime } = {}) {
  const abs = resolveInCourse(courseId, rel);
  const exists = fs.existsSync(abs);
  if (expectMtime && exists) {
    const cur = fs.statSync(abs).mtime.toISOString();
    if (cur !== expectMtime) throw new Error('文件在对话期间已被修改，请重新生成后再应用');
  }
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('内容超过 2MB');

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (exists) {
    fs.mkdirSync(NOTE_BACKUP, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(abs, path.join(NOTE_BACKUP, `${courseId}-${stamp}-${path.basename(abs)}`));
  }
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs);
  return {
    path: path.relative(WORKSPACE, abs),
    rel,
    created: !exists,
    bytes: Buffer.byteLength(text),
    mtime: fs.statSync(abs).mtime.toISOString(),
  };
}

export function hash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}
