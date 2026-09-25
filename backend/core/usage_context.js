const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function withUsage(usage, task) { return storage.run(usage, task); }
function recordWhisper(model, audioSec) {
  const usage = storage.getStore();
  if (usage) {
    usage.whisper_calls ||= [];
    usage.whisper_calls.push({ model, audio_sec: Number.isFinite(audioSec) ? audioSec :
      (Number.isFinite(usage.duration_sec) ? usage.duration_sec : null) });
  }
}
function recordFileBytes(bytes) {
  const usage = storage.getStore();
  if (usage && Number.isFinite(bytes)) usage.output_audio_bytes = (usage.output_audio_bytes || 0) + bytes;
}
function recordSourceBytes(bytes) {
  const usage = storage.getStore();
  if (usage && Number.isFinite(bytes)) usage.source_audio_bytes = (usage.source_audio_bytes || 0) + bytes;
}

function estimateProviderCost(usage) {
  const llmRates = {
    'openai/gpt-oss-120b': [0.15, 0.60],
    'openai/gpt-oss-20b': [0.075, 0.30],
    'qwen/qwen3.8-27b': [0.80, 4.00]
  };
  const whisperRates = { 'whisper-large-v3-turbo': 0.04, 'whisper-large-v3': 0.111 };
  let cost = 0;
  const missing = [];
  for (const call of usage.llm_calls || []) {
    const rate = llmRates[call.model];
    if (!rate || !Number.isFinite(call.input_tokens) || !Number.isFinite(call.output_tokens)) {
      missing.push(`llm:${call.model || 'unknown'}`);
    } else cost += (call.input_tokens * rate[0] + call.output_tokens * rate[1]) / 1_000_000;
  }
  for (const call of usage.whisper_calls || []) {
    const rate = whisperRates[call.model];
    if (!rate || !Number.isFinite(call.audio_sec)) missing.push(`whisper:${call.model || 'unknown'}`);
    else cost += call.audio_sec / 3600 * rate;
  }
  return { provider_cost_estimate_usd: Number(cost.toFixed(6)),
    provider_cost_complete: missing.length === 0,
    missing_provider_costs: missing,
    // No provider egress meter or VPS allocation is available here. Do not
    // present this value as total cost or profit.
    proxy_egress_bytes: null, full_cost_complete: false };
}

module.exports = { withUsage, recordWhisper, recordFileBytes, recordSourceBytes, estimateProviderCost };
