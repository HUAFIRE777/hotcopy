const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('./db');
const { createApp } = require('./server');
const { callModel, normalizeOutput } = require('./assets/generate');

const RAW_TEXT = '这段视频讨论内容产品如何从原声逐字稿提炼事实，并根据平台写成能直接编辑的文案。'.repeat(4);
const KIT_OUTPUT = {
  cover_options: [
    { main: '先看这三个变化', sub: '来自原声逐字稿' },
    { main: '旧方法为何费时', sub: '从三个步骤说起' },
    { main: '如何重新整理内容', sub: '可编辑的制作思路' }
  ],
  teleprompter_script: [
    { stage: '黄金钩子 (0-3s)', spoken: '先看这三个变化。', visual_cue: '文字卡出现三个关键词' },
    { stage: '核心干货与反转', spoken: '原声给出了三个步骤。', visual_cue: '用授权图示依次展示' },
    { stage: '结尾行动引导 (CTA)', spoken: '你会先试哪一步？', visual_cue: '镜头回到讲述者' }
  ],
  social_post: { title: '三个内容整理步骤', body: '先整理事实。\n再检查依据。', tags: ['#内容创作', '#工作流', '#短视频'] },
  mindmap_mermaid: 'mindmap\n  root((内容整理))\n    来源\n      原声逐字稿\n    方法\n      三个步骤\n    交付\n      口播文案'
};

