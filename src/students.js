// 学生码管理：一处生成、一处落盘，CLI 和后台共用。
// 两个持久化位置必须同时更新：
//   1) config/students.json —— 重启后还能恢复（种子）
//   2) SQLite students 表 —— 当前进程立即生效
// 只改一处就会出现"重启后学生又回来了"或者"码发了但不生效"。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SERVICE_DIR } from './pack.js';
import { hashCode } from './store.js';

// 测试可用 TA_SEED_FILE / TA_CODE_VAULT 指到临时文件
const SEED_FILE = process.env.TA_SEED_FILE || path.join(SERVICE_DIR, 'config/students.json');
const CODE_VAULT = process.env.TA_CODE_VAULT || path.join(SERVICE_DIR, 'data/codes.md');

// 去掉易混字符（0/O、1/I/L），按 4-4 分组便于口述
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateCode() {
  const block = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `${block()}-${block()}`;
}

export function readSeed() {
  if (!fs.existsSync(SEED_FILE)) return { students: [] };
  const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  return { ...data, students: Array.isArray(data.students) ? data.students : [] };
}

function writeSeed(data) {
  fs.writeFileSync(SEED_FILE, JSON.stringify(data, null, 2) + '\n');
}

function appendVault({ name, code, courseId, label }) {
  fs.mkdirSync(path.dirname(CODE_VAULT), { recursive: true });
  const line = `| ${new Date().toISOString().slice(0, 10)} | ${name} | \`${code}\` | ${courseId} | ${label || ''} |\n`;
  if (!fs.existsSync(CODE_VAULT)) {
    fs.writeFileSync(CODE_VAULT, '| 日期 | 学生 | 访问码 | 课程 | 备注 |\n| --- | --- | --- | --- | --- |\n');
  }
  fs.appendFileSync(CODE_VAULT, line);
}

/**
 * 新增学生：写种子 + 写库 + 记明文码。返回明文码（只此一次）。
 * 同名已存在会报错，避免误覆盖别人的码。
 */
export function createStudent({ name, courseId, label = null, project = null, quota = {} }, store) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('学生名字不能为空');
  if (!/^[\p{L}\p{N}_\-·]{1,20}$/u.test(clean)) throw new Error('名字只能是中英文、数字、下划线，最长 20 字');

  const seed = readSeed();
  if (seed.students.some((s) => s.name === clean)) throw new Error(`学生 ${clean} 已存在`);
  if (store.findStudentByName(clean)) throw new Error(`学生 ${clean} 已在数据库中`);

  const code = generateCode();
  const entry = {
    name: clean,
    course_id: courseId,
    label,
    project,
    code_sha256: hashCode(code),
    ...(Object.keys(quota).length ? { quota } : {}),
    created_at: new Date().toISOString(),
  };

  seed.students.push(entry);
  writeSeed(seed);
  store.seedStudents([entry]); // 立即生效，不需要重启
  // 学生与课程是多对多：建号时顺手接第一单
  if (courseId) store.enroll(clean, courseId);
  appendVault({ name: clean, code, courseId, label });
  return { code, name: clean, courseId };
}

/** 换码：旧码立即失效，历史问答和额度都保留。 */
export function rotateCode(name, store) {
  const seed = readSeed();
  const entry = seed.students.find((s) => s.name === name);
  if (!entry) throw new Error(`种子文件里没有 ${name}，无法换码`);

  const code = generateCode();
  entry.code_sha256 = hashCode(code);
  entry.rotated_at = new Date().toISOString();
  writeSeed(seed);

  store.seedStudents([{ ...entry, code_sha256: entry.code_sha256 }]);
  appendVault({ name, code, courseId: entry.course_id, label: '换码' });
  return { code, name };
}

/**
 * 删除：种子和数据库都要删，否则下次重启学生会"复活"。
 * 历史问答保留（student 字段只是名字），方便事后复盘。
 */
export function deleteStudent(name, store) {
  const seed = readSeed();
  const before = seed.students.length;
  seed.students = seed.students.filter((s) => s.name !== name);
  writeSeed(seed);
  store.deleteStudent(name);
  return { removedFromSeed: before !== seed.students.length };
}
