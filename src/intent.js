// 意图分类：先判断学生在问什么，再决定用哪套讲法。
// 五种意图对应五种回答策略，见 src/answer.js 的 KIND_SPEC。
export const KINDS = ['knowledge', 'problem_guided', 'problem_full', 'problem_step', 'extend'];

export const KIND_LABEL = {
  knowledge: '讲知识',
  problem_guided: '讲题·引导',
  problem_full: '讲题·完整过程',
  problem_step: '只讲这一步',
  extend: '延伸拓展',
};

export const KIND_HINT = {
  knowledge: '概念、定义、定理为什么这样',
  problem_guided: '带你把一道题做出来',
  problem_full: '给出完整推导过程',
  problem_step: '只解释你卡住的那一步',
  extend: '方法、联系与推广',
};

// 强信号：命中即倾向该意图
const FULL = /(完整|详细|全过程|全过?程|逐步|一步步|写全|展开写|标准答案|直接给.{0,6}答案|告诉我答案|完整解法|完整推导)/;
const STEP = /(这一步|这步|第\s*[一二三四五六七八九十\d]+\s*(步|问|小问)|怎么来的|怎么得到|为什么等于|这个等号|从上一步|为什么可以这样|这里为什么|怎么化简|怎么变形|怎么凑)/;
// 注意：不能直接匹配"求"——"要求""需求"里也有这个字，会把知识题误判成解题题
const PROBLEM = /(这道题|这题|该题|题目|第\s*\d+\s*题|习题|练习|例\s*\d+(\.\d+)?[-.]\d+|(?<![需要])求|证明|计算|解方程|判断下列|验证|化简|讨论)/;
// 题干里出现真实等式（$x^2+y^2=1$、cos x + x sin y = e^y）且带判断词，基本就是在问具体题目
const EQUATION = /[A-Za-z0-9$\\)\]\}]\s*=\s*[^=]/;
const JUDGE = /(能否|能不能|是否|判断|确定|解出|求出|得到|讨论|验证|满足|成立)/;
const EXTEND = /(学习方法|怎么学|如何学|复习|总结|联系|应用|推广|有什么用|技巧|习惯|规划|框架|体系|举一反三|串起来)/;
const KNOWLEDGE = /(什么是|定义|定理|性质|含义|区别|几何意义|直观|怎么理解|为什么|条件|前提|充要|充分|必要)/;

/** 纯规则分类：快、免费、可解释。返回 confidence=0 时交给模型兜底。 */
export function classifyByRules(question) {
  const q = String(question || '').trim();
  const hit = (re) => re.test(q);
  const signals = [];

  if (hit(FULL)) signals.push('完整过程');
  if (hit(STEP)) signals.push('某一步');
  if (hit(PROBLEM)) signals.push('题目');
  if (hit(EXTEND)) signals.push('拓展');
  if (hit(KNOWLEDGE)) signals.push('知识');

  // 粘进来的整道题：多行 + 含数学式子，即使没有"求"字也算题目
  const looksPasted = q.length > 120 && /\n/.test(q) && /[=<>≤≥]|\$/.test(q);
  // 写了具体等式又问"能否/是否"——就是在问一道题，不是问概念
  const eqProblem = hit(EQUATION) && hit(JUDGE);
  if (eqProblem && !signals.includes('题目')) signals.push('题目');

  let kind = null;
  // 明确要完整过程，优先级最高（学生已经明说了）
  if (signals.includes('完整过程')) kind = 'problem_full';
  // "这一步"优先级高于"这题"：只答那一步，不要重讲整题
  else if (signals.includes('某一步')) kind = 'problem_step';
  // 有题目信号就按讲题处理（含粘贴的整题）
  else if (signals.includes('题目') || looksPasted) kind = 'problem_guided';
  // 没有题目信号、只有方法/联系类信号 → 拓展
  else if (signals.includes('拓展')) kind = 'extend';
  else if (signals.includes('知识')) kind = 'knowledge';

  const strong = signals.length > 0;
  return {
    kind,
    confidence: kind ? (signals.length > 1 ? 0.75 : 0.9) : 0,
    signals,
    source: 'rules',
  };
}

const CLASSIFY_PROMPT = `把学生的提问归到下面五类之一，只输出类别单词，不要解释、不要标点。

knowledge      问概念、定义、定理、条件、为什么这样
problem_guided 想让你带他把一道题做出来（或直接贴了题目）
problem_full   明确要求给出完整推导过程、标准答案
problem_step   只问某一具体步骤、某个等价变形怎么来的
extend         问学习方法、知识点之间的联系、推广、应用

学生提问：`;

export async function classifyIntent({ question, llm }) {
  const rules = classifyByRules(question);
  if (rules.kind && rules.confidence >= 0.75) return rules;

  // 没把握时才花一次极小的模型调用，约 100 tokens
  try {
    const { text } = await llm.complete({
      system: '你是分类器，只输出一个英文类别单词。',
      user: `${CLASSIFY_PROMPT}\n${String(question).slice(0, 600)}`,
      maxTokens: 12,
    });
    const word = String(text || '').trim().toLowerCase().match(/[a-z_]+/)?.[0];
    if (KINDS.includes(word)) {
      return { kind: word, confidence: 0.6, signals: rules.signals, source: 'llm' };
    }
  } catch {
    // 分类失败不该阻塞答疑
  }

  return {
    kind: rules.kind || 'knowledge',
    confidence: rules.kind ? rules.confidence : 0.3,
    signals: rules.signals,
    source: rules.kind ? 'rules' : 'fallback',
  };
}
