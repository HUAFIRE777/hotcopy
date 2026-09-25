const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const runFile = promisify(execFile);
const PROBE_VIDEO_ID = 'TbkUKCm3CHQ';
const AUTH_COOLDOWN_MS = 30 * 60 * 1000;
const RATE_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_SLOT_IN_FLIGHT = 2;
const PROBE_INTERVAL_MS = 30 * 60 * 1000;
const LABELS = { primary: '主用', backup1: '备用一', backup2: '备用二' };
const state = new Map();
const inFlight = new Map();
const lastSelected = new Map();
const groupCooldown = new Map();
let selectionSequence = 0;
let activeSlot = 'primary';
let lastSwitchAt = null;

function cookieSlots(env = process.env) {
  if (env.YTDLP_EGRESS_CONFIG) {
    const config = JSON.parse(fs.readFileSync(env.YTDLP_EGRESS_CONFIG, 'utf8'));
    if (!Array.isArray(config.groups) || !config.groups.length) throw new Error('出口配置缺少 groups');
    const seen = new Set();
    return config.groups.flatMap(group => {
      if (!/^[a-z0-9_-]{2,32}$/i.test(group.id) || seen.has(group.id) ||
          !Array.isArray(group.cookies) || group.cookies.length < 1 || group.cookies.length > 2) {
        throw new Error('出口组配置无效');
      }
      seen.add(group.id);
      const proxy = new URL(group.proxy);
      if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol)) throw new Error('不支持的代理协议');
      return group.cookies.map((filePath, index) => {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Cookie 路径必须是绝对路径');
        return { name: `${group.id}_${index + 1}`, label: `${group.label || group.id} · ${index ? '备用' : '主用'}`,
          path: filePath, group: group.id, country: group.country || '', proxyUrl: group.proxy };
      });
    });
  }
  return [
    { name: 'primary', label: LABELS.primary, path: env.YTDLP_COOKIES_PATH || '/opt/hotcopy/cookies.txt' },
    { name: 'backup1', label: LABELS.backup1, path: env.YTDLP_COOKIES_BACKUP_1_PATH || '/opt/hotcopy/cookies-backup-1.txt' },
    { name: 'backup2', label: LABELS.backup2, path: env.YTDLP_COOKIES_BACKUP_2_PATH || '/opt/hotcopy/cookies-backup-2.txt' }
  ];
}

