const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { cleanTrends } = require('./trends_live');

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const dbArg = argv.find(argument => argument.startsWith('--db='));
  const dbPath = dbArg ? path.resolve(dbArg.slice(5)) : path.join(__dirname, 'database.sqlite');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const preview = cleanTrends(db);
    console.log(JSON.stringify({ database: dbPath, ...preview }));
    if (!apply) return;
    const backupDir = path.join(path.dirname(dbPath), '.backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = path.join(backupDir,
      `${path.basename(dbPath)}.trends-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await db.backup(backup);
    const applied = cleanTrends(db, { dryRun: false });
    console.log(JSON.stringify({ backup, ...applied }));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`热点清理失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
