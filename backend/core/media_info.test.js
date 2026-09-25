const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSource, cacheMode, youtubeDuration, parseDuration } = require('./media_info');

test('source parser normalizes YouTube and rejects unsafe direct URLs', () => {
  assert.deepEqual(parseSource('https://youtu.be/abcdefghijk?t=32'), {
    platform: 'youtube', videoId: 'abcdefghijk',
    url: 'https://www.youtube.com/watch?v=abcdefghijk'
  });
  assert.throws(() => parseSource('http://127.0.0.1/audio.mp3'), /HTTPS/);
  assert.throws(() => parseSource('https://example.com/audio.mp3'), /任务队列支持/);
  assert.notEqual(cacheMode('rewrite', 'one'), cacheMode('rewrite', 'two'));
});

test('duration metadata uses configured proxy failover and rejects unknown duration', async () => {
  const calls = [];
  const run = async (_program, args) => {
    calls.push(args);
    return { stdout: '1801\n' };
  };
  const failover = task => task(null, 'isp-1', 'socks5://localhost:1234');
  assert.equal(await youtubeDuration('abcdefghijk', { run, failover }), 1801);
  assert.ok(calls[0].includes('--proxy'));
  assert.ok(calls[0].includes('socks5://localhost:1234'));
  assert.throws(() => parseDuration('NA'), /时长/);
});
