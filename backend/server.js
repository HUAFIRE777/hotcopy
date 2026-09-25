const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const { YoutubeTranscript } = require('youtube-transcript');
const { validTrend, readRadarTrends, TREND_MAX_AGE_MS } = require('./trends_live');
const { extractYouTubeId, getYouTubeTranscript } = require('./youtube_transcript');
const { modelCatalog, selectedRewriteModel } = require('./core/model_catalog');
const { createJobQueue } = require('./core/job_queue');
const { createJobWorker } = require('./core/job_worker');
const { SUPPORTED_MODES, parseSource, cacheMode, parseDuration, youtubeDuration, ffprobeLocalDuration } = require('./core/media_info');
const { downloadSafeAudio } = require('./core/safe_audio');
const { generateText, generateScript } = require('./core/llm');
const { PLATFORMS, FORMATS, selectedPoints } = require('./core/points');
const { recordWhisper, recordFileBytes, recordSourceBytes } = require('./core/usage_context');
const { runWithCookieFailover, getCookieStatus, probeSlot, updateCookieSlot, startCookieMonitoring } = require('./youtube_cookie_pool');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[Auth] JWT_SECRET 未配置；重启后需重新登录');
const db = new Database('database.sqlite');

// 初始化数据库表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password_hash TEXT,
    plan TEXT DEFAULT 'free',        -- 'free', 'basic', 'pro', 'premium'
    monthly_limit INTEGER DEFAULT 3, -- free: 3, basic: 50, pro: 100, premium: 300
    used_count INTEGER DEFAULT 0,
    expires_at INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS trends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT,                   -- 'youtube' 或 'tiktok'
    category TEXT,                   -- 'tech', 'business', 'life'
    video_id TEXT UNIQUE,
    title TEXT,
    title_cn TEXT,
    cover_url TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS copies_cache (
    video_id TEXT,
    mode TEXT,                       -- 'translate' 或 'rewrite'
    content TEXT,
    created_at INTEGER,
    PRIMARY KEY (video_id, mode)
  );

  CREATE TABLE IF NOT EXISTS dataset_sft (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_platform TEXT,
    source_id TEXT,
    instruction TEXT,
    cleaned_input TEXT,
    target_output TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin_auth (
    id INTEGER PRIMARY KEY,
    username TEXT DEFAULT 'huafire',
    password_hash TEXT,
    updated_at INTEGER
  );
`);
db.exec(`CREATE TABLE IF NOT EXISTS media_meta (
  video_id TEXT PRIMARY KEY, platform TEXT NOT NULL, duration_sec INTEGER NOT NULL,
  title TEXT, updated_at INTEGER NOT NULL
);`);
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('billing_scheme')) db.exec("ALTER TABLE users ADD COLUMN billing_scheme TEXT NOT NULL DEFAULT 'legacy'");
function boundedWorkerSetting(name, fallback, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;
}
const jobQueue = createJobQueue(db, {
  maxRunning: boundedWorkerSetting('HOTCOPY_MAX_RUNNING', 2, 16)
});

// 初始化默认管理员 (如果尚未存在)
try {
  const existingAdmin = db.prepare('SELECT * FROM admin_auth WHERE id = 1').get();
  if (!existingAdmin && process.env.ADMIN_KEY) {
    const defaultUser = 'huafire';
    const hash = bcrypt.hashSync(process.env.ADMIN_KEY, 10);
    db.prepare(`
      INSERT INTO admin_auth (id, username, password_hash, updated_at)
      VALUES (1, ?, ?, ?)
    `).run(defaultUser, hash, Date.now());
    console.log(`[Admin] 初始化管理员成功: 用户名=${defaultUser}`);
  } else if (!existingAdmin) {
    console.warn('[Admin] ADMIN_KEY 未配置；管理员账号未初始化');
  } else if (bcrypt.compareSync('hotcopy_super_admin_pass_8888', existingAdmin.password_hash)) {
    if (process.env.ADMIN_KEY) {
      db.prepare('UPDATE admin_auth SET password_hash=?,updated_at=? WHERE id=1')
        .run(bcrypt.hashSync(process.env.ADMIN_KEY, 10), Date.now());
      console.warn('[Admin] 旧版公开初始密码已替换为 ADMIN_KEY');
    } else {
      console.warn('[Admin] 旧版公开初始密码已禁用；配置 ADMIN_KEY 后重启以轮换');
    }
  }
} catch (e) {
  console.error('[Admin] 初始化管理员表失败:', e.message);
}

app.use(express.json({
  limit: '300kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cors({ origin: '*' }));

// 中间件：JWT 鉴权
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '请先登录' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: '登录凭证已失效，请重新登录' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    req.user = user;
    next();
  });
}

// 中间件：管理员鉴权 (支持 JWT Token 与直接 Admin-Key 双通道鉴权)
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || 
                (req.headers['authorization'] && req.headers['authorization'].replace(/^Bearer\s+/i, ''));
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.role === 'admin') {
        req.adminUser = decoded.username || 'huafire';
        return next();
      }
    } catch (e) {
      // 凭据无效则尝试降级检查 key
    }
  }

  const secret = req.headers['x-admin-key'];
  if (process.env.ADMIN_KEY && secret === process.env.ADMIN_KEY) {
    req.adminUser = 'huafire';
    return next();
  }

  return res.status(403).json({ error: '无权访问管理员后台，请登录或提供有效凭证' });
}

// 凭证维护只接受管理员登录签发的 JWT；旧版 Admin-Key 不可用于上传会话文件。
function requireAdminSession(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (typeof token !== 'string') return res.status(403).json({ error: '请先登录管理员后台' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded?.role === 'admin') return next();
  } catch {}
  return res.status(403).json({ error: '管理员登录已失效，请重新登录' });
}

function cleanRawTranscript(text) {
  return text
    .replace(/\b(uh|um|you know|like|so yeah|i mean)\b/gi, '')
    .replace(/subscribe to (the|my) channel/gi, '')
    .replace(/hit the (bell|like) button/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------- 认证模块 ----------------
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '参数不完整' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const billingScheme = process.env.HOTCOPY_ENABLE_UNIT_BILLING === '1' ? 'units' : 'legacy';
    const stmt = db.prepare(`
      INSERT INTO users (email, password_hash, plan, monthly_limit, used_count, expires_at, created_at, billing_scheme)
      VALUES (?, ?, 'free', 3, 0, ?, ?, ?)
    `);
    const info = stmt.run(email, hash, Date.now() + 30 * 86400000, Date.now(), billingScheme);
    const token = jwt.sign({ id: info.lastInsertRowid }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, plan: 'free', used_count: 0, monthly_limit: 3, billing_scheme: billingScheme });
  } catch (err) {
    res.status(400).json({ error: '该邮箱已被注册' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(400).json({ error: '用户不存在' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(400).json({ error: '密码错误' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    email: user.email,
    plan: user.plan,
    used_count: user.used_count,
    monthly_limit: user.monthly_limit,
    billing_scheme: user.billing_scheme,
    expires_at: user.expires_at
  });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({
    email: req.user.email,
    plan: req.user.plan,
    used_count: req.user.used_count,
    monthly_limit: req.user.monthly_limit,
    billing_scheme: req.user.billing_scheme,
    expires_at: req.user.expires_at
  });
});

app.post('/api/auth/activate', authenticate, (req, res) => {
  const { code } = req.body;
  const clean = (code || '').trim().toUpperCase();
  if (clean.startsWith('EZPRO-') || clean.length >= 8) {
    db.prepare(`
      UPDATE users 
      SET plan = 'pro', monthly_limit = 100, expires_at = ?
      WHERE id = ?
    `).run(Date.now() + 365 * 86400000, req.user.id);
    return res.json({ success: true, plan: 'pro', message: '卡密激活成功！已升级为 Pro 会员（100次/月）' });
  }
  res.status(400).json({ error: '无效卡密，请检查输入或在上方购买' });
});

const trendColumns = new Set(db.prepare('PRAGMA table_info(trends)').all().map(column => column.name));
if (!trendColumns.has('duration')) db.exec('ALTER TABLE trends ADD COLUMN duration TEXT');
if (!trendColumns.has('intro')) db.exec('ALTER TABLE trends ADD COLUMN intro TEXT');
if (!trendColumns.has('hot_badge')) db.exec('ALTER TABLE trends ADD COLUMN hot_badge TEXT');
if (!trendColumns.has('source')) db.exec('ALTER TABLE trends ADD COLUMN source TEXT');
if (!trendColumns.has('views_count')) db.exec('ALTER TABLE trends ADD COLUMN views_count INTEGER');
if (!trendColumns.has('views_updated_at')) db.exec('ALTER TABLE trends ADD COLUMN views_updated_at INTEGER');
db.exec(`
  CREATE TABLE IF NOT EXISTS trend_sync (
    platform TEXT PRIMARY KEY,
    attempted_at INTEGER,
    succeeded_at INTEGER,
    status TEXT NOT NULL
  );
`);

// ---------------- 每两小时同步可核验的平台榜单 ----------------
const TREND_INTERVAL_MS = 2 * 60 * 60 * 1000;
const trendInsert = db.prepare(`
  INSERT INTO trends (platform, category, video_id, title, title_cn, cover_url, updated_at, duration, intro, hot_badge, source, views_count, views_updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function trendCategory(name = '') {
  if (/科技|数码|科学|计算机|AI|知识/.test(name)) return 'tech';
  if (/财经|商业|职场/.test(name)) return 'business';
  if (/生活|美食|运动|旅行|手工/.test(name)) return 'lifestyle';
  return 'growth';
}

async function fetchBilibiliTrends() {
  const { data } = await axios.get('https://api.bilibili.com/x/web-interface/ranking/v2', {
    params: { rid: 36, type: 'all' }, timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (data?.code !== 0 || !Array.isArray(data.data?.list)) throw new Error('B站榜单不可用');
  return data.data.list.filter(item => /^BV[a-zA-Z0-9]{10}$/.test(item.bvid || '') && item.title)
    .slice(0, 24).map(item => ({
      platform: 'bilibili', category: trendCategory(item.tname), video_id: item.bvid,
      title: item.title, cover_url: (item.pic || '').replace(/^http:/, 'https:'),
      duration: Number.isSafeInteger(item.duration) && item.duration > 0 ? item.duration : null,
      views_count: Number.isSafeInteger(item.stat?.view) && item.stat.view >= 0 ? item.stat.view : null,
      intro: item.tname || '', source: 'bilibili-knowledge-ranking'
    }));
}

async function fetchAppleTrends() {
  const { data } = await axios.get('https://rss.applemarketingtools.com/api/v2/us/podcasts/top/10/podcasts.json', { timeout: 12000 });
  const shows = data?.feed?.results;
  if (!Array.isArray(shows) || !shows.length) throw new Error('Apple 播客榜单不可用');
  const episodes = await Promise.allSettled(shows.slice(0, 8).map(async show => {
    if (!/^\d+$/.test(show.id || '')) return null;
    const result = await axios.get('https://itunes.apple.com/lookup', {
      params: { id: show.id, entity: 'podcastEpisode', limit: 1 }, timeout: 12000
    });
    const episode = result.data?.results?.find(item => item.wrapperType === 'podcastEpisode');
    const episodeId = episode?.trackViewUrl?.match(/[?&]i=(\d+)/)?.[1];
    if (!episodeId || !episode.trackName || Number(episode.collectionId) !== Number(show.id) ||
        !/^https:\/\/podcasts\.apple\.com\//.test(episode.trackViewUrl || '') ||
        !/^https:\/\//.test(episode.episodeUrl || '')) return null;
    try {
      const probe = await axios.get(episode.episodeUrl, {
        responseType: 'stream', timeout: 8000, maxRedirects: 3,
        headers: { Range: 'bytes=0-0' }
      });
      const contentType = probe.headers['content-type'] || '';
      probe.data.destroy();
      if (!/(audio|octet-stream)/i.test(contentType)) return null;
    } catch { return null; }
    return {
      platform: 'podcast', category: 'podcast', video_id: `${show.id}?i=${episodeId}`,
      title: episode.trackName, cover_url: episode.artworkUrl600 || show.artworkUrl100,
      duration: Number.isSafeInteger(episode.trackTimeMillis) && episode.trackTimeMillis > 0
        ? Math.round(episode.trackTimeMillis / 1000) : null,
      intro: show.name, source: 'apple-podcast-chart'
    };
  }));
  return episodes.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
}

async function fetchYouTubeTrends() {
  return readRadarTrends();
}

async function updateTrendsJob() {
  const sources = [
    ['bilibili', fetchBilibiliTrends],
    ['podcast', fetchAppleTrends],
    ['youtube', fetchYouTubeTrends]
  ];
  await Promise.all(sources.map(async ([platform, fetcher]) => {
    const attemptedAt = Date.now();
    try {
      const items = await fetcher();
      const validItems = items.filter(validTrend);
      if (!validItems.length) throw new Error('榜单未返回可核验条目');
      const syncedAt = Date.now();
      db.transaction(() => {
        db.prepare('DELETE FROM trends WHERE platform = ?').run(platform);
        for (const item of validItems) {
          trendInsert.run(item.platform, item.category, item.video_id, item.title, null,
            item.cover_url, syncedAt, item.duration || '', item.intro, '', item.source,
            item.views_count ?? null, item.views_count != null ? item.views_updated_at || syncedAt : null);
        }
        db.prepare(`INSERT INTO trend_sync (platform, attempted_at, succeeded_at, status)
          VALUES (?, ?, ?, 'ok') ON CONFLICT(platform) DO UPDATE SET
          attempted_at = excluded.attempted_at, succeeded_at = excluded.succeeded_at, status = 'ok'`)
          .run(platform, attemptedAt, syncedAt);
      })();
    } catch (error) {
      db.prepare(`INSERT INTO trend_sync (platform, attempted_at, succeeded_at, status)
        VALUES (?, ?, NULL, 'error') ON CONFLICT(platform) DO UPDATE SET
        attempted_at = excluded.attempted_at, status = 'error'`).run(platform, attemptedAt);
      console.warn(`[Trends] ${platform} 同步失败: ${error.message}`);
    }
  }));
}
cron.schedule('0 */2 * * *', updateTrendsJob);

// 只刷新已收录视频的播放量；单次 B 站榜单请求和本地雷达读取，不启动浏览器。
async function updateTrendViewsJob() {
  const update = db.prepare(`UPDATE trends SET views_count = ?, views_updated_at = ?
    WHERE platform = ? AND video_id = ? AND source = ?
      AND (views_count IS NULL OR views_count <> ?)`);
  try {
    const items = await fetchBilibiliTrends();
    const checkedAt = Date.now();
    db.transaction(() => {
      for (const item of items) {
        if (item.views_count != null) update.run(item.views_count, checkedAt,
          'bilibili', item.video_id, item.source, item.views_count);
      }
    })();
  } catch (error) {
    console.warn(`[Trends] B站播放量暂未更新: ${error.response?.status || error.code || 'SOURCE_ERROR'}`);
  }
  try {
    const items = readRadarTrends();
    db.transaction(() => {
      for (const item of items) {
        if (item.views_count != null) update.run(item.views_count,
          item.views_updated_at || Date.now(), 'youtube', item.video_id,
          item.source, item.views_count);
      }
    })();
  } catch (error) {
    console.warn(`[Trends] YouTube 播放量暂未更新: ${error.code || 'SOURCE_ERROR'}`);
  }
}
cron.schedule('*/15 * * * *', updateTrendViewsJob);

app.get('/api/trends', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  const category = req.query.category || 'all';
  const platform = req.query.platform || 'all';
  let query = 'SELECT * FROM trends WHERE source IS NOT NULL AND updated_at >= ?';
  const params = [Date.now() - TREND_MAX_AGE_MS];
  if (category !== 'all') {
    query += ' AND category = ?';
    params.push(category);
  }
  if (platform !== 'all') {
    query += ' AND platform = ?';
    params.push(platform);
  }
  query += ' ORDER BY updated_at DESC, id ASC LIMIT 100';
  const list = db.prepare(query).all(...params).filter(validTrend);
  res.json(list);
});

app.get('/api/trends/status', (req, res) => {
  const sources = db.prepare('SELECT platform, attempted_at, succeeded_at, status FROM trend_sync').all();
  res.json({ interval_ms: TREND_INTERVAL_MS, sources });
});


// ---------------- 音频转录底层与 Groq Whisper 重试机制 ----------------
const { execFile } = require('child_process');

function getGroqApiKeys() {
  const keysStr = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
  return keysStr.split(',').map(k => k.trim()).filter(Boolean);
}

async function sendFileToWhisper(filePath, maxRetries = 1) {
  const keys = getGroqApiKeys();
  const models = ['whisper-large-v3-turbo', 'whisper-large-v3'];
  let lastErr = null;
  let audioSec = null;
  try {
    const { stdout } = await new Promise((resolve, reject) => execFile('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 10000 }, (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr })));
    const parsed = Number(String(stdout).trim());
    if (Number.isFinite(parsed) && parsed > 0) audioSec = parsed;
  } catch {}

  for (const apiKey of keys) {
    for (const model of models) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const form = new FormData();
          form.append('file', fs.createReadStream(filePath));
          form.append('model', model);
          const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
            headers: {
              ...form.getHeaders(),
              'Authorization': 'Bearer ' + apiKey
            },
            timeout: 120000
          });
          if (!res.data?.text?.trim()) throw new Error('听写服务未返回有效对白');
          recordWhisper(model, audioSec);
          return res.data.text;
        } catch (err) {
          lastErr = err;
          const errMsg = err.response?.data?.error?.message || err.message;
          console.warn(`[Groq Whisper - ${model}] Key(..${apiKey.slice(-6)}) 第 ${attempt + 1} 次尝试失败: ${errMsg}`);
          if (errMsg.includes('Rate limit reached')) {
            break; // 触发配额上限，立即轮换下一个模型或下一个 Key
          }
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
      }
    }
  }

  // 备用兜底：如果配置了 OPENAI_API_KEY，且所有 Groq Key 都达到上限，降级到 OpenAI Whisper 官方接口
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log('[Audio Engine] Groq 额度耗尽，启用 OpenAI Whisper 官方通道兜底...');
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      form.append('model', 'whisper-1');
      const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
        },
        timeout: 120000
      });
      if (!res.data?.text?.trim()) throw new Error('听写服务未返回有效对白');
      recordWhisper('openai/whisper-1', audioSec);
      return res.data.text;
    } catch (oaErr) {
      console.error('[OpenAI Whisper 兜底失败]:', oaErr.message);
    }
  }

  const rawMsg = lastErr?.response?.data?.error?.message || lastErr?.message || '';
  if (rawMsg.includes('Rate limit reached') || rawMsg.includes('seconds of audio per hour')) {
    throw new Error('当前免费听写通道负载饱和（每小时转录时长已满，将在几分钟后自动恢复）。如需持续听写超长播客，可在后台配置多个 Groq 密钥或开通按量付费。');
  }
  throw new Error('语音转录失败: ' + rawMsg);
}

