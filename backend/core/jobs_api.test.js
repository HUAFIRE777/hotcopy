const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function poll(task, predicate, deadlineMs = 8_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const result = await task();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('任务状态未在测试时间内达到预期');
}

test('HTTP submit, durable worker, owner-only result and metered replay', { timeout: 15_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-jobs-api-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: dir, env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret',
      HOTCOPY_DISABLE_TREND_SYNC: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 500); });
  const base = `http://127.0.0.1:${port}`;
  try {
    await poll(async () => {
      try { return (await fetch(`${base}/api/models`)).status; } catch { return 0; }
    }, status => status === 200);
    assert.equal((await fetch(`${base}/api/admin/stats`, {
      headers: { 'x-admin-key': 'hotcopy_super_admin_pass_8888' }
    })).status, 403);
    const register = async email => {
      const response = await fetch(`${base}/api/auth/register`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-password' }) });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    };
    const token = await register('one@example.test');
    const otherToken = await register('two@example.test');
    const db = new Database(path.join(dir, 'database.sqlite'));
    try {
      db.prepare('INSERT INTO media_meta VALUES (?,?,?,?,?)')
        .run('abcdefghijk', 'youtube', 900, 'Test', Date.now());
      db.prepare('INSERT INTO copies_cache VALUES (?,?,?,?)')
        .run('abcdefghijk', 'rewrite', '缓存成稿', Date.now());
      const request = async (route, bearer, method = 'GET', body) => fetch(`${base}${route}`, {
        method, headers: { Authorization: `Bearer ${bearer}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      let response = await request('/api/jobs', token, 'POST', {
        url: 'https://youtu.be/abcdefghijk', mode: 'rewrite' });
      assert.equal(response.status, 202);
      const created = await response.json();
      response = await request(`/api/jobs/${created.id}`, otherToken);
      assert.equal(response.status, 404);
      const completed = await poll(async () =>
        (await request(`/api/jobs/${created.id}`, token)).json(), job => job.status === 'succeeded');
      assert.equal(completed.result, '缓存成稿');
      assert.equal(completed.credits, 1);
      response = await request('/api/jobs', token, 'POST', {
        url: 'https://youtu.be/abcdefghijk', mode: 'rewrite' });
      const replay = await response.json();
      const again = await poll(async () =>
        (await request(`/api/jobs/${replay.id}`, token)).json(), job => job.status === 'succeeded');
      assert.equal(again.credits, 0);
      assert.equal(db.prepare('SELECT used_count FROM users WHERE email=?').get('one@example.test').used_count, 1);
    } finally { db.close(); }
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(stderr.includes('Error:'), false, stderr.slice(0, 300));
});

test('HTTP script route generates points once, then rewrites from selected points', { timeout: 15_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-script-api-'));
  const port = await freePort();
  const llm = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const first = payload.messages[0].content.includes('严格用以下 Markdown 标题');
    const content = first ? '# 主旨\n原文主旨。\n# 重点\n- 事实一。\n- 事实二。\n- 事实三。\n# 平台稿\n抖音成稿。' : '只根据选中重点写的新稿。';
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: payload.model, choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 30 } }));
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const llmPort = llm.address().port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: dir, env: { ...process.env, PORT: String(port), JWT_SECRET: 'test-secret',
      HOTCOPY_DISABLE_TREND_SYNC: '1', LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      LLM_API_KEY: 'test', LLM_MODEL: 'openai/gpt-oss-120b' }, stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await poll(async () => {
      try { return (await fetch(`${base}/api/models`)).status; } catch { return 0; }
    }, status => status === 200);
    let response = await fetch(`${base}/api/auth/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'script@example.test', password: 'test-password' }) });
    const token = (await response.json()).token;
    const db = new Database(path.join(dir, 'database.sqlite'));
    try {
      db.prepare('INSERT INTO media_meta VALUES (?,?,?,?,?)')
        .run('abcdefghijk', 'youtube', 900, 'Test', Date.now());
      db.prepare('INSERT INTO copies_cache VALUES (?,?,?,?)')
        .run('abcdefghijk', 'raw', '这是第一段事实。这是第二段事实。这是第三段事实。', Date.now());
      const request = (route, method = 'GET', body) => fetch(`${base}${route}`, { method,
        headers: { Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      response = await request('/api/script', 'POST', { url: 'https://youtu.be/abcdefghijk',
        platform: 'douyin', format: 'spoken' });
      assert.equal(response.status, 202);
      const first = await response.json();
      const done = await poll(async () => (await request(`/api/jobs/${first.id}`)).json(),
        job => ['succeeded', 'failed'].includes(job.status));
      assert.equal(done.status, 'succeeded', done.error);
      assert.match(done.result, /抖音成稿/);
      response = await request(`/api/script/points?url=${encodeURIComponent('https://youtu.be/abcdefghijk')}`);
      assert.equal(response.status, 200);
      const points = await response.json();
      assert.equal(points.points.length, 3);
      response = await request('/api/script', 'POST', { url: 'https://youtu.be/abcdefghijk',
        platform: 'xiaohongshu', format: 'storyboard', point_ids: [points.points[0].id] });
      const second = await response.json();
      const secondDone = await poll(async () => (await request(`/api/jobs/${second.id}`)).json(),
        job => ['succeeded', 'failed'].includes(job.status));
      assert.equal(secondDone.status, 'succeeded', secondDone.error);
      assert.equal(secondDone.result, '只根据选中重点写的新稿。');
      assert.equal(db.prepare('SELECT used_count FROM users WHERE email=?').get('script@example.test').used_count, 2);
      assert.equal(db.prepare("SELECT count(*) AS n FROM usage_log WHERE status='succeeded'").get().n, 2);
    } finally { db.close(); }
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    await new Promise(resolve => llm.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
