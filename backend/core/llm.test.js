const test = require('node:test');
const assert = require('node:assert/strict');
const { generateText, splitText } = require('./llm');

const env = { LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'test',
  LLM_MODEL: 'first-model' };

test('long source is reduced by ordered chunks before final generation; usage is retained', async () => {
  const received = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    received.push(body);
    return { ok: true, json: async () => ({ model: body.model,
      choices: [{ message: { content: `result-${received.length}` } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
  };
  const original = 'A'.repeat(18_000) + 'B'.repeat(18_000) + 'C'.repeat(100);
  const result = await generateText(original, 'rewrite', { env, fetchImpl });
  assert.equal(splitText(original).length, 3);
  assert.equal(received.length, 4);
  assert.match(received[3].messages[1].content, /第 1 段事实/);
  assert.match(received[3].messages[1].content, /第 3 段事实/);
  assert.equal(result.calls.reduce((sum, call) => sum + call.input_tokens, 0), 400);
});

test('automatic model fallback responds to 429; explicit model does not switch', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    calls.push(model);
    if (model === 'first-model') return { ok: false, status: 429, text: async () => 'busy' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '成稿' } }], usage: {} }) };
  };
  const result = await generateText('正文', 'rewrite', { env, fetchImpl });
  assert.equal(result.text, '成稿');
  assert.deepEqual(calls, ['first-model', 'openai/gpt-oss-120b']);
  calls.length = 0;
  await assert.rejects(generateText('正文', 'rewrite', { env, fetchImpl, model: 'first-model' }), /429/);
  assert.deepEqual(calls, ['first-model', 'first-model']);
});

test('translation covers each chunk without dropping source tails', async () => {
  const inputs = [];
  const fetchImpl = async (_url, options) => {
    inputs.push(JSON.parse(options.body).messages[1].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: String(inputs.length) } }] }) };
  };
  const source = 'X'.repeat(20_000) + 'tail';
  const result = await generateText(source, 'translate', { env, fetchImpl });
  assert.equal(inputs.join(''), source);
  assert.equal(result.text, '1\n\n2');
});
