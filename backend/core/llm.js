const DEFAULT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const { PLATFORMS, FORMATS, parsePoints } = require('./points');
const SOURCE_CHUNK = 18_000;

const PROMPTS = {
  summary: '把原文整理为一句话主旨和 3–6 条核心要点。每条要点写明原文依据或数字。不要加入原文没有的事实，不要输出赞助、求关注等广告内容。',
  rewrite: '根据原文写一份可编辑的中文自媒体初稿。保留可核对的事实和数字，不编造。原作者的亲身经历须称为“原博主的经历”，不要冒充作者用第一人称。去掉赞助、广告、求关注和“以下是为你生成”等说明。只输出成稿。',
  translate: '把原文准确译为自然中文，保留顺序、数字和专有名词；不要概括或遗漏，不要添加原文没有的内容。只输出译文。'
};

function splitText(text, size = SOURCE_CHUNK) {
  if (text.length <= size) return [text];
  const chunks = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(position + size, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('。', end), text.lastIndexOf('. ', end),
        text.lastIndexOf('\n', end));
      if (boundary > position + size / 2) end = boundary + 1;
    }
    chunks.push(text.slice(position, end));
    position = end;
  }
  return chunks;
}

function candidateModels(model, env) {
  return model ? [model] : [...new Set([env.LLM_MODEL, ...DEFAULT_MODELS].filter(Boolean))];
}

async function callOnce(messages, { model, env = process.env, fetchImpl = fetch,
  timeoutMs = 60_000, maxTokens = 2500, calls }) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error('AI 模型服务尚未配置');
  let lastError;
  for (const candidate of candidateModels(model, env)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      try {
      const response = await fetchImpl(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
        body: JSON.stringify({ model: candidate, stream: false, max_tokens: maxTokens, messages })
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 180);
        const retryAfter = Math.min(60, Math.max(1, Number(response.headers?.get?.('retry-after')) || 2));
        throw Object.assign(new Error(`模型请求失败（${response.status}）：${detail}`),
          { status: response.status, retryAfter });
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回有效内容');
      const usage = data.usage || {};
      calls.push({ model: data.model || candidate, input_tokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
        output_tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
        elapsed_ms: Date.now() - started });
      return content.trim();
      } catch (error) {
        lastError = error;
        if (error.status === 429 && attempt === 0 && model) {
          await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
          continue;
        }
        if (model || (error.status && error.status < 500 && error.status !== 429)) throw error;
        break;
      }
    }
  }
  throw lastError || new Error('AI 模型暂时不可用');
}

async function generateText(text, mode, options = {}) {
  if (mode === 'raw') return { text, calls: [] };
  if (!PROMPTS[mode]) throw new Error('不支持的生成模式');
  const source = String(text || '').trim();
  if (!source) throw new Error('原文为空');
  const calls = options.calls || [];
  const invoke = (messages, maxTokens) => callOnce(messages, { ...options, calls, maxTokens });
  const chunks = splitText(source);
  if (mode === 'translate') {
    const translations = [];
    for (const chunk of chunks) translations.push(await invoke([
      { role: 'system', content: PROMPTS.translate }, { role: 'user', content: chunk }
    ], 5000));
    return { text: translations.join('\n\n'), calls };
  }
  let input = source;
  if (chunks.length > 1) {
    const notes = [];
    for (let index = 0; index < chunks.length; index++) {
      notes.push(await invoke([
        { role: 'system', content: '仅提取本段事实、论点、数据和原作者经历；保持原有顺序，不编造，不写广告。' },
        { role: 'user', content: `第 ${index + 1}/${chunks.length} 段：\n${chunks[index]}` }
      ], 1300));
    }
    input = notes.map((note, index) => `第 ${index + 1} 段事实：\n${note}`).join('\n\n');
  }
  const result = await invoke([
    { role: 'system', content: PROMPTS[mode] }, { role: 'user', content: input }
  ], 3000);
  return { text: result, calls };
}

async function generateScript(source, { platform, format, points, model,
  env = process.env, fetchImpl = fetch, calls = [] } = {}) {
  if (!PLATFORMS[platform] || !FORMATS[format]) throw new Error('不支持的平台或成稿形式');
  const invoke = (messages, maxTokens) => callOnce(messages, {
    model, env, fetchImpl, calls, maxTokens
  });
  const baseRules = `写成 ${PLATFORMS[platform]}。${FORMATS[format]}。事实和数字必须来自输入；原博主经历称为“原博主”，不要代入第一人称；删除赞助、广告及求关注；不添加虚构细节。`;
  if (points) {
    const text = await invoke([
      { role: 'system', content: `${baseRules}仅输出平台稿，不重复罗列要点。` },
      { role: 'user', content: points.map((point, index) => `${index + 1}. ${point.text}`).join('\n') }
    ], 3000);
    return { text, calls, points: null };
  }
  const chunks = splitText(String(source || '').trim());
  if (!chunks[0]) throw new Error('原文为空');
  const notes = [];
  if (chunks.length > 1) {
    for (let index = 0; index < chunks.length; index++) {
      notes.push(await invoke([
        { role: 'system', content: '只提取本段事实、数据和作者观点，保持顺序；不要改写成脚本。' },
        { role: 'user', content: `第 ${index + 1}/${chunks.length} 段：\n${chunks[index]}` }
      ], 1300));
    }
  }
  const input = chunks.length === 1 ? chunks[0] :
    notes.map((note, index) => `第 ${index + 1} 段：\n${note}`).join('\n\n');
  const text = await invoke([
    { role: 'system', content: `${baseRules}严格用以下 Markdown 标题依次输出：\n# 主旨\n一句话\n# 重点\n- 重点及原文依据（3–6 条）\n# 平台稿\n完整成稿。` },
    { role: 'user', content: input }
  ], 3600);
  return { text, calls, points: parsePoints(text) };
}

module.exports = { generateText, generateScript, splitText, candidateModels };
