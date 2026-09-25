const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { transcribeWithGroq, TURBO_MODEL, ACCURATE_MODEL } = require('./whisper');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-whisper-test-'));
  const file = path.join(dir, 'audio.mp3');
  fs.writeFileSync(file, 'test audio');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function modelIn(form) {
  return form._streams.find(value => value === TURBO_MODEL || value === ACCURATE_MODEL);
}

test('有对白时仅调用 Turbo', async () => {
  const { file, cleanup } = fixture();
  try {
    const calls = [];
    const billed = [];
    const text = await transcribeWithGroq(file, { keys: ['key'], audioSec: 60,
      post: async (_url, form) => { calls.push(modelIn(form)); return { data: { text: '识别结果' } }; },
      onBilled: (...args) => billed.push(args) });
    assert.equal(text, '识别结果');
    assert.deepEqual(calls, [TURBO_MODEL]);
    assert.deepEqual(billed, [[TURBO_MODEL, 60]]);
  } finally { cleanup(); }
});

test('Turbo 明确返回空白时才调用一次 Large V3，并记录两次费用', async () => {
  const { file, cleanup } = fixture();
  try {
    const calls = [];
    const billed = [];
    const text = await transcribeWithGroq(file, { keys: ['key'], audioSec: 60,
      post: async (_url, form) => {
        const model = modelIn(form);
        calls.push(model);
        return { data: { text: model === TURBO_MODEL ? '  ' : '备用识别结果' } };
      }, onBilled: (...args) => billed.push(args), logger: { warn() {} } });
    assert.equal(text, '备用识别结果');
    assert.deepEqual(calls, [TURBO_MODEL, ACCURATE_MODEL]);
    assert.deepEqual(billed, [[TURBO_MODEL, 60], [ACCURATE_MODEL, 60]]);
  } finally { cleanup(); }
});

test('限流时只换 Key 重试 Turbo，不触发 Large V3', async () => {
  const { file, cleanup } = fixture();
  try {
    const calls = [];
    const text = await transcribeWithGroq(file, { keys: ['first', 'second'], maxRetries: 1,
      post: async (_url, form, options) => {
        calls.push({ model: modelIn(form), key: options.headers.Authorization });
        if (options.headers.Authorization === 'Bearer first') {
          throw Object.assign(new Error('Rate limit reached'), { response: { status: 429,
            data: { error: { message: 'Rate limit reached' } } } });
        }
        return { data: { text: '成功' } };
      }, logger: { warn() {} } });
    assert.equal(text, '成功');
    assert.deepEqual(calls.map(call => call.model), [TURBO_MODEL, TURBO_MODEL]);
  } finally { cleanup(); }
});

test('网络故障重试 Turbo 后失败，始终不切换 Large V3', async () => {
  const { file, cleanup } = fixture();
  try {
    const calls = [];
    await assert.rejects(transcribeWithGroq(file, { keys: ['key'], maxRetries: 1,
      post: async (_url, form) => { calls.push(modelIn(form)); throw new Error('timeout'); },
      sleep: async () => {}, logger: { warn() {} } }), /timeout/);
    assert.deepEqual(calls, [TURBO_MODEL, TURBO_MODEL]);
  } finally { cleanup(); }
});
