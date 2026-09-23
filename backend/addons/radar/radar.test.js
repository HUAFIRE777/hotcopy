const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../db');
const { createWorker } = require('../worker');
const { SEED_CREATORS, seedCreators } = require('./seed_creators');
const {
  parseYouTubeFeed, parseYtDlpPlaylist, fetchChannelFeed, fetchChannelWithYtDlp,
  CHANNEL_ID_PATTERN
} = require('./youtube_rss');

const FIRE_ID = 'UCsBjURrPoezykLs9EqgamOA';
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
  <link rel="self" href="https://www.youtube.com/feeds/videos.xml?channel_id=${FIRE_ID}"/>
  <title>Fireship</title>
  <entry>
    <yt:videoId>abcdefghijk</yt:videoId><yt:channelId>${FIRE_ID}</yt:channelId>
    <title>AI &amp; Code</title><published>2026-09-23T01:00:00+00:00</published>
    <media:group><media:thumbnail url="https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"/><media:content duration="123"/></media:group>
  </entry>
  <entry>
    <yt:videoId>ABCDEFGHIJK</yt:videoId><yt:channelId>${FIRE_ID}</yt:channelId>
    <title>Second video</title><published>2026-09-22T01:00:00+00:00</published>
  </entry>
</feed>`;
const YTDLP_JSON = JSON.stringify({
  _type: 'playlist', id: FIRE_ID, channel_id: FIRE_ID, title: 'Fireship - Videos',
  entries: [{
    id: 'abcdefghijk', title: 'Latest video', timestamp: null, view_count: 1900000, duration: 615,
    thumbnails: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }]
  }]
});

test('20 个精选频道 ID 唯一、格式正确且种子入库可重复执行', () => {
  assert.equal(SEED_CREATORS.length, 20);
  assert.equal(new Set(SEED_CREATORS.map(item => item.id)).size, 20);
  assert.ok(SEED_CREATORS.every(item => CHANNEL_ID_PATTERN.test(item.id)));
  assert.equal(SEED_CREATORS.find(item => item.name === 'Two Bit da Vinci').id, 'UCEgYhf84VjXDz-W7a9-rdCQ');
  const db = openDatabase(':memory:');
  try {
    seedCreators(db);
    seedCreators(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM radar_creators').get().count, 20);
    assert.equal(db.prepare('SELECT verified_source FROM radar_creators WHERE channel_id = ?').get(FIRE_ID).verified_source,
      'https://www.youtube.com/@Fireship');
  } finally { db.close(); }
});

test('阶段一附加库的频道表可原位升级，已有行保留', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-radar-test-'));
  const filename = path.join(directory, 'addons.sqlite');
  const oldDb = new Database(filename);
  oldDb.exec(`CREATE TABLE radar_creators (
    channel_id TEXT PRIMARY KEY, category TEXT NOT NULL, channel_name TEXT NOT NULL,
    channel_url TEXT NOT NULL, curated_rank INTEGER DEFAULT 99, is_active INTEGER DEFAULT 1,
    last_checked_at INTEGER DEFAULT 0, last_success_at INTEGER DEFAULT 0
  )`);
  oldDb.prepare('INSERT INTO radar_creators (channel_id, category, channel_name, channel_url) VALUES (?, ?, ?, ?)')
    .run(FIRE_ID, 'tech', 'Fireship', 'https://www.youtube.com/@Fireship');
  oldDb.close();
  try {
    const db = openDatabase(filename);
    try {
      const row = db.prepare('SELECT channel_name, failure_count, next_retry_at FROM radar_creators WHERE channel_id = ?').get(FIRE_ID);
      assert.equal(row.channel_name, 'Fireship');
      assert.equal(row.failure_count, 0);
      assert.equal(row.next_retry_at, 0);
      seedCreators(db);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM radar_creators').get().count, 20);
    } finally { db.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('RSS 解析验证频道归属、标题转义与真实视频 ID', async () => {
  const parsed = parseYouTubeFeed(FEED_XML, FIRE_ID);
  assert.equal(parsed.channelTitle, 'Fireship');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].title, 'AI & Code');
  assert.equal(parsed.entries[0].videoUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(parsed.entries[0].durationSeconds, 123);
  assert.throws(() => parseYouTubeFeed(FEED_XML, SEED_CREATORS[0].id), { code: 'CHANNEL_MISMATCH' });
  const emptyFeed = FEED_XML.replace(/<entry>[\s\S]*?<\/entry>/g, '');
  assert.equal(parseYouTubeFeed(emptyFeed, FIRE_ID).entries.length, 0);
  assert.equal(parseYouTubeFeed(emptyFeed.replace('rel="self" href=', 'href=').replace('channel_id=UCsBjURrPoezykLs9EqgamOA"/>', 'channel_id=UCsBjURrPoezykLs9EqgamOA" rel="self"/>'), FIRE_ID).entries.length, 0);
  assert.throws(() => parseYouTubeFeed(emptyFeed, SEED_CREATORS[0].id), { code: 'CHANNEL_MISMATCH' });
  const fetched = await fetchChannelFeed(FIRE_ID, {
    fetchImpl: async url => {
      assert.equal(url, `https://www.youtube.com/feeds/videos.xml?channel_id=${FIRE_ID}`);
      return new Response(FEED_XML, { status: 200, headers: { 'Content-Type': 'application/atom+xml' } });
    },
    fallbackImpl: () => { throw new Error('RSS 成功时不应调用 yt-dlp'); }
  });
  assert.equal(fetched.entries.length, 2);
  for (const status of [404, 500]) {
    const recovered = await fetchChannelFeed(FIRE_ID, {
      fetchImpl: async () => new Response('Feed failed', { status }),
      fallbackImpl: async id => {
        assert.equal(id, FIRE_ID);
        return parseYtDlpPlaylist(YTDLP_JSON, id);
      }
    });
    assert.equal(recovered.entries[0].latestViews, 1900000);
  }
  const networkRecovery = await fetchChannelFeed(FIRE_ID, {
    fetchImpl: async () => { throw new Error('network offline'); },
    fallbackImpl: async id => parseYtDlpPlaylist(YTDLP_JSON, id)
  });
  assert.equal(networkRecovery.entries.length, 1);
});

