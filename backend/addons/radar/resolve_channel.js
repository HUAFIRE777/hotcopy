const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runWithCookieFailover } = require('../../youtube_cookie_pool');

const execFileAsync = promisify(execFile);
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function canonicalChannelUrl(input) {
  if (typeof input !== 'string' || input.length > 300) return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
  const path = url.pathname.replace(/\/$/, '').replace(/\/videos$/, '');
  if (/^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(path) || /^\/@[A-Za-z0-9._-]{3,30}$/.test(path)) {
    return `https://www.youtube.com${path}/videos`;
  }
  return null;
}

async function resolveChannel(input, { execFileImpl = execFileAsync,
  binaryPath = process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp' } = {}) {
  const url = canonicalChannelUrl(input);
  if (!url) throw new Error('请粘贴 YouTube 博主的 @主页或 /channel/ 链接');
  const attempt = async cookiesPath => {
    const args = ['--flat-playlist', '--playlist-end', '1', '-J', '--no-warnings', '--no-progress'];
    if (cookiesPath) {
      const stat = await fs.stat(cookiesPath);
      if (!stat.isFile()) throw new Error('频道认证文件不可用');
      args.push('--cookies', cookiesPath);
    }
    args.push(url);
    const { stdout } = await execFileImpl(binaryPath, args, {
      timeout: 30000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true
    });
    const info = JSON.parse(stdout);
    const channelId = [info.channel_id, info.id, url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1]]
      .find(value => CHANNEL_ID.test(value || ''));
    const name = String(info.channel || info.uploader || info.title || '').trim().slice(0, 100);
    if (!channelId || !name) throw new Error('无法确认该 YouTube 频道，请检查主页链接');
    return { channelId, name, url: `https://www.youtube.com/channel/${channelId}` };
  };
  return runWithCookieFailover(attempt);
}

module.exports = { canonicalChannelUrl, resolveChannel };
