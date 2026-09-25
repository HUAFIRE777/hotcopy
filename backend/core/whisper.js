const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const TURBO_MODEL = 'whisper-large-v3-turbo';
const ACCURATE_MODEL = 'whisper-large-v3';

async function transcribeWithGroq(filePath, { keys, audioSec = null, maxRetries = 1,
  post = axios.post, onBilled = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  logger = console } = {}) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('语音转录服务尚未配置');

  const request = async (apiKey, model) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', model);
    const response = await post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` }, timeout: 120000
    });
    // A successful API response may still have no recognized speech and can be billed.
    onBilled(model, audioSec);
    return String(response.data?.text || '').trim();
  };

  let lastError;
  for (const apiKey of keys) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let attemptedAccurate = false;
      try {
        const text = await request(apiKey, TURBO_MODEL);
        if (text) return text;
        // Only an actual empty transcript justifies paying for the accurate model.
        attemptedAccurate = true;
        let accurateText;
        try { accurateText = await request(apiKey, ACCURATE_MODEL); }
        catch (error) { error.whisperAccurateAttempted = true; throw error; }
        if (accurateText) return accurateText;
        throw new Error('听写服务未识别出有效对白');
      } catch (error) {
        lastError = error;
        const message = error.response?.data?.error?.message || error.message;
        logger.warn?.(`[Groq Whisper] ${attemptedAccurate ? 'Large V3' : 'Turbo'} 第 ${attempt + 1} 次请求失败: ${message}`);
        // Once accurate transcription was attempted, further attempts would pay
        // for the same audio again without a clear recovery path.
        if (attemptedAccurate) {
          if (error.message === '听写服务未识别出有效对白') throw error;
          throw new Error(`语音转录失败: ${message}`);
        }
        const status = error.response?.status;
        if (status === 429 || status === 401 || status === 403 || status === 400) break;
        if (attempt < maxRetries) await sleep(1500 * (attempt + 1));
      }
    }
  }

  const detail = lastError?.response?.data?.error?.message || lastError?.message || '';
  if (lastError?.response?.status === 429 || /Rate limit reached|seconds of audio per hour/i.test(detail)) {
    throw new Error('当前听写通道额度或速率已满，请稍后重试');
  }
  throw new Error(`语音转录失败: ${detail || '服务暂不可用'}`);
}

module.exports = { transcribeWithGroq, TURBO_MODEL, ACCURATE_MODEL };