test('yt-dlp 回退使用无 shell 的固定参数、可选 Cookie，并校验频道与字段', async () => {
  const parsed = parseYtDlpPlaylist(YTDLP_JSON, FIRE_ID);
  assert.equal(parsed.entries[0].publishedAt, 0);
  assert.equal(parsed.entries[0].latestViews, 1900000);
  assert.equal(parsed.entries[0].thumbnailUrl, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal(parsed.entries[0].durationSeconds, 615);
  assert.throws(() => parseYtDlpPlaylist(YTDLP_JSON, SEED_CREATORS[0].id), { code: 'YTDLP_CHANNEL_MISMATCH' });
  assert.throws(() => parseYtDlpPlaylist('{', FIRE_ID), { code: 'YTDLP_BAD_JSON' });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-ytdlp-test-'));
  const cookiesPath = path.join(directory, 'cookies.txt');
  fs.writeFileSync(cookiesPath, '');
  try {
    const calls = [];
    const result = await fetchChannelWithYtDlp(FIRE_ID, {
      binaryPath: '/usr/local/bin/yt-dlp', cookiesPath,
      execFileImpl: async (binary, args, options) => {
        calls.push({ binary, args, options });
        return { stdout: YTDLP_JSON };
      }
    });
    assert.equal(result.entries[0].videoUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(calls[0].binary, '/usr/local/bin/yt-dlp');
    assert.deepEqual(calls[0].args, [
      '--flat-playlist', '--playlist-end', '10', '-J', '--no-warnings', '--no-progress',
      '--cookies', cookiesPath, `https://www.youtube.com/channel/${FIRE_ID}/videos`
    ]);
    assert.equal(calls[0].options.shell, false);
    assert.ok(calls[0].options.maxBuffer <= 2 * 1024 * 1024);
    await assert.rejects(fetchChannelWithYtDlp(FIRE_ID, {
      cookiesPath: path.join(directory, 'missing.txt'), execFileImpl: async () => { throw new Error('must not run'); }
    }), { code: 'YTDLP_COOKIES_UNAVAILABLE' });
    await assert.rejects(fetchChannelWithYtDlp(FIRE_ID, {
      cookiesPath: '', execFileImpl: async () => { const error = new Error('command failed'); error.code = 'ENOENT'; throw error; }
    }), { code: 'YTDLP_UNAVAILABLE' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('雷达 RSS 回退在主凭证认证失败时使用备用凭证', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-radar-cookie-test-'));
  const names = ['YTDLP_COOKIES_PATH', 'YTDLP_COOKIES_BACKUP_1_PATH', 'YTDLP_COOKIES_BACKUP_2_PATH'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach((name, index) => {
      process.env[name] = path.join(directory, `slot-${index}.txt`);
      fs.writeFileSync(process.env[name], 'test cookie file');
    });
    const calls = [];
    const result = await fetchChannelWithYtDlp(FIRE_ID, {
      execFileImpl: async (binary, args) => {
        const selected = args[args.indexOf('--cookies') + 1];
        calls.push(selected);
        if (selected === process.env.YTDLP_COOKIES_PATH) {
          const error = new Error('yt-dlp failed');
          error.stderr = "Sign in to confirm you're not a bot";
          throw error;
        }
        return { stdout: YTDLP_JSON };
      }
    });
    assert.equal(result.entries.length, 1);
    assert.deepEqual(calls, [process.env.YTDLP_COOKIES_PATH, process.env.YTDLP_COOKIES_BACKUP_1_PATH]);
  } finally {
    names.forEach(name => { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Worker 去重入库，失败退避并保留最后成功时间', async () => {
  const db = openDatabase(':memory:');
  let clock = Date.parse('2026-09-23T03:00:00Z');
  let fail = true;
  let latestViews = 1900000;
  let publishedAt = 0;
  let durationSeconds = 615;
  const errors = [];
  const worker = createWorker({
    db,
    now: () => clock,
    logger: { warn: message => errors.push(message) },
    fetchFeed: async channelId => {
      if (channelId === FIRE_ID && fail) {
        const error = new Error('feed unavailable');
        error.code = 'HTTP_404';
        throw error;
      }
      return { entries: channelId === FIRE_ID ? [{
        videoId: 'abcdefghijk', title: 'Real item', publishedAt, latestViews, durationSeconds,
        videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
      }] : [] };
    }
  });
  try {
    const first = await worker.runOnce();
    assert.equal(first.checked, 20);
    assert.equal(first.failed, 1);
    assert.equal(first.inserted, 0);
    const failed = db.prepare('SELECT last_error_code, next_retry_at, last_success_at FROM radar_creators WHERE channel_id = ?').get(FIRE_ID);
    assert.equal(failed.last_error_code, 'HTTP_404');
    assert.equal(failed.next_retry_at, clock + 30 * 60 * 1000);
    assert.equal(failed.last_success_at, 0);
    assert.equal(errors.length, 1);

    fail = false;
    const deferred = await worker.runOnce();
    assert.equal(deferred.checked, 19);
    assert.equal(deferred.inserted, 0);
    clock += 30 * 60 * 1000;
    const recovered = await worker.runOnce();
    assert.equal(recovered.inserted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM radar_videos').get().count, 1);
    assert.deepEqual(db.prepare('SELECT published_at, latest_views FROM radar_videos WHERE video_id = ?').get('abcdefghijk'),
      { published_at: 0, latest_views: 1900000 });
    assert.equal(db.prepare('SELECT duration_seconds FROM radar_videos WHERE video_id = ?').get('abcdefghijk').duration_seconds, 615);
    assert.equal(db.prepare('SELECT last_error_code FROM radar_creators WHERE channel_id = ?').get(FIRE_ID).last_error_code, null);
    latestViews = 2000000;
    durationSeconds = 620;
    publishedAt = clock - 3600000;
    assert.equal((await worker.runOnce()).inserted, 0);
    assert.deepEqual(db.prepare('SELECT published_at, latest_views, status_badge FROM radar_videos WHERE video_id = ?').get('abcdefghijk'),
      { published_at: publishedAt, latest_views: 2000000, status_badge: 'NEW' });
    assert.equal(db.prepare('SELECT duration_seconds FROM radar_videos WHERE video_id = ?').get('abcdefghijk').duration_seconds, 620);
  } finally { db.close(); }
});
