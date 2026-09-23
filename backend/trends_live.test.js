const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { cleanTrends, readRadarTrends, validTrend } = require('./trends_live');

test('旧库无 source 列时预览不写入；执行后清占位与伪缓存并保留真实缓存', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE trends (id INTEGER PRIMARY KEY, platform TEXT, video_id TEXT, title TEXT);
      CREATE TABLE copies_cache (video_id TEXT, mode TEXT, content TEXT, PRIMARY KEY(video_id, mode));
    `);
    db.prepare('INSERT INTO trends (platform, video_id, title) VALUES (?, ?, ?)')
      .run('youtube', 'jNQXAC9IVRw', '假的 Cursor AI 教程');
    db.prepare('INSERT INTO trends (platform, video_id, title) VALUES (?, ?, ?)')
      .run('bilibili', 'BV1BK411L7DJ', '待重新同步的旧数据');
    const insertCache = db.prepare('INSERT INTO copies_cache (video_id, mode, content) VALUES (?, ?, ?)');
    insertCache.run('jNQXAC9IVRw', 'raw', '真实旧内容也按明确要求清除');
    insertCache.run('another-id', 'raw', '[00:00:01] Welcome everyone. In today\'s session, we are breaking down a topic. throughput increases by over 300%');
    insertCache.run('real-id', 'raw', '用户实际录音的逐字稿');
    const preview = cleanTrends(db);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.deleteTrends, 2);
    assert.equal(preview.deleteCache, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trends').get().n, 2);
    assert.equal(db.prepare('PRAGMA table_info(trends)').all().some(column => column.name === 'source'), false);
    cleanTrends(db, { dryRun: false });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trends').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM copies_cache').get().n, 1);
    assert.equal(db.prepare('PRAGMA table_info(trends)').all().some(column => column.name === 'source'), true);
    assert.equal(cleanTrends(db, { dryRun: false }).deleteTrends, 0);
  } finally { db.close(); }
});

test('只允许指定活水来源与合法视频或节目 ID 进入热点', () => {
  assert.equal(validTrend({ platform: 'youtube', source: 'youtube-radar', video_id: 'AbCdEfGhI12', title: '真实频道视频' }), true);
  assert.equal(validTrend({ platform: 'youtube', source: 'youtube-radar', video_id: 'dQw4w9WgXcQ', title: '伪标题' }), false);
  assert.equal(validTrend({ platform: 'youtube', source: 'youtube-most-popular', video_id: 'AbCdEfGhI12', title: '旧来源' }), false);
  assert.equal(validTrend({ platform: 'bilibili', source: 'bilibili-knowledge-ranking', video_id: 'BV1BK411L7DJ', title: 'B站' }), true);
  assert.equal(validTrend({ platform: 'podcast', source: 'apple-podcast-chart', video_id: '12345?i=67890', title: '播客单集' }), true);
  assert.equal(validTrend({ platform: 'podcast', source: 'apple-podcast-chart', video_id: '12345', title: '缺单集' }), false);
});

test('YouTube 热点只取近期成功同步的真实雷达视频并排除占位 ID', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-radar-source-'));
  const file = path.join(directory, 'addons.sqlite');
  const radar = new Database(file);
  const now = Date.now();
  radar.exec(`
    CREATE TABLE radar_creators (channel_id TEXT PRIMARY KEY, channel_name TEXT, is_active INTEGER, last_success_at INTEGER);
    CREATE TABLE radar_videos (video_id TEXT PRIMARY KEY, channel_id TEXT, title TEXT, video_url TEXT,
      thumbnail_url TEXT, category TEXT, latest_views INTEGER, published_at INTEGER, first_seen_at INTEGER);
  `);
  radar.prepare('INSERT INTO radar_creators VALUES (?, ?, ?, ?)').run('channel-a', '真实频道', 1, now);
  radar.prepare('INSERT INTO radar_creators VALUES (?, ?, ?, ?)').run('channel-b', '第二频道', 1, now);
  radar.prepare('INSERT INTO radar_creators VALUES (?, ?, ?, ?)').run('channel-old', '失联频道', 1, now - 7 * 60 * 60 * 1000);
  const insert = radar.prepare('INSERT INTO radar_videos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('AbCdEfGhI12', 'channel-a', '真实视频', 'https://www.youtube.com/watch?v=AbCdEfGhI12',
    null, 'ai', 12345, 0, now);
  insert.run('LmNoPqRsT34', 'channel-a', '同频道第二条', 'https://www.youtube.com/watch?v=LmNoPqRsT34',
    null, 'ai', 12000, 0, now);
  insert.run('UvWxYzAbC56', 'channel-b', '第二频道视频', 'https://www.youtube.com/watch?v=UvWxYzAbC56',
    null, 'business', 100, 0, now);
  insert.run('dQw4w9WgXcQ', 'channel-a', '伪标题', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    null, 'ai', 999999, 0, now);
  insert.run('ZyXwVuTsR09', 'channel-old', '过期频道', 'https://www.youtube.com/watch?v=ZyXwVuTsR09',
    null, 'tech', 1, 0, now);
  radar.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const trends = readRadarTrends({ dbPath: file, now });
  assert.equal(trends.length, 3);
  assert.equal(trends[0].video_id, 'AbCdEfGhI12');
  assert.equal(trends[1].video_id, 'UvWxYzAbC56');
  assert.equal(trends[0].source, 'youtube-radar');
  assert.equal(trends[0].category, 'tech');
  assert.equal(trends[0].cover_url, 'https://i.ytimg.com/vi/AbCdEfGhI12/hqdefault.jpg');
});
