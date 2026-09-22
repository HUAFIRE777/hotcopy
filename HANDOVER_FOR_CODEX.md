# HotCopy 项目完整工程交接与升级指南 (Handover Document for Codex)

> **文档定位**：本交接文档专为接棒的开发者 / AI 编程助理（Codex / Claude 等）编写，涵盖 HotCopy 当前完整生产架构、核心业务链路、代码全景字典、安全底线约束，以及待攻坚的三大升级任务（**UI 高级感升级**、**全面去 AI 话文案改造**、**交互体验与稳定性加固**）。

---

## 一、 项目全景与生产运行环境

### 1. 核心定位
HotCopy 是一款面向内容创作者、自媒体操盘手、出海研报团队的**多平台长音视频内容提炼与二次创作 SaaS**。一键支持 YouTube、B站、小宇宙播客、Apple 播客长音频解析，提供【原声逐字稿】、【核心事实简报】、【双语精翻】和【AI 爆款改写】四档交付物。

### 2. 现网拓扑与服务地址
- **前端生产站点**：`https://hotcopy.eazyopc.com` (托管于 GitHub Pages / CDN，纯原生 HTML5 + Tailwind CSS + Vanilla JS 零构建 SPA)
- **后端 API 生产站点**：`https://api.eazyopc.com` (反向代理至 Node.js 生产机 `http://127.0.0.1:3001`)
- **云服务器环境**：新加坡独立 Linux VPS (`139.180.190.183`)
  - 进程管理：PM2 进程名 `hotcopy-backend`（目录位于 `/opt/hotcopy`，常态 CPU 0%，内存 ~18MB）
  - 数据库：SQLite 3（使用 `better-sqlite3` 驱动，本地落盘 `database.sqlite`）
- **代码仓库**：`https://github.com/HUAFIRE777/hotcopy.git` (主分支: `main`)

---

## 二、 核心架构与底层技术实现

### 1. 前后端技术栈
- **前端架构** (`frontend/index.html`，单文件 SPA)：
  - 样式引擎：Tailwind CSS (CDN) + 自定义极简性冷淡科技风（Stone / Amber / Zinc 调色）
  - 交互状态管理：原生状态机（`token`、`currentUser`、`clientCache`、`allTrendsList`）
  - 网络通信：原生 `fetch` 处理流式 Chunk（SSE / text/plain chunked 响应流打字机效果）
- **后端架构** (`backend/server.js`，Node.js 22 + Express)：
  - 数据库引擎：`better-sqlite3`（全参数化预编译查询，严格防 SQL 注入与列名语法冲突）
  - 音视频转录管道：Groq Whisper API（长音频自动使用 `ffmpeg` 40 分钟容灾切片，自动轻量化压缩至 24MB 以下单次直出）
  - 大模型生成引擎：Groq OpenAI 兼容端点，配备**多模型自动熔断降级链**（`process.env.LLM_MODEL` 优先，遇 429 限流自动秒切 `openai/gpt-oss-120b` 与 `openai/gpt-oss-20b`）
  - 支付系统：Creem.io 信用卡/借记卡收银台，配备 **HMAC-SHA256 官方验签**防伪回调 Webhook。

### 2. 关键核心资产：双层零成本缓存架构 (Zero Redundant Transcription)
为解决“用户在同一链接下切换 4 个模式（逐字稿、简报、改写、翻译）反复扣模型费用或重新下载”的痛点，系统已实现双层缓存：
1. **浏览器前端高速缓存** (`clientCache[url + '::' + mode]`)：
   - 用户在一个视频下点击过任意模式后，结果永久缓存在当前 Session 中。
   - 再次点击或切换 Tab 时 **0 毫秒即显**，无任何网络请求与模型调用。
2. **后端 SQLite 缓存表** (`copies_cache (video_id, mode, content)`)：
   - 首次解析音视频时，将 Whisper 生成的原声纯文本存入 `mode = 'raw'`。
   - 用户后续在该音视频下请求“简报”、“改写”或“双语精翻”时，后端直接读取 `raw` 逐字稿注入 Prompt，**永远不会重复下载音视频或二次调用 Whisper 听译引擎**！

