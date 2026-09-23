# HotCopy 附加服务：创作资产与频道雷达

本目录提供独立的 3002 端口 API、独立的 `addons.sqlite`、三类单项内容资产、一次生成的全套制作包、零额外模型调用的视频制作包、Pro/Premium 创作项目保存与 Premium 作品库。频道雷达有独立 Worker，使用 YouTube Atom Feed 并在失败时回退到本地 `yt-dlp`。

## 配置与启动

使用 `backend/` 已安装的 Node.js 依赖。部署环境需注入 `ADDONS_USER_KEY_SECRET`（至少 32 个随机字符）和现有模型配置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`；附加服务会读取 `backend/.env`，但绝不输出其内容。不要使用文档示例中的固定默认 Pepper。

```bash
node backend/addons/server.js
```

服务只绑定 `127.0.0.1:3002`。可选 `CORE_API_BASE` 指向核心服务，默认 `http://127.0.0.1:3001`；`ADDONS_DB_PATH` 可为测试指定独立数据库。生产反向代理需要**保留** `/api/addons/` 前缀：

```nginx
location /api/addons/ {
    proxy_pass http://127.0.0.1:3002;
}
```

交接文档中 `proxy_pass http://127.0.0.1:3002/;` 末尾的斜杠会剥离路径前缀，与本服务路由不匹配，部署时应采用上面的写法。此阶段不包含生产代理或 PM2 变更。

## 当前接口

- `GET /api/addons/health`
- `GET /api/addons/assets/usage`
- `POST /api/addons/assets/xiaohongshu`
- `POST /api/addons/assets/short-video`
- `POST /api/addons/assets/mindmap`
- `POST /api/addons/assets/production-kit`（从已有逐字稿一次生成封面三选、分镜口播、社媒图文和脑图；计一次创作额度）
- `POST /api/addons/assets/production-package`（从现有四段口播稿生成 Agent 制作指令，不调用模型）
- `GET/POST /api/addons/assets/library`、`DELETE /api/addons/assets/library/:id`（仅 Premium）
- `GET/POST /api/addons/projects`、`GET/DELETE /api/addons/projects/:id`、`PUT /api/addons/projects/:id/assets`（Pro/Premium，按用户隔离）
- `GET /api/addons/radar/status`、`GET /api/addons/radar/channels`、`GET /api/addons/radar/inbox?category=all`（仅 Premium）

资产接口接收前端已有的 `raw_text`，不会访问视频链接、下载媒体或调用 Whisper。全套制作包单次模型输出上限 `max_tokens: 3500`，其他模型生成接口为 2500。免费与 Basic 不能调用生成接口；Pro 每月总计 30 次，Premium 每月总计 100 次，四类模型生成资产共用额度池。额度按 UTC 自然月计算，与核心整理次数分别显示。模型调用失败会退还本次预留额度；如果进程在调用途中异常退出，预留额度需要人工核对。

生成耗时及价格取决于输入长度、模型和当时服务状态，不能保证“1 秒”或“不到 1 分钱”。输入当前限 40,000 字符；过长时需缩短素材或等待后续分段处理能力。

旧版视频制作包从已经生成的口播稿整理四段口播、对应画面方向和一份可复制给 Agent 的制作指令；它不生成视频，也不再消耗模型额度。新增全套制作包从已有原声逐字稿调用模型一次，产出封面、分镜台词及画面提示、图文正文、话题标签和脑图。模型的 Mermaid mindmap 文本会被解析、校验并规范化，前端根据校验后的节点生成本地 SVG 预览，不加载外部 Mermaid 脚本。

创作项目保存原声全文、素材链接、项目标题，以及按类型和口播平台保存的图文、口播、脑图和旧版视频制作包；Premium 还可保存完整全套制作包到同一项目的 `kit_data`。旧版项目表会原位增加可空的 `video_id` 和 `kit_data`，原数据保留。相同用户保存同一素材链接会更新原项目，并保留未提交的新内容字段。Pro 最多 50 个项目，Premium 最多 200 个；单个项目原声限 40,000 字符。项目与旧版 Premium 作品库是两套独立内容，删除项目会一并删除项目内作品。

## 雷达 Worker

```bash
node backend/addons/worker.js
```

Worker 与 API 共用 `backend/addons/addons.sqlite`，启动时以参数化 SQL 种入 20 个已核对频道。频道 ID 的来源 URL 记录在 [`radar/seed_creators.js`](./radar/seed_creators.js)；它们是精选名单，不代表 YouTube 官方 Top 排名。[YouTube 开发者文档](https://developers.google.com/youtube/v3/guides/push_notifications)给出了 `feeds/videos.xml?channel_id=...` 的 Atom Feed 格式。

当 RSS 返回错误或内容无法解析时，Worker 用本地 `/usr/local/bin/yt-dlp` 抓取该频道最近 10 个视频的公开列表。可设置 `YTDLP_BIN` 覆盖可执行文件路径，设置 `YTDLP_COOKIES_PATH=/opt/hotcopy/cookies.txt` 传入现有 Cookie 文件；配置了不可读取的 Cookie 路径会报错，不会悄悄改用无 Cookie 请求。命令使用 `execFile` 参数数组，不启动 shell，单次输出上限 2 MiB、超时 30 秒。只读取频道列表，不下载视频或运行 Whisper。

Worker 启动时运行一轮，之后每 30 分钟运行一轮；同一轮最多并发 2 个频道请求。视频按 `video_id` 去重。请求失败会保留已有视频、记录错误代码，并按 30 分钟至 24 小时退避。回退列表中的 `view_count` 会写入并更新 `latest_views`；频道页给出的播放量可能经过取整，前端用“约”标记。`--flat-playlist` 经常不提供发布时间，缺失时数据库存 `published_at=0`，界面显示“暂无”，不会伪称视频在 24 小时内发布。API 返回最后检查和最后成功时间，前端不会把失败当作“零播放”或生成演示视频。

**当前验证边界：** 2026-09-23 本机请求多个真实频道的 RSS 返回 HTTP 404；新加坡 VPS 上亦有 500/404。改用 VPS 已安装的 `yt-dlp` 和现有 Cookie 文件后，对 Fireship 的真实 JSON 成功解析出 10 个视频、ID、标题、缩略图及播放量。RSS 本身仍不稳定，但回退路径已通过实机数据核对。尚未将这版 Worker 部署或注册为生产进程；上线后仍需检查进程日志、API 同步状态及 20 个频道的实际成功率。

本阶段只发现和展示频道视频，并记录可取得的最近播放量。播放量时间序列快照、时速评分、黑马判定与用户订阅分发尚未启用；未采到播放量时 API 返回 `null`。目前也未修改生产 PM2 或 Nginx 配置。
