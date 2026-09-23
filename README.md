# HotCopy (热文工坊)

> **YouTube / TikTok 海外热点视频提取与 AI 爆款文案生成器**  
> 一键提取海外视频原声逐字稿，AI 智能本土化改写为小红书与短视频高转化爆款脚本。

## 🌟 核心特性

- **四档核心处理引擎**：
  1. ⚡ **提取原声 (直接导出)**：0 大模型 Token 成本，纯官方字幕直拉，支持一键导出标准 `.txt`。
  2. 💡 **核心要点提炼 (速读)**：提炼结构化事实简报，10 秒扫完视频核心论点与数据。
  3. 🌐 **双语精准精翻**：自然流畅中文直翻，保留时间脉络。
  4. 🚀 **AI 爆款改写**：重塑为符合小红书/短视频口播逻辑的中文高转化文案。
- **全球热点活水**：YouTube 从雷达数据库读取真实频道视频；B站使用知识区公开榜单；Apple Podcasts 只展示可验证的单集音频。每两小时同步一次，失效来源不会继续展示。
- **双重商业变现闭环**：
  - **Google AdSense**：免费用户展示规范广告位 (`ca-pub-6499357447763670`)。
  - **Creem.io 会员订阅**：三档方案（基础版 $4.9、Pro版 $9.9、高级版 $19.9），打通 Webhook 自动发货与卡密激活，会员全站自动去广告。
- **高阶 SFT 训练集双写沉淀**：
  - 所有成功的二创改写数据自动沉淀进 SQLite `dataset_sft` 表。
  - 管理员后台一键导出标准 `hotcopy_sft_dataset.jsonl` 语料。

## 📁 目录结构

```text
HotCopy/
├── backend/
│   ├── server.js              # 核心后端 API（鉴权、定时抓取、Groq转写、流式生成、Creem回调、SFT双写）
│   ├── trends_live.js         # 热点来源校验与雷达读取
│   ├── clean_trends.js        # 历史伪数据清理（默认只预览，--apply 前备份）
│   ├── package.json           # 后端依赖配置
│   ├── .env.example           # 环境变量示例
│   └── database.sqlite        # SQLite 数据库（自动建表）
└── frontend/
    ├── index.html             # HotCopy 现代用户端单页（含 AdSense、4档处理坞、热点瀑布流、Creem 弹窗）
    ├── admin.html             # 运营管控与 SFT 数据集导出后台
    ├── ads.txt                # Google AdSense 防伪验证文件
    ├── robots.txt             # 爬虫搜索引擎配置
    ├── sitemap.xml            # XML 网站地图
    ├── _headers               # Cloudflare Pages 响应头
    └── favicon.svg            # 专属品牌矢量图标
```

历史伪数据清理：先运行 `node backend/clean_trends.js` 查看删除数量，确认后运行 `node backend/clean_trends.js --apply`。执行前会将数据库备份到 `backend/.backups/`；雷达数据库由附加服务维护，默认路径为 `backend/addons/addons.sqlite`，可通过 `ADDONS_DB_PATH` 指定。

## 🚀 部署指南

### 前端（Cloudflare Pages）
- **Root directory**: `frontend`
- **Build command**: 留空（纯静态无需编译）
- **Build output directory**: 留空或填写 `/`
- **Custom domain**: `hotcopy.eazyopc.com`

### 后端（Node.js + PM2）
```bash
cd backend
npm install
pm2 start server.js --name hotcopy-backend --max-memory-restart 400M
```
