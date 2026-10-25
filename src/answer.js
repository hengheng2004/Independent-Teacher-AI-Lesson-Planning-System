// 组装上下文、按意图选策略、调用模型、校验引用。
// 关键：引用不是让模型“自觉”标注，而是最后由程序逐条比对块编号，编造的引用一律作废。
import { retrieveForPrompt } from './search.js';
import { KIND_LABEL } from './intent.js';

const MAX_QUESTION_CHARS = 2000;
const NO_EVIDENCE = '[[无依据]]';

/** 五种意图各自的回答策略。改讲法只改这里。 */
export const KIND_SPEC = {
  knowledge: {
    goal: '讲清一个概念、定理或条件，不讲题',
    maxTokens: 1000,
    blocks: 10,
    rules: [
      '第一句直接给结论或定义，让学生只读一句也有收获。',
      '逐条讲清成立的条件，并说明每条为什么需要；讲义里有的反例要点出来。',
      '给一个最小例子（讲义中有的优先），最后用一句话回到学生原问题。',
      '不要主动解题、不要贴题目解答；如果判断他其实想问某道题，结尾一句提示他把题贴出来。',
      '篇幅控制在 450 字内，不要写成教材章节。',
    ],
  },
  problem_guided: {
    goal: '带学生自己把这道题做出来（苏格拉底式，不给答案）',
    maxTokens: 800,
    blocks: 10,
    rules: [
      '第一句点明这题考的是哪个定理或方法，以及为什么是它。',
      '把已知与所求浓缩成两行，指出还缺哪个条件，缺的留给学生自己找。',
      '只给第一步，并说明这一步的依据；不要连着往下算。',
      '最后反问一个具体的、可回答的问题来推进，例如「你能算出这里的 $F_y$ 吗」。',
      '不写完整推导，不给最终答案数字。篇幅 350 字内。',
    ],
  },
  problem_full: {
    goal: '完整讲解一道题的全过程',
    maxTokens: 1800,
    blocks: 12,
    rules: [
      '开头一句说清思路（用哪个定理、为什么）。',
      '分步推导，每步以「第 1 步」「第 2 步」开头，关键代数变形不许跳步。',
      '每一步末尾标依据：定理编号或块编号。',
      '结束前给一句「检验」：怎样快速验证答案对不对。',
      '最后列 1–2 个常见错误，讲义里有的才写。',
    ],
  },
  problem_step: {
    goal: '只解释学生卡住的那一步',
    maxTokens: 600,
    blocks: 6,
    rules: [
      '直接回答那一步：这一步在做什么、依据是什么。',
      '给出这一小段的推导或变形，能一行写完就一行。',
      '最多补一句「这一步容易错在……」。',
      '不要从头讲题，不要给最终答案，不要顺带讲整章。',
      '篇幅 180 字内。',
    ],
  },
  extend: {
    goal: '在讲义基础上做适度延伸：方法、联系、推广、应用',
    maxTokens: 1100,
    blocks: 10,
    rules: [
      '先用讲义内容回答，并标出处。',
      '需要延伸的部分另起一段，以「拓展（不在讲义原文）」开头，说明这是常见做法或一般经验。',
      '延伸要贴着本课程进度，不泛泛而谈；给一个今天就能做的小动作。',
      '不要编造书名、定理编号、页码，不要写「某教材里说」。',
      '篇幅 450 字内。',
    ],
  },
};

/**
 * 用一般知识回答，但明确标注超出讲义、不编造出处、沿用讲义记号。
 * 两条路径都会走到这里：检索不到任何块，或模型按规则回了「无依据」。
 */
async function generateOffSyllabus({ course, packs, q, k, llm, started, retrievalMode }) {
  const spec = KIND_SPEC[k] || KIND_SPEC.knowledge;
  const system = buildOffSyllabusPrompt(course);
  const user = [
    '【重要】下面只给讲义目录与样例写法作为「记号参考」，本次回答属于「超出讲义范围」。',
    '',
    '【本课程讲义目录与记号参考】只用来对齐术语、符号和讲法，不作为事实依据：',
    buildStyleContext(packs),
    '',
    `【学生提问】${q}`,
  ].join('\n');

  const { text, usage } = await llm.complete({ system, user, maxTokens: spec.maxTokens });
  const rendered2 = renderAnswer(text, [], { allowUncited: true });
  return {
    ...rendered2,
    kind: k,
    offSyllabus: true,
    retrievalMode,
    usage,
    latencyMs: Date.now() - started,
    chapters: [],
    packVersions: {},
    provider: llm.provider,
    status: 'extended',
  };
}

/**
 * 超出讲义时给的「风格参考」：目录 + 每章一段样例，
 * 只用于对齐符号与说法，不当作事实依据（提示词里已声明）。
 */
function buildStyleContext(packs) {
  const parts = [];
  for (const pack of packs.slice(0, 4)) {
    parts.push(`《${pack.chapterTitle}》目录：${(pack.toc || []).slice(0, 8).join(' / ')}`);
    const sample = (pack.blocks || [])[0];
    if (sample) parts.push(`样例写法：[[${sample.id}]] ${String(sample.text).slice(0, 260)}`);
  }
  return parts.join('\n');
}