async function setup(t) {
  const db = openDatabase(':memory:');
  const modelCalls = [];
  const authCalls = [];
  const app = createApp({
    db,
    config: {
      coreBaseUrl: 'http://127.0.0.1:3001',
      userKeySecret: 'local-test-secret-value-longer-than-32-characters',
      model: { baseUrl: 'http://unused.test', apiKey: 'test-only', model: 'test-model' }
    },
    fetchImpl: async (url, options) => {
      authCalls.push(url);
      const identity = options.headers.Authorization.replace('Bearer ', '');
      if (identity === 'invalid') return new Response('{}', { status: 401 });
      const plan = identity.startsWith('premium') ? 'premium'
        : identity.startsWith('pro') ? 'pro' : 'basic';
      return Response.json({
        email: `${identity}@example.test`,
        plan,
        expires_at: Date.now() + 86400000
      });
    },
    modelCall: async args => {
      modelCalls.push(args);
      if (args.rawText.includes('FAIL')) throw new Error('simulated model failure');
      if (args.assetType === 'short-video') {
        return { script_markdown: '【黄金前3秒 Hook】\n开场\n【痛点共鸣与反常识】\n问题\n【干货论证与核心反转】\n事实\n【互动与关注引导】\n结尾' };
      }
      if (args.assetType === 'mindmap') {
        return normalizeOutput('mindmap', JSON.stringify({
          title: '内容工作流',
          branches: [
            { title: '来源', children: ['视频', '播客'] },
            { title: '整理', children: ['原声', '要点'] },
            { title: '分发', children: ['图文', '口播'] }
          ]
        }));
      }
      if (args.assetType === 'production-kit') {
        return normalizeOutput('production-kit', JSON.stringify(KIT_OUTPUT));
      }
      return {
        title: '可编辑的图文', hook: '从原声出发。',
        sections: [1, 2, 3].map(number => ({ subtitle: `要点${number}`, body: '具体内容' })),
        tags: ['#内容', '#创作', '#图文', '#视频', '#工作流']
      };
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, identity, body, method = 'POST') {
    const response = await fetch(`${base}/api/addons${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${identity}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }
  return { db, request, modelCalls, authCalls };
}

test('独立库建立八张表，鉴权走核心 /api/auth/me，Basic 不消耗模型额度', async t => {
  const { db, request, modelCalls, authCalls } = await setup(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map(row => row.name).sort();
  assert.deepEqual(tables, [
    'asset_library', 'asset_usage', 'creation_project_assets', 'creation_projects',
    'radar_creators', 'radar_inbox', 'radar_videos', 'radar_view_snapshots'
  ]);
  assert.equal((await request('/assets/xiaohongshu', 'basic', { raw_text: RAW_TEXT })).status, 403);
  assert.equal((await request('/assets/xiaohongshu', 'invalid', { raw_text: RAW_TEXT })).status, 401);
  assert.equal(modelCalls.length, 0);
  assert.ok(authCalls.every(url => url === 'http://127.0.0.1:3001/api/auth/me'));
});

test('制作包直接使用现有口播，不调用模型，不消耗创作额度', async t => {
  const { request, modelCalls } = await setup(t);
  const script = '【黄金前3秒 Hook】\n先看这个数字。\n【痛点共鸣与反常识】\n很多人忽略了成本。\n【干货论证与核心反转】\n原声给出了三个步骤。\n【互动与关注引导】\n你会先试哪一步？';
  assert.equal((await request('/assets/production-package', 'basic', {
    script_markdown: script, platform: 'douyin'
  })).status, 403);
  const packageResult = await request('/assets/production-package', 'pro', {
    script_markdown: script, platform: 'douyin', source_title: '成本分析'
  });
  assert.equal(packageResult.status, 200);
  assert.equal(packageResult.data.data.sections.length, 4);
  assert.equal(packageResult.data.data.format, '9:16');
  assert.ok(packageResult.data.data.agent_prompt.includes('先看这个数字。'));
  assert.equal(modelCalls.length, 0);
  assert.equal((await request('/assets/usage', 'pro', null, 'GET')).data.used, 0);
  assert.equal((await request('/assets/production-package', 'pro', {
    script_markdown: '只有一句话', platform: 'douyin'
  })).status, 400);
});

test('全套制作包仅 Pro/Premium 可生成，一次扣额；模型失败安全退额', async t => {
  const { request, modelCalls } = await setup(t);
  const input = { raw_text: RAW_TEXT, title: '新选题', source_url: 'https://www.youtube.com/watch?v=abcdefghijk' };
  assert.equal((await request('/assets/production-kit', 'basic', input)).status, 403);
  assert.equal((await request('/assets/production-kit', 'invalid', input)).status, 401);
  const generated = await request('/assets/production-kit', 'pro', input);
  assert.equal(generated.status, 200);
  assert.equal(generated.data.remaining, 29);
  assert.equal(generated.data.data.cover_options.length, 3);
  assert.equal(generated.data.data.teleprompter_script.length, 3);
  assert.ok(generated.data.data.mindmap_mermaid.startsWith('mindmap\n'));
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].rawText, RAW_TEXT);
  assert.equal(modelCalls[0].title, '新选题');
  const failed = await request('/assets/production-kit', 'pro', { ...input, raw_text: `${RAW_TEXT} FAIL` });
  assert.equal(failed.status, 502);
  const usage = await request('/assets/usage', 'pro', null, 'GET');
  assert.equal(usage.data.used, 1);
  assert.equal(usage.data.by_type['production-kit'], 1);
});

test('全套制作包模型限 3500 tokens，能解析 JSON 围栏并拒绝恶意脑图节点', async () => {
  let requestBody;
  const result = await callModel({
    assetType: 'production-kit', rawText: RAW_TEXT, title: '素材标题',
    modelConfig: { baseUrl: 'http://model.test/v1', apiKey: 'test-only', model: 'test-model' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(KIT_OUTPUT)}\n\`\`\`` } }] });
    }
  });
  assert.equal(requestBody.max_tokens, 3500);
  assert.equal(requestBody.stream, false);
  assert.ok(requestBody.messages[1].content.includes(RAW_TEXT));
  assert.equal(result.mindmap_tree.branches.length, 3);
  assert.throws(() => normalizeOutput('production-kit', JSON.stringify({
    ...KIT_OUTPUT,
    mindmap_mermaid: 'mindmap\n  root((标题))\n    <script>alert(1)</script>\n      内容\n    分支二\n      内容\n    分支三\n      内容'
  })));
});

