// Creates a consistent snapshot of the database + encrypted receipts in ./backups/<timestamp>/
// The snapshot is already encrypted at the field/file level; store it together with your .env key.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import { db } from '../server/db.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(process.env.BACKUP_DIR || path.join(ROOT, 'backups'), stamp);
fs.mkdirSync(path.join(dest, 'uploads'), { recursive: true });

const target = path.join(dest, 'tracker.sqlite').replace(/\\/g, '/').replace(/'/g, "''");
db.exec(`VACUUM INTO '${target}'`);

let files = 0;
for (const f of fs.readdirSync(path.join(config.dataDir, 'uploads'))) {
  fs.copyFileSync(path.join(config.dataDir, 'uploads', f), path.join(dest, 'uploads', f));
  files += 1;
}
db.close();
console.log(`Backup written to ${dest}`);
console.log(`  database: tracker.sqlite, receipts: ${files} file(s)`);
console.log('Remember: the backup is only readable together with the ENCRYPTION_KEY from your .env');
