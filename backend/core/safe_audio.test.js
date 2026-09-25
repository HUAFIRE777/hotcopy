const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Readable } = require('stream');
const { downloadSafeAudio, assertHttpsPublicUrl, publicAddress } = require('./safe_audio');

test('audio fetch rejects local addresses and non-HTTPS links', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.throws(() => assertHttpsPublicUrl('https://127.0.0.1/a.mp3'), /公开 HTTPS/);
  assert.throws(() => assertHttpsPublicUrl('http://example.com/a.mp3'), /公开 HTTPS/);
  assert.throws(() => assertHttpsPublicUrl('https://user:pass@example.com/a.mp3'), /公开 HTTPS/);
});

test('podcast download bounds bytes and removes temporary files', async () => {
  const good = await downloadSafeAudio('https://example.com/a.mp3', {
    get: async () => ({ data: Readable.from([Buffer.from('audio')]) }), maxBytes: 10
  });
  assert.equal(fs.readFileSync(good.file, 'utf8'), 'audio');
  assert.equal(good.bytes, 5);
  good.cleanup();
  assert.equal(fs.existsSync(good.file), false);
  await assert.rejects(downloadSafeAudio('https://example.com/a.mp3', {
    get: async () => ({ data: Readable.from([Buffer.from('too much audio')]) }), maxBytes: 10
  }), /允许大小/);
});