// ---------------- 工业级长音频处理管道 (自动轻量化压缩 + 超长分片保障) ----------------
async function transcribeLongAudio(audioSourceUrl, identifier, customHeaders = {}) {
  const tmpId = crypto.randomUUID();
  const compressedPath = `/tmp/hc_${tmpId}.mp3`;
  const chunkPrefix = `/tmp/hc_${tmpId}_chk`;

  const headerArgs = [];
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    const headerStr = Object.entries(customHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    headerArgs.push('-headers', headerStr);
  }

  console.log(`[Audio Engine] 正在下载并轻量化压缩音频: ${identifier}...`);
  // 16kHz mono 32kbps：约 14.4MB / 小时
  const args = ['-y', ...headerArgs, '-i', audioSourceUrl, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', compressedPath];

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('音频提取/压缩失败: ' + (stderr || err.message).slice(-200)));
      resolve();
    });
  });

  if (!fs.existsSync(compressedPath)) {
    throw new Error('音频文件未成功生成');
  }

  const stat = fs.statSync(compressedPath);
  console.log(`[Audio Engine] 音频压缩完成，文件大小: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

  let fullTranscript = '';

  try {
    // 若压缩后 <= 24MB（约 100 分钟），直接单次转录
    if (stat.size <= 24 * 1024 * 1024) {
      console.log(`[Audio Engine] 文件 <= 24MB，单次上传 Groq Whisper 听写...`);
      fullTranscript = await sendFileToWhisper(compressedPath);
    } else {
      // 超长音频 (> 24MB，约 1.5~3小时+)，启动 40 分钟无损时间切片
      console.log(`[Audio Engine] 音频超过 24MB，启用 40 分钟时间切片容灾分段...`);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-y', '-i', compressedPath, '-f', 'segment', '-segment_time', '2400',
          '-c', 'copy', `${chunkPrefix}_%03d.mp3`], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error('长音频切片失败: ' + (stderr || err.message)));
          resolve();
        });
      });

      const tmpDirFiles = fs.readdirSync('/tmp');
      const chunkFiles = tmpDirFiles
        .filter(f => f.startsWith(`hc_${tmpId}_chk_`) && f.endsWith('.mp3'))
        .sort()
        .map(f => `/tmp/${f}`);

      console.log(`[Audio Engine] 成功生成 ${chunkFiles.length} 个分段，开始分批听写...`);

      for (let i = 0; i < chunkFiles.length; i++) {
        const cPath = chunkFiles[i];
        console.log(`[Audio Engine] 正在听写分段 ${i + 1}/${chunkFiles.length}...`);
        const chunkText = await sendFileToWhisper(cPath);
        if (chunkText) {
          fullTranscript += (fullTranscript ? ' ' : '') + chunkText.trim();
        }
        try { fs.unlinkSync(cPath); } catch (e) {}
      }
    }
  } finally {
    try { if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath); } catch (e) {}
    for (const name of fs.readdirSync('/tmp').filter(file => file.startsWith(`hc_${tmpId}_chk_`))) {
      try { fs.unlinkSync(path.join('/tmp', name)); } catch {}
    }
  }

  return fullTranscript;
}

// ---------------- YouTube 音频流提取与 Groq Whisper 听译 (支持超长视频分片) ----------------
function fetchYouTubeWhisperTranscript(videoId) {
  return new Promise((resolve, reject) => {
    const audioPath = `/tmp/yt_${videoId}_${Date.now()}.mp3`;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[Groq Whisper] 正在为 YouTube 视频 ${videoId} 提取音频流并进行轻量化压缩...`);
    runWithCookieFailover((cookiesPath, _slot, proxyUrl) => new Promise((downloadResolve, downloadReject) => {
      try { fs.unlinkSync(audioPath); } catch {}
      const args = [];
      if (proxyUrl) args.push('--proxy', proxyUrl);
      if (cookiesPath) args.push('--cookies', cookiesPath);
      args.push('-f', 'ba[ext=m4a]/ba', '--extract-audio', '--audio-format', 'mp3',
        '--postprocessor-args', '-ar 16000 -ac 1 -b:a 32k', '-o', audioPath, videoUrl);
      execFile(process.env.YTDLP_BIN || 'yt-dlp', args,
        { timeout: 300000, maxBuffer: 2 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
          if (err) {
            err.stderr = stderr;
            return downloadReject(err);
          }
          downloadResolve();
        });
    })).then(async () => {
      try {
        if (!fs.existsSync(audioPath)) {
          return reject(new Error('音频下载完成但未生成有效文件'));
        }

        const stat = fs.statSync(audioPath);
        recordFileBytes(stat.size);
        console.log(`[YouTube Whisper] 音频下载完成，文件大小: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

        let transcript = '';
        if (stat.size <= 24 * 1024 * 1024) {
          transcript = await sendFileToWhisper(audioPath);
        } else {
          // 超长 YouTube 视频分片
          const chunkPrefix = `/tmp/yt_chk_${videoId}_${Date.now()}`;
          await new Promise((resChunk, rejChunk) => {
            execFile('ffmpeg', ['-y', '-i', audioPath, '-f', 'segment', '-segment_time', '2400',
              '-c', 'copy', `${chunkPrefix}_%03d.mp3`], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (chunkErr) => {
              if (chunkErr) return rejChunk(chunkErr);
              resChunk();
            });
          });

          const tmpDirFiles = fs.readdirSync('/tmp');
          const chunkFiles = tmpDirFiles
            .filter(f => f.startsWith(path.basename(chunkPrefix)) && f.endsWith('.mp3'))
            .sort()
            .map(f => `/tmp/${f}`);

          for (const cPath of chunkFiles) {
            const chunkText = await sendFileToWhisper(cPath);
            if (chunkText) transcript += (transcript ? ' ' : '') + chunkText.trim();
            try { fs.unlinkSync(cPath); } catch (e) {}
          }
        }

        fs.unlink(audioPath, () => {});
        console.log(`[Groq Whisper] YouTube 听译完成，提取到 ${transcript.length} 字符`);
        resolve(transcript);
      } catch (whisperErr) {
        fs.unlink(audioPath, () => {});
        reject(new Error('Groq Whisper 语音转录失败: ' + (whisperErr.response?.data?.error?.message || whisperErr.message)));
      }
    }).catch(error => {
      try { fs.unlinkSync(audioPath); } catch {}
      const detail = String(error.stderr || error.message || '');
      if (/This video is unavailable|Video unavailable|private video/i.test(detail)) {
        return reject(new Error('该视频在 YouTube 上不存在、已被作者删除或设为私密视频，请检查视频链接是否正确！'));
      }
      if (/Sign in to confirm your age/i.test(detail)) {
        return reject(new Error('该视频受 YouTube 年龄限制保护，无法公开提取音频！'));
      }
      reject(new Error('暂时无法提取该视频音频流，请稍后重试'));
    });
  });
}

// ---------------- 播客与通用音频解析引擎 (Apple Podcasts / 小宇宙 / 通用直链) ----------------
async function fetchPodcastAudio(inputUrl) {
  const cleanUrl = (inputUrl || '').trim();

  // 1. 通用音频直链 (.mp3, .m4a, .wav, .aac, .ogg)
  if (/\.(mp3|m4a|wav|aac|ogg)(\?.*)?$/i.test(cleanUrl)) {
    return {
      audioUrl: cleanUrl,
      title: '通用音频文件',
      id: 'audio_' + crypto.createHash('md5').update(cleanUrl).digest('hex').slice(0, 12)
    };
  }

  // 2. 小宇宙播客 (xiaoyuzhoufm.com)
  if (cleanUrl.includes('xiaoyuzhoufm.com')) {
    const epMatch = cleanUrl.match(/episode\/([a-zA-Z0-9]+)/);
    const epId = epMatch ? epMatch[1] : ('xyz_' + Date.now());
    console.log(`[小宇宙播客] 正在解析单集页面: ${epId}`);

    let html = '';
    try {
      const res = await axios.get(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          'Referer': 'https://www.xiaoyuzhoufm.com'
        },
        timeout: 15000
      });
      html = res.data;
    } catch (err) {
      if (err.response?.status === 404) {
        throw new Error('该小宇宙单集不存在或已被下架删除 (404)');
      }
      throw err;
    }
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(/ - [^|]+ \| 小宇宙.*$/, '') : '小宇宙播客单集';

    // 匹配 media.xyzcdn.net 音频直链或 enclosure
    const audioMatch = html.match(/https:\/\/media\.xyzcdn\.net\/[^"'\s<>]+\.(?:m4a|mp3)/) ||
                       html.match(/<meta property="og:audio" content="([^"]+)"/) ||
                       html.match(/"enclosure":\s*\{\s*"url":\s*"([^"]+)"/);

    if (!audioMatch) {
      throw new Error('未能从小宇宙单集网页中解析到有效音频直链，请确认该节目是否已公开发布');
    }
    const audioUrl = audioMatch[1] || audioMatch[0];
    console.log(`[小宇宙播客] 解析到音频直链: ${audioUrl.slice(0, 80)}...`);
    return {
      audioUrl,
      title,
      id: 'xyz_' + epId
    };
  }

  // 3. Apple Podcasts (苹果播客)
  if (cleanUrl.includes('podcasts.apple.com')) {
    const epMatch = cleanUrl.match(/[?&]i=(\d+)/);
    const podMatch = cleanUrl.match(/\/id(\d+)/);
    const epId = epMatch ? epMatch[1] : (podMatch ? podMatch[1] : 'apple_' + Date.now());
    console.log(`[Apple Podcasts] 正在解析苹果播客单集: ${epId}`);

    // 通道一：直接抓取网页提取音频直链
    try {
      const res = await axios.get(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 15000
      });
      const html = res.data;
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].replace(/ on Apple Podcasts.*$/, '') : 'Apple 播客单集';

      const audioMatch = html.match(/https:\/\/[^"'\s<>]+\.(?:mp3|m4a)[^"'\s<>]*/i);
      if (audioMatch) {
        const audioUrl = audioMatch[0].replace(/\\/g, '');
        console.log(`[Apple Podcasts] 网页直出音频直链: ${audioUrl.slice(0, 80)}...`);
        return {
          audioUrl,
          title,
          id: 'apple_' + epId
        };
      }
    } catch (pageErr) {
      console.warn('[Apple Podcasts] 网页直取失败，切换到 iTunes Lookup API 备选通道:', pageErr.message);
    }

    // 通道二：iTunes Lookup API 备用
    if (podMatch) {
      try {
        const itunesRes = await axios.get(`https://itunes.apple.com/lookup?id=${podMatch[1]}&entity=podcastEpisode&limit=60`, { timeout: 15000 });
        const results = itunesRes.data?.results || [];
        let ep = null;
        if (epMatch) {
          ep = results.find(r => String(r.trackId) === epMatch[1]);
        }
        if (!ep && results.length > 1) {
          ep = results[1];
        }
        if (ep && ep.episodeUrl) {
          console.log(`[Apple Podcasts] iTunes API 提取音频直链成功: ${ep.episodeUrl.slice(0, 80)}...`);
          return {
            audioUrl: ep.episodeUrl,
            title: ep.trackName || 'Apple 播客',
            id: 'apple_' + epId
          };
        }
      } catch (itunesErr) {
        console.warn('[Apple Podcasts] iTunes Lookup 失败:', itunesErr.message);
      }
    }

    throw new Error('未能从 Apple Podcasts 解析到音频文件直链，请检查单集链接是否有效');
  }

  throw new Error('未识别的播客或音频链接类型');
}