test('创作项目可按素材保存并恢复，作品按平台关联且用户相互隔离', async t => {
  const { db, request } = await setup(t);
  const source = 'https://www.youtube.com/watch?v=abcdefghijk';
  const body = { source_url: source, title: 'Fireship 新视频', raw_text: RAW_TEXT };
  assert.equal((await request('/projects', 'basic', body)).status, 403);
  const created = await request('/projects', 'pro-a', body);
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request('/projects', 'pro-a', body)).data.id, id);
  assert.equal((await request('/projects', 'pro-b', body)).status, 201);
  assert.equal((await request(`/projects/${id}`, 'pro-b', null, 'GET')).status, 404);
  const script = '【黄金前3秒 Hook】\n开场\n【痛点共鸣与反常识】\n问题\n【干货论证与核心反转】\n事实\n【互动与关注引导】\n结尾';
  const saved = await request(`/projects/${id}/assets`, 'pro-a', {
    asset_type: 'short-video', platform: 'douyin', content: { script_markdown: script }
  }, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal((await request(`/projects/${id}/assets`, 'pro-b', {
    asset_type: 'short-video', platform: 'douyin', content: { script_markdown: script }
  }, 'PUT')).status, 404);
  const detail = await request(`/projects/${id}`, 'pro-a', null, 'GET');
  assert.equal(detail.data.project.raw_text, RAW_TEXT);
  assert.equal(detail.data.project.assets[0].content.script_markdown, script);
  const list = await request('/projects', 'pro-a', null, 'GET');
  assert.equal(list.data.items[0].asset_count, 1);
  assert.equal(Object.hasOwn(list.data.items[0], 'raw_text'), false);
  assert.equal((await request(`/projects/${id}`, 'pro-b', null, 'DELETE')).data.deleted, false);
  assert.equal((await request(`/projects/${id}`, 'pro-a', null, 'DELETE')).data.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM creation_project_assets').get().count, 0);
  assert.equal((await request(`/projects/${id}`, 'pro-a', null, 'GET')).status, 404);
});

test('同一项目保存口播与制作包，重新读取后可继续使用 Agent 指令', async t => {
  const { request, modelCalls } = await setup(t);
  const source = 'https://www.youtube.com/watch?v=abcdefghijk';
  const project = await request('/projects', 'premium-owner', {
    source_url: source, title: '雷达选题', raw_text: RAW_TEXT
  });
  const script = '【黄金前3秒 Hook】\n先看变化。\n【痛点共鸣与反常识】\n旧方法耗时。\n【干货论证与核心反转】\n三个步骤可以复核。\n【互动与关注引导】\n你会怎么做？';
  const result = await request('/assets/production-package', 'premium-owner', {
    script_markdown: script, platform: 'douyin', source_title: '雷达选题'
  });
  assert.equal(result.status, 200);
  assert.equal(modelCalls.length, 0);
  for (const [assetType, content] of [
    ['short-video', { script_markdown: script }],
    ['production-package', result.data.data]
  ]) {
    const saved = await request(`/projects/${project.data.id}/assets`, 'premium-owner', {
      asset_type: assetType, platform: 'douyin', content
    }, 'PUT');
    assert.equal(saved.status, 200);
  }
  const detail = await request(`/projects/${project.data.id}`, 'premium-owner', null, 'GET');
  assert.equal(detail.data.project.assets.length, 2);
  const packageAsset = detail.data.project.assets.find(asset => asset.asset_type === 'production-package');
  assert.equal(packageAsset.content.script_markdown, script);
  assert.ok(packageAsset.content.agent_prompt.includes('先看变化。'));
  assert.equal((await request('/assets/usage', 'premium-owner', null, 'GET')).data.used, 0);
});

