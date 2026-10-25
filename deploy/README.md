# 部署到服务器（VPS）

给"老师只收到一个网址、什么都不用装"的场景。本文以 Ubuntu 22.04 为例，其他发行版改包管理命令即可。

## 一、服务器要求

| 项 | 最低 | 说明 |
| --- | --- | --- |
| 系统 | Ubuntu 22.04 / Debian 12 | 需要能装 Node ≥ 22 |
| 内存 | 1 GB | 向量模型推理约占 300 MB |
| 磁盘 | 5 GB | 依赖 500 MB + 模型 23 MB + 材料 |
| 带宽 | 1 Mbps | 主要是文本 |
| 备案 | 国内服务器需备案 | 用香港/新加坡可跳过 |

> 别用最低配 512 MB 的机器：`npm install` 和 ONNX 推理会 OOM。

## 二、装 Node 与系统依赖

```bash
# Node 22（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 扫描版 PDF 的 OCR（可选；只有要用本机 OCR 时才需要）
sudo apt install -y poppler-utils tesseract-ocr tesseract-ocr-chi-sim
```

## 三、部署代码

```bash
sudo useradd -m -s /bin/bash teacher
sudo mkdir -p /opt/teacher-ai && sudo chown teacher:teacher /opt/teacher-ai

sudo -u teacher git clone <你的仓库地址> /opt/teacher-ai
cd /opt/teacher-ai
sudo -u teacher npm install --omit=dev
```

**把向量模型拷上去**（仓库里没有，而且服务器上大概率下不动 HuggingFace）：

```bash
# 在你本机执行
rsync -av data/models/ 服务器:/opt/teacher-ai/data/models/
```

## 四、配置

```bash
sudo -u teacher cp .env.example .env
sudo -u teacher vim .env
```

必填：

```bash
DEEPSEEK_API_KEY=sk-...      # 或 OPENAI_BASE_URL + OPENAI_API_KEY 走别的厂商
HOST=127.0.0.1               # 只让本机反代访问，别开 0.0.0.0
PORT=8787
```

## 五、建知识包并起服务

```bash
cd /opt/teacher-ai
sudo -u teacher node scripts/build-packs.mjs
sudo -u teacher node scripts/build-vectors.mjs     # 需要模型文件

sudo cp deploy/teacher-ai.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now teacher-ai
curl -s localhost:8787/healthz    # provider 应为 deepseek
```

## 六、域名与 HTTPS

**Caddy（推荐，自动证书）**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt install -y caddy

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # 改成你的域名
sudo systemctl reload caddy
```

**Nginx**：用 `deploy/nginx.conf`，配 certbot。

⚠️ **反代必须关掉响应缓冲**（配置里已写 `flush_interval -1` / `proxy_buffering off`），否则备课对话的流式输出会一次性憋到最后才吐出来。

## 七、数据迁移（从本机搬到服务器）

```bash
# 停本机服务后执行
rsync -av courses/ 服务器:/opt/teacher-ai/courses/
rsync -av data/assistant.db* 服务器:/opt/teacher-ai/data/
rsync -av config/ 服务器:/opt/teacher-ai/config/
rsync -av students/ 服务器:/opt/teacher-ai/students/
```

搬完在服务器上重建一次：

```bash
sudo -u teacher node scripts/build-packs.mjs
sudo -u teacher node scripts/build-vectors.mjs
sudo systemctl restart teacher-ai
```

**学生码不用重发**：哈希在 `config/students.json` 和数据库里，跟着搬就行。

## 八、备份

```bash
# /opt/teacher-ai/backup.sh
#!/bin/bash
D=/opt/teacher-ai/backups/$(date +%F)
mkdir -p "$D"
sqlite3 /opt/teacher-ai/data/assistant.db ".backup '$D/assistant.db'"
tar czf "$D/content.tar.gz" -C /opt/teacher-ai courses students config
find /opt/teacher-ai/backups -mtime +14 -delete
```

```bash
sudo crontab -u teacher -e
# 0 3 * * * /opt/teacher-ai/backup.sh
```

## 九、升级

```bash
cd /opt/teacher-ai
sudo -u teacher git pull
sudo -u teacher npm install --omit=dev
sudo -u teacher node scripts/build-packs.mjs
sudo -u teacher node scripts/build-vectors.mjs
sudo systemctl restart teacher-ai
```

## 十、常见问题

| 现象 | 原因 |
| --- | --- |
| 学生打开是 502 | systemd 服务没起来，`journalctl -u teacher-ai -n 50` |
| 提问转圈很久最后一次性出现 | 反代没关缓冲 |
| 回答是占位内容 | `.env` 没填 key，或改完没 restart |
| OCR 报错 | 缺 `poppler-utils` / `tesseract-ocr`，或改用 `OCR_BACKEND=vision` |
| 内存吃满被杀 | 机器太小，升到 1 GB 以上 |
| `npm install` 卡住 | 换国内镜像：`npm config set registry https://registry.npmmirror.com` |