// ---------------- Bilibili 知识视频解析引擎 (官方CC字幕优先 + 极速音频流保底) ----------------
async function fetchBilibiliTranscript(inputUrl) {
  let cleanUrl = (inputUrl || '').trim();
  const urlExtract = cleanUrl.match(/https?:\/\/[^\s]+/);
  if (urlExtract) cleanUrl = urlExtract[0];

  // 1. 如果是 b23.tv 短链接，先 302 重定向还原为真实 BV 链接
  if (cleanUrl.includes('b23.tv')) {
    try {
      const redir = await axios.get(cleanUrl, {
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        },
        timeout: 10000
      });
      if (redir.headers.location) {
        cleanUrl = redir.headers.location;
      }
    } catch (e) {
      console.warn('[Bilibili] b23.tv 短链接还原跳转:', e.message);
    }
  }

  // 2. 提取 BV 号
  const bvMatch = cleanUrl.match(/(BV[0-9a-zA-Z]{10})/i);
  if (!bvMatch) {
    throw new Error('未在链接中识别到有效的 B站 BV 号，请检查链接格式');
  }
  const bvid = bvMatch[1];
  console.log(`[Bilibili] 正在解析 B站 视频: ${bvid}`);

  // 3. 采用移动端页面请求（避开海外机房 412 WAF 挑战）
  const pageRes = await axios.get(`https://m.bilibili.com/video/${bvid}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Referer': 'https://m.bilibili.com'
    },
    timeout: 15000
  });

  const m = pageRes.data.match(/__INITIAL_STATE__\s*=\s*({.+?});/);
  if (!m) {
    throw new Error('B站移动端页面解析异常，未能获取视频状态');
  }

  const initState = JSON.parse(m[1]);
  if (initState.video?.error === -404 || initState.error === -404 || (!initState.video?.viewInfo?.title && !initState.video?.playUrlInfo)) {
    throw new Error('该 B站 视频不存在或已被作者下架删除 (404)');
  }
  const viewInfo = initState.video?.viewInfo || {};
  const title = viewInfo.title || 'Bilibili 视频';
  const cid = viewInfo.cid;

  // 4. 优先检查官方 CC 字幕 (0秒直出)
  let subtitles = viewInfo.subtitle?.list || [];

  if ((!subtitles || subtitles.length === 0) && cid) {
    try {
      const pRes = await axios.get(`https://api.bilibili.com/x/player/v2?cid=${cid}&bvid=${bvid}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          'Referer': 'https://m.bilibili.com'
        },
        timeout: 10000
      });
      if (pRes.data?.data?.subtitle?.subtitles) {
        subtitles = pRes.data.data.subtitle.subtitles;
      }
    } catch (e) {
      console.warn('[Bilibili] player/v2 字幕查询跳过:', e.message);
    }
  }

  if (subtitles && subtitles.length > 0) {
    const subItem = subtitles.find(s => (s.lan || '').startsWith('zh')) || subtitles[0];
    let subUrl = subItem.subtitle_url;
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
    console.log(`[Bilibili] 发现官方 CC 字幕 (${subItem.lan_doc || subItem.lan})，正在极速拉取...`);

    const subRes = await axios.get(subUrl, { timeout: 10000 });
    const body = subRes.data?.body || [];
    const transcriptText = body.map(b => b.content).filter(Boolean).join(' ');
    if (transcriptText.trim().length > 20) {
      console.log(`[Bilibili] 成功秒出 CC 字幕，共 ${transcriptText.length} 字符`);
      return {
        text: transcriptText,
        title,
        id: 'bili_' + bvid
      };
    }
  }

  // 5. 无字幕时，无缝切换到高清播放流提取 + Groq Whisper 听译保底
  console.log(`[Bilibili] 该视频未挂载官方字幕，启用高清音频流提取与 Whisper 听写保底...`);
  const playUrlInfo = initState.video?.playUrlInfo?.[0] || initState.video?.playUrlInfo || {};
  const streamUrl = playUrlInfo.url;

  if (!streamUrl) {
    throw new Error('未获取到该 B站 视频的播放音频流，可能为大会员专区或受版权地区限制');
  }

  const customHeaders = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Referer': 'https://www.bilibili.com'
  };

  const text = await transcribeLongAudio(streamUrl, 'bili_' + bvid, customHeaders);
  return {
    text,
    title,
    id: 'bili_' + bvid
  };
}

