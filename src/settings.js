// 工作台「设置」页的可编辑配置：存 data/settings.json（已被 .gitignore 排除）。
//
// 优先级：settings.json > .env > 默认值。
// 这样老师在界面上改完立即生效，不用碰 .env、不用重启；.env 仍然可以兜底。
import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_DIR } from './pack.js';

const FILE = path.join(SERVICE_DIR, 'data/settings.json');

const EMPTY = {
  chat: { provider: '', baseUrl: '', apiKey: '', model: '' },
  review: { model: '' },
  ocr: { backend: '', baseUrl: '', apiKey: '', model: '', command: '' },
};

export function readSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      chat: { ...EMPTY.chat, ...(j.chat || {}) },
      review: { ...EMPTY.review, ...(j.review || {}) },
      ocr: { ...EMPTY.ocr, ...(j.ocr || {}) },
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function writeSettings(patch) {
  const cur = readSettings();
  // 空字符串表示「不修改已有值」，避免界面上用掩码回显时把 key 抹掉
  for (const group of ['chat', 'review', 'ocr']) {
    for (const [k, v] of Object.entries(patch?.[group] || {})) {
      // null 表示「清空这一项」，'' 表示「不修改」——两者要区分开，
      // 否则界面上没法把已经存下的 key 删掉。
      if (v === null) {
        cur[group][k] = '';
        continue;
      }
      if (v === '') continue;
      // 界面上回显的是 ••••1234 这种掩码，原样提交回来时必须忽略，
      // 否则会把真实 key 覆盖成掩码字符串。
      if (/^[•*]+/.test(String(v))) continue;
      // 从网页/文档复制时常混进零宽字符和首尾空白，会让 URL 解析失败或模型名对不上
      cur[group][k] = String(v).replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    }
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
  return cur;
}

/** 把设置写进 process.env（createLLM / 视觉客户端都从环境变量读）。 */
export function applySettings(s = readSettings()) {
  const set = (k, v) => {
    if (v) process.env[k] = v;
    else delete process.env[k];
  };

  if (s.chat.provider) set('LLM_PROVIDER', s.chat.provider);
  const provider = (s.chat.provider || process.env.LLM_PROVIDER || '').toLowerCase();

  if (s.chat.baseUrl) set('OPENAI_BASE_URL', s.chat.baseUrl);
  if (s.chat.apiKey) {
    if (provider === 'deepseek') set('DEEPSEEK_API_KEY', s.chat.apiKey);
    else set('OPENAI_API_KEY', s.chat.apiKey);
  }
  if (s.chat.model) {
    if (provider === 'deepseek') set('DEEPSEEK_MODEL', s.chat.model);
    else set('OPENAI_MODEL', s.chat.model);
  }

  if (s.review.model) set('REVIEW_MODEL', s.review.model);
  if (s.ocr.backend) set('OCR_BACKEND', s.ocr.backend);
  if (s.ocr.command) set('OCR_COMMAND', s.ocr.command);
  if (s.ocr.baseUrl) set('OCR_BASE_URL', s.ocr.baseUrl);
  if (s.ocr.apiKey) set('OCR_API_KEY', s.ocr.apiKey);
  if (s.ocr.model) set('OCR_MODEL', s.ocr.model);
  return s;
}

/** 给界面回显用：key 只露后四位。 */
export function maskedSettings() {
  const s = readSettings();
  const mask = (k) => (k ? `••••${String(k).slice(-4)}` : '');
  return {
    chat: { ...s.chat, apiKey: mask(s.chat.apiKey) },
    review: { ...s.review },
    ocr: { ...s.ocr, apiKey: mask(s.ocr.apiKey) },
    file: path.relative(SERVICE_DIR, FILE),
  };
}
