const crypto = require('crypto');
const { withUsage, estimateProviderCost } = require('./usage_context');

function createJobWorker(queue, { inspect, process, cacheMode, intervalMs = 1000,
  localConcurrency = 2, logger = console } = {}) {
  const workerId = crypto.randomUUID();
  let timer = null;
  const active = new Set();

  async function run(job) {
    const usage = job.usage_json ? JSON.parse(job.usage_json) :
      { started_at: Date.now(), llm_calls: [], whisper_calls: [] };
    const heartbeat = setInterval(() => queue.renew(job.id, workerId), 15_000);
    heartbeat.unref?.();
    try {
      const key = cacheMode(job.mode, job.model, JSON.parse(job.options_json || '{}'));
      const durationSec = job.duration_sec || await withUsage(usage, () => inspect(job));
      usage.duration_sec = durationSec;
      const bill = queue.reserve(job.id, workerId, { durationSec, cacheMode: key });
      if (bill.needsConfirm) {
        Object.assign(usage, estimateProviderCost(usage));
        queue.recordInterim(job.id, usage);
        return;
      }
      const output = bill.cached ? { text: bill.cached, cache_hit: true } :
        await withUsage(usage, () => process(job, usage));
      usage.cache_hit = Boolean(bill.cached);
      usage.finished_at = Date.now();
      Object.assign(usage, estimateProviderCost(usage));
      queue.finish(job.id, workerId, { text: output.text, cacheMode: key, usage });
    } catch (error) {
      usage.finished_at = Date.now();
      Object.assign(usage, estimateProviderCost(usage));
      queue.fail(job.id, workerId, error.publicMessage || error.message || '处理失败', { usage });
      logger.error?.(`[Job ${job.id}] ${error.message}`);
    } finally {
      clearInterval(heartbeat);
      active.delete(job.id);
    }
  }

  function tick() {
    while (active.size < localConcurrency) {
      const job = queue.claim(workerId);
      if (!job) break;
      active.add(job.id);
      run(job).catch(error => logger.error?.(error));
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch (error) { logger.error?.(error); } }, intervalMs);
    timer.unref?.();
    tick();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick, workerId };
}

module.exports = { createJobWorker };
