const crypto = require('crypto');

const PLATFORMS = {
  douyin: '抖音：开场直接给信息，句子短，适合竖屏口播',
  xiaohongshu: '小红书：清晰的体验与做法，避免夸张承诺',
  bilibili: 'B站：保留推理脉络、来源与必要背景',
  shipinhao: '视频号：稳健、通俗、有明确观点',
  tiktok: 'TikTok：开头立即说明价值，短句适合竖屏口播，不编造冲突',
  youtube: 'YouTube：给出清楚的背景、分段论证与结论，保留来源'
};
const FORMATS = {
  spoken: '口播稿：分段、可直接朗读，不写镜头指令',
  storyboard: '分镜表：用表格写镜头、画面、旁白与素材提示'
};

function pointId(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12); }

function parsePoints(markdown) {
  const text = String(markdown || '');
  const essence = text.match(/(?:^|\n)#{1,3}\s*主旨\s*\n([^\n]+)/)?.[1]?.trim();
  const section = text.match(/(?:^|\n)#{1,3}\s*重点\s*\n([\s\S]*?)(?=\n#{1,3}\s*平台稿\s*\n|$)/)?.[1];
  const draft = text.match(/(?:^|\n)#{1,3}\s*平台稿\s*\n([\s\S]+)/)?.[1]?.trim();
  if (!essence || !section || !draft) throw new Error('模型未按约定返回主旨、重点和成稿');
  const points = section.split('\n').map(line => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean).slice(0, 6).map(value => ({ id: pointId(value), text: value }));
  if (points.length < 3) throw new Error('模型返回的重点不足，请重试');
  return { essence, points, draft };
}

function selectedPoints(points, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 6 ||
      !ids.every(id => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id))) {
    throw new Error('请选择 1–6 条有效重点');
  }
  const selected = ids.map(id => points.find(point => point.id === id));
  if (selected.some(point => !point)) throw new Error('所选重点与当前来源不匹配');
  return selected;
}

module.exports = { PLATFORMS, FORMATS, parsePoints, selectedPoints };
