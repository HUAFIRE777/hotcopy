const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePoints, selectedPoints } = require('./points');
const { cacheMode } = require('./media_info');
const { generateScript } = require('./llm');

const answer = `# 主旨\n用三个事实解释问题。\n# 重点\n- 第一条事实，来源有数字 10。\n- 第二条事实，来源有数字 20。\n- 第三条事实，原博主说了结果。\n# 平台稿\n这是一份可以录制的稿。`;

test('points have stable IDs, reject forged IDs, and cache keys separate variants', () => {
  const parsed = parsePoints(answer);
  assert.equal(parsed.points.length, 3);
  assert.deepEqual(parsePoints(answer).points, parsed.points);
  assert.deepEqual(selectedPoints(parsed.points, [parsed.points[0].id]), [parsed.points[0]]);
  assert.throws(() => selectedPoints(parsed.points, ['0123456789ab']), /不匹配/);
  const base = cacheMode('script', null, { platform: 'douyin', format: 'spoken' });
  assert.notEqual(base, cacheMode('script', null, { platform: 'bilibili', format: 'spoken' }));
  assert.notEqual(base, cacheMode('script', null, { platform: 'douyin', format: 'storyboard' }));
  assert.notEqual(base, cacheMode('script', null, { platform: 'douyin', format: 'spoken',
    point_ids: [parsed.points[0].id] }));
});

test('first script call produces points and draft in one final model response', async () => {
  const calls = [];
  const result = await generateScript('原文事实', { platform: 'douyin', format: 'spoken',
    env: { LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'test', LLM_MODEL: 'model' },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 } }) };
    } });
  assert.equal(calls.length, 1);
  assert.equal(result.points.points.length, 3);
  assert.match(result.text, /平台稿/);
});

test('selected points re-generation sends only chosen facts', async () => {
  const points = parsePoints(answer).points;
  const inputs = [];
  const result = await generateScript('', { platform: 'xiaohongshu', format: 'storyboard',
    points: [points[1]],
    env: { LLM_BASE_URL: 'https://example.test/v1', LLM_API_KEY: 'test', LLM_MODEL: 'model' },
    fetchImpl: async (_url, options) => {
      inputs.push(JSON.parse(options.body).messages[1].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '新分镜' } }] }) };
    } });
  assert.equal(result.text, '新分镜');
  assert.match(inputs[0], /第二条事实/);
  assert.doesNotMatch(inputs[0], /第一条事实/);
});
