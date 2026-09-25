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

test('匿名认证失败才使用 Cookie，同组认证失败再切备用', async () => {
  const context = fixture();
  try {
    for (const slot of cookieSlots(context.env)) fs.writeFileSync(slot.path, validContent);
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name) => {
      calls.push(name);
      if (name === 'public') throw new Error("Sign in to confirm you're not a bot");
      if (name === 'primary') throw Object.assign(new Error('yt-dlp failed'), { stderr: "Sign in to confirm you're not a bot" });
      return 'caption';
    }, { env: context.env });
    assert.equal(result, 'caption');
    assert.deepEqual(calls, ['public', 'primary', 'backup1']);
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
    assert.equal(otherCalls[0], 'public');
    assert.equal(isAuthenticationError(new Error('Sign in to confirm your age')), true);
  } finally { context.close(); }
});

test('匿名成功时完全不读取 Cookie', async () => {
  const context = fixture();
  try {
    for (const slot of cookieSlots(context.env)) fs.writeFileSync(slot.path, validContent);
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name) => {
      calls.push(name);
      assert.equal(filePath, null);
      return 'public captions';
    }, { env: context.env });
    assert.equal(result, 'public captions');
    assert.deepEqual(calls, ['public']);
  } finally { context.close(); }
});

test('匿名 429 不再拿账号 Cookie 重试', async () => {
  const context = fixture();
  try {
    for (const slot of cookieSlots(context.env)) fs.writeFileSync(slot.path, validContent);
    const attempts = [];
    await assert.rejects(runWithCookieFailover(async (_filePath, name) => {
      attempts.push(name);
      throw Object.assign(new Error('HTTP Error 429: Too Many Requests'), { stderr: 'HTTP Error 429' });
    }, { env: context.env }), /429/);
    assert.deepEqual(attempts, ['public']);
    const status = getCookieStatus({ env: context.env });
    assert.ok(status.slots.every(slot => slot.status === 'untested'));
  } finally { context.close(); }
});

test('InnerTube 匿名专用模式只跨出口切换，不读取 Cookie', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const groups = [1, 2].map(number => {
      const cookie = path.join(context.directory, `isp-${number}.txt`);
      fs.writeFileSync(cookie, validContent);
      return { id: `anon${number}`, proxy: `socks5://isp-${number}.example:1080`, cookies: [cookie] };
    });
    fs.writeFileSync(configPath, JSON.stringify({ groups }));
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name) => {
      calls.push(name);
      assert.equal(filePath, null);
      if (name === 'anon1_anon') throw new Error("Sign in to confirm you're not a bot");
      return 'captions';
    }, { env: { YTDLP_EGRESS_CONFIG: configPath }, anonymousOnly: true });
    assert.equal(result, 'captions');
    assert.deepEqual(calls, ['anon1_anon', 'anon2_anon']);
    assert.ok(getCookieStatus({ env: { YTDLP_EGRESS_CONFIG: configPath } })
      .slots.every(slot => slot.status === 'untested'));
  } finally { context.close(); }
});

test('curl 连接失败时冷却该出口并试另一条匿名出口', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const groups = [1, 2].map(number => {
      const cookie = path.join(context.directory, `curl-${number}.txt`);
      fs.writeFileSync(cookie, validContent);
      return { id: `curl${number}`, proxy: `socks5://curl-${number}.example:1080`, cookies: [cookie] };
    });
    fs.writeFileSync(configPath, JSON.stringify({ groups }));
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name) => {
      calls.push(name);
      assert.equal(filePath, null);
      if (name === 'curl1_anon') throw Object.assign(new Error('curl connection failed'), { code: 7 });
      return 'captions';
    }, { env: { YTDLP_EGRESS_CONFIG: configPath }, anonymousOnly: true });
    assert.equal(result, 'captions');
    assert.deepEqual(calls, ['curl1_anon', 'curl2_anon']);
  } finally { context.close(); }
});

test('每个 ISP 只配置一份 Cookie 时，匿名成功不读取凭证', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const cookie = path.join(context.directory, 'isp-cookie.txt');
    fs.writeFileSync(cookie, validContent);
    fs.writeFileSync(configPath, JSON.stringify({ groups: [{ id: 'isp1', proxy: 'socks5://isp.example:1080', cookies: [cookie] }] }));
    const env = { YTDLP_EGRESS_CONFIG: configPath };
    assert.deepEqual(cookieSlots(env).map(slot => slot.name), ['isp1_1']);
    const calls = [];
    const result = await runWithCookieFailover(async (filePath, name, proxy) => {
      calls.push([filePath, name, proxy]);
      return 'public transcript';
    }, { env });
    assert.equal(result, 'public transcript');
    assert.deepEqual(calls, [[null, 'isp1_anon', 'socks5://isp.example:1080']]);
  } finally { context.close(); }
});

