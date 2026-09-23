const express = require('express');
const cors = require('cors');
const path = require('path');
const { openDatabase } = require('./db');
const { createRequireAddonUser } = require('./middleware/auth');
const { createQuota, planLimit, ASSET_TYPES } = require('./assets/quota');
const { callModel, PLATFORMS } = require('./assets/generate');
const { buildProductionPackage } = require('./assets/production_package');
const { createProjectStore, projectId, ProjectError } = require('./projects/store');
const { seedCreators } = require('./radar/seed_creators');

const MAX_RAW_CHARS = 40000;
const MAX_CONCURRENT_GENERATIONS = 2;

function createApp({ db, config, fetchImpl = fetch, modelCall = callModel }) {
  seedCreators(db);
  const app = express();
  const quota = createQuota(db);
  const projects = createProjectStore(db);
  const inFlightUsers = new Set();
  let activeGenerations = 0;
  const allowedOrigins = new Set(config.allowedOrigins || [
    'https://hotcopy.eazyopc.com',
    'http://localhost:8765',
    'http://127.0.0.1:8765'
  ]);

  app.disable('x-powered-by');
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)) }));
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/addons/health', (_req, res) => res.json({ ok: true, service: 'hotcopy-addons' }));
  const requireUser = createRequireAddonUser({
    coreBaseUrl: config.coreBaseUrl,
    userKeySecret: config.userKeySecret,
    fetchImpl
  });
  const router = express.Router();
  router.use(requireUser);

  function requireCreator(req, res, next) {
    if (!planLimit(req.addonUser)) {
      return res.status(403).json({ error: '创作项目面向有效 Pro 与 Premium 会员开放' });
    }
    next();
  }

  router.get('/assets/usage', (req, res) => {
    res.json({ success: true, ...quota.usage(req.addonUser) });
  });

  router.post('/assets/production-package', requireCreator, (req, res) => {
    try {
      const data = buildProductionPackage({
        scriptMarkdown: req.body?.script_markdown,
        platform: req.body?.platform,
        sourceTitle: req.body?.source_title
      });
      return res.json({ success: true, data });
    } catch {
      return res.status(400).json({ error: '请先提供完整的四段口播稿与有效平台' });
    }
  });

  router.post('/assets/:assetType', async (req, res, next) => {
    const assetType = req.params.assetType;
    if (assetType === 'library') return next();
    if (!ASSET_TYPES.has(assetType)) return res.status(404).json({ error: '未知资产类型' });
    const user = req.addonUser;
    if (!planLimit(user)) return res.status(403).json({ error: '创作资产工坊面向有效 Pro 与 Premium 会员开放' });

    const rawText = req.body?.raw_text;
    if (typeof rawText !== 'string' || rawText.trim().length < 40 || rawText.length > MAX_RAW_CHARS) {
      return res.status(400).json({ error: `请提供 40 至 ${MAX_RAW_CHARS} 字的原声全文` });
    }
    const platform = req.body?.platform;
    if (assetType === 'short-video' && !Object.hasOwn(PLATFORMS, platform)) {
      return res.status(400).json({ error: '请选择有效的口播平台' });
    }
    if (assetType === 'production-kit' &&
        ((req.body?.title !== undefined &&
          (typeof req.body.title !== 'string' || req.body.title.length > 120 || /[\x00-\x1f]/.test(req.body.title))) ||
         (req.body?.source_url !== undefined &&
          (typeof req.body.source_url !== 'string' || req.body.source_url.length > 2048 || /[\x00-\x1f]/.test(req.body.source_url))) ||
         (req.body?.video_id !== undefined &&
          (typeof req.body.video_id !== 'string' || req.body.video_id.length > 128 || /[\x00-\x1f]/.test(req.body.video_id))))) {
      return res.status(400).json({ error: '制作包素材信息无效' });
    }
    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS || inFlightUsers.has(user.key)) {
      return res.status(429).json({ error: '当前生成任务较多，请稍后再试' });
    }

    let reservation;
    try {
      reservation = quota.reserve(user, assetType);
    } catch {
      return res.status(503).json({ error: '额度服务暂不可用，请稍后重试' });
    }
    if (!reservation) return res.status(429).json({ error: '本月内容资产额度已用完' });
    activeGenerations += 1;
    inFlightUsers.add(user.key);
    const controller = new AbortController();
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', abortOnClose);
    try {
      const data = await modelCall({
        assetType,
        platform,
        rawText: rawText.trim(),
        title: assetType === 'production-kit' ? (req.body.title || '').trim() : '',
        modelConfig: config.model,
        fetchImpl,
        signal: controller.signal
      });
      const result = { success: true, remaining: reservation.remaining };
      if (assetType === 'xiaohongshu') result.data = data;
      if (assetType === 'production-kit') result.data = data;
      if (assetType === 'short-video') {
        result.platform = platform;
        result.script_markdown = data.script_markdown;
      }
      if (assetType === 'mindmap') Object.assign(result, data);
      return res.json(result);
    } catch (error) {
      quota.refund(user, assetType, reservation.month);
      if (res.destroyed) return;
      return next(error);
    } finally {
      res.off('close', abortOnClose);
      activeGenerations -= 1;
      inFlightUsers.delete(user.key);
    }
  });

  function requirePremium(req, res, next) {
    if (req.addonUser.plan !== 'premium' || !planLimit(req.addonUser)) {
      return res.status(403).json({ error: '云端资产库面向有效 Premium 会员开放' });
    }
    next();
  }

  function requireRadarPremium(req, res, next) {
    if (req.addonUser.plan !== 'premium' || !planLimit(req.addonUser)) {
      return res.status(403).json({ error: '爆款追踪面向有效 Premium 会员开放' });
    }
    next();
  }

  router.get('/radar/status', requireRadarPremium, (_req, res) => {
    const status = db.prepare(`
      SELECT COUNT(*) AS channel_count,
        SUM(CASE WHEN last_success_at > 0 THEN 1 ELSE 0 END) AS synced_channels,
        SUM(CASE WHEN last_error_code IS NOT NULL THEN 1 ELSE 0 END) AS failed_channels,
        MAX(last_checked_at) AS last_checked_at,
        MAX(last_success_at) AS last_success_at
      FROM radar_creators WHERE is_active = 1
    `).get();
    const failed = Number(status.failed_channels) || 0;
    const synced = Number(status.synced_channels) || 0;
    res.json({
      success: true,
      poll_minutes: 30,
      channel_count: status.channel_count,
      synced_channels: synced,
      failed_channels: failed,
      last_checked_at: status.last_checked_at || null,
      last_success_at: status.last_success_at || null,
      source_status: failed ? 'degraded' : synced ? 'ok' : 'waiting'
    });
  });

  router.get('/radar/channels', requireRadarPremium, (_req, res) => {
    const channels = db.prepare(`
      SELECT channel_id, channel_name, category, channel_url, curated_rank,
        last_checked_at, last_success_at, last_error_code
      FROM radar_creators WHERE is_active = 1 ORDER BY curated_rank ASC
    `).all();
    res.json({ success: true, channels });
  });

  router.get('/radar/inbox', requireRadarPremium, (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : 'all';
    if (!['all', 'ai', 'tech', 'business', 'growth'].includes(category)) {
      return res.status(400).json({ error: '未知监控领域' });
    }
    const items = db.prepare(`
      SELECT v.video_id, v.title, v.video_url AS source_url, v.thumbnail_url,
        v.published_at, v.first_seen_at, v.category, v.status_badge,
        c.channel_name, c.channel_url,
        v.latest_views
      FROM radar_videos v
      JOIN radar_creators c ON c.channel_id = v.channel_id
      WHERE c.is_active = 1 AND (? = 'all' OR v.category = ?)
      ORDER BY COALESCE(NULLIF(v.published_at, 0), v.first_seen_at) DESC,
        v.first_seen_at DESC LIMIT 60
    `).all(category, category);
    return res.json({ success: true, items });
  });

  router.get('/projects', requireCreator, (req, res) => {
    return res.json({ success: true, items: projects.list(req.addonUser) });
  });

  router.post('/projects', requireCreator, (req, res) => {
    const result = projects.upsert(req.addonUser, req.body);
    return res.status(result.created ? 201 : 200).json({ success: true, ...result });
  });

  router.get('/projects/:id', requireCreator, (req, res) => {
    return res.json({ success: true, project: projects.get(req.addonUser, projectId(req.params.id)) });
  });

  router.put('/projects/:id/assets', requireCreator, (req, res) => {
    const result = projects.saveAsset(req.addonUser, projectId(req.params.id), req.body);
    return res.json({ success: true, ...result });
  });

  router.delete('/projects/:id', requireCreator, (req, res) => {
    return res.json({ success: true, deleted: projects.remove(req.addonUser, projectId(req.params.id)) });
  });

  router.get('/assets/library', requirePremium, (req, res) => {
    const items = db.prepare(`
      SELECT id, asset_type, title, content_json, created_at
      FROM asset_library WHERE user_key = ? ORDER BY created_at DESC, id DESC LIMIT 100
    `).all(req.addonUser.key).map(row => ({
      id: row.id,
      asset_type: row.asset_type,
      title: row.title,
      content: JSON.parse(row.content_json),
      created_at: row.created_at
    }));
    res.json({ success: true, items });
  });

  router.post('/assets/library', requirePremium, (req, res) => {
    const { asset_type: assetType, title, content } = req.body || {};
    if (!ASSET_TYPES.has(assetType) || typeof title !== 'string' || !title.trim() || title.length > 120 ||
        !content || typeof content !== 'object' || Array.isArray(content)) {
      return res.status(400).json({ error: '作品内容格式无效' });
    }
    const contentJson = JSON.stringify(content);
    if (contentJson.length > 80000) return res.status(413).json({ error: '作品内容过长' });
    const info = db.prepare(`
      INSERT INTO asset_library (user_key, asset_type, title, content_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.addonUser.key, assetType, title.trim(), contentJson, Date.now());
    return res.status(201).json({ success: true, id: Number(info.lastInsertRowid) });
  });

  router.delete('/assets/library/:id', requirePremium, (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: '作品 ID 无效' });
    const result = db.prepare('DELETE FROM asset_library WHERE id = ? AND user_key = ?')
      .run(Number(req.params.id), req.addonUser.key);
    return res.json({ success: true, deleted: result.changes === 1 });
  });

  app.use('/api/addons', router);
  app.use((error, _req, res, _next) => {
    if (error instanceof ProjectError) return res.status(error.status).json({ error: error.message });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: '提交的文本过长' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: '请求 JSON 格式无效' });
    return res.status(error.status || 502).json({ error: error.status === 503 ? error.message : '内容生成未完成，请稍后重试' });
  });
  return app;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const config = {
    coreBaseUrl: process.env.CORE_API_BASE || 'http://127.0.0.1:3001',
    userKeySecret: process.env.ADDONS_USER_KEY_SECRET,
    model: {
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.ADDONS_LLM_MODEL || process.env.LLM_MODEL || 'openai/gpt-oss-120b'
    }
  };
  if (!config.userKeySecret || config.userKeySecret.length < 32) {
    throw new Error('启动前请配置至少 32 个字符的 ADDONS_USER_KEY_SECRET');
  }
  const db = openDatabase();
  const app = createApp({ db, config });
  app.listen(3002, '127.0.0.1', () => {
    console.log('HotCopy 附加服务已在 127.0.0.1:3002 启动');
  });
}

module.exports = { createApp };
