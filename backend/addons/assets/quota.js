const LIMITS = Object.freeze({ pro: 30, premium: 100 });
const ASSET_TYPES = new Set(['xiaohongshu', 'short-video', 'mindmap', 'production-kit']);

function billingMonth(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

function planLimit(user, now = Date.now()) {
  if (user.expiresAt <= now) return 0;
  return LIMITS[user.plan] || 0;
}

function createQuota(db) {
  const totalStatement = db.prepare(`
    SELECT COALESCE(SUM(used_count), 0) AS used
    FROM asset_usage WHERE user_key = ? AND billing_month = ?
  `);
  const typeStatement = db.prepare(`
    SELECT asset_type, used_count FROM asset_usage
    WHERE user_key = ? AND billing_month = ?
  `);
  const incrementStatement = db.prepare(`
    INSERT INTO asset_usage (user_key, billing_month, asset_type, used_count, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_key, billing_month, asset_type)
    DO UPDATE SET used_count = used_count + 1, updated_at = excluded.updated_at
  `);
  const refundStatement = db.prepare(`
    UPDATE asset_usage SET used_count = used_count - 1, updated_at = ?
    WHERE user_key = ? AND billing_month = ? AND asset_type = ? AND used_count > 0
  `);

  function usage(user, now = Date.now()) {
    const month = billingMonth(now);
    const used = totalStatement.get(user.key, month).used;
    const limit = planLimit(user, now);
    return {
      plan: user.plan,
      month,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      by_type: Object.fromEntries(typeStatement.all(user.key, month)
        .map(row => [row.asset_type, row.used_count]))
    };
  }

  const reserveTransaction = db.transaction((user, assetType, now) => {
    const month = billingMonth(now);
    const used = totalStatement.get(user.key, month).used;
    const limit = planLimit(user, now);
    if (used >= limit) return null;
    incrementStatement.run(user.key, month, assetType, now);
    return { month, remaining: limit - used - 1 };
  });

  function reserve(user, assetType, now = Date.now()) {
    if (!ASSET_TYPES.has(assetType)) throw new Error('未知资产类型');
    return reserveTransaction(user, assetType, now);
  }

  function refund(user, assetType, month, now = Date.now()) {
    refundStatement.run(now, user.key, month, assetType);
  }

  return { usage, reserve, refund };
}

module.exports = { createQuota, planLimit, billingMonth, ASSET_TYPES };