// ---------------- TikTok 音频提取与 Groq 转写 ----------------
async function fetchTikTokTranscript(url) {
  const parseRes = await axios.post('https://www.tikwm.com/api/', { url }, { timeout: 10000 });
  const audioUrl = parseRes.data?.data?.music || parseRes.data?.data?.play;
  if (!audioUrl) throw new Error('未能解析到 TikTok 音频流');

  const audioStream = await axios.get(audioUrl, { responseType: 'stream' });
  const formData = new FormData();
  formData.append('file', audioStream.data, { filename: 'audio.mp3' });
  formData.append('model', 'whisper-large-v3');

  const whisperRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
    headers: {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    timeout: 30000
  });

  recordWhisper('whisper-large-v3', null);
  return whisperRes.data.text;
}

// ---------------- 磁盘与缓存超限自愈保护机制 ----------------
function pruneExcessCache() {
  try {
    const now = Date.now();
    db.prepare(`DELETE FROM copies_cache WHERE
      (mode = 'raw' AND created_at < ?) OR (mode != 'raw' AND created_at < ?)`)
      .run(now - 60 * 86400000, now - 30 * 86400000);
  } catch (e) {}
}

// 只删除 HotCopy 自己创建、且已超过六小时的临时文件；运行中任务不能被清理。
setInterval(() => {
  pruneExcessCache();
  for (const name of fs.readdirSync('/tmp').filter(file => /^(?:yt_|yt_chk_|hc_)[A-Za-z0-9_-]+(?:\.mp3|_chk_\d+\.mp3)$/.test(file))) {
    try {
      const target = path.join('/tmp', name);
      const stat = fs.lstatSync(target);
      if (stat.isFile() && Date.now() - stat.mtimeMs > 6 * 3600000) fs.unlinkSync(target);
    } catch {}
  }
}, 1800000);

