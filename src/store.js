// 答疑流水：所有提问、回答、引用、学生反馈都落在本地 SQLite。
// 用途一：教师抽检与卡点统计；用途二：出问题时能还原“当时依据的是哪一版知识包”；
// 用途三：按学生统计额度用量（额度不另存计数器，直接由流水算，永远与事实一致）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SERVICE_DIR } from './pack.js';
import { periodStarts } from './quota.js';

const DATA_DIR = process.env.TA_DATA_DIR || path.join(SERVICE_DIR, 'data');

export function hashCode(code) {
  const normalized = String(code || '')
    .trim()
    .replace(/[\s-]/g, '')
    .toUpperCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** 老库平滑升级：缺列就补，已存在则跳过。 */
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`alter table ${table} add column ${column} ${ddl}`);
}

export function openStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'assistant.db'));
  db.exec(`
    pragma journal_mode = WAL;
    -- 报名关系：学生 × 课程。一个学生可报多门课，一门课可有多名学生。
    create table if not exists enrollments (
      id integer primary key autoincrement,
      student text not null,
      course_id text not null,
      goal text,
      status text not null default 'active',
      created_at text not null,
      unique(student, course_id)
    );
    create index if not exists idx_enr_course on enrollments(course_id);
    create index if not exists idx_enr_student on enrollments(student);
    create table if not exists students (
      code_hash text primary key,
      name text not null,
      course_id text not null,
      label text,
      active integer not null default 1,
      created_at text not null
    );
    create table if not exists questions (
      id integer primary key autoincrement,
      course_id text not null,
      student text,
      question text not null,
      answer text,
      citations text,
      status text not null,
      mode text not null,
      chapters text,
      pack_versions text,
      provider text,
      tokens_in integer default 0,
      tokens_out integer default 0,
      latency_ms integer default 0,
      feedback text,
      feedback_note text,
      resolved integer not null default 0,
      created_at text not null
    );
    create index if not exists idx_q_created on questions(created_at desc);
    create index if not exists idx_q_status on questions(status);
    create index if not exists idx_q_student on questions(student);
    create table if not exists notes (
      id integer primary key autoincrement,
      question_id integer,
      author text,
      body text not null,
      created_at text not null
    );
    -- 备课/审查对话
    create table if not exists teacher_sessions (
      id integer primary key autoincrement,
      course_id text not null,
      chapter text,
      agent text not null default 'prep',
      title text,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists teacher_messages (
      id integer primary key autoincrement,
      session_id integer not null,
      role text not null,
      content text not null,
      created_at text not null
    );
    create index if not exists idx_tm_session on teacher_messages(session_id);
  `);

  // 额度覆盖值：null 表示“跟随课程默认”，0 表示“不限”
  for (const [col, ddl] of [
    ['daily_limit', 'integer'],
    ['monthly_limit', 'integer'],
    ['total_limit', 'integer'],
    ['token_limit', 'integer'],
    ['burst_limit', 'integer'],
  ]) {
    ensureColumn(db, 'students', col, ddl);
    // 每单（学生×课程）也可以单独设额度
    ensureColumn(db, 'enrollments', col, ddl);
  }
  // 指向 students/<目录>，画像文件就写在那里
  ensureColumn(db, 'students', 'project', 'text');

  // 修掉早期版本留下的空哈希行，并保证“一名学生一行”：同名只保留最新一行
  const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');
  db.prepare('delete from students where code_hash = ?').run(EMPTY_HASH);
  db.exec(`delete from students where rowid not in (select max(rowid) from students group by name)`);
  db.exec('create unique index if not exists idx_student_name on students(name)');

  // 迁移：老的 students.course_id 补成报名记录（一次性，重复执行安全）
  db.exec(`
    insert or ignore into enrollments (student, course_id, created_at)
    select name, course_id, created_at from students
    where course_id is not null and course_id <> ''
  `);

  const now = () => new Date().toISOString();

  return {
    // ---- 学生 ----
    seedStudents(students) {
      const stmt = db.prepare(
        `insert into students
           (code_hash, name, course_id, label, project, active, created_at,
            daily_limit, monthly_limit, total_limit, token_limit, burst_limit)
         values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         on conflict(name) do update set
           code_hash = excluded.code_hash, course_id = excluded.course_id,
           label = excluded.label, project = coalesce(excluded.project, students.project)`,
      );
      for (const s of students) {
        // 种子文件只存哈希；测试里可直接传 code
        const hash = s.code_sha256 || hashCode(s.code);
        if (!hash || hash.length !== 64) throw new Error(`学生 ${s.name} 缺少有效的访问码哈希`);
        const q = s.quota || {};
        stmt.run(
          hash,
          s.name,
          s.course_id,
          s.label || null,
          s.project || null,
          now(),
          q.daily ?? null,
          q.monthly ?? null,
          q.total ?? null,
          q.tokens ?? null,
          q.burstPerHour ?? null,
        );
      }
    },
    findStudent(code) {
      return db
        .prepare('select * from students where code_hash = ? and active = 1')
        .get(hashCode(code));
    },
    findStudentByName(name) {
      return db.prepare('select * from students where name = ?').get(name);
    },
    listStudents() {
      // 不返回 code_hash
      return db
        .prepare(
          `select name, course_id, label, project, active, created_at,
                  daily_limit, monthly_limit, total_limit, token_limit, burst_limit
           from students order by created_at`,
        )
        .all();
    },
    /** 单人的问答记录，按时间倒序，用于生成画像的自动摘要。 */
    listByStudent(name, { limit = 200, sinceDays = 60 } = {}) {
      const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
      return db
        .prepare(
          `select id, question, status, mode, chapters, created_at
           from questions where student = ? and created_at >= ?
           order by id desc limit ?`,
        )
        .all(name, since, Math.min(Number(limit) || 200, 500));
    },
    /** 后台用：学生 + 额度覆盖值 + 当前用量。 */
    listWithUsage(starts = periodStarts()) {
      const rows = db.prepare('select * from students order by created_at').all();
      return rows.map((s) => ({
        name: s.name,
        course_id: s.course_id,
        label: s.label,
        active: s.active,
        created_at: s.created_at,
        overrides: {
          daily: s.daily_limit,
          monthly: s.monthly_limit,
          total: s.total_limit,
          tokens: s.token_limit,
          burstPerHour: s.burst_limit,
        },
        usage: this.usage(s.name, starts),
      }));
    },
    setQuota(name, patch = {}) {
      const map = {
        daily: 'daily_limit',
        monthly: 'monthly_limit',
        total: 'total_limit',
        tokens: 'token_limit',
        burstPerHour: 'burst_limit',
      };
      const sets = [];
      const args = [];
      for (const [k, col] of Object.entries(map)) {
        if (!(k in patch)) continue;
        const v = patch[k];
        sets.push(`${col} = ?`);
        args.push(v === null || v === '' ? null : Number(v));
      }
      if (!sets.length) return;
      args.push(name);
      db.prepare(`update students set ${sets.join(', ')} where name = ?`).run(...args);
    },
    // ---- 报名（学生 × 课程）----
    enroll(student, courseId, goal = null) {
      db.prepare(
        `insert into enrollments (student, course_id, goal, status, created_at)
         values (?,?,?,'active',?)
         on conflict(student, course_id) do update set status = 'active', goal = coalesce(excluded.goal, enrollments.goal)`,
      ).run(student, courseId, goal, now());
    },
    unenroll(student, courseId) {
      db.prepare('delete from enrollments where student = ? and course_id = ?').run(student, courseId);
    },
    coursesOf(name) {
      return db
        .prepare(`select course_id from enrollments where student = ? and status = 'active' order by id`)
        .all(name)
        .map((r) => r.course_id);
    },
    studentsOf(courseId) {
      return db
        .prepare(`select e.student, e.goal, e.created_at from enrollments e where e.course_id = ? and e.status = 'active' order by e.id`)
        .all(courseId);
    },
    enrollmentCount(courseId) {
      return db
        .prepare(`select count(*) c from enrollments where course_id = ? and status = 'active'`)
        .get(courseId).c;
    },
    getEnrollment(name, courseId) {
      return db.prepare('select * from enrollments where student = ? and course_id = ?').get(name, courseId);
    },
    setEnrollmentQuota(name, courseId, patch = {}) {
      const map = {
        daily: 'daily_limit',
        monthly: 'monthly_limit',
        total: 'total_limit',
        tokens: 'token_limit',
        burstPerHour: 'burst_limit',
      };
      const sets = [];
      const args = [];
      for (const [k, col] of Object.entries(map)) {
        if (!(k in patch)) continue;
        const v = patch[k];
        sets.push(`${col} = ?`);
        args.push(v === null || v === '' ? null : Number(v));
      }
      if (!sets.length) return;
      args.push(name, courseId);
      db.prepare(`update enrollments set ${sets.join(', ')} where student = ? and course_id = ?`).run(...args);
    },
    setStudentActive(name, active) {
      db.prepare('update students set active = ? where name = ?').run(active ? 1 : 0, name);
    },
    /** 删掉学生行（码即刻失效）；历史问答保留，靠 student 字段里的名字仍可复盘。 */
    deleteStudent(name) {
      db.prepare('delete from students where name = ?').run(name);
      db.prepare('delete from enrollments where student = ?').run(name);
    },
    /** 单人用量：近一小时 / 今日 / 本月 / 累计次数 / 累计 token。 */
    usage(name, starts = periodStarts(), courseId = null) {
      const where = courseId ? 'student = ? and course_id = ?' : 'student = ?';
      const args = courseId ? [name, courseId] : [name];
      const r = db
        .prepare(
          `select
             sum(case when created_at >= ? then 1 else 0 end) burstPerHour,
             sum(case when created_at >= ? then 1 else 0 end) daily,
             sum(case when created_at >= ? then 1 else 0 end) monthly,
             count(*) total,
             coalesce(sum(tokens_in + tokens_out), 0) tokens
           from questions where ${where}`,
        )
        .get(starts.hour, starts.today, starts.month, ...args);
      return {
        burstPerHour: Number(r.burstPerHour || 0),
        daily: Number(r.daily || 0),
        monthly: Number(r.monthly || 0),
        total: Number(r.total || 0),
        tokens: Number(r.tokens || 0),
      };
    },

    // ---- 问答 ----
    record(q) {
      const info = db
        .prepare(
          `insert into questions
           (course_id, student, question, answer, citations, status, mode, chapters, pack_versions,
            provider, tokens_in, tokens_out, latency_ms, created_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          q.courseId,
          q.student || null,
          q.question,
          q.answer || '',
          JSON.stringify(q.citations || []),
          q.status,
          q.mode,
          (q.chapters || []).join(','),
          JSON.stringify(q.packVersions || {}),
          q.provider || '',
          q.usage?.input_tokens || 0,
          q.usage?.output_tokens || 0,
          q.latencyMs || 0,
          now(),
        );
      return Number(info.lastInsertRowid);
    },
    setFeedback(id, feedback, note) {
      db.prepare('update questions set feedback = ?, feedback_note = ? where id = ?')
        .run(feedback, note || null, id);
    },
    resolve(id, resolved = 1) {
      db.prepare('update questions set resolved = ? where id = ?').run(resolved ? 1 : 0, id);
    },
    addNote(questionId, author, body) {
      db.prepare('insert into notes (question_id, author, body, created_at) values (?,?,?,?)')
        .run(questionId, author, body, now());
    },
    list({ limit = 100, status = null, sinceDays = null } = {}) {
      let sql = 'select * from questions';
      const where = [];
      const args = [];
      if (status) {
        where.push('status = ?');
        args.push(status);
      }
      if (sinceDays) {
        where.push('created_at >= ?');
        args.push(new Date(Date.now() - sinceDays * 864e5).toISOString());
      }
      if (where.length) sql += ' where ' + where.join(' and ');
      sql += ' order by id desc limit ?';
      args.push(Math.min(Number(limit) || 100, 500));
      return db.prepare(sql).all(...args);
    },
    summary(days = 7) {
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const rows = db
        .prepare(
          // date(..., '+8 hours') 让分组按上海自然日，而不是 UTC
          `select date(created_at, '+8 hours') d, count(*) total,
                  sum(case when status = 'unanswered' then 1 else 0 end) unanswered,
                  sum(case when status = 'uncited' then 1 else 0 end) uncited,
                  sum(case when feedback = 'down' then 1 else 0 end) bad
           from questions where created_at >= ? group by d order by d`,
        )
        .all(since);
      const top = db
        .prepare(
          `select student, course_id, count(*) c from questions
           where created_at >= ? group by student, course_id order by c desc limit 10`,
        )
        .all(since);
      const pending = db
        .prepare(`select count(*) c from questions where status in ('unanswered','uncited') and resolved = 0`)
        .get();
      // 学生到底在问什么：讲知识多还是讲题多，决定下一步该补什么材料
      const byKind = db
        .prepare(`select mode kind, count(*) c from questions where created_at >= ? group by mode order by c desc`)
        .all(since);
      return { days, rows, top, pending: pending.c, byKind };
    },

    // ---- 备课对话 ----
    createSession({ courseId, chapter, agent = 'prep', title = '新会话' }) {
      const t = now();
      const info = db
        .prepare(
          `insert into teacher_sessions (course_id, chapter, agent, title, created_at, updated_at)
           values (?,?,?,?,?,?)`,
        )
        .run(courseId, chapter || null, agent, title, t, t);
      return Number(info.lastInsertRowid);
    },
    listSessions(courseId) {
      return db
        .prepare(
          `select s.*, (select count(*) from teacher_messages m where m.session_id = s.id) msgs
           from teacher_sessions s where s.course_id = ? order by s.updated_at desc limit 50`,
        )
        .all(courseId);
    },
    getSession(id) {
      return db.prepare('select * from teacher_sessions where id = ?').get(id);
    },
    touchSession(id, title) {
      db.prepare('update teacher_sessions set updated_at = ?, title = coalesce(?, title) where id = ?')
        .run(now(), title || null, id);
    },
    addMessage(sessionId, role, content) {
      db.prepare('insert into teacher_messages (session_id, role, content, created_at) values (?,?,?,?)')
        .run(sessionId, role, String(content), now());
      db.prepare('update teacher_sessions set updated_at = ? where id = ?').run(now(), sessionId);
    },
    messages(sessionId, limit = 40) {
      const rows = db
        .prepare('select role, content, created_at from teacher_messages where session_id = ? order by id asc')
        .all(sessionId);
      return rows.slice(-limit);
    },
  };
}
