const crypto = require('crypto');

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/;

function modelCatalog(env = process.env) {
  const ids = (env.LLM_MODEL_CHOICES || '').split(',')
    .map(value => (value || '').trim())
    .filter(value => MODEL_ID.test(value));
  const choices = [...new Set(ids)].slice(0, 8).map(id => ({ id, label: id }));
  return { choices };
}

function selectedRewriteModel(value, env = process.env) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !modelCatalog(env).choices.some(choice => choice.id === value)) {
    throw new Error('所选模型不可用，请刷新模型列表后重试');
  }
  return value;
}

function rewriteCacheMode(model) {
  return model ? `rewrite:model:${crypto.createHash('sha256').update(model).digest('hex').slice(0, 20)}` : 'rewrite';
}

module.exports = { modelCatalog, selectedRewriteModel, rewriteCacheMode };