function buildOffSyllabusPrompt(course) {
  return [
    `你是「${course.name}」这门课的 AI 助教，服务对象是一名正在跟老师上课的学生。`,
    '',
    '## 本次情况：问题超出讲义范围',
    '讲义里没有直接对应的内容。请用你自己的知识尽力解答，同时严格遵守：',
    '',
    '1. 开头一句话说明「这个点讲义里没有直接写，下面的解答超出讲义范围」。',
    '2. 术语、符号、记号尽量与【讲义目录与记号参考】保持一致（例如同样用 $F_y$、$\\partial$、向量写法）；',
    '   讲义里若用某个约定，优先沿用，不要另起一套。',
    '3. 不编造讲义里的页码、题号、定理编号；也不要声称「讲义第 X 页说过」。',
    '4. 能确定的部分正常讲；拿不准的地方明说「这一点我不确定」。',
    '5. 如果这道题其实属于本课程后续章节，指出「这属于后续章节的内容」，但不要因此拒绝解答。',
    '6. 不要输出 HTML，不要用 Markdown 表格；数学用 $...$ 或 $$...$$。',
    '7. 篇幅控制在 500 字内，结构清楚。',
  ].join('\n');
}

function groundingRules(kind) {
  const base = [
    '只依据下面给出的【讲义摘录】回答；摘录里没有的内容不要替学生补。',
    '每一处实质结论都要标出处，格式为 [[块编号]]，例如 [[ch18-S7]]，可连标多个。',
    '如果摘录里没有能支撑回答的内容，只输出 [[无依据]] 加一句话说明，把问题留给人。',
    '不要编造定理编号、题号、页码。摘录里没出现的编号一律不写。',
    '不要输出 HTML，不要用 Markdown 表格。',
  ];
  if (kind === 'extend') {
    return [
      base[0],
      base[1],
      '延伸内容必须单独成段并注明「拓展（不在讲义原文）」，不得混进讲义原文里当事实。',
      base[3],
      base[4],
      '若摘录与该问题完全无关，先输出 [[无依据]]，只给一般性建议（同样注明是拓展）。',
    ];
  }
  return base;
}

export function buildSystemPrompt(course, kind = 'knowledge') {
  const spec = KIND_SPEC[kind] || KIND_SPEC.knowledge;
  const lines = [
    `你是「${course.name}」这门课的 AI 助教，服务对象是一名正在跟老师上课的学生。`,
    '',
    `## 本次任务：${KIND_LABEL[kind] || kind} —— ${spec.goal}`,
    '严格按下面的任务细则作答；回答的形态比信息量重要。',
    '',
    '## 硬性规则',
    ...groundingRules(kind).map((r, i) => `${i + 1}. ${r}`),
    '',
    '## 任务细则',
    ...spec.rules.map((r) => `- ${r}`),
    '',
    '## 通用风格',
    '- 用中文，数学用 $...$ 或 $$...$$。段落短，多用小标题和编号。',
    '- 学生说「卡住了」时，先定位他可能错的那一步，不要重讲整章。',
    '- 如果给了【上一轮对话】，学生说「这一步」「第四步」「那个公式」通常指上一轮的内容：接着讲，不要让他重新提供材料。',
    '- 学生情绪明显焦虑时，先用一句话安抚，再回到内容。',
    '',
    '## 边界',
    '- 不评价老师，不比较其他教材或机构。',
    '- 不回答与本课程无关的问题（闲聊、其他科目、代写作业）。',
    '- 不说「根据我的知识」；你的依据只有摘录，或明确标注的拓展。',
  ];
  return lines.join('\n');
}

function renderContext(packsUsed) {
  const parts = [];
  for (const { pack, blocks } of packsUsed) {
    parts.push(`\n### ${pack.chapterTitle}（${pack.chapterKey}）`);
    for (const b of blocks) {
      parts.push(`\n[[${b.id}]] ${b.label}\n${b.text}`);
    }
  }
  return parts.join('\n');
}

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 把回答里的 [[id]] 渲染成可点开的角标，同时把正文 HTML 转义。
 * allowUncited：拓展类回答允许没有出处（此时状态为 extended，而不是 uncited 警告）。
 */
