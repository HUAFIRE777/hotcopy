const { execFile } = require('child_process');
const { promisify } = require('util');
const { runWithCookieFailover } = require('../youtube_cookie_pool');
const { extractYouTubeId } = require('../youtube_transcript');

const runFile = promisify(execFile);
const SUPPORTED_MODES = new Set(['raw', 'summary', 'rewrite', 'translate']);

function parseSource(input) {
  const url = typeof input === 'string' ? input.trim() : '';
  if (!url || url.length > 2048) throw new Error('请提供有效的内容链接');
  const ytId = extractYouTubeId(url);
  if (ytId) return { platform: 'youtube', videoId: ytId,
    url: `https://www.youtube.com/watch?v=${ytId}` };
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('链接格式无效'); }
  if (parsed.protocol !== 'https:') throw new Error('仅支持 HTTPS 内容链接');
  const host = parsed.hostname.toLowerCase();
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') {
    const id = url.match(/BV[A-Za-z0-9]{10}/)?.[0];
    return { platform: 'bilibili', videoId: id ? `bili_${id}` : `bili_url_${hash(url)}`, url };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    return { platform: 'tiktok', videoId: `tk_${hash(url)}`, url };
  }
  if (host === 'podcasts.apple.com' || host === 'xiaoyuzhoufm.com' || host.endsWith('.xiaoyuzhoufm.com')) {
    return { platform: 'podcast', videoId: `pod_${hash(url)}`, url };
  }
  // Direct audio URLs are temporarily disabled in the queued route: ffprobe and
  // FFmpeg may follow redirects into private networks when pointed at user URLs.
  throw new Error('当前任务队列支持 YouTube、B站、TikTok、Apple Podcasts 和小宇宙链接');
}

function hash(value) { return require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 20); }

function cacheMode(mode, model, options = {}) {
  if (mode === 'script') {
    const pointKey = options.point_ids?.length ? hash([...options.point_ids].sort().join(',')) : 'all';
    return `script:${options.platform}:${options.format}:${pointKey}${model ? ':' + hash(model) : ''}`;
  }
  return mode === 'rewrite' && model ? `rewrite:model:${hash(model)}` : mode;
}

function parseDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600) {
    throw new Error('无法确认内容时长，暂不扣次数');
  }
  return Math.ceil(duration);
}

async function youtubeDuration(videoId, { run = runFile, failover = runWithCookieFailover } = {}) {
  const attempt = async (cookiePath, _slot, proxyUrl) => {
    const args = ['--no-playlist', '--skip-download', '--no-warnings', '--print', '%(duration)s',
      '--socket-timeout', '15', '--retries', '1'];
    if (proxyUrl) args.push('--proxy', proxyUrl);
    if (cookiePath) args.push('--cookies', cookiePath);
    args.push(`https://www.youtube.com/watch?v=${videoId}`);
    const { stdout } = await run(process.env.YTDLP_BIN || 'yt-dlp', args,
      { timeout: 45_000, maxBuffer: 1024 * 1024, shell: false });
    return parseDuration(String(stdout).trim().split(/\s+/).pop());
  };
  return failover(attempt);
}

async function ffprobeDuration(audioUrl, { run = runFile } = {}) {
  const parsed = new URL(audioUrl);
  if (parsed.protocol !== 'https:') throw new Error('音频地址必须使用 HTTPS');
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', audioUrl],
  { timeout: 30_000, maxBuffer: 1024 * 1024, shell: false });
  return parseDuration(String(stdout).trim());
}

async function ffprobeLocalDuration(file, { run = runFile } = {}) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file],
  { timeout: 30_000, maxBuffer: 1024 * 1024, shell: false });
  return parseDuration(String(stdout).trim());
}

module.exports = { SUPPORTED_MODES, parseSource, cacheMode, parseDuration,
  youtubeDuration, ffprobeDuration, ffprobeLocalDuration };