// ---------------- 持久化任务链 ----------------
async function inspectQueuedMedia(job) {
  const cached = db.prepare('SELECT duration_sec FROM media_meta WHERE video_id=?').get(job.video_id);
  if (cached?.duration_sec) return cached.duration_sec;
  const source = parseSource(job.source_url);
  let durationSec;
  if (source.platform === 'youtube') {
    durationSec = await youtubeDuration(source.videoId);
  } else if (source.platform === 'bilibili') {
    let bvid = source.url.match(/BV[A-Za-z0-9]{10}/)?.[0];
    if (!bvid && new URL(source.url).hostname === 'b23.tv') {
      const response = await axios.get(source.url, { maxRedirects: 0,
        validateStatus: status => status >= 300 && status < 400, timeout: 10000 });
      bvid = response.headers.location?.match(/BV[A-Za-z0-9]{10}/)?.[0];
    }
    if (!bvid) throw new Error('未识别到 B站视频编号');
    const response = await axios.get('https://api.bilibili.com/x/web-interface/view', {
      params: { bvid }, timeout: 12000 });
    durationSec = parseDuration(response.data?.data?.duration);
  } else if (source.platform === 'tiktok') {
    const response = await axios.post('https://www.tikwm.com/api/', { url: source.url }, { timeout: 12000 });
    durationSec = parseDuration(response.data?.data?.duration);
  } else if (source.platform === 'podcast') {
    const audio = await fetchPodcastAudio(source.url);
    const downloaded = await downloadSafeAudio(audio.audioUrl);
    try {
      recordSourceBytes(downloaded.bytes);
      durationSec = await ffprobeLocalDuration(downloaded.file);
    }
    finally { downloaded.cleanup(); }
  }
  db.prepare(`INSERT OR REPLACE INTO media_meta
    (video_id,platform,duration_sec,title,updated_at) VALUES (?,?,?,?,?)`)
    .run(job.video_id, source.platform, durationSec, '', Date.now());
  return durationSec;
}

