// 学生额度：按人设限，按自然日/自然月/累计/token 四个维度分别算。
// 0 表示不限。所有判断都是纯函数，便于测试，也便于以后加“套餐”。
export const DEFAULT_QUOTA = {
  daily: 20, // 每天提问次数
  monthly: 200, // 每月提问次数
  total: 0, // 累计提问次数（0 = 不限，适合按学期卖课）
  tokens: 0, // 累计 token 上限（成本兜底）
  burstPerHour: 10, // 每小时防连刷
};

const DIMENSIONS = ['daily', 'monthly', 'total', 'tokens', 'burstPerHour'];

/**
 * 合并额度：默认值 → 课程默认 → 学生覆盖。
 * null/undefined/'' 视为“没设”，显式 0 表示不限。
 */
export function resolveQuota({ defaults = DEFAULT_QUOTA, student = {} } = {}) {
  const out = {};
  for (const k of DIMENSIONS) {
    const base = defaults[k] ?? DEFAULT_QUOTA[k];
    const v = student[k];
    out[k] = v === null || v === undefined || v === '' ? Number(base) : Number(v);
    if (!Number.isFinite(out[k]) || out[k] < 0) out[k] = Number(base);
  }
  return out;
}

/** 上海时区的今日零点、本月零点，用于把 created_at（UTC ISO）切到自然日/月。 */
export function periodStarts(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // YYYY-MM-DD
  const month = day.slice(0, 7);
  const dayStart = new Date(`${day}T00:00:00+08:00`);
  return {
    hour: new Date(now.getTime() - 3600e3).toISOString(),
    today: dayStart.toISOString(),
    month: new Date(`${month}-01T00:00:00+08:00`).toISOString(),
    nextDay: new Date(dayStart.getTime() + 864e5).toISOString(),
    day,
  };
}

/** 用量 → 各维度剩余，供前端展示和后台核对。 */
export function quotaView(usage, quota) {
  const view = {};
  for (const k of DIMENSIONS) {
    const limit = quota[k];
    const used = usage[k] || 0;
    view[k] = { limit, used, left: limit > 0 ? Math.max(0, limit - used) : null };
  }
  // 学生端只看最紧的那个“次数”维度，避免一次抛四个数字
  const spreads = ['daily', 'monthly', 'total'].filter((k) => quota[k] > 0);
  const tightest = spreads.sort((a, b) => view[a].left - view[b].left)[0];
  view.summary = tightest
    ? { dimension: tightest, left: view[tightest].left, limit: quota[tightest], used: view[tightest].used }
    : { dimension: null, left: null, limit: 0, used: usage.total || 0 };
  return view;
}

/**
 * 逐个维度判断，返回第一个触发的限制。
 * 顺序：防连刷 → 每日 → 每月 → 累计 → token（先拦最容易恢复的，提示才有用）。
 */
export function evaluateQuota(usage, quota, starts) {
  const v = quotaView(usage, quota);
  const ordered = [
    ['burst', 'burstPerHour'],
    ['daily', 'daily'],
    ['monthly', 'monthly'],
    ['total', 'total'],
  ];
  for (const [code, key] of ordered) {
    const limit = quota[key];
    const used = usage[key] || 0;
    if (limit > 0 && used >= limit) {
      const message = {
        burst: `这一小时已经问了 ${used} 次（上限 ${limit} 次），先自己想一想再问下一题。`,
        daily: `今天的 ${limit} 次答疑额度用完了，明天 0 点自动恢复。着急的话直接把题发给老师。`,
        monthly: `本月的 ${limit} 次额度用完了，下个月 1 号恢复。需要加额度请联系老师。`,
        total: `累计 ${limit} 次的额度已经用完，需要加额度请联系老师。`,
      }[code];
      return { ok: false, code, message, view: v, retryAt: code === 'daily' ? starts.nextDay : null };
    }
  }
  if (quota.tokens > 0 && (usage.tokens || 0) >= quota.tokens) {
    return {
      ok: false,
      code: 'tokens',
      message: `本账号的用量额度（${quota.tokens} tokens）已经用完，需要加额度请联系老师。`,
      view: v,
      retryAt: null,
    };
  }
  return { ok: true, view: v, message: '' };
}
