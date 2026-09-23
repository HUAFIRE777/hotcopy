const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { runWithCookieFailover } = require('./youtube_cookie_pool');

const runFile = promisify(execFile);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SUBTITLE_LANGUAGES = 'en,zh,zh-Hans,zh-Hant';

function extractYouTubeId(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const candidates = input.trim().match(/https?:\/\/[^\s<>"']+/gi) || [];
  if (!candidates.length && /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(input.trim())) {
    candidates.push(`https://${input.trim()}`);
  }

  for (const candidate of candidates) {
    let url;
    try { url = new URL(candidate.replace(/[),，。.!！]+$/, '')); } catch { continue; }
    const host = url.hostname.toLowerCase();
    let id = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = url.pathname.split('/')[1];
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
               host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'watch') id = url.searchParams.get('v');
      else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1];
    }
    if (VIDEO_ID.test(id || '')) return id;
  }
  return null;
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x([0-9a-f]+)|#(\d+));/gi, (entity, hex, decimal) => {
    if (hex || decimal) {
      const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&#39;': "'" })[entity.toLowerCase()] || entity;
  });
}

function parseVttTranscript(vtt) {
  if (typeof vtt !== 'string') return '';
  let transcript = '';
  const blocks = vtt.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const cueIndex = lines.findIndex(line => line.includes('-->'));
    if (cueIndex < 0) continue;
    const cue = decodeEntities(lines.slice(cueIndex + 1).join(' ')
      .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!cue || /^(?:\[(?:music|applause|音乐|掌声)\]|♪+)$/i.test(cue)) continue;
    if (!transcript) { transcript = cue; continue; }
    const maxOverlap = Math.min(250, transcript.length, cue.length);
    let overlap = 0;
    for (let size = maxOverlap; size > 0; size--) {
      if (transcript.endsWith(cue.slice(0, size))) { overlap = size; break; }
    }
    if (overlap === cue.length) continue;
    if (overlap < 3) overlap = 0;
    transcript += `${overlap ? '' : ' '}${cue.slice(overlap)}`;
  }
  return transcript.trim();
}

function subtitlePriority(filename, preferredLanguage) {
  const match = filename.match(/\.((?:en|zh)(?:-[A-Za-z]+)?)\.vtt$/i);
  const language = match?.[1]?.toLowerCase() || '';
  const preferred = String(preferredLanguage || '').toLowerCase();
  if (preferred && (language === preferred || language.startsWith(`${preferred}-`))) return 0;
  if (preferred.startsWith('zh') && language.startsWith('zh')) return 1;
  return ({ en: 2, zh: 3, 'zh-hans': 4, 'zh-hant': 5 })[language] ?? 10;
}

async function fetchYouTubeCaptionsFast(videoId, options = {}) {
  if (!VIDEO_ID.test(videoId || '')) throw new Error('无效的 YouTube 视频 ID');
  const fileSystem = options.fs || fs;
  const runner = options.run || runFile;
  const tmpDir = await fileSystem.promises.mkdtemp(path.join(options.tmpRoot || os.tmpdir(), 'hotcopy-yt-sub-'));
  try {
    const attempt = async cookiesPath => {
      for (const name of await fileSystem.promises.readdir(tmpDir)) {
        await fileSystem.promises.unlink(path.join(tmpDir, name));
      }
      const args = [];
      if (cookiesPath) args.push('--cookies', cookiesPath);
      args.push('--write-subs', '--write-auto-subs', '--sub-langs', SUBTITLE_LANGUAGES,
        '--sub-format', 'vtt', '--skip-download', '--no-playlist', '--no-progress',
        '--retries', '1', '--fragment-retries', '1', '--socket-timeout', '8',
        '--no-simulate', '--print', '%(language)s', '-o', path.join(tmpDir, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`);
      const { stdout = '' } = await runner(options.binary || process.env.YTDLP_BIN || 'yt-dlp', args, {
        timeout: options.timeoutMs || 30000,
        maxBuffer: 2 * 1024 * 1024,
        shell: false
      });
      const preferredLanguage = String(stdout).trim().split(/\s+/).pop();
      const files = (await fileSystem.promises.readdir(tmpDir))
        .filter(name => name.startsWith(`${videoId}.`) && name.endsWith('.vtt'))
        .sort((a, b) => subtitlePriority(a, preferredLanguage) - subtitlePriority(b, preferredLanguage));
      for (const filename of files) {
        const transcript = parseVttTranscript(await fileSystem.promises.readFile(path.join(tmpDir, filename), 'utf8'));
        if (transcript.length >= 10) return transcript;
      }
      return '';
    };
    if (Object.hasOwn(options, 'cookiesPath')) {
      if (options.cookiesPath && !fileSystem.existsSync(options.cookiesPath)) throw new Error('字幕 Cookie 文件不可用');
      return attempt(options.cookiesPath);
    }
    return runWithCookieFailover(attempt);
  } finally {
    await fileSystem.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

async function getYouTubeTranscript(videoId, { captions = fetchYouTubeCaptionsFast, legacy, whisper, onFallback = () => {} }) {
  if (!VIDEO_ID.test(videoId || '')) throw new Error('无效的 YouTube 视频 ID');
  for (const [stage, fetcher] of [['yt-dlp 字幕', captions], ['备用字幕', legacy], ['音频听译', whisper]]) {
    if (typeof fetcher !== 'function') continue;
    try {
      const result = await fetcher(videoId);
      const text = typeof result === 'string' ? result.trim() : '';
      if (text) return { text, source: stage };
      onFallback(stage, new Error('未返回有效对白'));
    } catch (error) {
      onFallback(stage, error);
      if (stage === '音频听译') {
        if (/unavailable|private|deleted|下架|私密|不存在|年龄限制|age.restrict/i.test(error.message || '')) {
          throw new Error('该视频已下架、设为私密或限制访问，请尝试其他链接');
        }
        throw new Error('该视频暂时无法提取字幕或音频，请稍后重试');
      }
    }
  }
  throw new Error('该视频没有可用字幕，也未识别到有效人声对白');
}

module.exports = { extractYouTubeId, parseVttTranscript, fetchYouTubeCaptionsFast, getYouTubeTranscript };