test('Premium 可把完整套件写入现有项目；Pro 无权保存套件，租户隔离不变', async t => {
  const { request } = await setup(t);
  const source = 'https://www.youtube.com/watch?v=abcdefghijk';
  const normalizedKit = normalizeOutput('production-kit', JSON.stringify(KIT_OUTPUT));
  assert.equal((await request('/projects', 'pro', {
    title: '选题', source_url: source, kit_data: normalizedKit
  })).status, 403);
  const created = await request('/projects', 'premium-owner', {
    title: '选题', source_url: source, video_id: 'abcdefghijk', kit_data: normalizedKit
  });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request(`/projects/${id}`, 'premium-other', null, 'GET')).status, 404);
  const detail = await request(`/projects/${id}`, 'premium-owner', null, 'GET');
  assert.equal(detail.data.project.video_id, 'abcdefghijk');
  assert.equal(detail.data.project.kit_data.cover_options.length, 3);
  const listed = await request('/projects', 'premium-owner', null, 'GET');
  assert.equal(listed.data.items[0].has_kit, 1);
  const updated = await request('/projects', 'premium-owner', {
    title: '选题新版', source_url: source, raw_text: RAW_TEXT
  });
  assert.equal(updated.data.id, id);
  const after = await request(`/projects/${id}`, 'premium-owner', null, 'GET');
  assert.equal(after.data.project.kit_data.social_post.title, KIT_OUTPUT.social_post.title);
  assert.equal(after.data.project.raw_text, RAW_TEXT);
  assert.equal((await request(`/projects/${id}`, 'premium-owner', null, 'DELETE')).data.deleted, true);
  assert.equal((await request(`/projects/${id}`, 'premium-owner', null, 'GET')).status, 404);
});

