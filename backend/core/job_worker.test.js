const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createJobQueue } = require('./job_queue');
const { createJobWorker } = require('./job_worker');

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,plan TEXT,used_count INTEGER,monthly_limit INTEGER,billing_scheme TEXT);
    INSERT INTO users VALUES (1,'pro',0,10,'units');
    CREATE TABLE copies_cache (video_id TEXT,mode TEXT,content TEXT,created_at INTEGER,PRIMARY KEY(video_id,mode));`);
  const queue = createJobQueue(db);
  const job = queue.submit({ userId: 1, sourceUrl: 'https://youtu.be/abcdefghijk',
    videoId: 'abcdefghijk', mode: 'rewrite' });
  return { db, queue, job };
}

async function until(predicate) {
  for (let n = 0; n < 30; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('任务未在测试时间内结束');
}

test('worker completes queued job and stores token evidence', async () => {
  const { db, queue, job } = setup();
  const worker = createJobWorker(queue, {
    inspect: async () => 900,
    process: async (_job, usage) => {
      usage.llm_calls.push({ model: 'openai/gpt-oss-120b', input_tokens: 1000, output_tokens: 200 });
      return { text: '完整成稿' };
    }, cacheMode: mode => mode,
    logger: { error: error => { throw error; } }
  });
  worker.tick();
  await until(() => queue.getForUser(job.id, 1).status === 'succeeded');
  assert.equal(queue.getForUser(job.id, 1).result, '完整成稿');
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 1);
  const usage = queue.recentUsage()[0].usage;
  assert.equal(usage.llm_calls[0].input_tokens, 1000);
  assert.equal(usage.provider_cost_complete, true);
  worker.stop();
});

test('worker failure releases reserved credit without writing result cache', async () => {
  const { db, queue, job } = setup();
  const worker = createJobWorker(queue, {
    inspect: async () => 900,
    process: async () => { throw new Error('模型失败'); },
    cacheMode: mode => mode, logger: { error: () => {} }
  });
  worker.tick();
  await until(() => queue.getForUser(job.id, 1).status === 'failed');
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM copies_cache').get().n, 0);
  worker.stop();
});
