const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { extractYouTubeId, parseVttTranscript, fetchYouTubeCaptionsFast, getYouTubeTranscript } = require('./youtube_transcript');

test('标准、Shorts、直播、手机端与带跟踪参数的短链识别为同一视频', () => {
  const id = 'TbkUKCm3CHQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?si=abc&v=${id}&feature=share`,
    `https://m.youtube.com/shorts/${id}?si=abc`,
    `https://youtube.com/live/${id}?feature=share`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/embed/${id}`,
    `复制链接 https://music.youtube.com/watch?v=${id}&list=abc`
  ]) assert.equal(extractYouTubeId(url), id, url);
  for (const url of [
    'https://notyoutube.com/watch?v=TbkUKCm3CHQ',
    'https://youtube.com/watch?v=TbkUKCm3CHQmore',
    'https://youtube.com/shorts/invalid',
    'https://youtube.com/@channel',
    'https://youtu.be/dQw4w9WgXc',
    '', null
  ]) assert.equal(extractYouTubeId(url), null, String(url));
});

test('VTT 清除时间戳与标记，合并滚动字幕，不重复相邻对白', () => {
  const vtt = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c>Hello</c>\n\n00:00:01.000 --> 00:00:02.000\n<c>Hello world</c>\n\n00:00:02.000 --> 00:00:03.000\nworld &amp; friends\n\n00:00:03.000 --> 00:00:04.000\n[Music]\n\n00:00:04.000 --> 00:00:05.000\nWe use TypeScript.`;
  assert.equal(parseVttTranscript(vtt), 'Hello world & friends We use TypeScript.');
});

test('yt-dlp 只接收固定视频 URL 与参数数组，优先原语言并清理临时字幕', async () => {
  let outputDirectory;
  let command;
  const run = async (binary, args, options) => {
    command = { binary, args, options };
    const template = args[args.indexOf('-o') + 1];
    outputDirectory = require('path').dirname(template);
    fs.writeFileSync(require('path').join(outputDirectory, 'TbkUKCm3CHQ.en.vtt'),
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOriginal English dialogue');
    fs.writeFileSync(require('path').join(outputDirectory, 'TbkUKCm3CHQ.zh-Hans.vtt'),
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n自动翻译成中文的对白');
    return { stdout: 'en\n' };
  };
  const text = await fetchYouTubeCaptionsFast('TbkUKCm3CHQ', { run, cookiesPath: null });
  assert.equal(text, 'Original English dialogue');
  assert.equal(command.args.at(-1), 'https://www.youtube.com/watch?v=TbkUKCm3CHQ');
  assert.equal(command.args.includes('--skip-download'), true);
  assert.equal(command.args.includes('--no-simulate'), true);
  assert.equal(command.args.includes('--write-auto-subs'), true);
  assert.equal(command.args.includes('--cookies'), false);
  assert.equal(fs.existsSync(outputDirectory), false);
});

test('指定 Cookie 不可用时不静默裸连，临时目录仍被清理', async () => {
  let called = false;
  await assert.rejects(fetchYouTubeCaptionsFast('TbkUKCm3CHQ', {
    cookiesPath: '/definitely/missing/hotcopy-cookies.txt',
    run: async () => { called = true; return { stdout: '' }; }
  }), /Cookie 文件不可用/);
  assert.equal(called, false);
});

test('异步字幕写入完成前保留临时目录，结束后清理', async () => {
  let directory;
  const text = await fetchYouTubeCaptionsFast('TbkUKCm3CHQ', {
    cookiesPath: null,
    run: async (_binary, args) => {
      directory = require('path').dirname(args[args.indexOf('-o') + 1]);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(directory), true);
      fs.writeFileSync(require('path').join(directory, 'TbkUKCm3CHQ.en.vtt'),
        'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nDelayed English dialogue');
      return { stdout: 'en\n' };
    }
  });
  assert.equal(text, 'Delayed English dialogue');
  assert.equal(fs.existsSync(directory), false);
});

test('字幕快速路径、yt-dlp、备用库、Whisper 依次降级，失败返回友好错误', async () => {
  const fastCalls = [];
  const fast = await getYouTubeTranscript('TbkUKCm3CHQ', {
    innerTube: async () => '',
    captions: async () => { fastCalls.push('captions'); return '直接获得的字幕'; },
    legacy: async () => { fastCalls.push('legacy'); return ''; },
    whisper: async () => { fastCalls.push('whisper'); return ''; }
  });
  assert.deepEqual(fastCalls, ['captions']);
  assert.deepEqual(fast, { text: '直接获得的字幕', source: 'yt-dlp 字幕' });
  const calls = [];
  const result = await getYouTubeTranscript('TbkUKCm3CHQ', {
    innerTube: async () => '',
    captions: async () => { calls.push('captions'); throw new Error('HTTP 429'); },
    legacy: async () => { calls.push('legacy'); return ''; },
    whisper: async () => { calls.push('whisper'); return '真实对白'; }
  });
  assert.deepEqual(calls, ['captions', 'legacy', 'whisper']);
  assert.deepEqual(result, { text: '真实对白', source: '音频听译' });
  await assert.rejects(getYouTubeTranscript('TbkUKCm3CHQ', {
    innerTube: async () => '',
    captions: async () => '', legacy: async () => '', whisper: async () => { throw new Error('Video unavailable'); }
  }), /已下架、设为私密或限制访问/);
});
