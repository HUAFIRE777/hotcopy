const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PLACEHOLDER_VIDEO_IDS = new Set(['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0']);
const LIVE_TREND_SOURCES = Object.freeze({
  youtube: 'youtube-radar',
  bilibili: 'bilibili-knowledge-ranking',
  podcast: 'apple-podcast-chart'
});
const TREND_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RADAR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function validTrend(row) {
  if (!row || row.source !== LIVE_TREND_SOURCES[row.platform] ||
      typeof row.title !== 'string' || !row.title.trim()) return false;
  const id = row.video_id;
  if (row.platform === 'youtube') return /^[\w-]{11}$/.test(id || '') && !PLACEHOLDER_VIDEO_IDS.has(id);
  if (row.platform === 'bilibili') return /^BV[a-zA-Z0-9]{10}$/.test(id || '');
  if (row.platform === 'podcast') return /^\d+\?i=\d+$/.test(id || '');
  return false;
}

function isSyntheticCache(row) {
  if (PLACEHOLDER_VIDEO_IDS.has(row.video_id)) return true;
  const content = row.content || '';
  if (row.mode === 'raw') {
    return content.startsWith('[00:00:01] Welcome everyone. In today\'s session, we are breaking down') &&
      content.includes('throughput increases by over 300%');
  }
  if (row.mode === 'summary') {
    return content.startsWith('【一句话精髓】') && content.includes('通过架构精简与方法论迭代，实现效能与商业价值的数倍跃升');
  }
  if (row.mode === 'rewrite') {
    return content.startsWith('🔥 爆款标题参考：') && content.includes('别再走弯路了，一文搞懂核心全流程');
  }
  return false;
}

function inspectTrends(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(trends)').all().map(column => column.name));
  const rows = db.prepare(`SELECT id, platform, video_id, title${columns.has('source') ? ', source' : ''} FROM trends`).all();
  const trendIds = rows.filter(row => !validTrend(row)).map(row => row.id);
  const cacheRows = db.prepare('SELECT video_id, mode, content FROM copies_cache').all();
  const cacheKeys = cacheRows.filter(isSyntheticCache).map(row => [row.video_id, row.mode]);
  return { hasSourceColumn: columns.has('source'), trendIds, cacheKeys,
    totals: { trends: rows.length, cache: cacheRows.length } };
}

function cleanTrends(db, { dryRun = true } = {}) {
  const inspection = inspectTrends(db);
  const result = {
    dryRun,
    inspected: inspection.totals,
    deleteTrends: inspection.trendIds.length,
    deleteCache: inspection.cacheKeys.length
  };
  if (dryRun) return result;
  db.transaction(() => {
    if (!inspection.hasSourceColumn) db.exec('ALTER TABLE trends ADD COLUMN source TEXT');
    const deleteTrend = db.prepare('DELETE FROM trends WHERE id = ?');
    const deleteCache = db.prepare('DELETE FROM copies_cache WHERE video_id = ? AND mode = ?');
    inspection.trendIds.forEach(id => deleteTrend.run(id));
    inspection.cacheKeys.forEach(key => deleteCache.run(...key));
  })();
  return result;
}

function readRadarTrends({ dbPath = process.env.ADDONS_DB_PATH || path.join(__dirname, 'addons', 'addons.sqlite'), now = Date.now() } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error('雷达数据库尚未部署');
  const radar = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasDuration = radar.prepare('PRAGMA table_info(radar_videos)').all()
      .some(column => column.name === 'duration_seconds');
    const rows = radar.prepare(`
      WITH ranked AS (
        SELECT v.video_id, v.channel_id, v.title, v.video_url, v.thumbnail_url,
          v.category, v.latest_views, v.published_at, v.first_seen_at, c.channel_name,
          ${hasDuration ? 'v.duration_seconds' : 'NULL AS duration_seconds'},
          ROW_NUMBER() OVER (PARTITION BY v.channel_id
            ORDER BY COALESCE(NULLIF(v.published_at, 0), v.first_seen_at) DESC,
              COALESCE(v.latest_views, 0) DESC) AS channel_rank
        FROM radar_videos v
        JOIN radar_creators c ON c.channel_id = v.channel_id
        WHERE c.is_active = 1 AND c.last_success_at >= ?
      )
      SELECT * FROM ranked WHERE channel_rank <= 3
      ORDER BY COALESCE(NULLIF(published_at, 0), first_seen_at) DESC,
        COALESCE(latest_views, 0) DESC LIMIT 60
    `).all(now - RADAR_MAX_AGE_MS);
    const validRows = rows.filter(row => /^[\w-]{11}$/.test(row.video_id || '') &&
      !PLACEHOLDER_VIDEO_IDS.has(row.video_id) &&
      row.video_url === `https://www.youtube.com/watch?v=${row.video_id}` &&
      typeof row.title === 'string' && row.title.trim());
    const seenChannels = new Set();
    const primary = [];
    const extra = [];
    for (const row of validRows) {
      if (seenChannels.has(row.channel_id)) extra.push(row);
      else { seenChannels.add(row.channel_id); primary.push(row); }
    }
    return [...primary, ...extra].slice(0, 30).map(row => ({
        platform: 'youtube',
        category: row.category === 'business' ? 'business' : row.category === 'growth' ? 'growth' : 'tech',
        video_id: row.video_id,
        title: row.title,
        cover_url: /^https:\/\/i\.ytimg\.com\//.test(row.thumbnail_url || '')
          ? row.thumbnail_url : `https://i.ytimg.com/vi/${row.video_id}/hqdefault.jpg`,
        duration: Number.isSafeInteger(row.duration_seconds) && row.duration_seconds > 0
          ? row.duration_seconds : null,
        intro: row.channel_name,
        source: LIVE_TREND_SOURCES.youtube
      }));
  } finally {
    radar.close();
  }
}

module.exports = {
  PLACEHOLDER_VIDEO_IDS, LIVE_TREND_SOURCES, TREND_MAX_AGE_MS,
  validTrend, isSyntheticCache, inspectTrends, cleanTrends, readRadarTrends
};
