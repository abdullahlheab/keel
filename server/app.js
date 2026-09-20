import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { securityHeaders, csrfGuard, apiLimiter } from './middleware/security.js';
import { loadSession, requireAuth, requireCompany } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import companyRoutes from './routes/company.js';
import projectRoutes from './routes/projects.js';
import expenseRoutes from './routes/expenses.js';
import taskRoutes from './routes/tasks.js';
import activityRoutes from './routes/activity.js';
import apiKeyRoutes from './routes/apikeys.js';
import v1Routes from './routes/v1.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  app.use(securityHeaders);

  // ---- API ----
  const api = express.Router();
  api.use(apiLimiter);
  api.use(express.json({ limit: '1mb' }));
  // Public API: API keys only, mounted before cookie sessions and the CSRF guard on purpose.
  api.use('/v1', v1Routes);
  api.use(loadSession);
  api.use(csrfGuard);
  api.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  api.use('/auth', authRoutes);
  api.use(requireAuth, requireCompany);
  api.use(companyRoutes);
  api.use(apiKeyRoutes);
  api.use(projectRoutes);
  api.use(expenseRoutes);
  api.use(taskRoutes);
  api.use(activityRoutes);
  api.use(notFoundHandler);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, api);

  // ---- static frontend ----
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: config.isProd ? '1h' : 0, etag: true }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use(errorHandler);
  return app;
}
