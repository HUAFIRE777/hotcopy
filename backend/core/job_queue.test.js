const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobQueue, creditUnits } = require('./job_queue');

function setup({ maxRunning = 4 } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, plan TEXT, used_count INTEGER, monthly_limit INTEGER, billing_scheme TEXT);
    CREATE TABLE copies_cache (video_id TEXT, mode TEXT, content TEXT, created_at INTEGER,
      PRIMARY KEY(video_id,mode));
    INSERT INTO users VALUES (1,'pro',0,10,'units'),(2,'pro',0,10,'units'),(3,'free',0,3,'units'),
      (4,'pro',0,10,'legacy');`);
  let clock = 100_000;
  const queue = createJobQueue(db, { now: () => clock, maxRunning });
  return { db, queue, advance: ms => { clock += ms; } };
}

function createJob(queue, userId = 1, videoId = 'abcdefghijk') {
  return queue.submit({ userId, sourceUrl: `https://youtu.be/${videoId}`,
    videoId, mode: 'rewrite' });
}

test('30-minute units round up and reject unknown duration', () => {
  assert.equal(creditUnits(1800), 1);
  assert.equal(creditUnits(1801), 2);
  assert.equal(creditUnits(7200), 4);
  assert.throws(() => creditUnits(null), /时长/);
});

test('long job requests confirmation, then reserves exactly once and grants own replay', () => {
  const { db, queue } = setup();
  const submitted = createJob(queue);
  assert.equal(queue.claim('w1').id, submitted.id);
  assert.deepEqual(queue.reserve(submitted.id, 'w1', { durationSec: 7200, cacheMode: 'rewrite' }),
    { needsConfirm: true, credits: 4, shared: false });
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 0);
  assert.equal(queue.confirm(submitted.id, 1).status, 'queued');
  assert.equal(queue.claim('w2').id, submitted.id);
  assert.equal(queue.reserve(submitted.id, 'w2', { durationSec: 7200, cacheMode: 'rewrite' }).credits, 4);
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 4);
  assert.equal(queue.finish(submitted.id, 'w2', { text: '成稿', cacheMode: 'rewrite' }), true);
  assert.equal(queue.getForUser(submitted.id, 2), undefined);
  const repeat = createJob(queue);
  queue.claim('w3');
  assert.equal(queue.reserve(repeat.id, 'w3', { durationSec: 7200, cacheMode: 'rewrite' }).credits, 0);
  queue.finish(repeat.id, 'w3', { text: '成稿', cacheMode: 'rewrite' });
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 4);
});

test('shared cache costs one unit for a new user and failure refunds exactly once', () => {
  const { db, queue } = setup();
  db.prepare('INSERT INTO copies_cache VALUES (?,?,?,?)').run('abcdefghijk', 'rewrite', '共享成稿', 1);
  const first = createJob(queue, 2);
  queue.claim('w');
  const reservation = queue.reserve(first.id, 'w', { durationSec: 7200, cacheMode: 'rewrite' });
  assert.equal(reservation.credits, 1);
  assert.equal(reservation.cached, '共享成稿');
  assert.equal(queue.fail(first.id, 'w', '服务失败'), true);
  assert.equal(queue.fail(first.id, 'w', '重复失败'), false);
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=2').get().used_count, 0);
});

test('a shared raw transcript avoids long-source transcription units for a new format', () => {
  const { db, queue } = setup();
  db.prepare('INSERT INTO copies_cache VALUES (?,?,?,?)').run('abcdefghijk', 'raw', '已缓存原声', 1);
  const job = createJob(queue);
  queue.claim('w');
  const bill = queue.reserve(job.id, 'w', { durationSec: 7200, cacheMode: 'rewrite' });
  assert.equal(bill.needsConfirm, false);
  assert.equal(bill.credits, 1);
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 1);
});

test('expired worker lease can be reclaimed without charging twice', () => {
  const { db, queue, advance } = setup();
  const job = createJob(queue);
  queue.claim('old');
  queue.reserve(job.id, 'old', { durationSec: 1200, cacheMode: 'rewrite' });
  advance(60_001);
  assert.equal(queue.claim('new').id, job.id);
  queue.reserve(job.id, 'new', { durationSec: 1200, cacheMode: 'rewrite' });
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 1);
  assert.equal(queue.finish(job.id, 'old', { text: '旧结果', cacheMode: 'rewrite' }), false);
  assert.equal(queue.finish(job.id, 'new', { text: '新结果', cacheMode: 'rewrite' }), true);
});

test('global active limit and user pending limit reject surplus work', () => {
  const { queue } = setup({ maxRunning: 1 });
  createJob(queue, 1, 'abcdefghijk');
  createJob(queue, 1, 'lmnopqrstuv');
  createJob(queue, 1, '01234567890');
  assert.throws(() => createJob(queue, 1, 'ABCDEFGHIJK'), /待处理任务已满/);
  assert.ok(queue.claim('w1'));
  assert.equal(queue.claim('w2'), null);
});