function fileInfo(filePath, fileSystem = fs) {
  try {
    const stat = fileSystem.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    return { size: stat.size, updatedAt: stat.mtimeMs, fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
  } catch { return null; }
}

function isAuthenticationError(error) {
  const detail = String(error?.stderr || error?.stdout || error?.message || '');
  return /sign in to confirm you(?:'|’)?re not a bot|sign in to confirm your age|age.restrict|members.only|cookies? (?:are |is )?(?:invalid|expired|no longer valid)|authentication required|login required/i.test(detail);
}

function classifyError(error, { proxyMode = false } = {}) {
  if (isAuthenticationError(error)) return 'auth_failed';
  const detail = String(error?.stderr || error?.stdout || error?.message || '');
  if (/rate.limit|too many requests|HTTP Error 429/i.test(detail)) return 'rate_limited';
  if (/HTTP Error 403|access denied|request blocked/i.test(detail)) return 'rate_limited';
  if (/HTTP Error 407|proxy authentication|proxy connection|proxy tunnel/i.test(detail)) return 'proxy_failed';
  if (/private video|video unavailable|not available in your country|age.restrict/i.test(detail)) return 'video_unavailable';
  if (proxyMode && (error?.killed || error?.code === 'ETIMEDOUT' ||
      [5, 6, 7, 28, 35, 52, 56].includes(Number(error?.code)) ||
      /(?:timed? out|timeout|SSL_ERROR_SYSCALL|Failed to connect|Could not resolve proxy)/i.test(detail))) {
    return 'proxy_failed';
  }
  return 'probe_failed';
}

function redactProxyError(error, proxyUrl) {
  if (!proxyUrl || !error) return error;
  for (const key of ['message', 'cmd', 'stderr', 'stdout']) {
    if (typeof error[key] === 'string') error[key] = error[key].replaceAll(proxyUrl, '[proxy redacted]');
  }
  return error;
}

function recordResult(name, filePath, status, now = Date.now(), fileSystem = fs, activate = false) {
  const info = fileInfo(filePath, fileSystem);
  const previous = state.get(name);
  state.set(name, {
    fingerprint: info?.fingerprint || null,
    status,
    lastCheckedAt: now,
    lastSuccessAt: status === 'available' ? now : previous?.lastSuccessAt || null
  });
  if (activate && status === 'available' && activeSlot !== name) {
    activeSlot = name;
    lastSwitchAt = now;
  }
}

function getCookieStatus({ env = process.env, fileSystem = fs, now = Date.now() } = {}) {
  const slots = cookieSlots(env).map(slot => {
    const info = fileInfo(slot.path, fileSystem);
    const previous = state.get(slot.name);
    const fresh = info && previous?.fingerprint === info.fingerprint;
    return {
      name: slot.name, label: slot.label, group: slot.group || null, country: slot.country || null,
      configured: Boolean(info),
      status: !info ? 'missing' : fresh ? previous.status : 'untested',
      updatedAt: info?.updatedAt || null, size: info?.size || null,
      lastCheckedAt: fresh ? previous.lastCheckedAt : null,
      lastSuccessAt: fresh ? previous.lastSuccessAt : null,
      active: activeSlot === slot.name,
      inFlight: inFlight.get(slot.name) || 0,
      coolingDownUntil: fresh && ['auth_failed', 'rate_limited', 'proxy_failed'].includes(previous.status)
        ? previous.lastCheckedAt + (previous.status === 'auth_failed' ? AUTH_COOLDOWN_MS : RATE_COOLDOWN_MS) : null
    };
  });
  const failing = slots.filter(slot => !['available', 'untested'].includes(slot.status));
  return { activeSlot, lastSwitchAt, checkedAt: now, slots,
    alert: failing.length ? { level: 'critical', slots: failing.map(slot => slot.name) } : null };
}

async function runWithCookieFailover(task, { env = process.env, fileSystem = fs, now = Date.now, anonymousOnly = false } = {}) {
  const proxyMode = Boolean(env.YTDLP_EGRESS_CONFIG);
  const configuredSlots = cookieSlots(env);
  const slots = configuredSlots.filter(slot => {
    const info = fileInfo(slot.path, fileSystem);
    if (!info) return false;
    const previous = state.get(slot.name);
    if (previous?.fingerprint === info.fingerprint &&
        ((previous.status === 'auth_failed' && now() - previous.lastCheckedAt < AUTH_COOLDOWN_MS) ||
         (['rate_limited', 'proxy_failed'].includes(previous.status) && now() - previous.lastCheckedAt < RATE_COOLDOWN_MS))) return false;
    return true;
  }).sort((a, b) => proxyMode
    ? (a.group === b.group
      ? Number(a.name.endsWith('_2')) - Number(b.name.endsWith('_2'))
      : (lastSelected.get(a.group) || 0) - (lastSelected.get(b.group) || 0))
    : ((inFlight.get(a.name) || 0) - (inFlight.get(b.name) || 0) ||
       (lastSelected.get(a.name) || 0) - (lastSelected.get(b.name) || 0)));
  let lastError;
  const blockedGroups = new Set();
  const cookieEligibleGroups = new Set();
  const anonymousGroups = proxyMode
    ? [...new Map(configuredSlots.map(slot => [slot.group, slot.proxyUrl])).entries()]
      .filter(([group]) => (groupCooldown.get(group) || 0) <= now())
      .sort((a, b) => (lastSelected.get(a[0]) || 0) - (lastSelected.get(b[0]) || 0))
    : [[null, null]];

  for (const [group, proxyUrl] of anonymousGroups) {
    const name = group ? `${group}_anon` : 'public';
    if ((inFlight.get(name) || 0) >= MAX_SLOT_IN_FLIGHT) continue;
    inFlight.set(name, (inFlight.get(name) || 0) + 1);
    if (group) lastSelected.set(group, ++selectionSequence);
    try {
      const result = await task(null, name, proxyUrl);
      if (group) groupCooldown.delete(group);
      if (activeSlot !== name) { activeSlot = name; lastSwitchAt = now(); }
      return result;
    } catch (error) {
      const status = classifyError(error, { proxyMode });
      redactProxyError(error, proxyUrl);
      lastError = error;
      if (status === 'video_unavailable') throw error;
      if ((status === 'rate_limited' && /(?:HTTP Error )?429/i.test(String(error.stderr || error.message || ''))) ||
          status === 'proxy_failed') {
        if (group) {
          blockedGroups.add(group);
          groupCooldown.set(group, now() + RATE_COOLDOWN_MS);
        } else if (status === 'rate_limited') throw error;
      } else if (group) {
        cookieEligibleGroups.add(group);
      } else {
        cookieEligibleGroups.add('direct');
      }
    } finally {
      inFlight.set(name, Math.max(0, (inFlight.get(name) || 1) - 1));
    }
  }

  if (anonymousOnly || !cookieEligibleGroups.size) {
    throw lastError || Object.assign(new Error('YouTube 提取任务繁忙，请稍后重试'), { code: 'YOUTUBE_BUSY' });
  }
  for (const slot of slots) {
    if (!cookieEligibleGroups.has(slot.group || 'direct')) continue;
    if (blockedGroups.has(slot.group)) continue;
    if ((inFlight.get(slot.name) || 0) >= MAX_SLOT_IN_FLIGHT) continue;
    inFlight.set(slot.name, (inFlight.get(slot.name) || 0) + 1);
    lastSelected.set(slot.name, ++selectionSequence);
    if (proxyMode) lastSelected.set(slot.group, selectionSequence);
    try {
      const result = await task(slot.path, slot.name, slot.proxyUrl || null);
      recordResult(slot.name, slot.path, 'available', now(), fileSystem, true);
      return result;
    } catch (error) {
      const status = classifyError(error, { proxyMode });
      redactProxyError(error, slot.proxyUrl);
      if (!['auth_failed', 'rate_limited', 'proxy_failed'].includes(status)) throw error;
      recordResult(slot.name, slot.path, status, now(), fileSystem);
      lastError = error;
      if (proxyMode && ['rate_limited', 'proxy_failed'].includes(status)) {
        blockedGroups.add(slot.group);
        for (const peer of slots.filter(peer => peer.group === slot.group && peer.name !== slot.name)) {
          recordResult(peer.name, peer.path, status, now(), fileSystem);
        }
      }
    } finally {
      inFlight.set(slot.name, Math.max(0, (inFlight.get(slot.name) || 1) - 1));
    }
  }
  throw lastError || Object.assign(new Error('所有代理出口繁忙或不可用'), { code: 'YOUTUBE_EGRESS_UNAVAILABLE' });
}

async function probeCookieFile(filePath, {
  run = runFile, binary = process.env.YTDLP_BIN || 'yt-dlp', timeoutMs = 25000, proxyUrl = null
} = {}) {
  const args = [...(proxyUrl ? ['--proxy', proxyUrl] : []), '--cookies', filePath, '--skip-download', '--no-playlist', '--no-warnings',
    '--no-progress', '--socket-timeout', '8', '--retries', '1', '--print', '%(id)s',
    `https://www.youtube.com/watch?v=${PROBE_VIDEO_ID}`];
  const { stdout = '' } = await run(binary, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false });
  if (!String(stdout).split(/\s+/).includes(PROBE_VIDEO_ID)) throw new Error('公开视频探针没有返回预期视频');
  return true;
}

async function probeSlot(name, options = {}) {
  const slot = cookieSlots(options.env).find(entry => entry.name === name);
  if (!slot) throw new Error('无效的凭证位置');
  if (!fileInfo(slot.path, options.fileSystem || fs)) {
    state.delete(slot.name);
    return getCookieStatus(options);
  }
  try {
    await probeCookieFile(slot.path, { ...options, proxyUrl: slot.proxyUrl });
    recordResult(slot.name, slot.path, 'available', Date.now(), options.fileSystem || fs);
  } catch (error) {
    recordResult(slot.name, slot.path, classifyError(error, { proxyMode: Boolean(slot.proxyUrl) }), Date.now(), options.fileSystem || fs);
  }
  return getCookieStatus(options);
}

function validateCookieContent(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 256 * 1024 || content.length < 50) return false;
  const lines = content.trim().split(/\r?\n/);
  const header = lines.some(line => /^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/i.test(line));
  const youtubeRow = lines.some(line => {
    const columns = line.replace(/^#HttpOnly_/, '').split(/\t| +/);
    return columns.length >= 7 && /^\.?youtube\.com$/i.test(columns[0]) && Boolean(columns[5]);
  });
  return header && youtubeRow;
}

async function updateCookieSlot(name, content, options = {}) {
  const slot = cookieSlots(options.env).find(entry => entry.name === name);
  if (!slot) throw new Error('无效的凭证位置');
  if (!validateCookieContent(content)) throw new Error('请提供完整的 YouTube Netscape 格式 Cookie 文件');
  const fileSystem = options.fileSystem || fs;
  const tempPath = path.join(path.dirname(slot.path), `.${path.basename(slot.path)}.${process.pid}.${Date.now()}.tmp`);
  let created = false;
  try {
    fileSystem.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    await probeCookieFile(tempPath, { ...options, proxyUrl: slot.proxyUrl });
    fileSystem.chmodSync(tempPath, 0o600);
    fileSystem.renameSync(tempPath, slot.path);
    recordResult(name, slot.path, 'available', Date.now(), fileSystem);
    return getCookieStatus(options);
  } finally {
    if (created) { try { fileSystem.unlinkSync(tempPath); } catch {} }
  }
}

function startCookieMonitoring(options = {}) {
  const probeAll = async () => {
    for (const name of cookieSlots(options.env).map(slot => slot.name)) {
      try { await probeSlot(name, options); } catch {} // The status endpoint reports each failure.
    }
  };
  const initial = setTimeout(probeAll, 60000);
  const interval = setInterval(probeAll, PROBE_INTERVAL_MS);
  initial.unref?.();
  interval.unref?.();
  return () => { clearTimeout(initial); clearInterval(interval); };
}

module.exports = {
  cookieSlots, getCookieStatus, isAuthenticationError, classifyError,
  runWithCookieFailover, probeCookieFile, probeSlot, updateCookieSlot,
  validateCookieContent, startCookieMonitoring
};
