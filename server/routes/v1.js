// Public REST API (v1). Authenticated with API keys only; reuses the same route handlers as the app.
import { Router } from 'express';
import { config } from '../config.js';
import { one, all } from '../db.js';
import { requireApiKey, apiKeyLimiter } from '../middleware/apikey.js';
import { notFoundHandler } from '../middleware/errors.js';
import { companyRow, categoryRow, getMembers } from '../services/repo.js';
import { buildOpenApi } from '../openapi.js';
import projectRoutes from './projects.js';
import expenseRoutes from './expenses.js';
import taskRoutes from './tasks.js';
import activityRoutes from './activity.js';

const router = Router();
const baseUrl = (req) => config.appUrl || `${req.protocol}://${req.get('host')}`;

// No cookies are accepted on this surface, so it is safe to allow any origin.
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key, X-Filename');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

router.get('/', (req, res) => res.json({ name: 'Keel API', version: 'v1', docs: `${baseUrl(req)}/developers`, openapi: `${baseUrl(req)}/api/v1/openapi.json` }));
router.get('/openapi.json', (req, res) => res.json(buildOpenApi(baseUrl(req))));

router.use(requireApiKey, apiKeyLimiter);

router.get('/me', (req, res) => {
  const k = req.apiKey;
  const owner = one('SELECT id, name, email FROM users WHERE id = ?', k.user_id);
  res.json({
    key: { id: k.id, name: k.name, scope: k.scope, prefix: k.prefix, expiresAt: k.expires_at, createdAt: k.created_at },
    actingAs: { id: owner.id, name: owner.name, email: owner.email, role: req.role },
    company: companyRow(req.company),
  });
});

router.get('/company', (req, res) => {
  res.json({
    company: companyRow(req.company),
    counts: {
      projects: one('SELECT count(*) AS c FROM projects WHERE company_id = ? AND status != ?', req.company.id, 'archived').c,
      expenses: one('SELECT count(*) AS c FROM expenses WHERE company_id = ?', req.company.id).c,
      openTasks: one('SELECT count(*) AS c FROM tasks WHERE company_id = ? AND status != ?', req.company.id, 'done').c,
    },
  });
});

router.get('/members', (req, res) => res.json({ items: getMembers(req.company.id) }));

router.get('/categories', (req, res) => {
  res.json({ items: all('SELECT * FROM categories WHERE company_id = ? ORDER BY archived, sort_order, name', req.company.id).map(categoryRow) });
});

router.use(projectRoutes);
router.use(taskRoutes);
router.use(expenseRoutes);
router.use(activityRoutes);
router.use(notFoundHandler);

export default router;