test('free user cannot use long source; insufficient credit never refunds unreserved units', () => {
  const { db, queue } = setup();
  const freeJob = createJob(queue, 3);
  queue.claim('free');
  assert.throws(() => queue.reserve(freeJob.id, 'free', { durationSec: 3600, cacheMode: 'rewrite' }), /免费用户/);
  queue.fail(freeJob.id, 'free', '免费用户不可用');
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=3').get().used_count, 0);
  db.prepare('UPDATE users SET used_count=10 WHERE id=1').run();
  const paid = createJob(queue, 1);
  queue.claim('paid');
  assert.throws(() => queue.reserve(paid.id, 'paid', { durationSec: 600, cacheMode: 'rewrite' }), /额度不足/);
  queue.fail(paid.id, 'paid', '额度不足');
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 10);
});

test('existing legacy member keeps one use per new video regardless of duration', () => {
  const { db, queue } = setup();
  const job = createJob(queue, 4);
  queue.claim('legacy');
  const bill = queue.reserve(job.id, 'legacy', { durationSec: 7200, cacheMode: 'rewrite' });
  assert.equal(bill.credits, 1);
  assert.equal(queue.getForUser(job.id, 4).metering_scheme, 'legacy');
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=4').get().used_count, 1);
});

test('two SQLite connections share the same global worker limit and deduplicate submissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-queue-multi-'));
  const filename = path.join(dir, 'jobs.sqlite');
  const first = new Database(filename);
  const second = new Database(filename);
  try {
    first.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,plan TEXT,used_count INTEGER,monthly_limit INTEGER,billing_scheme TEXT);
      INSERT INTO users VALUES (1,'pro',0,10,'units');
      CREATE TABLE copies_cache (video_id TEXT,mode TEXT,content TEXT,created_at INTEGER,PRIMARY KEY(video_id,mode));`);
    const q1 = createJobQueue(first, { maxRunning: 1 });
    const q2 = createJobQueue(second, { maxRunning: 1 });
    const a = createJob(q1);
    assert.equal(createJob(q2).id, a.id);
    const b = createJob(q2, 1, 'lmnopqrstuv');
    assert.equal(q1.claim('worker-a').id, a.id);
    assert.equal(q2.claim('worker-b'), null);
    q1.reserve(a.id, 'worker-a', { durationSec: 1200, cacheMode: 'rewrite' });
    q1.finish(a.id, 'worker-a', { text: '成稿 A', cacheMode: 'rewrite' });
    assert.equal(q2.claim('worker-b').id, b.id);
    q2.reserve(b.id, 'worker-b', { durationSec: 1200, cacheMode: 'rewrite' });
    q2.fail(b.id, 'worker-b', '处理失败');
    assert.equal(second.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 1);
  } finally {
    first.close(); second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel completions return the canonical cached result', () => {
  const { db, queue } = setup();
  const first = createJob(queue, 1);
  const second = createJob(queue, 2);
  queue.claim('a'); queue.claim('b');
  queue.reserve(first.id, 'a', { durationSec: 600, cacheMode: 'rewrite' });
  queue.reserve(second.id, 'b', { durationSec: 600, cacheMode: 'rewrite' });
  queue.finish(first.id, 'a', { text: '第一份', cacheMode: 'rewrite' });
  queue.finish(second.id, 'b', { text: '第二份', cacheMode: 'rewrite' });
  assert.equal(queue.getForUser(second.id, 2).result, '第一份');
  assert.equal(db.prepare("SELECT content FROM copies_cache WHERE video_id=? AND mode='rewrite'")
    .get('abcdefghijk').content, '第一份');
});

test('abandoned confirmation expires without debit or permanent pending slot', () => {
  const { db, queue, advance } = setup();
  const first = createJob(queue);
  queue.claim('w');
  queue.reserve(first.id, 'w', { durationSec: 3600, cacheMode: 'rewrite' });
  assert.equal(queue.getForUser(first.id, 1).status, 'needs_confirm');
  advance(24 * 60 * 60_000 + 1);
  assert.equal(queue.confirm(first.id, 1), null);
  const next = createJob(queue);
  assert.notEqual(next.id, first.id);
  assert.equal(queue.getForUser(first.id, 1).status, 'failed');
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=1').get().used_count, 0);
});

test('inspection usage survives confirmation and cancellation', () => {
  const { db, queue } = setup();
  const first = createJob(queue);
  queue.claim('a');
  queue.reserve(first.id, 'a', { durationSec: 3600, cacheMode: 'rewrite' });
  assert.equal(queue.recordInterim(first.id, { source_audio_bytes: 1234 }), true);
  queue.confirm(first.id, 1);
  assert.equal(JSON.parse(queue.claim('b').usage_json).source_audio_bytes, 1234);
  queue.reserve(first.id, 'b', { durationSec: 3600, cacheMode: 'rewrite' });
  queue.finish(first.id, 'b', { text: '结果', cacheMode: 'rewrite',
    usage: { source_audio_bytes: 1234 } });
  const second = createJob(queue, 2, 'lmnopqrstuv');
  queue.claim('c');
  queue.reserve(second.id, 'c', { durationSec: 3600, cacheMode: 'rewrite' });
  queue.recordInterim(second.id, { source_audio_bytes: 4321 });
  assert.equal(queue.cancel(second.id, 2), true);
  assert.equal(JSON.parse(db.prepare('SELECT usage_json FROM usage_log WHERE job_id=?')
    .get(second.id).usage_json).source_audio_bytes, 4321);
  assert.equal(db.prepare('SELECT used_count FROM users WHERE id=2').get().used_count, 0);
});
