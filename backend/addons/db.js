const Database = require('better-sqlite3');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, 'addons.sqlite');

function openDatabase(filename = process.env.ADDONS_DB_PATH || DEFAULT_DB_PATH) {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_creators (
      channel_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      channel_url TEXT NOT NULL,
      curated_rank INTEGER DEFAULT 99,
      is_active INTEGER DEFAULT 1,
      last_checked_at INTEGER DEFAULT 0,
      last_success_at INTEGER DEFAULT 0,
      last_error_code TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      verified_source TEXT,
      verified_at INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS radar_videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      thumbnail_url TEXT,
      published_at INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      latest_views INTEGER,
      duration_seconds INTEGER,
      velocity_hourly REAL DEFAULT 0,
      spike_score REAL DEFAULT 1,
      status_badge TEXT DEFAULT 'NEW'
    );

    CREATE TABLE IF NOT EXISTS radar_view_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      views_count INTEGER NOT NULL,
      UNIQUE(video_id, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_vid
      ON radar_view_snapshots(video_id, observed_at);

    CREATE TABLE IF NOT EXISTS radar_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      video_id TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(user_key, video_id)
    );

    CREATE TABLE IF NOT EXISTS asset_usage (
      user_key TEXT NOT NULL,
      billing_month TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, billing_month, asset_type)
    );

    CREATE TABLE IF NOT EXISTS asset_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asset_library_user_created
      ON asset_library(user_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS creation_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      video_id TEXT,
      kit_data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_key, source_url)
    );
    CREATE INDEX IF NOT EXISTS idx_creation_projects_user_updated
      ON creation_projects(user_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS creation_project_assets (
      project_id INTEGER NOT NULL REFERENCES creation_projects(id) ON DELETE CASCADE,
      asset_type TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, asset_type, platform)
    );
  `);
  const creatorColumns = new Set(db.prepare('PRAGMA table_info(radar_creators)').all().map(column => column.name));
  if (!creatorColumns.has('last_error_code')) db.exec('ALTER TABLE radar_creators ADD COLUMN last_error_code TEXT');
  if (!creatorColumns.has('failure_count')) db.exec('ALTER TABLE radar_creators ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0');
  if (!creatorColumns.has('next_retry_at')) db.exec('ALTER TABLE radar_creators ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0');
  if (!creatorColumns.has('verified_source')) db.exec('ALTER TABLE radar_creators ADD COLUMN verified_source TEXT');
  if (!creatorColumns.has('verified_at')) db.exec('ALTER TABLE radar_creators ADD COLUMN verified_at INTEGER DEFAULT 0');
  const videoColumns = new Set(db.prepare('PRAGMA table_info(radar_videos)').all().map(column => column.name));
  if (!videoColumns.has('duration_seconds')) db.exec('ALTER TABLE radar_videos ADD COLUMN duration_seconds INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_radar_creators_due ON radar_creators(is_active, next_retry_at)');
  const projectColumns = new Set(db.prepare('PRAGMA table_info(creation_projects)').all().map(column => column.name));
  if (!projectColumns.has('video_id')) db.exec('ALTER TABLE creation_projects ADD COLUMN video_id TEXT');
  if (!projectColumns.has('kit_data')) db.exec('ALTER TABLE creation_projects ADD COLUMN kit_data TEXT');
  return db;
}

module.exports = { openDatabase, DEFAULT_DB_PATH };
