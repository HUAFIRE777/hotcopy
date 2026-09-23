# HotCopy 创作资产工坊与 Premium 爆款雷达：全功能落地实施详案（Codex 执行版）

> **目标读者：** 接手开发的 AI 编程助手（Codex / Claude 等）与全栈工程师。  
> **核心原则：** 绝对物理隔离核心、零无头浏览器、零重复转录消耗、真实频道名单入库、严守现有套餐承诺。

---

## 目录
1. [系统边界与红线禁区 (Strict Boundaries)](#1-系统边界与红线禁区-strict-boundaries)
2. [总体架构与网络拓扑](#2-总体架构与网络拓扑)
3. [模块一：创作资产工坊 (小红书图文 / 定向口播 / 知识脑图)](#3-模块一创作资产工坊-小红书图文--定向口播--知识脑图)
4. [模块二：YouTube 真实频道爆款雷达 (免 Key、零风控)](#4-模块二youtube-真实频道爆款雷达-免-key零风控)
5. [数据字典与独立数据库设计 (`addons.sqlite`)](#5-数据字典与独立数据库设计-addonssqlite)
6. [后端 API 详细接口契约](#6-后端-api-详细接口契约)
7. [前端挂载点与精准 DOM 规范 (防止 Codex 破坏现有 UI)](#7-前端挂载点与精准-dom-规范-防止-codex-破坏现有-ui)
8. [20 个科技/AI/商业领域真实头部频道白名单](#8-20-个科技ai商业领域真实头部频道白名单)
9. [Codex 分步执行与验证清单 (Checklist)](#9-codex-分步执行与验证清单-checklist)

---

## 1. 系统边界与红线禁区 (Strict Boundaries)

为了避免 Codex 因不了解历史代码而误改核心导致崩溃，Codex 必须把以下规则作为最高铁律执行：

### 🚫 严禁触碰的“核心冻结区”
1. **不得修改** `backend/server.js` 中的核心生成逻辑 `app.post('/api/generate')`、Whisper 音频转录管道、`copies_cache` 的读写逻辑。
2. **不得修改** 核心数据库文件 `backend/database.sqlite`。严禁在核心库中创建雷达表、资产表。
3. **不得修改** 核心鉴权逻辑与 Creem 支付回调 `app.post('/api/webhook/creem')`。
4. **不得引入无头浏览器**（如 Puppeteer、Playwright、Selenium 等），服务器只有 1GB 内存，禁止高负载爬虫。
5. **不得在轮询任务中跑 Whisper 或 LLM**，雷达只收集公开元数据与播放量数字，不自动转写音频。

### ✅ 允许操作的“隔离区”
1. 新建并完全掌控目录：`backend/addons/`。所有新接口、新数据、定时任务必须在此目录下完成。
2. 在前端 `frontend/index.html` 现有结构的基础上，**仅在指定锚点挂载**新 UI（结果弹窗工具条与主导航入口），**严禁推翻现有 CSS、字体与色彩体系**。

---

## 2. 总体架构与网络拓扑

```text
┌─────────────────────────────────────────────────────────────┐
│                    用户浏览器 (index.html)                    │
└──────────────┬───────────────────────────────┬──────────────┘
               │ 核心转录与基础改写               │ 资产生成与雷达看板
               │ (保持原样)                     │ (全新隔离)
               ▼                               ▼
       POST /api/generate              POST /api/addons/assets/*
       GET  /api/auth/me               GET  /api/addons/radar/*
               │                               │
┌──────────────▼──────────────┐ ┌──────────────▼──────────────┐
│  核心服务 (Port 3001)        │ │  附加服务 (Port 3002)        │
│  进程: hotcopy-backend      │ │  进程: hotcopy-addons       │
│  库: database.sqlite        │ │  库: backend/addons/        │
│                             │ │      addons.sqlite          │
└──────────────┬──────────────┘ └──────────────┬──────────────┘
               │ 内网 Token 验证握手             │
               └───────────────────────────────┘
                                               ▲
                                               │ 读写数据
                                ┌──────────────┴──────────────┐
                                │  雷达轮询 Worker (后台运行)   │
                                │  进程: hotcopy-radar-worker │
                                │  执行 YouTube 官方 RSS 抓取  │
                                └─────────────────────────────┘
```

### 生产环境端口与反向代理规范
- 核心服务继续监听：`127.0.0.1:3001`
- 附加服务监听内部端口：`127.0.0.1:3002`
- Nginx 反向代理配置统一路径（由运维配置或本地转发）：
  ```nginx
  # 附加服务路由转发
  location /api/addons/ {
      proxy_pass http://127.0.0.1:3002/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  ```

---

## 3. 模块一：创作资产工坊 (小红书图文 / 定向口播 / 知识脑图)

### 3.1 零重复成本原则 (Zero-Cost Data Flow)
- **数据源头**：用户在结果弹窗生成三项资产时，前端直接提取已在 `clientCache` 中的 `raw`（原声全文）。
- **绝对不重调 Whisper**：不需要再次下载音视频，不需要再次调用语音识别，仅将清洗后的文本输入大模型进行结构化生成。

### 3.2 三大资产规格与 Prompt 规范 (杜绝 AI 腔)

#### 1. 小红书爆款图文 (`xiaohongshu`)
- **输出格式**：JSON 结构化返回（`{ title, hook, cards: [ { subtitle, content } ], tags }`）。
- **语言风格**：提炼 3 个最具颠覆性的信息增量，段落短小，适度 Emoji，严禁“在当今快节奏时代”等套话。
- **系统提示词**：
  ```text
  你是顶级小红书科技商业博主。根据转录稿提炼出高完播率、高收藏率的图文笔记。
  输出必须为严格的 JSON，禁止 Markdown 包裹或额外寒暄：
  {
    "title": "爆款标题（20字以内，痛点+冲突，带Emoji）",
    "hook": "开头前两句话（击中读者现实焦虑或好奇心）",
    "sections": [
      { "subtitle": "核心要点一（加粗小标题）", "body": "通俗口语化解析，提取具体数字或对比" },
      { "subtitle": "核心要点二（加粗小标题）", "body": "通俗口语化解析，提取具体数字或对比" },
      { "subtitle": "核心要点三（加粗小标题）", "body": "通俗口语化解析，提取具体数字或对比" }
    ],
    "tags": ["#标签1", "#标签2", "#标签3", "#标签4", "#标签5"]
  }
  ```

#### 2. 平台定向口播脚本 (`short-video`)
- **支持平台枚举**：`douyin`（抖音：极快节奏）、`xiaohongshu`（小红书：闺蜜/私域真诚感）、`shipinhao`（视频号：情绪价值/职场认知）、`tiktok`（海外：强反差）、`youtube`（中长视频钩子）。
- **结构约束**：必须严格包含四大段落标识，标注文案演播节奏：
  - `【黄金前3秒 Hook】`（前3秒必须留住人）
  - `【痛点共鸣与反常识】`
  - `【干货论证与核心反转】`
  - `【互动与关注引导】`

#### 3. 知识脑图 (`mindmap`)
- **输出格式**：结构化 JSON + 纯净无毒的 Mermaid 语法代码块。
- **规范**：采用 `graph LR` 或 `mindmap` 格式，节点文字必须简炼（<12个字符），层级为 `核心主题 -> 3~4个一级支柱 -> 2~3个二级细节`。
- **安全红线**：前端解析 Mermaid 时，必须使用 `DOMPurify.sanitize()` 或使用纯 SVG Canvas 渲染，严禁直接把用户文本作为原始 HTML 插入 DOM。

### 3.3 资产额度台账规则
- **Basic 用户 ($4.9)**：保留现有 50 次基础整理，不开放资产工坊（点击显示引导升级 Pro 弹窗）。
- **Pro 用户 ($9.9)**：每月赠送 **30 次** 资产生成额度。
- **Premium 用户 ($19.9)**：每月享有 **100 次** 资产生成额度 + 资产库永久云端保存。
- 资产额度与核心转录额度分开记账（存放在 `addons.sqlite` 的 `asset_usage` 表中），不消耗核心转录次数。

---

## 4. 模块二：YouTube 频道爆款雷达 (免 API Key，需验证 Feed 稳定性)

### 4.1 采集协议：官方 Atom RSS Feed
雷达优先使用 YouTube 公开 Atom Feed，避免消耗 YouTube Data API 配额；Feed 仍可能返回错误或受到区域、网络和平台策略影响，必须在部署环境实测：
```text
URL: https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}
请求方式: GET
依赖项: 零 Key、零认证、无头浏览器不需要
返回格式: Atom XML (含视频 ID、标题、发布时间等字段；条数及可用性以实际响应为准)
```

2026-09-23 本机对已核对频道的 Feed 请求返回 HTTP 404；新加坡 VPS 只读探测中，Fireship 多次返回 HTTP 500，另两个频道返回 HTTP 404，而频道主页可访问。无 `www` 的入口曾短暂返回 HTTP 200，随后又报错，尚未取得可解析并核对的视频数据。这不能当作“已打通生产抓取”。Worker 必须记录错误并退避，VPS 实测成功前不要宣传实时监控。

**阶段三补充兜底：** Feed 失败时调用本地 `yt-dlp --flat-playlist --playlist-end 10 -J` 读取频道 `/videos` 列表；Cookie 文件仅通过 `YTDLP_COOKIES_PATH` 配置。2026-09-23 已用新加坡 VPS 的真实 Fireship JSON 验证解析出 10 条视频与播放量。该模式通常没有发布时间，须以未知值保存，不得据此宣称“24 小时新发布”。生产 Worker 尚未启用。

### 4.2 轮询与播放量快照策略
1. **定时触发**：`worker.js` 使用 `node-cron` 每 30 分钟执行一次轮询。
2. **两级采样**：
   - 步骤一：拉取 RSS，若发现 `radar_videos` 中不存在的 `video_id`，立即插入新视频记录，标为 `NEW`。
   - 步骤二：针对发布时间在 24 小时以内的新视频，执行极轻量级播放量采样（使用 `yt-dlp --dump-json --skip-download "https://www.youtube.com/watch?v={id}"` 读取 `view_count`，或抓取公开页面的结构化数据）。
   - 记录采样时间戳 `observed_at` 与 `views_count` 存入 `radar_view_snapshots`。
3. **时速异动与黑马判决公式**：
   - **时速计算**：$V_{current} = \frac{\Delta Views}{\Delta Hours}$（最近两次采样的播放量增量 / 时间间隔）。
   - **历史基线**：取该频道近 10 个历史视频在发布 6 小时节点的平均时速 $V_{baseline}$。
   - **爆发标记**：若 $V_{current} \ge 2.5 \times V_{baseline}$，打上 `⚡ 时速异动 (2.5x)` 徽章。
   - **严禁虚假预测**：若采样点不足 2 个，界面统一显示 `🌱 数据采集中 (需更多样本)`，绝不可出现“神准必火”等欺骗性词汇。

---

## 5. 数据字典与独立数据库设计 (`addons.sqlite`)

所有表全部建立在 `backend/addons/addons.sqlite` 中，使用 `better-sqlite3` 驱动并执行参数化查询。

```sql
-- 1. 监控频道白名单表
CREATE TABLE IF NOT EXISTS radar_creators (
  channel_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,           -- 'tech', 'ai', 'business'
  channel_name TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  curated_rank INTEGER DEFAULT 99,
  is_active INTEGER DEFAULT 1,
  last_checked_at INTEGER DEFAULT 0,
  last_success_at INTEGER DEFAULT 0
);

-- 2. 雷达抓取的视频池
CREATE TABLE IF NOT EXISTS radar_videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  published_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  latest_views INTEGER DEFAULT 0,
  velocity_hourly REAL DEFAULT 0.0, -- 当前每小时播放增长速度
  spike_score REAL DEFAULT 1.0,     -- 对比基线倍数
  status_badge TEXT DEFAULT 'NEW'   -- 'NEW', 'SPIKE', 'COLLECTING'
);

-- 3. 播放量时间序列快照表 (用于算加速度)
CREATE TABLE IF NOT EXISTS radar_view_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  views_count INTEGER NOT NULL,
  UNIQUE(video_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_vid ON radar_view_snapshots(video_id, observed_at);

-- 4. Premium 用户雷达收件箱
CREATE TABLE IF NOT EXISTS radar_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,           -- 用户 Email 的 HMAC-SHA256
  video_id TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_key, video_id)
);

-- 5. 创作资产月度额度台账表
CREATE TABLE IF NOT EXISTS asset_usage (
  user_key TEXT NOT NULL,
  billing_month TEXT NOT NULL,      -- '2026-09'
  asset_type TEXT NOT NULL,         -- 'xiaohongshu', 'short-video', 'mindmap'
  used_count INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_key, billing_month, asset_type)
);

-- 6. 用户资产收藏库 (用户主动点击保存才落盘)
CREATE TABLE IF NOT EXISTS asset_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

---

## 6. 后端 API 详细接口契约

附加服务基准路径：`/api/addons/`

### 6.1 鉴权握手（中间件逻辑）
```javascript
// backend/addons/middleware/auth.js
const axios = require('axios');
const crypto = require('crypto');

async function requireAddonUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: '请先登录' });

  try {
    // 代理调用核心 3001 端口检验 Token
    const coreCheck = await axios.get('http://127.0.0.1:3001/api/auth/me', {
      headers: { Authorization: authHeader },
      timeout: 3000
    });
    const user = coreCheck.data;
    if (!user || !user.email) throw new Error('无效用户');

    // 计算内部脱敏唯一 user_key
    const pepper = process.env.RADAR_ID_PEPPER || 'hotcopy_radar_default_pepper_2026';
    req.userKey = crypto.createHmac('sha256', pepper).update(user.email.toLowerCase().trim()).digest('hex');
    req.userPlan = user.plan || 'free';
    req.rawToken = authHeader;
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录态已失效，请重新登录' });
  }
}
```

### 6.2 资产接口清单
1. **生成小红书图文**：
   - `POST /api/addons/assets/xiaohongshu`
   - Body: `{ raw_text: string, title?: string }`
   - 权限：Pro / Premium。在事务中检查并递增 `asset_usage`。
   - 响应：`{ success: true, data: { title, hook, sections, tags }, remaining: number }`
2. **生成定向短视频口播脚本**：
   - `POST /api/addons/assets/short-video`
   - Body: `{ raw_text: string, platform: 'douyin'|'xiaohongshu'|'shipinhao'|'tiktok'|'youtube' }`
   - 响应：`{ success: true, platform, script_markdown, remaining: number }`
3. **生成长文知识脑图**：
   - `POST /api/addons/assets/mindmap`
   - Body: `{ raw_text: string }`
   - 响应：`{ success: true, mermaid_code, json_tree, remaining: number }`
4. **获取当前用户资产额度**：
   - `GET /api/addons/assets/usage`
   - 响应：`{ plan: 'pro', month: '2026-09', used: 12, limit: 30 }`

### 6.3 雷达接口清单
1. **获取最新雷达流**：
   - `GET /api/addons/radar/inbox?category=all`
   - 权限：仅限 `premium` 用户（非 Premium 返回 403 明确提示需升级）。
   - 响应：
     ```json
     {
       "success": true,
       "items": [
         {
           "video_id": "dQw4w9WgXcQ",
           "title": "Scaling Monolithic Architecture in 2026",
           "channel_name": "Fireship",
           "thumbnail_url": "https://i.ytimg.com/vi/.../hqdefault.jpg",
           "published_at": 1727000000000,
           "latest_views": 85400,
           "velocity_hourly": 12400.0,
           "spike_score": 3.4,
           "status_badge": "SPIKE",
           "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
         }
       ]
     }
     ```

---

## 7. 前端挂载点与精准 DOM 规范 (防止 Codex 破坏现有 UI)

> ⚠️ **警告 Codex**：严禁推翻重写 `frontend/index.html` 的结构。只能在以下**指定锚点**进行精准植入！

### 挂载点 A：在现有导航栏增加「爆款雷达」入口
- **位置**：`frontend/index.html` 中的 `<nav class="hidden md:flex items-center gap-6 ...">` 内部。
- **插入代码**：
  ```html
  <a href="#radar" onclick="switchMainView('radar'); return false;" class="flex items-center gap-1 hover:text-stone-900 transition">
    <span>爆款雷达</span>
    <span class="text-[9px] px-1.5 py-0.5 rounded bg-[#294639] text-white font-bold tracking-wider">PRO+</span>
  </a>
  ```

### 挂载点 B：在结果弹窗 (`#resultModal`) 中挂载“成套资产工坊”
- **位置**：`#resultModal` 内部，在现有 `#resultTabs` 的下方。
- **插入代码**：
  ```html
  <!-- 二创资产即时生成工具栏 (仅 Pro/Premium 可见或带标识) -->
  <div id="assetCreationTray" class="flex items-center justify-between gap-2 p-2.5 bg-emerald-50/60 border border-emerald-200/80 rounded-xl my-2 text-xs">
    <div class="flex items-center gap-1.5 text-emerald-900 font-semibold">
      <span>✨ 创作资产工坊:</span>
    </div>
    <div class="flex items-center gap-1.5 flex-wrap">
      <button type="button" onclick="generateAsset('xiaohongshu')" class="px-2.5 py-1 bg-white hover:bg-emerald-100/60 text-emerald-900 border border-emerald-200 rounded-lg font-medium transition shadow-2xs">
        小红书图文
      </button>
      <button type="button" onclick="generateAsset('short-video')" class="px-2.5 py-1 bg-white hover:bg-emerald-100/60 text-emerald-900 border border-emerald-200 rounded-lg font-medium transition shadow-2xs">
        定向口播
      </button>
      <button type="button" onclick="generateAsset('mindmap')" class="px-2.5 py-1 bg-white hover:bg-emerald-100/60 text-emerald-900 border border-emerald-200 rounded-lg font-medium transition shadow-2xs">
        知识脑图
      </button>
    </div>
  </div>
  ```

### 挂载点 C：全网热点流下方新增「爆款雷达监控看板」
- **位置**：在 `<section id="trends">` 下方新增 `<section id="radarSection" class="hidden">`。
- **行为**：
  - 点击卡片上的 **【立即制作】** 时，直接执行：
    ```javascript
    document.getElementById('videoUrl').value = item.source_url;
    runConvert('raw');
    ```
    平滑进入现有的 HotCopy 转录主链！

---

## 8. 20 个科技/AI/商业领域真实头部频道白名单

以下名单于 2026-09-23 按各频道公开页面的 canonical channel ID 核对。原稿中有多处 ID 对错频道或无效，本表已更正；它是科技、AI、商业与成长领域精选名单，不代表官方排名：

```javascript
// backend/addons/radar/seed_creators.js
const SEED_CREATORS = [
  // 前沿 AI & 深度技术
  { id: 'UCXUPKJO5MZQN11PqgIvyuvQ', name: 'Andrej Karpathy', category: 'ai', url: 'https://www.youtube.com/@AndrejKarpathy' },
  { id: 'UCsBjURrPoezykLs9EqgamOA', name: 'Fireship', category: 'tech', url: 'https://www.youtube.com/@Fireship' },
  { id: 'UCSHZKyawb77ixDdsGog4iWA', name: 'Lex Fridman', category: 'ai', url: 'https://www.youtube.com/@lexfridman' },
  { id: 'UCcefcZRL2oaA_uBNeo5UOWg', name: 'Y Combinator', category: 'business', url: 'https://www.youtube.com/@ycombinator' },
  { id: 'UCbfYPyITQ-7l4upoX8nvctg', name: 'Two Minute Papers', category: 'ai', url: 'https://www.youtube.com/@TwoMinutePapers' },
  { id: 'UCEgYhf84VjXDz-W7a9-rdCQ', name: 'Two Bit da Vinci', category: 'tech', url: 'https://www.youtube.com/@TwoBitdaVinci' },
  { id: 'UCawZsQWqfGSbCI5yjkdVkTA', name: 'Matthew Berman', category: 'ai', url: 'https://www.youtube.com/@matthew_berman' },
  { id: 'UCNJ1Ymd5yFuUPtn21xtRbbw', name: 'AI Explained', category: 'ai', url: 'https://www.youtube.com/channel/UCNJ1Ymd5yFuUPtn21xtRbbw' },
  
  // 商业出海与独立开发者
  { id: 'UCJS9pqu9BzkAMNTmzNMNhvg', name: 'Google Cloud Tech', category: 'tech', url: 'https://www.youtube.com/@googlecloudtech' },
  { id: 'UCyaN6mg5u8Cjy2ZI4ikWaug', name: 'My First Million', category: 'business', url: 'https://www.youtube.com/@MyFirstMillionPod' },
  { id: 'UCGq-a57w-aPwyi3pW7XLiHw', name: 'The Diary Of A CEO', category: 'business', url: 'https://www.youtube.com/@TheDiaryOfACEO' },
  { id: 'UCESLZhusAkFfsNsApnjF_Cg', name: 'All-In Podcast', category: 'business', url: 'https://www.youtube.com/@allin' },
  { id: 'UC2D2CMWXMOVWx7giW1n3LIg', name: 'Andrew Huberman', category: 'growth', url: 'https://www.youtube.com/@hubermanlab' },
  { id: 'UCznv7Vf9nBdJYvBagFdAHWw', name: 'Tim Ferriss', category: 'growth', url: 'https://www.youtube.com/@timferriss' },
  { id: 'UCBJycsmduvYEL83R_U4JriQ', name: 'Marques Brownlee', category: 'tech', url: 'https://www.youtube.com/@mkbhd' },
  { id: 'UCddiUEpeqJcYeBxX1IVBKvQ', name: 'The Verge', category: 'tech', url: 'https://www.youtube.com/@TheVerge' },
  { id: 'UCqcbQf6yw5KzRoDDcZ_wBSw', name: 'Wes Roth', category: 'ai', url: 'https://www.youtube.com/@WesRoth' },
  { id: 'UCXl4i9dYBrFOabk0xGmbkRA', name: 'Dwarkesh Patel', category: 'business', url: 'https://www.youtube.com/@DwarkeshPatel' },
  { id: 'UC6t1O76G0jYXOAoYCm153dA', name: "Lenny's Podcast", category: 'business', url: 'https://www.youtube.com/@LennysPodcast' },
  { id: 'UCoOae5nYA7VqaXzerajD0lg', name: 'Ali Abdaal', category: 'growth', url: 'https://www.youtube.com/@aliabdaal' }
];
```

---

## 9. Codex 分步执行与验证清单 (Checklist)

Codex 在开发时，请依次打勾执行并向用户汇报：

- [ ] **Step 1：目录搭建**
  - 创建 `backend/addons/`，编写 `server.js`、`db.js`、`worker.js`。
  - 确认 `db.js` 正确初始化 `addons.sqlite` 并完成 6 张表创建。
- [ ] **Step 2：鉴权握手**
  - 实现 `requireAddonUser` 中间件，向 `http://127.0.0.1:3001/api/auth/me` 发起验证，跑通 `user_key` 的 HMAC 计算。
- [ ] **Step 3：创作资产工坊实现**
  - 编写小红书、口播、脑图三大生成路由。
  - 确保直接输入 `raw_text`，**严禁再次发起 Whisper 听写**。
  - 设置 `max_tokens: 2500`，防止 Groq 报错 429。
- [ ] **Step 4：前端弹窗挂载**
  - 在 `#resultModal` 中植入 `#assetCreationTray`。
  - 测试点击生成小红书图文，确认能秒级返回并在界面上支持一键复制与 Markdown 渲染。
- [ ] **Step 5：雷达定时 Worker**
  - 导入上述 20 个真实频道白名单。
  - 实现基于官方 RSS 的 30 分钟轮询解析与新视频去重入库。
- [ ] **Step 6：联调测试与回滚验证**
  - 启动附加服务：`node backend/addons/server.js`。
  - 强制关闭附加服务，测试主站 `hotcopy.eazyopc.com` 提取 YouTube 与 B 站视频，确认主站 100% 毫无影响。
