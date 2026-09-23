const crypto = require('crypto');

function createRequireAddonUser({ coreBaseUrl, userKeySecret, fetchImpl = fetch }) {
  if (!userKeySecret || userKeySecret.length < 32) {
    throw new Error('ADDONS_USER_KEY_SECRET 至少需要 32 个字符');
  }

  return async function requireAddonUser(req, res, next) {
    const authorization = req.get('authorization') || '';
    if (!/^Bearer\s+[^\s]+$/i.test(authorization)) {
      return res.status(401).json({ error: '请先登录' });
    }

    try {
      const response = await fetchImpl(`${coreBaseUrl}/api/auth/me`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) return res.status(401).json({ error: '登录态已失效，请重新登录' });
      const user = await response.json();
      if (typeof user.email !== 'string' || !user.email.trim()) {
        return res.status(401).json({ error: '登录态已失效，请重新登录' });
      }

      req.addonUser = {
        key: crypto.createHmac('sha256', userKeySecret)
          .update(user.email.trim().toLowerCase())
          .digest('hex'),
        plan: user.plan || 'free',
        expiresAt: Number(user.expires_at) || 0
      };
      next();
    } catch {
      return res.status(503).json({ error: '暂时无法验证会员状态，请稍后重试' });
    }
  };
}

module.exports = { createRequireAddonUser };
