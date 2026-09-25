const crypto = require('crypto');

const MAX_PENDING_PER_USER = 3;
const MAX_ATTEMPTS = 2;
const LEASE_MS = 60_000;
const CONFIRMATION_TTL_MS = 24 * 60 * 60_000;

function creditUnits(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('无法确认内容时长，暂不扣次数');
  return Math.max(1, Math.ceil(durationSec / 1800));
}

function createJobQueue(db, { now = Date.now, maxRunning = 4 } = {}) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS processing_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      source_url TEXT NOT NULL,
      video_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT,
      options_json TEXT NOT NULL DEFAULT '{}',
      options_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('queued','running','needs_confirm','succeeded','failed')),
      confirmed INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      metering_scheme TEXT,
      duration_sec INTEGER,
      result TEXT,
      error TEXT,
      usage_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      lease_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_claim ON processing_jobs(status, lease_until, created_at);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_user ON processing_jobs(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS user_unlocks (
      user_id INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      cache_mode TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, video_id, cache_mode)
    );
    CREATE TABLE IF NOT EXISTS usage_log (
      job_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      credits INTEGER NOT NULL,
      duration_sec INTEGER,
      usage_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const jobColumns = new Set(db.prepare('PRAGMA table_info(processing_jobs)').all().map(column => column.name));
  if (!jobColumns.has('reserved')) db.exec('ALTER TABLE processing_jobs ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('metering_scheme')) db.exec('ALTER TABLE processing_jobs ADD COLUMN metering_scheme TEXT');
  if (!jobColumns.has('options_json')) db.exec("ALTER TABLE processing_jobs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'");
  if (!jobColumns.has('options_hash')) db.exec("ALTER TABLE processing_jobs ADD COLUMN options_hash TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_active_duplicate
      ON processing_jobs(user_id, video_id, mode, COALESCE(model, ''), options_hash)
      WHERE status IN ('queued','running','needs_confirm');`);

  const jobById = db.prepare('SELECT * FROM processing_jobs WHERE id = ?');
  const publicJob = row => row && ({
    id: row.id, status: row.status, mode: row.mode,
    credits: row.credits, duration_sec: row.duration_sec, metering_scheme: row.metering_scheme,
    result: row.status === 'succeeded' ? row.result : null,
    error: row.status === 'failed' ? row.error : null,
    created_at: row.created_at, updated_at: row.updated_at
  });

  function submit({ userId, sourceUrl, videoId, mode, model = null, options = {} }) {
    return db.transaction(() => {
      // An abandoned confirmation must not occupy one of the user's slots forever.
      const expired = db.prepare(`SELECT * FROM processing_jobs WHERE user_id=?
        AND status='needs_confirm' AND updated_at < ?`)
        .all(userId, now() - CONFIRMATION_TTL_MS);
      for (const old of expired) {
        db.prepare(`INSERT OR REPLACE INTO usage_log
          (job_id,user_id,video_id,mode,status,credits,duration_sec,usage_json,created_at)
          VALUES (?,?,?,?,'expired',0,?,?,?)`)
          .run(old.id, userId, old.video_id, old.mode, old.duration_sec,
            old.usage_json || '{}', now());
      }
      db.prepare(`UPDATE processing_jobs SET status='failed',error='确认已过期，请重新提交',updated_at=?
        WHERE user_id=? AND status='needs_confirm' AND updated_at < ?`)
        .run(now(), userId, now() - CONFIRMATION_TTL_MS);
      const optionsJson = JSON.stringify(options);
      const optionsHash = crypto.createHash('sha256').update(optionsJson).digest('hex').slice(0, 20);
      const existing = db.prepare(`SELECT * FROM processing_jobs WHERE user_id = ? AND video_id = ?
        AND mode = ? AND COALESCE(model, '') = COALESCE(?, '') AND options_hash=?
        AND status IN ('queued','running','needs_confirm') ORDER BY created_at DESC LIMIT 1`)
        .get(userId, videoId, mode, model, optionsHash);
      if (existing) return publicJob(existing);
      const pending = db.prepare(`SELECT count(*) AS n FROM processing_jobs WHERE user_id = ?
        AND status IN ('queued','running','needs_confirm')`).get(userId).n;
      if (pending >= MAX_PENDING_PER_USER) throw Object.assign(new Error('待处理任务已满，请稍后再试'), { status: 429 });
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO processing_jobs
        (id,user_id,source_url,video_id,mode,model,options_json,options_hash,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'queued',?,?)`)
        .run(id, userId, sourceUrl, videoId, mode, model, optionsJson, optionsHash, now(), now());
      return publicJob(jobById.get(id));
    })();
  }

  function getForUser(id, userId) { return publicJob(db.prepare('SELECT * FROM processing_jobs WHERE id = ? AND user_id = ?').get(id, userId)); }

  function claim(workerId) {
    return db.transaction(() => {
      const active = db.prepare(`SELECT count(*) AS n FROM processing_jobs
        WHERE status = 'running' AND lease_until > ?`).get(now()).n;
      if (active >= maxRunning) return null;
      const job = db.prepare(`SELECT * FROM processing_jobs
        WHERE status = 'queued' OR (status = 'running' AND lease_until <= ?)
        ORDER BY created_at LIMIT 1`).get(now());
      if (!job) return null;
      if (job.attempts >= MAX_ATTEMPTS) {
        fail(job.id, job.worker_id, '任务中断，请重试', { allowExpired: true });
        return null;
      }
      db.prepare(`UPDATE processing_jobs SET status='running',worker_id=?,lease_until=?,
        attempts=attempts+1,updated_at=? WHERE id=?`)
        .run(workerId, now() + LEASE_MS, now(), job.id);
      return jobById.get(job.id);
    })();
  }

  function renew(id, workerId) {
    return db.prepare(`UPDATE processing_jobs SET lease_until=?,updated_at=?
      WHERE id=? AND worker_id=? AND status='running'`).run(now() + LEASE_MS, now(), id, workerId).changes === 1;
  }

  function reserve(id, workerId, { durationSec, cacheMode }) {
    return db.transaction(() => {
      const job = jobById.get(id);
      if (!job || job.status !== 'running' || job.worker_id !== workerId) throw new Error('任务租约已失效');
      const user = db.prepare('SELECT plan,used_count,monthly_limit,billing_scheme FROM users WHERE id=?').get(job.user_id);
      if (!user) throw new Error('用户不存在');
      if (user.plan === 'free' && durationSec > 1800) throw new Error('免费用户仅可处理 30 分钟以内的内容');
      if (job.reserved) {
        const shared = db.prepare('SELECT content FROM copies_cache WHERE video_id=? AND mode=?')
          .get(job.video_id, cacheMode);
        return { needsConfirm: false, credits: job.credits, cached: shared?.content || null };
      }
      const own = db.prepare('SELECT 1 FROM user_unlocks WHERE user_id=? AND video_id=? AND cache_mode=?')
        .get(job.user_id, job.video_id, cacheMode);
      const shared = db.prepare('SELECT content FROM copies_cache WHERE video_id=? AND mode=?')
        .get(job.video_id, cacheMode);
      const sharedRaw = db.prepare("SELECT 1 FROM copies_cache WHERE video_id=? AND mode='raw'")
        .get(job.video_id);
      const previouslyUnlocked = db.prepare('SELECT 1 FROM user_unlocks WHERE user_id=? AND video_id=? LIMIT 1')
        .get(job.user_id, job.video_id);
      const meteringScheme = user.billing_scheme === 'units' ? 'units' : 'legacy';
      const credits = own ? 0 : meteringScheme === 'legacy' ? 1 :
        (shared || sharedRaw || previouslyUnlocked ? 1 : creditUnits(durationSec));
      db.prepare('UPDATE processing_jobs SET duration_sec=?,credits=?,metering_scheme=?,updated_at=? WHERE id=?')
        .run(durationSec, credits, meteringScheme, now(), id);
      if (credits >= 2 && !job.confirmed) {
        db.prepare(`UPDATE processing_jobs SET status='needs_confirm',worker_id=NULL,lease_until=NULL,updated_at=? WHERE id=?`)
          .run(now(), id);
        return { needsConfirm: true, credits, shared: Boolean(shared) };
      }
      if (credits) {
        const charged = db.prepare(`UPDATE users SET used_count=used_count+?
          WHERE id=? AND used_count+?<=monthly_limit`)
          .run(credits, job.user_id, credits).changes;
        if (charged !== 1) throw Object.assign(new Error('剩余额度不足'), { status: 429 });
      }
      db.prepare('UPDATE processing_jobs SET reserved=1 WHERE id=?').run(id);
      return { needsConfirm: false, credits, cached: shared?.content || null };
    })();
  }

  function confirm(id, userId) {
    const changed = db.prepare(`UPDATE processing_jobs SET status='queued',confirmed=1,
      worker_id=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND user_id=? AND status='needs_confirm' AND updated_at>=?`)
      .run(now(), id, userId, now() - CONFIRMATION_TTL_MS).changes;
    return changed ? getForUser(id, userId) : null;
  }

  function recordInterim(id, usage) {
    return db.prepare(`UPDATE processing_jobs SET usage_json=?,updated_at=?
      WHERE id=? AND status='needs_confirm'`).run(JSON.stringify(usage), now(), id).changes === 1;
  }

  function cancel(id, userId) {
    return db.transaction(() => {
      const job = db.prepare('SELECT * FROM processing_jobs WHERE id=? AND user_id=?').get(id, userId);
      if (!job || !['queued', 'needs_confirm'].includes(job.status)) return false;
      if (job.reserved && job.credits) db.prepare('UPDATE users SET used_count=MAX(0,used_count-?) WHERE id=?')
        .run(job.credits, userId);
      db.prepare(`UPDATE processing_jobs SET status='failed',credits=0,reserved=0,error='用户取消',updated_at=? WHERE id=?`)
        .run(now(), id);
      db.prepare(`INSERT OR REPLACE INTO usage_log
        (job_id,user_id,video_id,mode,status,credits,duration_sec,usage_json,created_at)
        VALUES (?,?,?,?,'cancelled',0,?,?,?)`)
        .run(id, userId, job.video_id, job.mode, job.duration_sec,
          job.usage_json || '{}', now());
      return true;
    })();
  }

  function finish(id, workerId, { text, cacheMode, usage = {} }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('生成结果为空');
    return db.transaction(() => {
      const job = jobById.get(id);
      if (!job || job.status !== 'running' || job.worker_id !== workerId) return false;
      db.prepare(`INSERT OR IGNORE INTO copies_cache (video_id,mode,content,created_at) VALUES (?,?,?,?)`)
        .run(job.video_id, cacheMode, text, now());
      // A parallel job may have stored the same result key first. Return the
      // persisted version so a replay and the original response agree.
      const canonicalText = db.prepare('SELECT content FROM copies_cache WHERE video_id=? AND mode=?')
        .get(job.video_id, cacheMode).content;
      db.prepare(`INSERT OR IGNORE INTO user_unlocks (user_id,video_id,cache_mode,job_id,created_at)
        VALUES (?,?,?,?,?)`).run(job.user_id, job.video_id, cacheMode, id, now());
      const usageJson = JSON.stringify(usage);
      db.prepare(`INSERT OR REPLACE INTO usage_log
        (job_id,user_id,video_id,mode,status,credits,duration_sec,usage_json,created_at)
        VALUES (?,?,?,?,'succeeded',?,?,?,?)`)
        .run(id, job.user_id, job.video_id, job.mode, job.credits, job.duration_sec, usageJson, now());
      db.prepare(`UPDATE processing_jobs SET status='succeeded',result=?,usage_json=?,
        worker_id=NULL,lease_until=NULL,updated_at=? WHERE id=?`).run(canonicalText, usageJson, now(), id);
      return true;
    })();
  }

  function fail(id, workerId, error, { usage = {}, allowExpired = false } = {}) {
    return db.transaction(() => {
      const job = jobById.get(id);
      if (!job || job.status !== 'running' || (!allowExpired && job.worker_id !== workerId)) return false;
      if (job.reserved && job.credits) db.prepare('UPDATE users SET used_count=MAX(0,used_count-?) WHERE id=?').run(job.credits, job.user_id);
      const usageJson = JSON.stringify(usage);
      db.prepare(`INSERT OR REPLACE INTO usage_log
        (job_id,user_id,video_id,mode,status,credits,duration_sec,usage_json,created_at)
        VALUES (?,?,?,?,'failed',0,?,?,?)`)
        .run(id, job.user_id, job.video_id, job.mode, job.duration_sec, usageJson, now());
      db.prepare(`UPDATE processing_jobs SET status='failed',credits=0,reserved=0,error=?,usage_json=?,
        worker_id=NULL,lease_until=NULL,updated_at=? WHERE id=?`)
        .run(String(error || '任务失败').slice(0, 300), usageJson, now(), id);
      return true;
    })();
  }

  function recentUsage(limit = 100) {
    return db.prepare(`SELECT usage_log.*, processing_jobs.metering_scheme
      FROM usage_log JOIN processing_jobs ON processing_jobs.id=usage_log.job_id
      ORDER BY usage_log.created_at DESC LIMIT ?`).all(Math.min(Math.max(1, limit), 500))
      .map(row => ({ ...row, usage: JSON.parse(row.usage_json) }));
  }

  return { submit, getForUser, claim, renew, reserve, confirm, recordInterim,
    cancel, finish, fail, recentUsage, creditUnits };
}

module.exports = { createJobQueue, creditUnits };