export function renderAnswer(rawText, packsUsed, { allowUncited = false } = {}) {
  const known = new Map();
  for (const { pack, blocks } of packsUsed) {
    for (const b of blocks) known.set(b.id, { ...b, chapterTitle: pack.chapterTitle });
  }

  const citations = [];
  const order = new Map();
  const invalid = new Set();
  const cited = new Set();

  const text = String(rawText || '')
    .replace(/\[\[\s*(无依据|[a-zA-Z0-9_-]+)\s*\]\]/g, (m, id) => {
      if (id === '无依据') {
        cited.add(NO_EVIDENCE);
        return '@@NOEV@@';
      }
      const block = known.get(id);
      if (!block) {
        invalid.add(id);
        return '';
      }
      cited.add(id);
      if (!order.has(id)) {
        order.set(id, citations.length + 1);
        citations.push({
          id,
          label: block.label,
          chapterTitle: block.chapterTitle,
          snippet: block.text.length > 1200 ? block.text.slice(0, 1200) + '…' : block.text,
        });
      }
      return `@@CITE${order.get(id)}@@`;
    })
    // 兜底：任何残留的 [[...]] 都不是可验证引用，直接删掉，别让它露给学生
    .replace(/\[\[\s*([^\[\]]{1,80}?)\s*\]\]/g, (m, id) => {
      invalid.add(id);
      return '';
    });

  const noEvidence = cited.has(NO_EVIDENCE);
  const html = esc(text)
    .replace(/@@NOEV@@/g, '<span class="noev">无依据</span>')
    .replace(/@@CITE(\d+)@@/g, '<sup class="cite" data-i="$1">[$1]</sup>')
    // 只认 **加粗** 和行首 #，不做完整 Markdown 渲染：数学里 * 等符号太多，过度解析会破坏公式
    .replace(/\*\*([^*\n]{1,80})\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n/g, '<br>');

  let status = 'answered';
  if (noEvidence) status = 'unanswered';
  else if (!citations.length) status = allowUncited ? 'extended' : 'uncited';

  return { html, text, citations, status, invalid: [...invalid] };
}

export async function answerQuestion({ course, packs, question, kind = 'knowledge', llm, history = [] }) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) throw new Error('问题是空的');

  const k = KIND_SPEC[kind] ? kind : 'knowledge';
  const spec = KIND_SPEC[k];
  const started = Date.now();
  // 只有「追问」才把上一轮问题拼进检索词；否则无关的新问题会被旧话题带偏。
  const ANAPHORA = /(第[一二三四五六七八九十\d]+步|这一步|那一步|这个公式|那个公式|上面|刚才|再说|继续|为什么成立|怎么来的)/;
  const prev = history.length ? history[history.length - 1] : null;
  const isFollowUp = Boolean(prev) && (ANAPHORA.test(q) || q.length <= 12);
  const query = isFollowUp ? `${q} ${prev.question}` : q;
  // 有向量就走混合检索；没有向量或模型加载失败会自动退回纯词法
  const retrieval = await retrieveForPrompt(packs, query, { budget: 14000, maxBlocks: spec.blocks });
  const { packsUsed } = retrieval;

  // 把上一轮引用过的块补回来：否则学生追问上一轮的某一步时，
  // 那段材料不在本次上下文里，引用会被判无效，模型只能说「找不到资料」。
  const already = new Set(packsUsed.flatMap((p) => p.blocks.map((bl) => bl.id)));
  for (const h of isFollowUp ? history : []) {
    for (const c of h.citations || []) {
      if (already.has(c.id)) continue;
      for (const pack of packs) {
        const bl = [...pack.blocks, ...pack.reserved].find((b) => b.id === c.id);
        if (bl && packsUsed.length < spec.blocks + 6) {
          packsUsed.push({ pack, blocks: [bl], reserved: [] , fromPrev: true });
          already.add(c.id);
        }
      }
    }
  }

  // 讲义里没有对应内容：不直接拒答，改用「超出讲义」模式。
  if (!packsUsed.length) {
    return generateOffSyllabus({ course, packs, q, k, llm, started, retrievalMode: retrieval.mode });
  }

  const system = buildSystemPrompt(course, k);
  const historyBlock = history.length
    ? [
        '【上一轮对话】学生可能在追问这里的某一步或某个公式；直接接着讲，不要说没有资料。',
        ...history.map((h, i) => `（${i + 1}）学生：${h.question}\n助教：${String(h.answer || '').slice(0, 600)}`),
        '',
      ].join('\n')
    : '';

  const user = [
    '【讲义摘录】只能依据以下内容回答；引用时写块编号。',
    renderContext(packsUsed),
    '',
    '【本讲目录】',
    packsUsed.map((p) => p.pack.toc.join('\n')).join('\n'),
    '',
    historyBlock,
    `【本次任务】${KIND_LABEL[k]}：${spec.goal}`,
    '',
    `【学生提问】${q}`,
  ].join('\n');

  const { text, usage } = await llm.complete({ system, user, maxTokens: spec.maxTokens });
  let rendered = renderAnswer(text, packsUsed, { allowUncited: k === 'extend' });

  // 模型按规则回了「无依据」（检索命中的内容其实不相关）→ 换超出讲义模式重试一次。
  // 只在这种情况下多花一次调用，正常问答不受影响。
  if (rendered.status === 'unanswered' || (rendered.status === 'uncited' && !(rendered.citations || []).length)) {
    return generateOffSyllabus({ course, packs, q, k, llm, started, retrievalMode: retrieval.mode });
  }

  const packVersions = {};
  const chapters = [];
  for (const p of packsUsed) {
    packVersions[p.pack.chapterKey] = p.pack.packVersion;
    chapters.push(p.pack.chapterKey);
  }

  return {
    ...rendered,
    kind: k,
    retrievalMode: retrieval.mode,
    retrievalNote: retrieval.note || '',
    usage,
    latencyMs: Date.now() - started,
    chapters,
    packVersions,
    provider: llm.provider,
  };
}
