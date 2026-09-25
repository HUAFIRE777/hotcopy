const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJson3Transcript, selectCaptionTrack, curlRequest,
  fetchYouTubeCaptionsInnerTube } = require('./youtube_innertube');
const { getYouTubeTranscript } = require('./youtube_transcript');

test('JSON3 滚动字幕去重并保留真实对白', () => {
  assert.equal(parseJson3Transcript({ events: [
    { segs: [{ utf8: 'Hello' }] },
    { segs: [{ utf8: 'Hello world' }] },
    { segs: [{ utf8: 'world &amp; friends' }] },
    { segs: [{ utf8: '[Music]' }] }
  ] }), 'Hello world & friends');
});

test('优先选中文轨道，次选英文，并偏好人工字幕', () => {
  const tracks = [
    { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?en=1' },
    { languageCode: 'zh-Hans', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?zh=asr' },
    { languageCode: 'zh-Hans', baseUrl: 'https://www.youtube.com/api/timedtext?zh=manual' }
  ];
  assert.equal(selectCaptionTrack(tracks), tracks[2]);
  assert.equal(selectCaptionTrack(tracks, [{ defaultCaptionTrackIndex: 0 }]), tracks[0]);
});

test('InnerTube 只用匿名出口，读取 JSON3 字幕并跳过 yt-dlp', async () => {
  const calls = [];
  const result = await getYouTubeTranscript('TbkUKCm3CHQ', {
    innerTube: () => fetchYouTubeCaptionsInnerTube('TbkUKCm3CHQ', {
      failover: (attempt, options) => {
        assert.equal(options.anonymousOnly, true);
        return attempt(null, 'isp_anon', 'socks5://proxy.example:1080');
      },
      request: async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/youtubei/')) return { captions: { playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=TbkUKCm3CHQ' }]
        } } };
        return { events: [{ segs: [{ utf8: 'Transcript from JSON3' }] }] };
      }
    }),
    captions: async () => { throw new Error('yt-dlp should not run'); }
  });
  assert.deepEqual(result, { text: 'Transcript from JSON3', source: 'InnerTube 字幕' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.videoId, 'TbkUKCm3CHQ');
  assert.equal(calls[1].options.proxyUrl, 'socks5://proxy.example:1080');
  assert.match(calls[1].url, /fmt=json3/);
});

test('无字幕或无效字幕地址回退，不向不可信地址发送请求', async () => {
  const request = async url => url.includes('/youtubei/') ? { captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [{ languageCode: 'en', baseUrl: 'https://example.com/secret' }]
  } } } : assert.fail('Unexpected subtitle URL');
  await assert.rejects(fetchYouTubeCaptionsInnerTube('TbkUKCm3CHQ', {
    request, failover: attempt => attempt(null, 'public', null)
  }), /字幕地址无效/);
  assert.equal(await fetchYouTubeCaptionsInnerTube('TbkUKCm3CHQ', {
    request: async () => ({ captions: {} }), failover: attempt => attempt(null, 'public', null)
  }), '');
});

test('InnerTube 200 登录挑战按认证失败处理，供下一条匿名出口接管', async () => {
  await assert.rejects(fetchYouTubeCaptionsInnerTube('TbkUKCm3CHQ', {
    request: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
    failover: attempt => attempt(null, 'isp_anon', 'socks5://proxy.example:1080')
  }), /Sign in to confirm/);
});

test('SOCKS DNS 经代理解析，HTTP 错误显式分类', async () => {
  let args;
  await assert.rejects(curlRequest('https://www.youtube.com/youtubei/v1/player', {
    proxyUrl: 'socks5://user:pass@proxy.example:1080', body: { videoId: 'TbkUKCm3CHQ' },
    run: async (_binary, command) => {
      args = command;
      return { stdout: '{}\n__HOTCOPY_HTTP__429' };
    }
  }), /HTTP Error 429/);
  assert.equal(args[args.indexOf('--proxy') + 1].startsWith('socks5h://'), true);
});
