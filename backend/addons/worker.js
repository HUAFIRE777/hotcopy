const cron = require('node-cron');
const { openDatabase } = require('./db');
const { seedCreators } = require('./radar/seed_creators');
const { fetchChannelFeed } = require('./radar/youtube_rss');

const MAX_CONCURRENT_FEEDS = 2;
const NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

function retryDelay(failureCount) {
  return Math.min(MAX_RETRY_MS, 30 * 60 * 1000 * (2 ** Math.min(failureCount - 1, 6)));
}

function createWorker({ db, fetchFeed = fetchChannelFeed, now = Date.now, logger = console }) {
  seedCreators(db);
  const dueChannels = db.prepare(`
    SELECT channel_id, channel_name, category, failure_count
    FROM radar_creators
    WHERE is_active = 1 AND next_retry_at <= ?
    ORDER BY curated_rank ASC
  `);
  const insertVideo = db.prepare(`
    INSERT OR IGNORE INTO radar_videos
      (video_id, channel_id, category, title, video_url, thumbnail_url,
       published_at, first_seen_at, latest_views, status_badge)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const refreshVideo = db.prepare(`
    UPDATE radar_videos SET
      latest_views = COALESCE(?, latest_views),
      published_at = CASE WHEN published_at = 0 AND ? > 0 THEN ? ELSE published_at END,
      status_badge = CASE WHEN published_at = 0 AND ? > 0 THEN ? ELSE status_badge END
    WHERE video_id = ? AND channel_id = ?
  `);
  const markSuccess = db.prepare(`
    UPDATE radar_creators SET last_checked_at = ?, last_success_at = ?,
      last_error_code = NULL, failure_count = 0, next_retry_at = 0
    WHERE channel_id = ?
  `);
  const markFailure = db.prepare(`
    UPDATE radar_creators SET last_checked_at = ?, last_error_code = ?,
      failure_count = ?, next_retry_at = ?
    WHERE channel_id = ?
  `);
  let running = false;

  async function processChannel(channel) {
    const checkedAt = now();
    try {
      const feed = await fetchFeed(channel.channel_id);
      const inserted = db.transaction(() => {
        let count = 0;
        for (const video of feed.entries) {
          const age = checkedAt - video.publishedAt;
          const badge = age >= 0 && age <= NEW_WINDOW_MS ? 'NEW' : 'ARCHIVE';
          const inserted = insertVideo.run(
            video.videoId, channel.channel_id, channel.category, video.title,
            video.videoUrl, video.thumbnailUrl, video.publishedAt, checkedAt,
            video.latestViews ?? null, badge
          ).changes;
          count += inserted;
          if (!inserted && (video.latestViews != null || video.publishedAt > 0)) {
            refreshVideo.run(video.latestViews ?? null, video.publishedAt, video.publishedAt,
              video.publishedAt, badge, video.videoId, channel.channel_id);
          }
        }
        markSuccess.run(checkedAt, checkedAt, channel.channel_id);
        return count;
      })();
      return { ok: true, inserted, channelId: channel.channel_id };
    } catch (error) {
      const failureCount = channel.failure_count + 1;
      const code = /^([A-Z_]+|HTTP_\d{3})$/.test(error.code || '') ? error.code : 'FEED_ERROR';
      markFailure.run(checkedAt, code, failureCount, checkedAt + retryDelay(failureCount), channel.channel_id);
      logger.warn(`[Radar] ${channel.channel_name}: ${code}`);
      return { ok: false, inserted: 0, channelId: channel.channel_id, code };
    }
  }

  async function runOnce() {
    if (running) return { skipped: true, reason: 'previous_round_running' };
    running = true;
    try {
      const channels = dueChannels.all(now());
      let next = 0;
      const results = [];
      async function runner() {
        while (next < channels.length) {
          results.push(await processChannel(channels[next++]));
        }
      }
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_FEEDS, channels.length) }, runner));
      return {
        checked: results.length,
        succeeded: results.filter(result => result.ok).length,
        failed: results.filter(result => !result.ok).length,
        inserted: results.reduce((total, result) => total + result.inserted, 0),
        deferred: db.prepare('SELECT COUNT(*) AS count FROM radar_creators WHERE is_active = 1 AND next_retry_at > ?').get(now()).count
      };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const db = openDatabase();
  const worker = createWorker({ db });
  const poll = async () => {
    try {
      console.log('[Radar] 本轮检查:', JSON.stringify(await worker.runOnce()));
    } catch (error) {
      console.error('[Radar] 本轮任务失败:', error.message);
    }
  };
  cron.schedule('*/30 * * * *', poll, { timezone: 'UTC' });
  poll();
  console.log('[Radar] 已启动，每 30 分钟检查公开频道 Feed');
}

module.exports = { createWorker, retryDelay };
