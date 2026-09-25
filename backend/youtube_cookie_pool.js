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
const SLOT_NAMES = ['primary', 'backup1', 'backup2'];
const LABELS = { primary: '主用', backup1: '备用一', backup2: '备用二' };
const state = new Map();
const inFlight = new Map();
const lastSelected = new Map();
let selectionSequence = 0;
let activeSlot = 'primary';
let lastSwitchAt = null;

function cookieSlots(env = process.env) {
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
  return /sign in to confirm you(?:'|’)?re not a bot|cookies? (?:are |is )?(?:invalid|expired|no longer valid)|authentication required|login required/i.test(detail);
}

function classifyError(error) {
  if (isAuthenticationError(error)) return 'auth_failed';
  const detail = String(error?.stderr || error?.stdout || error?.message || '');
  if (/rate.limit|too many requests|HTTP Error 429/i.test(detail)) return 'rate_limited';
  if (/private video|video unavailable|not available in your country|age.restrict/i.test(detail)) return 'video_unavailable';
  return 'probe_failed';
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
      name: slot.name, label: slot.label, configured: Boolean(info),
      status: !info ? 'missing' : fresh ? previous.status : 'untested',
      updatedAt: info?.updatedAt || null, size: info?.size || null,
      lastCheckedAt: fresh ? previous.lastCheckedAt : null,
      lastSuccessAt: fresh ? previous.lastSuccessAt : null,
      active: activeSlot === slot.name,
      inFlight: inFlight.get(slot.name) || 0,
      coolingDownUntil: fresh && ['auth_failed', 'rate_limited'].includes(previous.status)
        ? previous.lastCheckedAt + (previous.status === 'rate_limited' ? RATE_COOLDOWN_MS : AUTH_COOLDOWN_MS) : null
    };
  });
  const failing = slots.filter(slot => !['available', 'untested'].includes(slot.status));
  return { activeSlot, lastSwitchAt, checkedAt: now, slots,
    alert: failing.length ? { level: 'critical', slots: failing.map(slot => slot.name) } : null };
}

async function runWithCookieFailover(task, { env = process.env, fileSystem = fs, now = Date.now } = {}) {
  const slots = cookieSlots(env).filter(slot => {
    const info = fileInfo(slot.path, fileSystem);
    if (!info) return false;
    const previous = state.get(slot.name);
    if (previous?.fingerprint === info.fingerprint &&
        ((previous.status === 'auth_failed' && now() - previous.lastCheckedAt < AUTH_COOLDOWN_MS) ||
         (previous.status === 'rate_limited' && now() - previous.lastCheckedAt < RATE_COOLDOWN_MS))) return false;
    return true;
  }).sort((a, b) => (inFlight.get(a.name) || 0) - (inFlight.get(b.name) || 0) ||
    (lastSelected.get(a.name) || 0) - (lastSelected.get(b.name) || 0));
  let lastAuthError;
  for (const slot of slots) {
    if ((inFlight.get(slot.name) || 0) >= MAX_SLOT_IN_FLIGHT) continue;
    inFlight.set(slot.name, (inFlight.get(slot.name) || 0) + 1);
    lastSelected.set(slot.name, ++selectionSequence);
    try {
      const result = await task(slot.path, slot.name);
      recordResult(slot.name, slot.path, 'available', now(), fileSystem, true);
      return result;
    } catch (error) {
      const status = classifyError(error);
      if (!['auth_failed', 'rate_limited'].includes(status)) throw error;
      recordResult(slot.name, slot.path, status, now(), fileSystem);
      lastAuthError = error;
    } finally {
      inFlight.set(slot.name, Math.max(0, (inFlight.get(slot.name) || 1) - 1));
    }
  }
  if ((inFlight.get('public') || 0) >= MAX_SLOT_IN_FLIGHT) {
    throw Object.assign(new Error('YouTube 提取任务繁忙，请稍后重试'), { code: 'YOUTUBE_BUSY' });
  }
  inFlight.set('public', (inFlight.get('public') || 0) + 1);
  try {
    const result = await task(null, 'public');
    if (activeSlot !== 'public') { activeSlot = 'public'; lastSwitchAt = now(); }
    return result;
  }
  catch (publicError) { throw publicError || lastAuthError; }
  finally { inFlight.set('public', Math.max(0, (inFlight.get('public') || 1) - 1)); }
}

async function probeCookieFile(filePath, {
  run = runFile, binary = process.env.YTDLP_BIN || 'yt-dlp', timeoutMs = 25000
} = {}) {
  const args = ['--cookies', filePath, '--skip-download', '--no-playlist', '--no-warnings',
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
    await probeCookieFile(slot.path, options);
    recordResult(slot.name, slot.path, 'available', Date.now(), options.fileSystem || fs);
  } catch (error) {
    recordResult(slot.name, slot.path, classifyError(error), Date.now(), options.fileSystem || fs);
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
    await probeCookieFile(tempPath, options);
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
    for (const name of SLOT_NAMES) {
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
