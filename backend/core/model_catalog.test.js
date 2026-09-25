const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalog, selectedRewriteModel, rewriteCacheMode } = require('./model_catalog');

test('only explicitly configured models can be selected', () => {
  const env = { LLM_MODEL: 'qwen/example', LLM_MODEL_CHOICES: 'openai/example,qwen/example, invalid model' };
  assert.deepEqual(modelCatalog(env).choices.map(choice => choice.id), ['openai/example', 'qwen/example']);
  assert.equal(selectedRewriteModel('openai/example', env), 'openai/example');
  assert.equal(selectedRewriteModel('', env), null);
  assert.throws(() => selectedRewriteModel('unconfigured/model', env), /不可用/);
  assert.throws(() => selectedRewriteModel(['qwen/example'], env), /不可用/);
});

test('default model is not advertised as a selectable model without an explicit choice', () => {
  assert.deepEqual(modelCatalog({ LLM_MODEL: 'old/default' }).choices, []);
});

test('different models cannot share rewrite cache entries', () => {
  assert.equal(rewriteCacheMode(null), 'rewrite');
  assert.equal(rewriteCacheMode('qwen/example'), rewriteCacheMode('qwen/example'));
  assert.notEqual(rewriteCacheMode('qwen/example'), rewriteCacheMode('openai/example'));
});