async function processQueuedMedia(job, usage) {
  const source = parseSource(job.source_url);
  const options = JSON.parse(job.options_json || '{}');
  const pointsRow = job.mode === 'script' ? db.prepare("SELECT content FROM copies_cache WHERE video_id=? AND mode='points'")
    .get(job.video_id) : null;
  const storedPoints = pointsRow ? JSON.parse(pointsRow.content) : null;
  if (job.mode === 'script' && options.point_ids?.length && !storedPoints) {
    throw new Error('该来源尚未生成可选重点');
  }
  if (job.mode === 'script' && storedPoints) {
    const selected = options.point_ids?.length ? selectedPoints(storedPoints.points, options.point_ids) : storedPoints.points;
    const result = await generateScript('', { platform: options.platform, format: options.format,
      points: selected, model: job.model, calls: usage.llm_calls });
    usage.llm_calls = result.calls;
    usage.transcript_source = 'shared_points_cache';
    return { text: result.text };
  }
  const rawCached = db.prepare("SELECT content FROM copies_cache WHERE video_id=? AND mode='raw'")
    .get(job.video_id);
  let text = rawCached?.content;
  if (text) usage.transcript_source = 'shared_raw_cache';
  if (!text) {
    if (source.platform === 'youtube') {
      const transcript = await getYouTubeTranscript(source.videoId, {
        legacy: process.env.YTDLP_EGRESS_CONFIG ? undefined : async id => {
          const items = await YoutubeTranscript.fetchTranscript(id);
          return Array.isArray(items) ? items.map(item => item.text || '').join(' ') : '';
        },
        whisper: fetchYouTubeWhisperTranscript,
        onFallback: stage => console.warn(`[Job YouTube] ${stage} 回退`)
      });
      text = transcript.text;
      usage.transcript_source = transcript.source;
    } else if (source.platform === 'bilibili') {
      const result = await fetchBilibiliTranscript(source.url);
      text = result.text;
      usage.transcript_source = 'bilibili';
    } else if (source.platform === 'tiktok') {
      text = await fetchTikTokTranscript(source.url);
      usage.transcript_source = 'tiktok_whisper';
    } else if (source.platform === 'podcast') {
      const result = await fetchPodcastAudio(source.url);
      const downloaded = await downloadSafeAudio(result.audioUrl);
      try {
        recordSourceBytes(downloaded.bytes);
        text = await transcribeLongAudio(downloaded.file, job.video_id);
      } finally { downloaded.cleanup(); }
      usage.transcript_source = 'podcast_whisper';
    }
    if (!text?.trim()) throw new Error('未获取到有效原文');
    text = cleanRawTranscript(text);
    db.prepare(`INSERT OR IGNORE INTO copies_cache (video_id,mode,content,created_at)
      VALUES (?,'raw',?,?)`).run(job.video_id, text, Date.now());
  }
  if (job.mode === 'raw') return { text };
  if (job.mode === 'script') {
    const result = await generateScript(text, { platform: options.platform,
      format: options.format, model: job.model, calls: usage.llm_calls });
    usage.llm_calls = result.calls;
    db.prepare(`INSERT OR IGNORE INTO copies_cache (video_id,mode,content,created_at)
      VALUES (?,'points',?,?)`).run(job.video_id,
      JSON.stringify({ essence: result.points.essence, points: result.points.points }), Date.now());
    return { text: result.text };
  }
  const result = await generateText(text, job.mode, { model: job.model, calls: usage.llm_calls });
  usage.llm_calls = result.calls;
  return { text: result.text };
}

const jobWorker = createJobWorker(jobQueue, {
  localConcurrency: boundedWorkerSetting('HOTCOPY_LOCAL_CONCURRENCY', 1, 8),
  inspect: async job => {
    const duration = await inspectQueuedMedia(job);
    if (job.mode === 'translate' && duration > 1800) throw new Error('中文翻译仅支持 30 分钟以内的内容');
    return duration;
  },
  process: processQueuedMedia,
  cacheMode
});

function submitJob(req, res) {
  try {
    const mode = req.body?.mode || 'rewrite';
    if (!SUPPORTED_MODES.has(mode) && mode !== 'script') return res.status(400).json({ error: '不支持的处理模式' });
    if (req.body?.model !== undefined && !['rewrite', 'script'].includes(mode)) {
      return res.status(400).json({ error: '仅 AI改成支持选择模型' });
    }
    const model = selectedRewriteModel(req.body?.model);
    const options = mode === 'script' ? scriptOptions(req.body) : {};
    const source = parseSource(req.body?.url);
    const job = jobQueue.submit({ userId: req.user.id, sourceUrl: source.url,
      videoId: source.videoId, mode, model, options });
    res.status(202).json(job);
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
}

app.post('/api/jobs', authenticate, submitJob);
app.post('/api/script', authenticate, (req, res) => {
  req.body = { ...req.body, mode: 'script' };
  submitJob(req, res);
});

function scriptOptions(body) {
  const platform = body?.platform;
  const format = body?.format;
  if (!PLATFORMS[platform] || !FORMATS[format]) throw new Error('请选择支持的平台和成稿形式');
  const ids = body?.point_ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 ||
      !ids.every(id => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id)))) {
    throw new Error('重点选择无效');
  }
  return { platform, format, point_ids: ids ? [...new Set(ids)].sort() : [] };
}

