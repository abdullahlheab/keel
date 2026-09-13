import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`Company Tracker listening on http://${host}:${config.port}  (env: ${config.env}, data: ${config.dataDir})`);
  if (!config.isProd) console.log('Tip: set NODE_ENV=production, TRUST_PROXY=true and SECURE_COOKIES=true when deploying behind HTTPS.');
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
