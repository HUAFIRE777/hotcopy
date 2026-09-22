const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');
const { YoutubeTranscript } = require('youtube-transcript');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
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
`);

app.use(express.json());
app.use(cors({ origin: '*' }));

// 中间件：JWT 鉴权
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '请先登录' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: '登录凭证已失效，请重新登录' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    req.user = user;
    next();
  });
}

// 中间件：管理员鉴权
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-key'];
  if (secret !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: '无权访问管理员后台' });
  }
  next();
}

function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
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
    const stmt = db.prepare(`
      INSERT INTO users (email, password_hash, plan, monthly_limit, used_count, expires_at, created_at)
      VALUES (?, ?, 'free', 3, 0, ?, ?)
    `);
    const info = stmt.run(email, hash, Date.now() + 30 * 86400000, Date.now());
    const token = jwt.sign({ id: info.lastInsertRowid }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, plan: 'free', used_count: 0, monthly_limit: 3 });
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

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    email: user.email,
    plan: user.plan,
    used_count: user.used_count,
    monthly_limit: user.monthly_limit,
    expires_at: user.expires_at
  });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({
    email: req.user.email,
    plan: req.user.plan,
    used_count: req.user.used_count,
    monthly_limit: req.user.monthly_limit,
    expires_at: req.user.expires_at
  });
});

// ---------------- 定时任务：2 小时同步全球热点 ----------------
async function updateTrendsJob() {
  const mockBatch = [
    { platform: 'youtube', category: 'tech', video_id: 'dQw4w9WgXcQ', title: 'OpenAI DevDay Highlights', title_cn: 'OpenAI 最新技术发布亮点' },
    { platform: 'youtube', category: 'business', video_id: 'aircAruvnKk', title: 'How I built a $10k MRR micro-saas', title_cn: '一个人如何靠 Micro-SaaS 做到月入万刀' },
    { platform: 'youtube', category: 'life', video_id: '3JZ_D3ELwOQ', title: 'The Science of Deep Sleep', title_cn: '顶尖神经科学家揭示深度睡眠法则' }
  ];

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trends (platform, category, video_id, title, title_cn, cover_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of mockBatch) {
    const cover = `https://img.youtube.com/vi/${item.video_id}/hqdefault.jpg`;
    stmt.run(item.platform, item.category, item.video_id, item.title, item.title_cn, cover, Date.now());
  }
}
cron.schedule('0 */2 * * *', updateTrendsJob);

app.get('/api/trends', (req, res) => {
  const category = req.query.category || 'tech';
  const list = db.prepare('SELECT * FROM trends WHERE category = ? ORDER BY updated_at DESC LIMIT 30').all(category);
  res.json(list);
});

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

  return whisperRes.data.text;
}

// ---------------- 核心生成与数据双写 ----------------
const PROMPT_REWRITE = `你是一位顶级自媒体爆款内容操盘手。请将提供的视频转录逐字稿，改写为符合中文互联网习惯的爆款文案：
1. 拟定 3 个抓人眼球的黄金前 3 秒爆款标题。
2. 提炼核心主干逻辑，分点阐述，消除机翻味，保留原作者真实意图。
3. 排版美观适度增加 Emoji，文末附带 3 个热门 Tag 标签。`;

const PROMPT_TRANSLATE = `你是一位专业翻译官。请将提供的音视频原文转录内容，翻译成自然流畅、准确严谨的中文，保留时间脉络与段落结构。`;

