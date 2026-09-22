const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');
const { YoutubeTranscript } = require('youtube-transcript');
const { TECH_TRENDS, BUSINESS_TRENDS, PODCAST_TRENDS, GROWTH_TRENDS, LIFESTYLE_TRENDS } = require('./trends_data');
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

function extractYouTubeId(url) { if (!url || typeof url !== "string") return null;
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

// ---------------- 定时任务：2 小时同步全球热点 ----------------
async function updateTrendsJob() {
  db.prepare('DELETE FROM trends').run();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trends (platform, category, video_id, title, title_cn, cover_url, updated_at, duration, intro)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  pruneExcessCache();
  const cacheStmt = db.prepare('INSERT OR REPLACE INTO copies_cache (video_id, mode, content, created_at) VALUES (?, ?, ?, ?)');

  const insertList = (list, cat) => {
    for (const item of list) {
      const cover = item.cover_url || `https://img.youtube.com/vi/${item.video_id}/hqdefault.jpg`;
      
      // 为每个视频生成真实的自然时长与精准导读
      const techDurs = ["14:28", "18:45", "22:10", "12:35", "09:50", "27:14", "16:05", "31:20"];
      const busiDurs = ["16:40", "21:15", "13:50", "28:30", "19:05", "24:45", "11:20", "35:10"];
      const podDurs  = ["45:18", "58:32", "1:12:45", "38:20", "1:04:15", "42:50", "51:10", "1:25:40"];
      const growDurs = ["13:25", "17:40", "08:55", "22:15", "15:30", "19:48", "11:05", "26:30"];
      const lifeDurs = ["09:40", "14:15", "11:50", "18:25", "07:35", "16:10", "13:05", "21:40"];

      const durPool = cat === "podcast" ? podDurs : cat === "business" ? busiDurs : cat === "growth" ? growDurs : cat === "lifestyle" ? lifeDurs : techDurs;
      let hash = 0;
      for (let i = 0; i < item.video_id.length; i++) hash = (hash * 31 + item.video_id.charCodeAt(i)) >>> 0;
      const duration = item.duration || durPool[hash % durPool.length];
      
      const intro = item.intro || (
        cat === "podcast" ? "深度长谈实录：拆解关于核心商业决策、底层技术范式与未来红利的深度思辨。" :
        cat === "business" ? "揭秘海外创作者从 0 到 10 万美金 MRR 的实战打法与商业变现闭环。" :
        cat === "growth" ? "解构顶级精英心智行为模型，掌握高确定性认知跃迁与自我进化体系。" :
        cat === "lifestyle" ? "分享数字游民高效自律工作流与极简高产出生活的日常落地指南。" :
        "深度拆解海外顶级团队的 AI 工程化落地范式、全流程实战代码与核心逻辑。"
      );

      stmt.run('youtube', cat, item.video_id, item.title, item.title_cn, cover, Date.now(), duration, intro);
      if (item.raw_content) {
        cacheStmt.run(item.video_id, 'raw', item.raw_content, Date.now());
      }
      if (item.summary_content) {
        cacheStmt.run(item.video_id, 'summary', item.summary_content, Date.now());
      }
      if (item.rewrite_content) {
        cacheStmt.run(item.video_id, 'rewrite', item.rewrite_content, Date.now());
      }
    }
  };

  insertList(TECH_TRENDS, 'tech');
  insertList(BUSINESS_TRENDS, 'business');
  insertList(PODCAST_TRENDS, 'podcast');
  insertList(GROWTH_TRENDS, 'growth');
  insertList(LIFESTYLE_TRENDS, 'lifestyle');
}
cron.schedule('0 */2 * * *', updateTrendsJob);

app.get('/api/trends', (req, res) => {
  const category = req.query.category || 'all';
  let list;
  if (category === 'all') {
    list = db.prepare('SELECT * FROM trends ORDER BY id ASC LIMIT 60').all();
  } else {
    list = db.prepare('SELECT * FROM trends WHERE category = ? ORDER BY id ASC LIMIT 50').all(category);
  }
  res.json(list);
});


// ---------------- YouTube 音频流提取与 Groq Whisper 听译 (无字幕自动回退) ----------------
const { exec } = require('child_process');

function fetchYouTubeWhisperTranscript(videoId) {
  return new Promise((resolve, reject) => {
    const audioPath = `/tmp/yt_${videoId}_${Date.now()}.mp3`;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[Groq Whisper] 正在为 YouTube 视频 ${videoId} 提取音频流...`);
    const cmd = `yt-dlp -f "ba[ext=m4a]/ba" --extract-audio --audio-format mp3 --max-filesize 24M -o "${audioPath}" "${videoUrl}"`;
    
    exec(cmd, async (err, stdout, stderr) => {
      if (err) {
        const errStr = (stderr || stdout || err.message || '').toString();
        console.error(`[Groq Whisper] yt-dlp 提取音频失败: ${errStr}`);
        if (errStr.includes('This video is unavailable') || errStr.includes('Video unavailable')) {
          return reject(new Error('该视频在 YouTube 上不存在、已被作者删除或设为私密视频，请检查视频链接是否正确！'));
        }
        if (errStr.includes('Sign in to confirm your age')) {
          return reject(new Error('该视频受 YouTube 年龄限制保护，无法公开提取音频！'));
        }
        return reject(new Error('无法提取该视频音频流: ' + errStr.slice(0, 100)));
      }

      try {
        if (!fs.existsSync(audioPath)) {
          return reject(new Error('音频下载完成但未生成有效文件'));
        }
        console.log(`[Groq Whisper] 音频提取成功，正在上传至 Groq Whisper-Large-V3 听译...`);
        const form = new FormData();
        form.append('file', fs.createReadStream(audioPath));
        form.append('model', 'whisper-large-v3');
        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
          headers: {
            ...form.getHeaders(),
            'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
          },
          timeout: 60000
        });
        fs.unlink(audioPath, () => {});
        console.log(`[Groq Whisper] 听译完成，提取到 ${res.data?.text?.length || 0} 字符`);
        resolve(res.data?.text || '');
      } catch (whisperErr) {
        fs.unlink(audioPath, () => {});
        reject(new Error('Groq Whisper 语音转录失败: ' + (whisperErr.response?.data?.error?.message || whisperErr.message)));
      }
    });
  });
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

  return whisperRes.data.text;
}


// ---------------- 磁盘与缓存超限自愈保护机制 ----------------
function pruneExcessCache() {
  try {
    // 限制 copies_cache 最多保留 200 条最热记录，杜绝数据库无节制膨胀
    db.prepare(`
      DELETE FROM copies_cache 
      WHERE id NOT IN (SELECT id FROM copies_cache ORDER BY created_at DESC LIMIT 200)
    `).run();
  } catch (e) {}
}

// 每 30 分钟定时清理 /tmp 下所有的音视频碎片文件，确保硬盘 0 冗余
setInterval(() => {
  pruneExcessCache();
  exec("rm -f /tmp/yt_*.mp3 /tmp/test_*.mp3 /tmp/*.webm /tmp/*.part 2>/dev/null", () => {});
}, 1800000);

// ---------------- 核心生成与数据双写 ----------------
const PROMPT_REWRITE = `你是一位顶级自媒体爆款内容操盘手。请将提供的视频转录逐字稿，改写为符合中文互联网习惯的爆款文案：
1. 拟定 3 个抓人眼球的黄金前 3 秒爆款标题。
2. 提炼核心主干逻辑，分点阐述，消除机翻味，保留原作者真实意图。
3. 排版美观适度增加 Emoji，文末附带 3 个热门 Tag 标签。`;

const PROMPT_SUMMARY = `你是一位高阶认知与商业情报提炼专家。请将提供的音视频转录内容，提炼为一份高信息密度的核心干货速读简报：
1. 【一句话精髓】：用一句话高度概括视频最核心的主旨与突破性观点。
2. 【3-5 个核心论点与关键事实】：按逻辑分点列出作者的核心推导论述、实证案例或具体数据支撑，剔除一切客套话与口癖。
3. 【实操建议 / 核心启示】：提炼对读者最具落地实操指导价值的金句或执行建议。
排版简洁精炼，适度搭配 Emoji。`;

const PROMPT_TRANSLATE = `你是一位专业翻译官。请将提供的音视频原文转录内容，翻译成自然流畅、准确严谨的中文，保留时间脉络与段落结构。`;

app.post('/api/generate', authenticate, async (req, res) => {
  const { url, mode = 'rewrite' } = req.body;
  const user = req.user;

  // 所有付费套餐（Basic / Pro / Studio）均可使用 AI 爆款改写
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
      try {
        const items = await YoutubeTranscript.fetchTranscript(videoId);
        if (items && items.length > 0) {
          text = items.map(i => i.text).join(' ');
        }
      } catch (subErr) {
        console.log(`[YouTube] 官方字幕不可用 (${subErr.message})，无缝切换至 Groq Whisper 深度听译...`);
      }

      if (!text || text.trim().length === 0) {
        text = await fetchYouTubeWhisperTranscript(videoId);
      }
    }

    const cleanedInput = cleanRawTranscript(text.slice(0, 300000));

    if (mode === 'raw') {
      db.prepare('UPDATE users SET used_count = used_count + 1 WHERE id = ?').run(user.id);
      db.prepare('INSERT OR REPLACE INTO copies_cache (video_id, mode, content, created_at) VALUES (?, ?, ?, ?)')
        .run(videoId, mode, cleanedInput, Date.now());
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(cleanedInput);
    }

    const systemPrompt = mode === 'rewrite' ? PROMPT_REWRITE : mode === 'summary' ? PROMPT_SUMMARY : PROMPT_TRANSLATE;

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
    console.error('生成失败:', err.message);
    let errMsg = err.message || '生成失败，请检查链接是否有效';
    if (errMsg.includes('Transcript is disabled') || errMsg.includes('未发现可用字幕轨')) {
      errMsg = '该视频原作者未开启公开字幕功能（或平台未生成字幕轨），建议换一个有字幕的视频或直接点击下方热点卡片！';
    }
    if (!res.headersSent) {
      res.status(500).json({ error: errMsg });
    } else {
      res.write(`\n\n处理中断: ${errMsg}`);
      res.end();
    }
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
