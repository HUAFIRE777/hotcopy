const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cookieSlots, getCookieStatus, isAuthenticationError, runWithCookieFailover,
  probeSlot, updateCookieSlot, validateCookieContent
} = require('./youtube_cookie_pool');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-cookie-test-'));
  const env = {
    YTDLP_COOKIES_PATH: path.join(directory, 'primary.txt'),
    YTDLP_COOKIES_BACKUP_1_PATH: path.join(directory, 'backup1.txt'),
    YTDLP_COOKIES_BACKUP_2_PATH: path.join(directory, 'backup2.txt')
  };
  return { directory, env, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

const validContent = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tLOGIN_INFO\ttest-value\n';

test('三套凭证路径独立，文件存在只标待检测', () => {
  const context = fixture();
  try {
    fs.writeFileSync(context.env.YTDLP_COOKIES_PATH, validContent);
    assert.deepEqual(cookieSlots(context.env).map(slot => slot.name), ['primary', 'backup1', 'backup2']);
    const status = getCookieStatus({ env: context.env });
    assert.equal(status.slots[0].status, 'untested');
    assert.equal(status.slots[1].status, 'missing');
    assert.equal(status.slots[2].status, 'missing');
    assert.equal(JSON.stringify(status).includes('test-value'), false);
  } finally { context.close(); }
});

test('只有明确的认证错误才切换到备用；普通错误立即抛出', async () => {
  const context = fixture();
  try {
    for (const slot of cookieSlots(context.env)) fs.writeFileSync(slot.path, validContent);
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name) => {
      calls.push(name);
      if (name === 'primary') throw Object.assign(new Error('yt-dlp failed'), { stderr: "Sign in to confirm you're not a bot" });
      return 'caption';
    }, { env: context.env });
    assert.equal(result, 'caption');
    assert.deepEqual(calls, ['primary', 'backup1']);
    const status = getCookieStatus({ env: context.env });
    assert.equal(status.activeSlot, 'backup1');
    assert.equal(status.slots[0].status, 'auth_failed');
    assert.equal(status.slots[1].status, 'available');
    const otherCalls = [];
    await assert.rejects(runWithCookieFailover(async (filePath, name) => {
      otherCalls.push(name);
      throw new Error('Video unavailable');
    }, { env: context.env }), /Video unavailable/);
    assert.equal(otherCalls.length, 1);
    assert.ok(['backup1', 'backup2'].includes(otherCalls[0]));
    assert.equal(isAuthenticationError(new Error('Sign in to confirm your age')), false);
  } finally { context.close(); }
});

test('主备均认证失败时仍可尝试公开视频模式', async () => {
  const context = fixture();
  try {
    for (const slot of cookieSlots(context.env)) fs.writeFileSync(slot.path, validContent);
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name) => {
      calls.push(name);
      if (filePath) throw new Error("Sign in to confirm you're not a bot");
      return 'public captions';
    }, { env: context.env });
    assert.equal(result, 'public captions');
    assert.deepEqual(calls, ['primary', 'backup1', 'backup2', 'public']);
  } finally { context.close(); }
});

test('三套凭证轮流处理请求，429 时尝试下一套并记录红色告警', async () => {
  const context = fixture();
  try {
    for (const slot of cookieSlots(context.env)) fs.writeFileSync(slot.path, validContent);
    const picked = [];
    for (let i = 0; i < 3; i++) {
      await runWithCookieFailover(async (_filePath, name) => { picked.push(name); return 'ok'; }, { env: context.env });
    }
    assert.deepEqual(new Set(picked), new Set(['primary', 'backup1', 'backup2']));
    const failing = picked[0];
    const attempts = [];
    await runWithCookieFailover(async (_filePath, name) => {
      attempts.push(name);
      if (name === failing) throw Object.assign(new Error('HTTP Error 429: Too Many Requests'), { stderr: 'HTTP Error 429' });
      return 'ok';
    }, { env: context.env });
    assert.deepEqual(attempts.length, 2);
    assert.equal(attempts[0], failing);
    const status = getCookieStatus({ env: context.env });
    assert.equal(status.slots.find(slot => slot.name === failing).status, 'rate_limited');
    assert.ok(status.alert.slots.includes(failing));
  } finally { context.close(); }
});

test('探针根据真实 yt-dlp 返回标记通过或认证失败', async () => {
  const context = fixture();
  try {
    fs.writeFileSync(context.env.YTDLP_COOKIES_PATH, validContent);
    const good = await probeSlot('primary', { env: context.env, run: async (binary, args, options) => {
      assert.equal(args[0], '--cookies');
      assert.equal(args[1], context.env.YTDLP_COOKIES_PATH);
      assert.equal(options.shell, false);
      return { stdout: 'TbkUKCm3CHQ\n' };
    } });
    assert.equal(good.slots[0].status, 'available');
    const failed = await probeSlot('primary', { env: context.env, run: async () => {
      throw new Error("Sign in to confirm you're not a bot");
    } });
    assert.equal(failed.slots[0].status, 'auth_failed');
  } finally { context.close(); }
});

test('无效上传保留原文件；探针通过后原子替换并限制为 0600', async () => {
  const context = fixture();
  try {
    const target = context.env.YTDLP_COOKIES_PATH;
    fs.writeFileSync(target, validContent);
    assert.equal(validateCookieContent('plain text'), false);
    assert.equal(validateCookieContent(validContent), true);
    const newContent = validContent.replace('test-value', 'fresh-value');
    await assert.rejects(updateCookieSlot('primary', newContent, {
      env: context.env, run: async () => { throw new Error('probe failed'); }
    }));
    assert.equal(fs.readFileSync(target, 'utf8'), validContent);
    assert.equal(fs.readdirSync(context.directory).length, 1);
    const status = await updateCookieSlot('primary', newContent, {
      env: context.env, run: async () => ({ stdout: 'TbkUKCm3CHQ\n' })
    });
    assert.equal(fs.readFileSync(target, 'utf8'), newContent);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(status.slots[0].status, 'available');
  } finally { context.close(); }
});