app.post('/api/generate', authenticate, async (req, res) => {
  const { url, mode = 'rewrite' } = req.body;
  const user = req.user;

  if (mode === 'rewrite' && user.plan === 'basic') {
    return res.status(403).json({ error: 'AI 爆款改写仅向 Pro/高级版开放，普通版仅支持双语精翻' });
  }

  if (user.used_count >= user.monthly_limit) {
    return res.status(429).json({ error: '本月生成额度已用尽，请升级会员方案' });
  }

  let text = '';
  let videoId = extractYouTubeId(url);
  const isTikTok = url.includes('tiktok.com');

  if (isTikTok) {
    videoId = 'tk_' + Buffer.from(url).toString('base64').slice(0, 16);
  }

  if (!videoId && !isTikTok) {
    return res.status(400).json({ error: '无效链接，仅支持 YouTube 或 TikTok' });
  }

  const cached = db.prepare('SELECT content FROM copies_cache WHERE video_id = ? AND mode = ?').get(videoId, mode);
  if (cached) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(cached.content);
  }

  try {
    if (isTikTok) {
      text = await fetchTikTokTranscript(url);
    } else {
      const items = await YoutubeTranscript.fetchTranscript(videoId);
      if (!items || items.length === 0) throw new Error('该视频未发现可用字幕轨');
      text = items.map(i => i.text).join(' ');
    }

    const cleanedInput = cleanRawTranscript(text.slice(0, 10000));
    const systemPrompt = mode === 'rewrite' ? PROMPT_REWRITE : PROMPT_TRANSLATE;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    const aiResp = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `原文本内容如下：\n\n${cleanedInput}` }
        ]
      })
    });

    const reader = aiResp.body.getReader();
    const decoder = new TextDecoder();
    let fullOutput = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.trim() !== '');

      for (const line of lines) {
        if (line.includes('[DONE]')) continue;
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const token = data.choices[0]?.delta?.content || '';
            fullOutput += token;
            res.write(token);
          } catch (e) {}
        }
      }
    }

    db.prepare('UPDATE users SET used_count = used_count + 1 WHERE id = ?').run(user.id);
    if (fullOutput) {
      db.prepare('INSERT OR REPLACE INTO copies_cache (video_id, mode, content, created_at) VALUES (?, ?, ?, ?)')
        .run(videoId, mode, fullOutput, Date.now());

      if (mode === 'rewrite' && cleanedInput.length > 200) {
        const defaultInstruction = "请根据以下海外视频转录内容，提炼核心事实并重构为地道、引人入胜的中文爆款图文脚本。";
        db.prepare(`
          INSERT INTO dataset_sft (source_platform, source_id, instruction, cleaned_input, target_output, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(isTikTok ? 'tiktok' : 'youtube', videoId, defaultInstruction, cleanedInput, fullOutput, Date.now());
      }
    }

    res.end();
  } catch (err) {
    res.status(500).write(`生成中断: ${err.message}`);
    res.end();
  }
});

// ---------------- Creem Webhook 自动发货 ----------------
app.post('/api/webhook/creem', (req, res) => {
  const event = req.body;
  if (event.type === 'checkout.completed' || event.type === 'subscription.created') {
    const email = event.data?.customer_email || event.data?.email;
    const name = (event.data?.product_name || '').toLowerCase();

    let plan = 'basic';
    let limit = 50;

    if (name.includes('premium')) {
      plan = 'premium';
      limit = 300;
    } else if (name.includes('pro')) {
      plan = 'pro';
      limit = 100;
    }

    db.prepare(`
      UPDATE users 
      SET plan = ?, monthly_limit = ?, used_count = 0, expires_at = ?
      WHERE email = ?
    `).run(plan, limit, Date.now() + 30 * 86400000, email);
    console.log(`[Creem Webhook] 成功开通 ${email} 为 ${plan} 会员`);
  }
  res.json({ received: true });
});

// ---------------- 管理后台接口 ----------------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT count(*) as count FROM users').get().count;
  const paidUsers = db.prepare("SELECT count(*) as count FROM users WHERE plan != 'free'").get().count;
  const sftDataCount = db.prepare('SELECT count(*) as count FROM dataset_sft').get().count;
  const users = db.prepare('SELECT id, email, plan, used_count, monthly_limit, expires_at FROM users ORDER BY id DESC LIMIT 50').all();
  res.json({ totalUsers, paidUsers, sftDataCount, users });
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

app.listen(PORT, () => {
  console.log(`HotCopy Core Backend running on port ${PORT}`);
  updateTrendsJob();
});