app.get('/api/script/points', authenticate, (req, res) => {
  try {
    const source = parseSource(req.query.url);
    const unlocked = db.prepare('SELECT 1 FROM user_unlocks WHERE user_id=? AND video_id=? LIMIT 1')
      .get(req.user.id, source.videoId);
    if (!unlocked) return res.status(403).json({ error: '请先处理该来源' });
    const row = db.prepare("SELECT content FROM copies_cache WHERE video_id=? AND mode='points'")
      .get(source.videoId);
    if (!row) return res.status(404).json({ error: '该来源尚无重点' });
    res.json(JSON.parse(row.content));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/jobs/:id', authenticate, (req, res) => {
  const job = jobQueue.getForUser(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

app.post('/api/jobs/:id/confirm', authenticate, (req, res) => {
  const job = jobQueue.confirm(req.params.id, req.user.id);
  if (!job) return res.status(409).json({ error: '任务无需确认或已结束' });
  res.status(202).json(job);
});

app.post('/api/jobs/:id/cancel', authenticate, (req, res) => {
  if (!jobQueue.cancel(req.params.id, req.user.id)) {
    return res.status(409).json({ error: '任务已经开始或已结束，无法取消' });
  }
  res.json({ success: true });
});

app.get('/api/admin/jobs/usage', requireAdminSession, (req, res) => {
  res.json({ rows: jobQueue.recentUsage(Number(req.query.limit) || 100),
    note: 'provider_cost_estimate_usd 不含代理、VPS、支付和退款，不代表总成本或利润' });
});

app.get('/api/models', (_req, res) => res.json(modelCatalog()));

// 兼容旧客户端：同一持久化任务链，避免绕过按时长扣退和并发闸门。
app.post('/api/generate', authenticate, async (req, res) => {
  try {
    const mode = req.body?.mode || 'rewrite';
    if (!SUPPORTED_MODES.has(mode)) return res.status(400).json({ error: '不支持的处理模式' });
    if (req.body?.model !== undefined && mode !== 'rewrite') {
      return res.status(400).json({ error: '仅 AI改成支持选择模型' });
    }
    const model = selectedRewriteModel(req.body?.model);
    const source = parseSource(req.body?.url);
    let job = jobQueue.submit({ userId: req.user.id, sourceUrl: source.url,
      videoId: source.videoId, mode, model });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && !res.destroyed) {
      job = jobQueue.getForUser(job.id, req.user.id);
      if (job.status === 'needs_confirm') {
        if (req.body?.confirm) { jobQueue.confirm(job.id, req.user.id); }
        else return res.status(409).json({ needs_confirm: true, credits: job.credits,
          duration_minutes: Math.ceil(job.duration_sec / 60), job_id: job.id });
      } else if (job.status === 'succeeded') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Credits-Charged', String(job.credits));
        return res.send(job.result);
      } else if (job.status === 'failed') {
        return res.status(500).json({ error: job.error || '任务失败，次数已退回' });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!res.destroyed) res.status(202).json({ job_id: job.id, status: job.status });
  } catch (error) {
    if (!res.headersSent) res.status(error.status || 400).json({ error: error.message });
  }
});

// ---------------- Creem Webhook 自动发货 (支持官方 HMAC-SHA256 验签与防伪) ----------------
app.post('/api/webhook/creem', async (req, res) => {
  const signature = req.headers['creem-signature'] || req.headers['x-creem-signature'];
  const webhookSecret = process.env.CREEM_WEBHOOK_SECRET;

  // 1. 如果已配置 Webhook Secret，执行严格 HMAC-SHA256 签名比对
  if (webhookSecret && webhookSecret.trim() !== 'your_creem_webhook_signing_secret' && webhookSecret.trim().length > 0) {
    if (!signature) {
      console.warn('[Creem Webhook] 拒绝请求: 缺少 creem-signature 签名头');
      return res.status(401).json({ error: 'Missing signature' });
    }

    try {
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret.trim())
        .update(rawBody)
        .digest('hex');

      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expectedSignature, 'hex');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.warn('[Creem Webhook] 拒绝请求: 签名校验失败 (Invalid Signature)，疑似伪造回调！');
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }
      console.log('[Creem Webhook] 官方签名校验通过 (HMAC-SHA256 Verified) ✓');
    } catch (sigErr) {
      console.error('[Creem Webhook] 验签异常:', sigErr.message);
      return res.status(403).json({ error: 'Signature verification failed' });
    }
  }

  const event = req.body || {};
  console.log('[Creem Webhook] 收到事件:', event.type || event.event);

  // 2. 如果配置了 CREEM_API_KEY，且存在 checkout_id，向官方反查真实订单状态
  const checkoutId = event.data?.checkout_id || event.data?.id;
  if (process.env.CREEM_API_KEY && process.env.CREEM_API_KEY.trim() && checkoutId) {
    try {
      console.log(`[Creem Webhook] 正在向官方 API 反查订单 ${checkoutId}...`);
      const verifyRes = await axios.get(`https://api.creem.io/v1/checkouts/${checkoutId}`, {
        headers: {
          'x-api-key': process.env.CREEM_API_KEY.trim()
        },
        timeout: 10000
      });
      const orderStatus = verifyRes.data?.status || verifyRes.data?.order_status;
      if (orderStatus !== 'completed' && orderStatus !== 'paid') {
        console.warn(`[Creem Webhook] 官方反查状态为 ${orderStatus}，非已付款状态，拦截发货！`);
        return res.status(400).json({ error: 'Order not paid on Creem' });
      }
      console.log(`[Creem Webhook] 官方 API 订单反查真实有效 (${orderStatus}) ✓`);
    } catch (apiErr) {
      console.warn('[Creem Webhook] API 反查请求跳过或网络异常:', apiErr.message);
    }
  }

  if (event.type === 'checkout.completed' || event.type === 'subscription.created' || event.event === 'checkout.completed') {
    const email = event.data?.customer_email || event.data?.email || event.data?.customer?.email || event.customer_email;
    const prodId = event.data?.product_id || event.data?.product?.id || event.product_id || '';
    const name = (event.data?.product_name || event.data?.product?.name || event.product_name || '').toLowerCase();

    // 检查是否为一次性加油包 (Booster / Top-up)
    const isBooster = prodId === 'prod_6Kq15IgZgt8kBenKZt1lWC' || 
                      prodId === 'prod_1KNRjyt1zEpUhQR9RHsVkv' || 
                      prodId === 'prod_1J2GS2ql5fOOLmALoP0dw6' ||
                      name.includes('booster') || name.includes('top-up') || name.includes('credit');

    if (email) {
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

      if (isBooster) {
        let addCredits = 20;
        let boosterPlan = 'basic';
        if (prodId === 'prod_1J2GS2ql5fOOLmALoP0dw6' || name.includes('100')) {
          addCredits = 100;
          boosterPlan = 'pro';
        } else if (prodId === 'prod_1KNRjyt1zEpUhQR9RHsVkv' || name.includes('50')) {
          addCredits = 50;
          boosterPlan = 'basic';
        } else if (prodId === 'prod_6Kq15IgZgt8kBenKZt1lWC' || name.includes('20')) {
          addCredits = 20;
          boosterPlan = 'basic';
        }

        if (!user) {
          db.prepare(`
            INSERT INTO users (email, password_hash, plan, monthly_limit, used_count, expires_at, created_at)
            VALUES (?, '', ?, ?, 0, ?, ?)
          `).run(email, boosterPlan, addCredits, Date.now() + 365 * 86400000, Date.now());
        } else {
          const newLimit = (user.monthly_limit || 0) + addCredits;
          const newPlan = user.plan === 'free' ? boosterPlan : user.plan;
          const newExpire = Math.max(user.expires_at || 0, Date.now() + 365 * 86400000);
          db.prepare(`
            UPDATE users 
            SET plan = ?, monthly_limit = ?, expires_at = ?
            WHERE email = ?
          `).run(newPlan, newLimit, newExpire, email);
        }
        console.log(`[Creem Webhook] 成功为用户 ${email} 充值一次性加油包 +${addCredits} 次额度 (套餐: ${boosterPlan})`);
      } else {
        // 月度订阅方案
        let plan = 'basic';
        let limit = 50;
        if (prodId === 'prod_18Pj0OPprcNCwgLmr6nnE4' || name.includes('premium') || name.includes('studio')) {
          plan = 'premium';
          limit = 300;
        } else if (prodId === 'prod_5Uaj4zKtKXiSHY7vsR0HHR' || name.includes('pro')) {
          plan = 'pro';
          limit = 100;
        } else if (prodId === 'prod_6yBTQZmi3xEv0nLQ53Ka3e' || name.includes('basic')) {
          plan = 'basic';
          limit = 50;
        }

        if (!user) {
          db.prepare(`
            INSERT INTO users (email, password_hash, plan, monthly_limit, used_count, expires_at, created_at)
            VALUES (?, '', ?, ?, 0, ?, ?)
          `).run(email, plan, limit, Date.now() + 30 * 86400000, Date.now());
        } else {
          db.prepare(`
            UPDATE users 
            SET plan = ?, monthly_limit = ?, used_count = 0, expires_at = ?
            WHERE email = ?
          `).run(plan, limit, Date.now() + 30 * 86400000, email);
        }
        console.log(`[Creem Webhook] 成功为用户 ${email} 开通 ${plan} 套餐 (${limit}次/月)`);
      }
    }
  }
  res.json({ received: true });
});

