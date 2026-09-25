const { execFile } = require('child_process');
const { promisify } = require('util');
const { runWithCookieFailover } = require('./youtube_cookie_pool');

const runFile = promisify(execFile);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const CLIENT_VERSION = process.env.YOUTUBE_ANDROID_CLIENT_VERSION || '21.26.364';

function parseJson3Transcript(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  let transcript = '';
  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const cue = event.segs.map(segment => segment?.utf8 || '').join('')
      .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, entity =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[entity] || entity)
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cue || /^(?:\[(?:music|applause|音乐|掌声)\]|♪+)$/i.test(cue)) continue;
    if (!transcript) { transcript = cue; continue; }
    let overlap = 0;
    for (let size = Math.min(250, transcript.length, cue.length); size > 0; size--) {
      if (transcript.endsWith(cue.slice(0, size))) { overlap = size; break; }
    }
    if (overlap === cue.length) continue;
    transcript += `${overlap >= 3 ? '' : ' '}${cue.slice(overlap >= 3 ? overlap : 0)}`;
  }
  return transcript.trim();
}

function selectCaptionTrack(tracks, audioTracks = []) {
  const defaultIndex = audioTracks.find(track => Number.isInteger(track?.defaultCaptionTrackIndex))
    ?.defaultCaptionTrackIndex;
  const originalLanguage = tracks[defaultIndex]?.languageCode?.toLowerCase().split('-')[0];
  const rank = track => {
    const lang = String(track.languageCode || '').toLowerCase();
    const languageRank = originalLanguage && lang.split('-')[0] === originalLanguage ? 0
      : lang === 'zh' || lang.startsWith('zh-') ? 1
        : lang === 'en' || lang.startsWith('en-') ? 2 : 3;
    return languageRank * 2 + (track.kind === 'asr' ? 1 : 0);
  };
  return [...tracks].filter(track => typeof track?.baseUrl === 'string')
    .sort((a, b) => rank(a) - rank(b))[0];
}

async function curlRequest(url, { body, proxyUrl, run = runFile, timeoutMs = 18000 } = {}) {
  const args = ['-q', '-sS', '--proto', '=https', '--connect-timeout', '6',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--compressed', '-w', '\n__HOTCOPY_HTTP__%{http_code}'];
  let normalizedProxy;
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    if (proxy.protocol === 'socks5:') proxy.protocol = 'socks5h:';
    normalizedProxy = proxy.toString();
    args.push('--proxy', normalizedProxy);
  }
  if (body) {
    args.push('-H', 'Content-Type: application/json',
      '-H', `User-Agent: com.google.android.youtube/${CLIENT_VERSION} (Linux; U; Android 11) gzip`,
      '--data-raw', JSON.stringify(body));
  }
  args.push(url);
  let stdout;
  try {
    ({ stdout } = await run('curl', args, {
      timeout: timeoutMs + 1000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      shell: false
    }));
  } catch (error) {
    for (const field of ['message', 'cmd', 'stderr', 'stdout']) {
      if (normalizedProxy && typeof error[field] === 'string') {
        error[field] = error[field].replaceAll(normalizedProxy, '[proxy redacted]');
      }
    }
    throw error;
  }
  const marker = '\n__HOTCOPY_HTTP__';
  const at = stdout.lastIndexOf(marker);
  if (at < 0) throw new Error('YouTube 接口响应格式无效');
  const status = Number(stdout.slice(at + marker.length));
  if (status < 200 || status >= 300) throw new Error(`HTTP Error ${status}`);
  return JSON.parse(stdout.slice(0, at));
}

async function fetchYouTubeCaptionsInnerTube(videoId, options = {}) {
  if (!VIDEO_ID.test(videoId || '')) throw new Error('无效的 YouTube 视频 ID');
  const request = options.request || curlRequest;
  const attempt = async (_cookiePath, _slot, proxyUrl) => {
    const player = await request(PLAYER_URL, {
      proxyUrl, body: {
        context: { client: { clientName: 'ANDROID', clientVersion: CLIENT_VERSION,
          androidSdkVersion: 30, hl: 'zh-CN' } },
        videoId
      }
    });
    if (player?.playabilityStatus?.status === 'LOGIN_REQUIRED') {
      throw new Error("Sign in to confirm you're not a bot");
    }
    const trackList = player?.captions?.playerCaptionsTracklistRenderer;
    const tracks = trackList?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) return '';
    const track = selectCaptionTrack(tracks, trackList.audioTracks);
    if (!track) return '';
    const captionUrl = new URL(track.baseUrl);
    if (captionUrl.protocol !== 'https:' ||
        !['youtube.com', 'www.youtube.com'].includes(captionUrl.hostname)) {
      throw new Error('YouTube 字幕地址无效');
    }
    captionUrl.searchParams.set('fmt', 'json3');
    return parseJson3Transcript(await request(captionUrl.toString(), { proxyUrl }));
  };
  return (options.failover || runWithCookieFailover)(attempt, { anonymousOnly: true });
}

module.exports = { parseJson3Transcript, selectCaptionTrack, curlRequest, fetchYouTubeCaptionsInnerTube };
