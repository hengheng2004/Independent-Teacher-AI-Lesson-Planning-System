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

# 视觉模型单独配，不影响聊天用的模型
OCR_BASE_URL=<厂商地址>
OCR_API_KEY=<key>
OCR_MODEL=<支持图片输入的模型>
```

> 为什么单独配：聊天用 DeepSeek（便宜、长文好），而 DeepSeek 没有视觉能力。
> 如果共用一套配置，开 OCR 就得把聊天也换成 VL 模型——又贵又不擅长长文。
> 三个 `OCR_*` 都填了才生效；不填就退回本机 OCR。

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

## 七点五、接入你自己的本地 OCR

如果你机器上有别的 OCR（PaddleOCR、RapidOCR、ABBYY、公司内部工具……），不用改代码，配一条命令即可：

```
设置 → OCR 方式 → 自定义命令
或 .env：OCR_COMMAND=...
```

命令要求：**对一张图片输出文字到 stdout**。可用占位符：

| 占位符 | 含义 |
| --- | --- |
| `{img}` | 该页渲染出的 JPEG 路径 |
| `{page}` | 页码 |
| `{pdf}` | 原始 PDF 路径 |
| `{from}` `{to}` | 本次页码范围 |

例子：

```bash
# RapidOCR
OCR_COMMAND=python3 -m rapidocr_onnxruntime --img {img}

# tesseract（自己指定语言包）
OCR_COMMAND=tesseract {img} stdout -l chi_sim+eng

# 自己的脚本
OCR_COMMAND=/usr/local/bin/my-ocr --image {img} --lang zh
```

注意：

- 命令在**你的机器上执行**，等于给了它和你同等的权限——只填你信任的命令
- 单页失败（非 0 退出码）会让整次 OCR 报错，并带上 stderr 前 200 字
- 页面渲染由系统负责（PDFium），你只管"图 → 文字"

## 八、平台差异

**Windows：只支持视觉模型 OCR。**

| 平台 | 本机 OCR | 视觉模型 OCR |
| --- | --- | --- |
| macOS | ✅（系统 Vision，免费、快） | ✅ |
| Linux | ✅（`tesseract` + 中文语言包） | ✅ |
| Windows | ❌ 不支持 | ✅ **唯一可用方式** |

原因是本机 OCR 依赖各系统自己的识别能力，Windows 没有可随包分发的免费中文 OCR（tesseract 的 Windows 版体验差、还得单独装），所以 Windows 上请直接用视觉模型。

页面渲染和页数解析已经统一用 PDFium（WebAssembly），三个平台同一套代码，不依赖 poppler 或 Spotlight：

- 页数：PDFium 直接读
- 页面转图：PDFium 渲染 → sharp 压成 JPEG（按页宽自动缩放到约 1400px）