// ---------------- 管理后台接口 ----------------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT count(*) as count FROM users').get().count;
  const basicCount = db.prepare("SELECT count(*) as count FROM users WHERE plan = 'basic'").get().count;
  const proCount = db.prepare("SELECT count(*) as count FROM users WHERE plan = 'pro'").get().count;
  const premiumCount = db.prepare("SELECT count(*) as count FROM users WHERE plan = 'premium'").get().count;
  const paidUsers = basicCount + proCount + premiumCount;
  const sftDataCount = db.prepare('SELECT count(*) as count FROM dataset_sft').get().count;
  
  // 总调用次数
  const totalUsedCount = db.prepare('SELECT COALESCE(SUM(used_count), 0) as total FROM users').get().total;
  const cachedCopiesCount = db.prepare('SELECT count(*) as count FROM copies_cache').get().count;
  
  // 今日调用
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const todayCopiesCount = db.prepare('SELECT count(*) as count FROM copies_cache WHERE created_at >= ?').get(startOfDay).count;
  
  // Whisper 语音转录与 LLM 调用
  const rawTranscripts = db.prepare("SELECT count(*) as count FROM copies_cache WHERE mode = 'raw'").get().count;
  const llmGenerations = db.prepare("SELECT count(*) as count FROM copies_cache WHERE mode != 'raw'").get().count;
  
  // 收入和利润必须来自支付流水与完整成本，当前未接入这两项。
  // 仅展示当前进程所在机器的系统指标。
  const memUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
  const memTotal = Math.round(os.totalmem() / 1024 / 1024);
  const loadAvg = os.loadavg().map(v => v.toFixed(2));
  
  const servers = [{
      name: '核心 API 所在服务器',
      cpu: `${loadAvg[0]} load`,
      memory: `${memUsed}MB / ${memTotal}MB`
    }];

  const users = db.prepare('SELECT id, email, plan, used_count, monthly_limit, expires_at, created_at FROM users ORDER BY id DESC LIMIT 100').all();
  
  res.json({
    totalUsers,
    paidUsers,
    sftDataCount,
    users,
    plans: { basic: basicCount, pro: proCount, premium: premiumCount },
    usage: {
      totalGenerations: totalUsedCount + cachedCopiesCount,
      todayGenerations: todayCopiesCount,
      whisperCalls: rawTranscripts,
      llmCalls: llmGenerations,
      estimatedTokens: (llmGenerations * 2500)
    },
    financials: { mrrUSD: null, dailyRevenueUSD: null, totalCostUSD: null,
      profitUSD: null, note: '支付收入与代理/VPS 全成本尚未核算' },
    servers
  });
});

app.get('/api/admin/export-dataset', requireAdmin, (req, res) => {
  const records = db.prepare('SELECT instruction, cleaned_input as input, target_output as output FROM dataset_sft ORDER BY id DESC').all();
  
  res.setHeader('Content-Type', 'application/jsonlines');
  res.setHeader('Content-Disposition', 'attachment; filename="hotcopy_sft_dataset.jsonl"');

  for (const r of records) {
    res.write(JSON.stringify(r) + '\n');
  }
  res.end();
});

app.post('/api/admin/upgrade', requireAdmin, (req, res) => {
  const { email, plan, days } = req.body;
  let limit = 50;
  if (plan === 'pro') limit = 100;
  if (plan === 'premium') limit = 300;

  db.prepare('UPDATE users SET plan = ?, monthly_limit = ?, expires_at = ? WHERE email = ?')
    .run(plan, limit, Date.now() + (days || 30) * 86400000, email);

  res.json({ success: true, message: `已更新 ${email} 的套餐为 ${plan}` });
});

app.get('/api/admin/cookies-status', requireAdminSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getCookieStatus());
});

app.post('/api/admin/cookies-probe', requireAdminSession, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await probeSlot(req.body?.slot));
  } catch {
    res.status(400).json({ error: '检测请求无效，请稍后重试' });
  }
});

app.post('/api/admin/cookies-update', requireAdminSession, async (req, res) => {
  try {
    const status = await updateCookieSlot(req.body?.slot || 'primary', req.body?.cookiesContent);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, message: '新凭证已通过公开视频探测并生效', ...status });
  } catch (error) {
    const badInput = /格式|位置/.test(error.message);
    res.status(badInput ? 400 : 422).json({
      error: badInput ? error.message : '新凭证未通过公开视频探测，原凭证已保留。请检查 Cookie、账号或服务器网络。'
    });
  }
});

// 管理员登录接口
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入管理员账号和安全密码' });
  }

  const admin = db.prepare('SELECT * FROM admin_auth WHERE id = 1').get();
  if (!admin) {
    return res.status(500).json({ error: '管理员配置异常，请联系系统维护者' });
  }
  if (bcrypt.compareSync('hotcopy_super_admin_pass_8888', admin.password_hash)) {
    return res.status(503).json({ error: '管理员旧版初始密码已禁用；请配置 ADMIN_KEY 并重启服务' });
  }

  // 账号名比对 (不区分大小写)
  if (username.trim().toLowerCase() !== admin.username.toLowerCase()) {
    return res.status(400).json({ error: '管理员账号名不存在或输入有误' });
  }

  // 密码比对
  const match = bcrypt.compareSync(password, admin.password_hash);
  if (!match) {
    // 兼容初始 key
    if (process.env.ADMIN_KEY && password === process.env.ADMIN_KEY) {
      const newHash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE admin_auth SET password_hash = ?, updated_at = ? WHERE id = 1').run(newHash, Date.now());
    } else {
      return res.status(400).json({ error: '管理员安全密码错误' });
    }
  }

  // 签发 7 天管理权限 Token
  const token = jwt.sign(
    { role: 'admin', username: admin.username },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`[Admin] 管理员【${admin.username}】安全登入成功`);
  res.json({
    success: true,
    token,
    username: admin.username,
    updatedAt: admin.updated_at
  });
});

// 获取管理员个人画像
app.get('/api/admin/profile', requireAdmin, (req, res) => {
  const admin = db.prepare('SELECT username, updated_at FROM admin_auth WHERE id = 1').get();
  res.json({
    username: admin ? admin.username : (req.adminUser || 'huafire'),
    updatedAt: admin ? admin.updated_at : Date.now()
  });
});

// 修改管理员账号与密码
app.post('/api/admin/change-credentials', requireAdmin, (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};

  if (!currentPassword) {
    return res.status(400).json({ error: '必须输入当前原密码以核实身份' });
  }

  const admin = db.prepare('SELECT * FROM admin_auth WHERE id = 1').get();
  if (!admin) {
    return res.status(500).json({ error: '管理员记录不存在' });
  }

  const valid = bcrypt.compareSync(currentPassword, admin.password_hash);
  if (!valid && (!process.env.ADMIN_KEY || currentPassword !== process.env.ADMIN_KEY)) {
    return res.status(400).json({ error: '当前原密码验证错误，无法修改' });
  }

  let finalUsername = admin.username;
  if (newUsername && newUsername.trim()) {
    const trimmed = newUsername.trim();
    if (trimmed.length < 2 || trimmed.length > 32) {
      return res.status(400).json({ error: '管理员名称长度需在 2 到 32 之间' });
    }
    finalUsername = trimmed;
  }

  let finalHash = admin.password_hash;
  if (newPassword && newPassword.trim()) {
    const trimmedPass = newPassword.trim();
    if (trimmedPass.length < 6) {
      return res.status(400).json({ error: '新密码长度至少需要 6 个字符' });
    }
    finalHash = bcrypt.hashSync(trimmedPass, 10);
  }

  db.prepare(`
    UPDATE admin_auth 
    SET username = ?, password_hash = ?, updated_at = ? 
    WHERE id = 1
  `).run(finalUsername, finalHash, Date.now());

  // 重新签发新 Token
  const newToken = jwt.sign(
    { role: 'admin', username: finalUsername },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`[Admin] 管理员修改了登录凭据: 用户名=${finalUsername}`);
  res.json({
    success: true,
    message: '管理员用户名与安全密码已成功更新！',
    token: newToken,
    username: finalUsername
  });
});

app.listen(PORT, () => {
  console.log(`HotCopy Core Backend running on port ${PORT}`);
  jobWorker.start();
  startCookieMonitoring();
  if (process.env.HOTCOPY_DISABLE_TREND_SYNC !== '1') updateTrendsJob();
});
