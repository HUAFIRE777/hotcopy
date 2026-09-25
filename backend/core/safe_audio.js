const axios = require('axios');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const MAX_AUDIO_BYTES = 256 * 1024 * 1024;

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return publicAddress(lower.slice(7));
    return !(lower === '::' || lower === '::1' || lower.startsWith('ff') || lower.startsWith('fc') ||
      lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb'));
  }
  return false;
}

function assertHttpsPublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('播客音频地址无效'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password ||
    !url.hostname || url.port && url.port !== '443' ||
    (net.isIP(hostname) && !publicAddress(hostname))) {
    throw new Error('播客音频地址必须使用公开 HTTPS 主机');
  }
  return url.toString();
}

function publicLookup(hostname, _options, callback) {
  if (net.isIP(hostname)) {
    return publicAddress(hostname) ? callback(null, hostname, net.isIP(hostname)) :
      callback(new Error('拒绝连接内网音频地址'));
  }
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const publicRecords = addresses.filter(record => publicAddress(record.address));
    if (!publicRecords.length || publicRecords.length !== addresses.length) {
      return callback(new Error('音频地址解析到内网或保留地址'));
    }
    callback(null, publicRecords[0].address, publicRecords[0].family);
  });
}

async function downloadSafeAudio(input, { get = axios.get, maxBytes = MAX_AUDIO_BYTES } = {}) {
  const url = assertHttpsPublicUrl(input);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotcopy-audio-'));
  const file = path.join(dir, 'source.audio');
  try {
    const response = await get(url, {
      responseType: 'stream', timeout: 30_000, maxRedirects: 3, proxy: false,
      httpsAgent: new https.Agent({ lookup: publicLookup }),
      beforeRedirect: options => assertHttpsPublicUrl(`${options.protocol}//${options.hostname}${options.port ? ':' + options.port : ''}/`),
      maxContentLength: maxBytes
    });
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new Error('音频超过允许大小') : null, chunk);
    } });
    await pipeline(response.data, limit, fs.createWriteStream(file, { mode: 0o600 }));
    if (!bytes) throw new Error('音频内容为空');
    return { file, bytes, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { downloadSafeAudio, assertHttpsPublicUrl, publicAddress };
