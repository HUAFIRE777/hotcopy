const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_FEED_CHARS = 300000;
const MAX_YTDLP_OUTPUT_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function feedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (full, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[1]?.toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : full;
  });
}

function tagText(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  if (!match) return '';
  const raw = match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '');
  return decodeXml(raw.trim());
}

function parseYouTubeFeed(xml, expectedChannelId) {
  if (!CHANNEL_ID_PATTERN.test(expectedChannelId) || typeof xml !== 'string' ||
      xml.length > MAX_FEED_CHARS || !/<feed\b/i.test(xml)) {
    throw feedError('INVALID_FEED');
  }
  const firstEntry = xml.search(/<entry\b/i);
  const feedHeader = xml.slice(0, firstEntry < 0 ? xml.length : firstEntry);
  const selfLink = [...feedHeader.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .find(link => /\brel=["']self["']/i.test(link))
    ?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!selfLink) throw feedError('INVALID_FEED');
  let selfChannelId;
  try {
    const selfUrl = new URL(decodeXml(selfLink));
    if (!['www.youtube.com', 'youtube.com'].includes(selfUrl.hostname) ||
        selfUrl.pathname !== '/feeds/videos.xml') throw feedError('INVALID_FEED');
    selfChannelId = selfUrl.searchParams.get('channel_id');
  } catch {
    throw feedError('INVALID_FEED');
  }
  if (selfChannelId !== expectedChannelId) throw feedError('CHANNEL_MISMATCH');
  const entries = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    const videoId = tagText(entry, 'yt:videoId');
    const channelId = tagText(entry, 'yt:channelId');
    const title = tagText(entry, 'title');
    const publishedAt = Date.parse(tagText(entry, 'published'));
    if (channelId !== expectedChannelId) throw feedError('CHANNEL_MISMATCH');
    if (!VIDEO_ID_PATTERN.test(videoId) || !title || !Number.isFinite(publishedAt)) {
      throw feedError('INVALID_ENTRY');
    }
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    const thumbnail = entry.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i)?.[1];
    entries.push({
      videoId,
      title,
      publishedAt,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: thumbnail ? decodeXml(thumbnail) : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    });
  }
  return { channelTitle: tagText(feedHeader, 'title'), entries };
}

function parseYtDlpPlaylist(raw, expectedChannelId) {
  let playlist;
  try {
    playlist = JSON.parse(raw);
  } catch {
    throw feedError('YTDLP_BAD_JSON');
  }
  if (!playlist || !Array.isArray(playlist.entries) ||
      playlist.id !== expectedChannelId ||
      (playlist.channel_id && playlist.channel_id !== expectedChannelId)) {
    throw feedError('YTDLP_CHANNEL_MISMATCH');
  }
  const entries = [];
  const seen = new Set();
  for (const video of playlist.entries.slice(0, 10)) {
    if (!video) continue;
    const videoId = video.id;
    if (!VIDEO_ID_PATTERN.test(videoId) || typeof video.title !== 'string' || !video.title.trim()) {
      throw feedError('YTDLP_INVALID_ENTRY');
    }
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    const timestamp = Number.isFinite(video.timestamp) && video.timestamp > 0
      ? video.timestamp : Number.isFinite(video.release_timestamp) && video.release_timestamp > 0
        ? video.release_timestamp : 0;
    const publishedAt = timestamp ? Math.round(timestamp * 1000) : 0;
    const thumbnails = Array.isArray(video.thumbnails) ? video.thumbnails : [];
    const thumbnail = [video.thumbnail, ...thumbnails.map(item => item?.url)]
      .find(url => typeof url === 'string' && /^https:\/\/i\.ytimg\.com\//.test(url));
    const latestViews = Number.isSafeInteger(video.view_count) && video.view_count >= 0
      ? video.view_count : null;
    entries.push({
      videoId,
      title: video.title.trim(),
      publishedAt,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      latestViews
    });
  }
  return { channelTitle: typeof playlist.title === 'string' ? playlist.title : '', entries };
}

async function fetchChannelWithYtDlp(channelId, {
  execFileImpl = execFileAsync,
  binaryPath = process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp',
  cookiesPath = process.env.YTDLP_COOKIES_PATH,
  timeoutMs = 30000
} = {}) {
  if (!CHANNEL_ID_PATTERN.test(channelId)) throw feedError('INVALID_CHANNEL_ID');
  const args = ['--flat-playlist', '--playlist-end', '10', '-J', '--no-warnings', '--no-progress'];
  if (cookiesPath) {
    let stats;
    try { stats = await fs.stat(cookiesPath); } catch { throw feedError('YTDLP_COOKIES_UNAVAILABLE'); }
    if (!stats.isFile()) throw feedError('YTDLP_COOKIES_UNAVAILABLE');
    args.push('--cookies', cookiesPath);
  }
  args.push(`https://www.youtube.com/channel/${channelId}/videos`);
  let stdout;
  try {
    ({ stdout } = await execFileImpl(binaryPath, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_YTDLP_OUTPUT_BYTES,
      windowsHide: true,
      shell: false
    }));
  } catch (error) {
    throw feedError(error.code === 'ENOENT' ? 'YTDLP_UNAVAILABLE'
      : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'YTDLP_OUTPUT_TOO_LARGE'
        : error.killed ? 'YTDLP_TIMEOUT' : 'YTDLP_FAILED');
  }
  return parseYtDlpPlaylist(stdout, channelId);
}

async function fetchRssFeed(channelId, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!CHANNEL_ID_PATTERN.test(channelId)) throw feedError('INVALID_CHANNEL_ID');
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw feedError(error.name === 'TimeoutError' ? 'FEED_TIMEOUT' : 'FEED_NETWORK_ERROR');
  }
  if (!response.ok) throw feedError(`HTTP_${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/xml|atom/i.test(contentType)) throw feedError('NON_XML_RESPONSE');
  const xml = await response.text();
  if (xml.length > MAX_FEED_CHARS) throw feedError('FEED_TOO_LARGE');
  return parseYouTubeFeed(xml, channelId);
}

async function fetchChannelFeed(channelId, {
  fallbackImpl = fetchChannelWithYtDlp,
  ...rssOptions
} = {}) {
  if (!CHANNEL_ID_PATTERN.test(channelId)) throw feedError('INVALID_CHANNEL_ID');
  try {
    return await fetchRssFeed(channelId, rssOptions);
  } catch {
    return fallbackImpl(channelId);
  }
}

module.exports = {
  fetchChannelFeed, fetchChannelWithYtDlp, fetchRssFeed,
  parseYouTubeFeed, parseYtDlpPlaylist, decodeXml, CHANNEL_ID_PATTERN
};
