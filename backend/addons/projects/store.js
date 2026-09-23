const { normalizeOutput, PLATFORMS } = require('../assets/generate');

const PROJECT_LIMITS = Object.freeze({ pro: 50, premium: 200 });
const PROJECT_ASSET_TYPES = new Set(['xiaohongshu', 'short-video', 'mindmap', 'production-package']);

class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function projectId(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ProjectError(400, '项目 ID 无效');
  }
  return Number(value);
}

function createProjectStore(db) {
  const bySource = db.prepare('SELECT id, raw_text, video_id, kit_data FROM creation_projects WHERE user_key = ? AND source_url = ?');
  const byId = db.prepare('SELECT * FROM creation_projects WHERE id = ? AND user_key = ?');
  const count = db.prepare('SELECT COUNT(*) AS total FROM creation_projects WHERE user_key = ?');
  const insert = db.prepare(`
    INSERT INTO creation_projects (user_key, source_url, title, raw_text, video_id, kit_data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE creation_projects SET title = ?, raw_text = ?, video_id = ?, kit_data = ?, updated_at = ?
    WHERE id = ? AND user_key = ?
  `);
  const list = db.prepare(`
    SELECT p.id, p.source_url, p.title, p.created_at, p.updated_at,
      CASE WHEN p.kit_data IS NULL THEN 0 ELSE 1 END AS has_kit,
      (SELECT COUNT(*) FROM creation_project_assets a WHERE a.project_id = p.id) AS asset_count
    FROM creation_projects p WHERE p.user_key = ?
    ORDER BY p.updated_at DESC, p.id DESC LIMIT 200
  `);
  const assets = db.prepare(`
    SELECT asset_type, platform, content_json, updated_at
    FROM creation_project_assets WHERE project_id = ?
    ORDER BY updated_at DESC
  `);
  const saveAssetStatement = db.prepare(`
    INSERT INTO creation_project_assets (project_id, asset_type, platform, content_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, asset_type, platform)
    DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at
  `);
  const touch = db.prepare('UPDATE creation_projects SET updated_at = ? WHERE id = ? AND user_key = ?');
  const remove = db.prepare('DELETE FROM creation_projects WHERE id = ? AND user_key = ?');

  const upsert = db.transaction((user, input, now = Date.now()) => {
    const sourceUrl = typeof input?.source_url === 'string' ? input.source_url.trim() : '';
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const rawText = input?.raw_text;
    const hasKit = input?.kit_data !== undefined && input?.kit_data !== null;
    if (hasKit && user.plan !== 'premium') throw new ProjectError(403, '全套制作包项目仅向 Premium 会员开放');
    let kitJson = null;
    if (hasKit) {
      try {
        const kit = normalizeOutput('production-kit', JSON.stringify(input.kit_data));
        kitJson = JSON.stringify(kit);
      } catch { throw new ProjectError(400, '全套制作包格式无效'); }
      if (kitJson.length > 50000) throw new ProjectError(413, '制作包内容过长');
    }
    const videoId = input?.video_id;
    if (!sourceUrl || sourceUrl.length > 2048 || /[\x00-\x1f]/.test(sourceUrl) ||
        !title || title.length > 120 || /[\x00-\x1f]/.test(title) ||
        (rawText !== undefined && (typeof rawText !== 'string' || !rawText.trim() || rawText.length > 40000)) ||
        (!hasKit && rawText === undefined) ||
        (videoId !== undefined && (typeof videoId !== 'string' || videoId.length > 128 || /[\x00-\x1f]/.test(videoId)))) {
      throw new ProjectError(400, '项目素材格式无效或内容过长');
    }
    const limit = PROJECT_LIMITS[user.plan] || 0;
    if (!limit) throw new ProjectError(403, '当前会员无法保存创作项目');
    const previous = bySource.get(user.key, sourceUrl);
    if (previous) {
      update.run(title, rawText === undefined ? previous.raw_text : rawText,
        videoId === undefined ? previous.video_id : videoId,
        kitJson === null ? previous.kit_data : kitJson, now, previous.id, user.key);
      return { id: previous.id, created: false };
    }
    if (count.get(user.key).total >= limit) {
      throw new ProjectError(409, '项目数量已达当前方案上限');
    }
    const result = insert.run(user.key, sourceUrl, title, rawText || '', videoId || null, kitJson, now, now);
    return { id: Number(result.lastInsertRowid), created: true };
  });

  const saveAsset = db.transaction((user, id, input, now = Date.now()) => {
    const row = byId.get(id, user.key);
    if (!row) throw new ProjectError(404, '找不到这个项目');
    const assetType = input?.asset_type;
    if (!PROJECT_ASSET_TYPES.has(assetType)) throw new ProjectError(400, '作品类型无效');
    const platform = assetType === 'short-video' || assetType === 'production-package'
      ? input?.platform : '';
    if ((platform && !Object.hasOwn(PLATFORMS, platform)) ||
        ((assetType === 'short-video' || assetType === 'production-package') && !platform)) {
      throw new ProjectError(400, '口播平台无效');
    }
    const content = input?.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new ProjectError(400, '作品内容格式无效');
    }
    if (assetType === 'short-video') {
      try { normalizeOutput('short-video', content.script_markdown); }
      catch { throw new ProjectError(400, '口播稿格式无效'); }
    }
    if (assetType === 'production-package' &&
        (content.platform !== platform || typeof content.agent_prompt !== 'string' ||
         !content.agent_prompt.trim() || !Array.isArray(content.sections) || content.sections.length !== 4)) {
      throw new ProjectError(400, '制作包格式无效');
    }
    if (assetType === 'mindmap' &&
        (!content.json_tree || !Array.isArray(content.json_tree.branches) ||
         typeof content.mermaid_code !== 'string')) {
      throw new ProjectError(400, '脑图格式无效');
    }
    if (assetType === 'xiaohongshu' &&
        (typeof content.title !== 'string' || !Array.isArray(content.sections))) {
      throw new ProjectError(400, '图文格式无效');
    }
    const contentJson = JSON.stringify(content);
    if (contentJson.length > 50000) throw new ProjectError(413, '作品内容过长');
    saveAssetStatement.run(id, assetType, platform || '', contentJson, now);
    touch.run(now, id, user.key);
    return { id, asset_type: assetType, platform: platform || '' };
  });

  return {
    upsert,
    list: user => list.all(user.key),
    get(user, id) {
      const row = byId.get(id, user.key);
      if (!row) throw new ProjectError(404, '找不到这个项目');
      return {
        id: row.id, source_url: row.source_url, title: row.title,
        raw_text: row.raw_text, video_id: row.video_id,
        kit_data: row.kit_data ? JSON.parse(row.kit_data) : null,
        created_at: row.created_at, updated_at: row.updated_at,
        assets: assets.all(id).map(asset => ({
          asset_type: asset.asset_type, platform: asset.platform,
          content: JSON.parse(asset.content_json), updated_at: asset.updated_at
        }))
      };
    },
    saveAsset,
    remove(user, id) {
      return remove.run(id, user.key).changes === 1;
    }
  };
}

module.exports = { createProjectStore, projectId, ProjectError, PROJECT_LIMITS };
