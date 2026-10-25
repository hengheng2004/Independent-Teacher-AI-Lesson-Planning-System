#!/usr/bin/env node
// 新增学生并生成访问码。和后台「新增学生」走同一套逻辑（src/students.js）：
// 写种子文件 + 立刻写库（不用重启服务）+ 明文记进 data/codes.md。
//
// 用法：node scripts/add-student.mjs --name 张三 --course linear-algebra-demo \
//         [--label 备注] [--project STU-2026-002-wechat-yang] \
//         [--daily 20 --monthly 200 --total 0 --tokens 0 --burst 10]
import { loadCourseConfig } from '../src/pack.js';
import { openStore } from '../src/store.js';
import { createStudent } from '../src/students.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '']);
    return acc;
  }, []),
);

const name = args.name;
const courseId = args.course;
if (!name || !courseId) {
  console.error(`用法：node scripts/add-student.mjs --name <学生名> --course <课程编号>
      可选：--label 备注 --project student-001
      可选额度：--daily 20 --monthly 200 --total 0 --tokens 0 --burst 10
      （不传则用课程默认；0 表示不限）
      --project 指向 students/ 下的目录，学生画像会写在那里`);
  process.exit(1);
}

const courses = loadCourseConfig().courses.filter((c) => c.enabled).map((c) => c.id);
if (!courses.includes(courseId)) {
  console.error(`课程编号不存在。可选：${courses.join(', ')}`);
  process.exit(1);
}

const quota = {};
for (const [flag, key] of [
  ['daily', 'daily'],
  ['monthly', 'monthly'],
  ['total', 'total'],
  ['tokens', 'tokens'],
  ['burst', 'burstPerHour'],
]) {
  if (args[flag] !== undefined && args[flag] !== '') {
    const n = Number(args[flag]);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`--${flag} 必须是非负整数`);
      process.exit(1);
    }
    quota[key] = n;
  }
}

try {
  const store = openStore();
  const r = createStudent(
    { name, courseId, label: args.label || null, project: args.project || null, quota },
    store,
  );
  console.log(`学生：${r.name}`);
  console.log(`课程：${courseId}`);
  console.log(`访问码（只显示这一次）：${r.code}`);
  console.log('已写入 config/students.json 和数据库，立即生效，不需要重启服务。');
  console.log('明文码同时记在 data/codes.md。');
} catch (e) {
  console.error(`失败：${e.message}`);
  process.exit(1);
}