test('代理失败时抛出的错误不包含代理账号密码', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const proxy = 'socks5://private-user:private-password@isp.example:1080';
    const cookie = path.join(context.directory, 'isp-cookie.txt');
    fs.writeFileSync(cookie, validContent);
    fs.writeFileSync(configPath, JSON.stringify({ groups: [{ id: 'secure1', proxy, cookies: [cookie] }] }));
    await assert.rejects(runWithCookieFailover(async () => {
      const error = new Error(`yt-dlp --proxy ${proxy} timed out`);
      error.killed = true;
      throw error;
    }, { env: { YTDLP_EGRESS_CONFIG: configPath } }), error => {
      assert.equal(error.message.includes('private-password'), false);
      return true;
    });
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

test('固定出口先逐条匿名；均需认证后才用同组 Cookie', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const groups = ['us', 'jp'].map(id => ({
      id, country: id.toUpperCase(), proxy: `http://${id}.example:8000`,
      cookies: [1, 2].map(n => path.join(context.directory, `${id}-${n}.txt`))
    }));
    fs.writeFileSync(configPath, JSON.stringify({ groups }));
    for (const group of groups) for (const cookie of group.cookies) fs.writeFileSync(cookie, validContent);
    const env = { YTDLP_EGRESS_CONFIG: configPath };
    const attempts = [];
    const result = await runWithCookieFailover(async (filePath, name, proxy) => {
      attempts.push([name, proxy, Boolean(filePath)]);
      if (name.endsWith('_anon')) throw new Error("Sign in to confirm you're not a bot");
      if (name === 'us_1') throw new Error("Sign in to confirm you're not a bot");
      return 'ok';
    }, { env });
    assert.equal(result, 'ok');
    assert.deepEqual(attempts.map(item => item[0]), ['us_anon', 'jp_anon', 'us_1', 'us_2']);
    assert.deepEqual(attempts.map(item => item[2]), [false, false, true, true]);
    assert.equal(attempts[1][1], 'http://jp.example:8000');
    assert.equal(getCookieStatus({ env }).slots.find(slot => slot.name === 'us_1').status, 'auth_failed');
    assert.equal(getCookieStatus({ env }).slots[2].country, 'JP');
    assert.equal(attempts.some(item => item[0] === 'public'), false);
  } finally { context.close(); }
});

test('匿名 403 后优先试另一出口的匿名请求', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const groups = ['de', 'ca'].map(id => ({ id, proxy: `http://${id}.example:8000`,
      cookies: [1, 2].map(n => path.join(context.directory, `${id}-${n}.txt`)) }));
    fs.writeFileSync(configPath, JSON.stringify({ groups }));
    for (const group of groups) for (const cookie of group.cookies) fs.writeFileSync(cookie, validContent);
    const seen = [];
    const result = await runWithCookieFailover(async (_path, name) => {
      seen.push(name);
      if (name === 'de_anon') throw Object.assign(new Error('Forbidden'), { stderr: 'HTTP Error 403: Forbidden' });
      return 'ok';
    }, { env: { YTDLP_EGRESS_CONFIG: configPath } });
    assert.equal(result, 'ok');
    assert.deepEqual(seen, ['de_anon', 'ca_anon']);
  } finally { context.close(); }
});

test('匿名代理超时跳到另一出口，不拿 Cookie 重试坏代理', async () => {
  const context = fixture();
  try {
    const configPath = path.join(context.directory, 'egress.json');
    const groups = ['us1', 'us2'].map(id => ({ id, proxy: `http://${id}.example:8000`,
      cookies: [1, 2].map(n => path.join(context.directory, `${id}-${n}.txt`)) }));
    fs.writeFileSync(configPath, JSON.stringify({ groups }));
    for (const group of groups) for (const cookie of group.cookies) fs.writeFileSync(cookie, validContent);
    const env = { YTDLP_EGRESS_CONFIG: configPath };
    const attempts = [];
    const result = await runWithCookieFailover(async (_filePath, name) => {
      attempts.push(name);
      if (name === 'us1_anon') throw Object.assign(new Error('yt-dlp timed out'), { killed: true, signal: 'SIGTERM' });
      return 'caption';
    }, { env });
    assert.equal(result, 'caption');
    assert.deepEqual(attempts, ['us1_anon', 'us2_anon']);
    const status = getCookieStatus({ env });
    assert.equal(status.slots.find(slot => slot.name === 'us1_1').status, 'untested');
    assert.equal(status.activeSlot, 'us2_anon');
  } finally { context.close(); }
});
