# 用视觉大模型做 OCR

适用于：扫描版 / 图片版 PDF（没有文字层），且本机没有 OCR 能力或想要更好的公式、表格、版面还原。

> 一句话：把每一页渲染成图片，交给多模态模型转写成 Markdown，结果写回 `xxx.ocr.md`，之后就和普通讲义一样参与检索。

---

## 一、什么时候该用

| 场景 | 建议 |
| --- | --- |
| macOS，普通中文课件 | 先用本机 OCR（Vision，免费、快） |
| 课件里有大量公式 / 表格 | 用视觉模型，公式能出 LaTeX |
| Windows / Linux 服务器，且不想装外部工具 | 用视觉模型（但页面渲染仍需 poppler，见第四节） |
| 页数很多、预算敏感 | 用本机 OCR，或只对重点页用视觉模型 |

---

## 二、支持的厂商

任何 **OpenAI 兼容**的多模态端点都行，配置在 `.env` 里：

```bash
OCR_BACKEND=vision
LLM_PROVIDER=openai
OPENAI_BASE_URL=<厂商地址>
OPENAI_API_KEY=<key>
OPENAI_MODEL=<支持图片输入的模型>
```

常见组合（价格随时变，以官网为准）：

| 厂商 | BASE_URL | 模型 | 说明 |
| --- | --- | --- | --- |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` / `qwen-vl-plus` | 中文版面强，国内直连 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` | 国内直连 |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` / `gpt-4o-mini` | 公式和表格最稳，需要网络可达 |
| DeepSeek | — | — | **不支持图片输入**，用不了这条路 |

> DeepSeek 的 key 只能用于问答和备课，OCR 必须另配一个多模态模型。

---

## 三、怎么用

配好 `.env` 后重启服务，之后三种用法：

**① 界面上点**

材料列表里 PDF 那一行 →「OCR 识别」→ 弹窗填页码范围（留空＝全部，填 `3-12` ＝只识别这几页）。

**② 命令行**

```bash
node scripts/ocr.mjs <课程编号> <文件名> [页码范围]
node scripts/ocr.mjs regression-analysis lec1.pdf 1-10
```

**③ 在对话里直接说**

老师侧（备课）说"第 12 页讲什么"，系统会按页码优先检索——但**前提是那些页已经 OCR 过**。

---

## 四、页面渲染从哪来

模型读的是图片，所以先把 PDF 页转成 JPEG。这一步和 OCR 模型无关：

| 平台 | 渲染方式 | 依赖 |
| --- | --- | --- |
| macOS | 内置 Swift 渲染器，随包编译 | 只需装 Xcode 命令行工具 |
| Linux | `pdftoppm` | `apt install poppler-utils` |
| Windows | `pdftoppm.exe` | 需要 poppler for Windows（或 WSL） |

渲染参数：1.6 倍分辨率、JPEG 质量 0.72——**再高只是多花钱，模型看不出差别**。

---

## 五、成本

按页计费。一页幻灯片渲染成 1200×900 左右的 JPEG，大约消耗：

```
图片 ≈ 800–1100 tokens
输出 ≈ 200–500 tokens
```

粗算（以国内模型为例）：**每页几厘到两分钱**，50 页的课件约 **¥0.5–1.5**。定价高的模型（如 gpt-4o）会翻几倍。

省钱的做法：

- 只 OCR 需要的页（`3-12`）
- 纯图页（整页照片、示意图）跳过——识别出来只有零星几个词，反而污染检索
- 先跑 2–3 页试质量，满意再全量

---

## 六、质量与注意事项

**比本机 OCR 好的地方**：公式能出 LaTeX、表格能保结构、多栏版面不会串行。

**仍然会错的地方**：

- 手写内容
- 极小字号的脚注
- 图里的文字（模型只看整体，细节容易漏）
- 数学符号的细微差别（`⊆` 与 `⊂`、上下标位置）

所以生成的 `.ocr.md` 开头会写一行提示：

> 由多模态模型识别（本次 1–10 页，共 50 页），可能有错字，引用前请核对原文。

**它不会自动进学生端**——OCR 完成后会按同名 PDF 找所属章节并自动挂进去（挂不上就挂第一章），然后重建索引。想改归属，去「编辑课程」里调。

---

## 七、出错了怎么办

| 现象 | 原因 |
| --- | --- |
| 报「没有可用的 OCR 方式」 | `OCR_BACKEND` 没设，或没配 `OPENAI_*` |
| 报「400 unsupported content type」 | 模型不支持图片输入，换 `qwen-vl` / `gpt-4o` 这类 |
| 报「读不到 PDF 页数」 | 该平台的页数解析不可用（Windows 上目前是这个问题，见下） |
| 某页返回空 | 纯图页，正常；跳过即可 |
| 很慢 | 目前是逐页串行，50 页大约几分钟 |

---

## 八、已知限制（Windows）

视觉 OCR 的**调用链已经写好**，但在 Windows 上还差两处才能真正跑起来：

1. `pdfPages()` 目前用 macOS 的 `mdls` 读页数，Windows 上会在第一步就报「读不到 PDF 页数」——要改成纯 JS 解析
2. 页面渲染依赖 `pdftoppm.exe`，需要 poppler for Windows 或改用其它渲染方式

也就是说：**Windows 上现在的视觉 OCR 是接不通的**，配置再对也会卡在第一处。修这两处大约 **2–3 小时**（含在 Windows 上实测）。

macOS 与 Linux 不受这个限制。