---

## 三、 文件组织与核心代码字典

```text
HotCopy/
├── frontend/
│   └── index.html             # 前端完整代码（UI 模板、模态框、趋势流、交互 JS）
├── backend/
│   ├── server.js              # 后端 Express 主入口、路由鉴权、流抓取与 LLM 管道
│   ├── trends_data.js         # 100 条全网趋势热点种子数据集（支持 4 大平台分类筛选）
│   ├── database.sqlite        # SQLite 生产数据库
│   └── package.json           # 依赖项清单
└── HANDOVER_FOR_CODEX.md      # 本交接指南
```

### 关键函数索引：

#### 1. 前端 `frontend/index.html`
- `init()`: 页面初始化入口，加载用户信息、热点流，并监听 Creem 支付完成的 `?payment=success` 状态。
- `loadAllTrends()` / `renderTrends()`: 渲染热门卡片列表，支持“全网热门 / B站 / 小宇宙 / 苹果播客 / YouTube”与行业双维筛选。
- `fillExample(url)`: 快速在输入框填入真实可用的测试样例。
- `runConvert(mode)` / `runConvertDirect(url, mode)`: 核心转换流程，先查 `clientCache`，未命中则向后端 `/api/generate` 发送流式请求并驱动打字机渲染。
- `switchResultTab(mode)`: 结果弹出框顶部的 4 档 Tab 切换控制器（无感秒切）。

#### 2. 后端 `backend/server.js`
- `fetchBilibiliTranscript(url)`: B 站解析引擎。优先拉取官方 CC 字幕 JSON（0秒直出）；无字幕时抓取移动端播放流并投送 Whisper 听译。
- `fetchPodcastTranscript(url)`: 播客与音频解析引擎。自动识别小宇宙（提取 `media.xyzcdn.net` 直链）与 Apple 播客（页面直出 + iTunes Lookup 容灾）。
- `transcribeLongAudio(streamUrl, cacheKey)`: 音频下载、ffmpeg 压缩与分片听译调度器。
- `app.post('/api/generate')`: 核心生产接口，接收 `url` 与 `mode`，做参数化鉴权、额度扣减、缓存复用与 LLM 流式输出。
- `app.post('/api/webhook/creem')`: Creem 支付回调，使用密钥计算 `HMAC-SHA256` 签名校验，校验通过后自动更新用户等级与月度额度。

---

## 四、 Codex 的三大重构攻坚任务

接手 Codex 在修改代码时，请重点围绕以下 3 大模块进行优化和升级：

### 任务 1：全面“去 AI 话”——重塑高级克制的产品语感 (Humanize the Copy)

#### 存在问题：
当前界面和提示词中，仍带有一些大模型常用的虚浮陈词滥调（例如：“在充斥着不确定性的时代”、“AI 爆款神器”、“一键逆天改写”、“深度赋能”等），缺乏真实内容创作者的专业感和克制感。

#### 改造方向与具体执行点：
1. **前端文案（UI Copywriting）**：
   - 参照 **Linear / Readwise Reader / Notion / Substack** 的语言风格，改用精炼、准确、克制、极具工具属性的措辞。
   - 替换示例：
     - 将 “AI 爆款改写” 优化为 **“分发改写”** 或 **“多平台图文重构”**。
     - 将 “核心事实简报” 优化为 **“核心要点与逻辑脉络”** 或 **“执行摘要 (Executive Summary)”**。
     - 将 “逐字稿” 优化为 **“原声全文 (Clean Transcript)”**。
     - 搜索占位符与按钮文案避免“无所不能”的夸张修辞，突出“长内容秒提炼、原声对齐、可直接引用”。
2. **后端 Prompt 改造 (`backend/server.js` 中的 PROMPT 模板)**：
   - 重点优化 `PROMPT_SUMMARY`、`PROMPT_REWRITE`、`PROMPT_TRANSLATE`：
   - **严禁**输出废话套话：例如严禁开头使用“在这个快节奏的时代…”、“今天我们一起来看…”、“总而言之…”、“不得不说…”。
   - **要求**：直接输出干货论点，采用结构化小标题、加粗关键数字、还原说话人逻辑转折点、生成具有真实社交媒体穿透力（但绝非低俗震惊体）的选题切入点。