test('已有 creation_projects 表平滑加列并保留原项目数据', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-addons-migration-'));
  const file = path.join(directory, 'legacy.sqlite');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE creation_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_key TEXT NOT NULL,
    source_url TEXT NOT NULL, title TEXT NOT NULL, raw_text TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_key, source_url)
  )`);
  legacy.prepare('INSERT INTO creation_projects (user_key, source_url, title, raw_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('saved-user', 'https://example.test/clip', '旧项目', RAW_TEXT, 1, 1);
  legacy.close();
  const upgraded = openDatabase(file);
  t.after(() => {
    upgraded.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const row = upgraded.prepare('SELECT title, raw_text, video_id, kit_data FROM creation_projects WHERE user_key = ?')
    .get('saved-user');
  assert.equal(row.title, '旧项目');
  assert.equal(row.raw_text, RAW_TEXT);
  assert.equal(row.video_id, null);
  assert.equal(row.kit_data, null);
});

test('Pro 生成只用已有 raw_text，失败退额度，创作资产共享月度上限', async t => {
  const { request, modelCalls } = await setup(t);
  const first = await request('/assets/xiaohongshu', 'pro', { raw_text: RAW_TEXT });
  assert.equal(first.status, 200);
  assert.equal(first.data.remaining, 29);
  assert.equal(modelCalls[0].rawText, RAW_TEXT);
  assert.equal((await request('/assets/short-video', 'pro', { raw_text: RAW_TEXT, platform: 'unknown' })).status, 400);
  const failed = await request('/assets/mindmap', 'pro', { raw_text: `${RAW_TEXT} FAIL` });
  assert.equal(failed.status, 502);
  const usage = await request('/assets/usage', 'pro', null, 'GET');
  assert.equal(usage.data.used, 1);
  assert.equal(usage.data.remaining, 29);
  assert.equal(usage.data.by_type.xiaohongshu, 1);
  assert.equal(usage.data.by_type.mindmap, 0);
});

test('Premium 作品库按用户隔离；脑图 Mermaid 不接受 HTML 注入', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/assets/library', 'pro', null, 'GET')).status, 403);
  const saved = await request('/assets/library', 'premium-a', {
    asset_type: 'mindmap', title: '私有脑图', content: { title: '私有脑图' }
  });
  assert.equal(saved.status, 201);
  assert.equal((await request('/assets/library', 'premium-b', null, 'GET')).data.items.length, 0);
  assert.equal((await request('/assets/library', 'premium-a', null, 'GET')).data.items.length, 1);
  assert.equal((await request(`/assets/library/${saved.data.id}`, 'premium-b', null, 'DELETE')).data.deleted, false);
  assert.equal((await request(`/assets/library/${saved.data.id}`, 'premium-a', null, 'DELETE')).data.deleted, true);

  const mindmap = normalizeOutput('mindmap', JSON.stringify({
    title: '<img src=x onerror=alert(1)>',
    branches: [
      { title: 'a]; click N0 "x', children: ['<script>x</script>', '正常信息'] },
      { title: '第二部分', children: ['证据 A', '证据 B'] },
      { title: '第三部分', children: ['结论 A', '结论 B'] }
    ]
  }));
  assert.equal(mindmap.mermaid_code.includes('<'), false);
  assert.equal(mindmap.mermaid_code.includes(';'), false);
  assert.equal(mindmap.mermaid_code.includes('"x'), false);
});

test('模型请求只发送原声文本并固定输出上限', async () => {
  let requestBody;
  const result = await callModel({
    assetType: 'xiaohongshu',
    rawText: RAW_TEXT,
    modelConfig: { baseUrl: 'http://model.test/v1', apiKey: 'test-only', model: 'test-model' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        title: '标题', hook: '开场',
        sections: [1, 2, 3].map(number => ({ subtitle: `要点${number}`, body: '事实' })),
        tags: ['#一', '#二', '#三', '#四', '#五']
      }) } }] });
    }
  });
  assert.equal(requestBody.max_tokens, 2500);
  assert.equal(requestBody.stream, false);
  assert.ok(requestBody.messages[1].content.includes(RAW_TEXT));
  assert.equal(result.sections.length, 3);
});

test('Pro 的 30 次是跨资产类型总额，超额请求不会调用模型', async t => {
  const { request, modelCalls } = await setup(t);
  for (let index = 0; index < 30; index += 1) {
    const assetType = ['short-video', 'xiaohongshu', 'production-kit'][index % 3];
    const body = assetType === 'short-video'
      ? { raw_text: RAW_TEXT, platform: 'douyin' }
      : { raw_text: RAW_TEXT };
    assert.equal((await request(`/assets/${assetType}`, 'pro', body)).status, 200);
  }
  assert.equal((await request('/assets/mindmap', 'pro', { raw_text: RAW_TEXT })).status, 429);
  assert.equal(modelCalls.length, 30);
});

test('雷达只给 Premium，空库不伪造播放量与视频', async t => {
  const { db, request } = await setup(t);
  assert.equal((await request('/radar/inbox', 'pro', null, 'GET')).status, 403);
  const status = await request('/radar/status', 'premium-a', null, 'GET');
  assert.equal(status.status, 200);
  assert.equal(status.data.channel_count, 20);
  assert.equal(status.data.source_status, 'waiting');
  const empty = await request('/radar/inbox?category=all', 'premium-a', null, 'GET');
  assert.deepEqual(empty.data.items, []);

  db.prepare(`
    INSERT INTO radar_videos
      (video_id, channel_id, category, title, video_url, published_at, first_seen_at, status_badge)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('abcdefghijk', 'UCsBjURrPoezykLs9EqgamOA', 'tech', 'New video',
    'https://www.youtube.com/watch?v=abcdefghijk', Date.now(), Date.now(), 'NEW');
  const inbox = await request('/radar/inbox?category=tech', 'premium-a', null, 'GET');
  assert.equal(inbox.data.items.length, 1);
  assert.equal(inbox.data.items[0].channel_name, 'Fireship');
  assert.equal(inbox.data.items[0].latest_views, null);
  db.prepare('UPDATE radar_videos SET latest_views = ? WHERE video_id = ?').run(1900000, 'abcdefghijk');
  const withViews = await request('/radar/inbox?category=tech', 'premium-a', null, 'GET');
  assert.equal(withViews.data.items[0].latest_views, 1900000);
});
