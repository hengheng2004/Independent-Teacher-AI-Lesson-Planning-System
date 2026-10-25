# 贡献指南

## 开发

```bash
npm install
npm test              # 98 项端到端自测，不需要 API key
npm run check         # 知识包体检
npm run eval          # 检索评测
npm run demo          # 起服务（mock 模型）
```

## 提交前必须做

1. `npm test` 全绿
2. `npm run check` 无告警
3. 确认没有把真实学生数据、讲义、key 提交进去：

```bash
git diff --cached | grep -iE "sk-|api[_-]?key|password" && echo "有敏感信息，检查一下"
```

## 代码约定

- 零依赖优先：除了向量模型运行时，不引入第三方库
- 纯函数放前面：额度、切块、融合排序都应该是可测的纯函数
- 中文注释写「为什么」，不写「是什么」
- 提示词改动要在 `src/answer.js` 的 `KIND_SPEC` 里集中改，别散落在调用处

## 加一门语言的教材？

目前只处理中文 + 简单 LaTeX。要支持其他语言，主要改两处：

- `src/pack.js` 的 `terms()`：现在是中文二元组，其他语言要换成分词
- `src/embed.js` 的 `EMBED_MODEL`：换成多语言模型（如 `bge-m3`）