---

### 任务 2：UI 美感与现代交互体验全面进化 (Visual & UX Elevation)

#### 改造方向：
1. **输入面板沉浸感提升**：
   - 当前输入框虽然简洁，但可以通过微边框（`ring-1 ring-stone-900/5`）、极柔阴影（`shadow-[0_2px_12px_rgba(0,0,0,0.04)]`）、支持拖拽音频文件放置区（Drag & Drop）提升质感。
   - 支持一键快捷粘贴剪贴板链接（Clipboard API 权限友好提示）。
2. **转换过程的“进度质感”**：
   - 目前转换时弹窗内仅有文本提示，建议加入优雅的**骨架屏 (Skeleton Screens)** 或具有节奏感的阶段进度指示器（例如：`[1/3 捕获音频流] -> [2/3 高保真转录] -> [3/3 观点提炼]`）。
3. **结果弹窗的阅读与导出体验**：
   - 引入轻量 Markdown 格式渲染（标题、列表、引用块更加美观易读）。
   - 增加 **“一键复制 Markdown”**、**“导出 Notion 格式”**、**“导出 TXT”**、**“生成摘要长图”** 等创作者刚需微功能。
   - 在逐字稿模式下，如果时间戳存在，提供时间戳高亮和快捷跳转复制。
4. **移动端手势与响应式适配**：
   - 确保在 iPhone Safari 和 Android Chrome 上，结果弹窗采用平滑底部抽屉（BottomSheet / Drawer）形态，支持下滑关闭。

---

### 任务 3：稳定性与安全防御加固 (Stability & Safeguards)

#### 必须坚守的铁律（Codex 必须严格执行）：
1. **绝对禁止泄露或窥探秘钥**：
   - 任何时候不得在代码中硬编码任何 API Key，不得在前端或公开日志中打印环境变量。
2. **数据库查询一律使用参数化语句**：
   - 任何 SQL 交互必须使用 `db.prepare('... WHERE x = ?').get(val)`，**切忌手写拼接双引号或单引号**。
3. **LLM 与 Whisper 的熔断机制**：
   - 保留现有的多模型候选降级链（`candidateModels`），且每次调用必须带有 `max_tokens`（建议 2000~3000）以防 Groq 报 OTPM 429 错误。
4. **音频文件临时目录自清理**：
   - `ffmpeg` 生成的临时音频碎片（`/tmp/*.mp3`），在转录完成后必须在 `finally` 块中通过 `fs.unlink` 彻底删除，避免 VPS 磁盘爆满。

---

## 五、 Codex 本地开发与线上发布部署流水线

### 1. 本地调试
```bash
# 1. 启动后端 (端口 3001)
cd /Users/huafire777/Desktop/program/HotCopy/backend
node server.js

# 2. 前端可直接通过 Live Server 或静态 HTTP 服务打开
cd /Users/huafire777/Desktop/program/HotCopy/frontend
# 打开 index.html
```

### 2. 生产环境部署指令（极速无感知发布）
修改代码后，在终端执行以下指令即可一键推送并热重启生产环境：

```bash
# 1. 语法静态检查 (保证 0 语法报错)
node -c backend/server.js
node -c backend/trends_data.js

# 2. 将改动同步至生产服务器 /opt/hotcopy
scp backend/server.js root@139.180.190.183:/opt/hotcopy/
scp backend/trends_data.js root@139.180.190.183:/opt/hotcopy/

# 3. 生产服务 0 停机热重载
ssh root@139.180.190.183 "pm2 reload hotcopy-backend"

# 4. 提交并推送到 GitHub 触发前端部署
git add .
git commit -m "refactor(ui): elevate typography, tone-of-voice and interactive states"
git push origin main
```

---

> **致 Codex**：HotCopy 的核心音视频解析、多平台流媒体抓取与双层缓存基建已经全部跑通且实机验证完毕。你的使命是专注于**极致的审美、人性的文案表达与丝滑的微交互体验**，把它打造成媲美硅谷顶流工具的一流产品！
