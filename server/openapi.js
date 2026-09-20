// OpenAPI 3 description of the public API. The in-app reference is rendered from this, so keep it truthful.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });
const ok = (schema, description = 'OK') => ({ 200: { description, ...json(schema) } });
const created = (schema) => ({ 201: { description: 'Created', ...json(schema) } });
const list = (name) => ({ type: 'object', properties: { items: { type: 'array', items: ref(name) } } });
const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', description, schema });
const p = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const body = (name, required = true) => ({ requestBody: { required, ...json(ref(name)) } });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const date = (description) => ({ type: 'string', format: 'date', description, example: '2026-10-01', nullable: true });
const uuid = (description) => ({ type: 'string', format: 'uuid', description, nullable: true });

const TASK_STATUS = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const PRIORITY = ['low', 'medium', 'high', 'urgent'];
const PROJECT_STATUS = ['planning', 'active', 'on_hold', 'completed', 'archived'];
const EXPENSE_STATUS = ['pending', 'paid', 'reimbursed'];

const taskId = p('id', 'Task id (UUID) or its reference such as `ACME-12`.');

export function buildOpenApi(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Keel API',
      version: '1.0.0',
      description: 'Read and change projects, tasks, expenses and activity in your Keel workspace. Authenticate every request with an API key: `Authorization: Bearer keel_...`. A key acts as the person who created it, with their role, and is limited to one company. Read-only keys can only make GET requests. Errors are JSON: `{ "error": "message", "fields": { "name": "problem" } }`. Money is returned as integer cents (`amountCents`) and accepted as a decimal (`amount`: 12.5 or "1,234.50"). Rate limit: 300 requests per minute per key.',
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Account', description: 'Who the key is, the company, its members and expense categories.' },
      { name: 'Projects', description: 'Projects with budget, spend and task progress.' },
      { name: 'Tasks', description: 'Work items on the board. Use a task id or its reference (e.g. ACME-12).' },
      { name: 'Expenses', description: 'Spending, with a company-wide summary.' },
      { name: 'Activity', description: 'The audit trail. Changes made through the API are marked with the key name.' },
    ],
    paths: {
      '/me': { get: { tags: ['Account'], summary: 'Check a key', description: 'Returns the key, the person it acts as, and the company. Handy for testing a connection.', responses: ok({ type: 'object' }) } },
      '/company': { get: { tags: ['Account'], summary: 'Company details and counts', responses: ok({ type: 'object' }) } },
      '/members': { get: { tags: ['Account'], summary: 'List members', description: 'Use the ids as `assigneeUserId`, `leadUserId` or `paidByUserId`.', responses: ok(list('Member')) } },
      '/categories': { get: { tags: ['Account'], summary: 'List expense categories', description: 'Use the ids as `categoryId` on expenses.', responses: ok(list('Category')) } },

      '/projects': {
        get: { tags: ['Projects'], summary: 'List projects', parameters: [q('status', 'Only this status.', { type: 'string', enum: PROJECT_STATUS }), q('includeArchived', 'Set to 1 to include archived projects.')], responses: ok(list('Project')) },
        post: { tags: ['Projects'], summary: 'Create a project', ...body('ProjectInput'), responses: created(ref('Project')) },
      },
      '/projects/{id}': {
        get: { tags: ['Projects'], summary: 'Get a project', description: 'Includes its tasks, latest expenses, and spend by month and category.', parameters: [p('id', 'Project id.')], responses: ok({ type: 'object' }) },
        patch: { tags: ['Projects'], summary: 'Update a project', description: 'Send only the fields you want to change.', parameters: [p('id', 'Project id.')], ...body('ProjectInput'), responses: ok(ref('Project')) },
        delete: { tags: ['Projects'], summary: 'Delete a project', description: 'Admins and owners only. Tasks and expenses are kept and become unassigned.', parameters: [p('id', 'Project id.')], responses: ok({ type: 'object' }) },
      },
      '/projects/{id}/tasks': {
        get: { tags: ['Projects'], summary: 'List the tasks of a project', parameters: [p('id', 'Project id.'), q('status', 'Only this status.', { type: 'string', enum: TASK_STATUS })], responses: ok(list('Task')) },
        post: { tags: ['Projects'], summary: 'Create a task on a project', description: 'Same body as creating a task; `projectId` is taken from the URL.', parameters: [p('id', 'Project id.')], ...body('TaskInput'), responses: created(ref('Task')) },
      },

      '/tasks': {
        get: {
          tags: ['Tasks'], summary: 'List tasks',
          parameters: [
            q('project', 'Project id, or `none` for tasks without a project.'), q('assignee', 'Member id, or `none` for unassigned.'),
            q('status', 'Only this status.', { type: 'string', enum: TASK_STATUS }), q('priority', 'Only this priority.', { type: 'string', enum: PRIORITY }),
            q('label', 'Only tasks carrying this label.'), q('q', 'Search in title, description, or an exact reference.'),
            q('updatedSince', 'ISO timestamp. Only tasks changed after it; useful for polling.', { type: 'string', format: 'date-time' }),
            q('limit', 'Page size.', { type: 'integer' }), q('offset', 'Items to skip.', { type: 'integer' }),
          ],
          responses: ok(list('Task')),
        },
        post: { tags: ['Tasks'], summary: 'Create a task', ...body('TaskInput'), responses: created(ref('Task')) },
      },
      '/tasks/{id}': {
        get: { tags: ['Tasks'], summary: 'Get a task with its comments', parameters: [taskId], responses: ok(ref('Task')) },
        patch: { tags: ['Tasks'], summary: 'Update a task', description: 'Send only the fields you want to change, for example `{ "status": "done" }`. Send `null` to clear a field.', parameters: [taskId], ...body('TaskInput'), responses: ok(ref('Task')) },
        delete: { tags: ['Tasks'], summary: 'Delete a task', description: 'Allowed for the creator, admins and owners.', parameters: [taskId], responses: ok({ type: 'object' }) },
      },
      '/tasks/{id}/move': { post: { tags: ['Tasks'], summary: 'Move a task to a column position', parameters: [taskId], requestBody: { required: true, ...json({ type: 'object', required: ['status', 'index'], properties: { status: { type: 'string', enum: TASK_STATUS, description: 'Target column.' }, index: { type: 'integer', description: '0 places it at the top.' } } }) }, responses: ok(ref('Task')) } },
      '/tasks/{id}/comments': { post: { tags: ['Tasks'], summary: 'Comment on a task', parameters: [taskId], requestBody: { required: true, ...json({ type: 'object', required: ['body'], properties: { body: str('The comment text.') } }) }, responses: created(ref('Comment')) } },
      '/tasks/bulk': { post: { tags: ['Tasks'], summary: 'Change many tasks at once', description: '`update` takes `data` with any of status, priority, assigneeUserId, projectId, dueDate. `move` takes `{ status, index }`. `add_label` and `remove_label` take `{ label }`. `duplicate` and `delete` take no data.', ...body('TaskBulk'), responses: ok(list('Task')) } },

      '/expenses': {
        get: {
          tags: ['Expenses'], summary: 'List expenses',
          parameters: [
            q('project', 'Project id, or `none`.'), q('category', 'Category id, or `none`.'), q('paidBy', 'Member id.'),
            q('status', 'Only this status.', { type: 'string', enum: EXPENSE_STATUS }), q('from', 'Earliest date, YYYY-MM-DD.'), q('to', 'Latest date, YYYY-MM-DD.'),
            q('q', 'Search vendor, description and notes.'), q('updatedSince', 'ISO timestamp. Only expenses changed after it.', { type: 'string', format: 'date-time' }),
            q('limit', 'Page size, up to 500 (default 100).', { type: 'integer' }), q('offset', 'Items to skip.', { type: 'integer' }),
          ],
          responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('Expense') }, total: { type: 'integer' }, sumCents: { type: 'integer' } } }),
        },
        post: { tags: ['Expenses'], summary: 'Create an expense', ...body('ExpenseInput'), responses: created(ref('Expense')) },
      },
      '/expenses/summary': { get: { tags: ['Expenses'], summary: 'Spending summary', description: 'Totals, the last 12 months, and breakdowns by project, category, payer and vendor, plus budgets.', parameters: [q('from', 'Earliest date for the breakdowns.'), q('to', 'Latest date for the breakdowns.'), q('project', 'Limit the breakdowns to one project.')], responses: ok({ type: 'object' }) } },
      '/expenses/{id}': {
        get: { tags: ['Expenses'], summary: 'Get an expense', parameters: [p('id', 'Expense id.')], responses: ok(ref('Expense')) },
        patch: { tags: ['Expenses'], summary: 'Update an expense', description: 'Members can change expenses they added or paid; admins and owners can change any.', parameters: [p('id', 'Expense id.')], ...body('ExpenseInput'), responses: ok(ref('Expense')) },
        delete: { tags: ['Expenses'], summary: 'Delete an expense', parameters: [p('id', 'Expense id.')], responses: ok({ type: 'object' }) },
      },
      '/expenses/bulk': { post: { tags: ['Expenses'], summary: 'Change many expenses at once', description: '`update` takes `data` with any of status, categoryId, projectId, paidByUserId, paymentMethod, recurring, date. `delete` takes no data.', ...body('ExpenseBulk'), responses: ok(list('Expense')) } },

      '/activity': { get: { tags: ['Activity'], summary: 'Read the activity log', parameters: [q('limit', 'Up to 200 (default 50).', { type: 'integer' }), q('before', 'ISO timestamp; returns older entries. Use `nextBefore` from the previous page.'), q('entityType', 'project, task, expense, member, company or apikey.'), q('entityId', 'Only entries about this item.'), q('userId', 'Only entries by this member.')], responses: ok(list('Activity')) } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API key created under API in the app, e.g. `keel_AbC...`.' } },
      schemas: {
        Error: { type: 'object', properties: { error: str('What went wrong.'), fields: { type: 'object', description: 'Per-field problems on validation errors.', additionalProperties: { type: 'string' } } } },
        Member: { type: 'object', properties: { id: uuid('Member id.'), name: str('Display name.'), email: str('Email.'), role: str('owner, admin or member.') } },
        Category: { type: 'object', properties: { id: uuid('Category id.'), name: str('Name.'), color: str('Hex color.'), archived: { type: 'boolean' } } },
        Project: {
          type: 'object',
          properties: {
            id: uuid('Project id.'), name: str('Name.'), description: str('Description.', { nullable: true }), status: { type: 'string', enum: PROJECT_STATUS }, color: str('Hex color.'),
            budgetCents: { type: 'integer', nullable: true, description: 'Budget in cents.' }, spentCents: { type: 'integer', description: 'All-time spend in cents.' }, expenseCount: { type: 'integer' },
            taskTotal: { type: 'integer' }, taskDone: { type: 'integer' }, taskOpen: { type: 'integer' }, startDate: date('Start date.'), endDate: date('Target end date.'), leadUserId: uuid('Project lead.'),
            createdAt: str('ISO timestamp.'), updatedAt: str('ISO timestamp.'),
          },
        },
        ProjectInput: {
          type: 'object', required: ['name'],
          properties: {
            name: str('Project name. Required when creating.'), description: str('What the project is about.'), status: { type: 'string', enum: PROJECT_STATUS, description: 'Defaults to active.' },
            color: str('Hex color such as #2a78d6.'), budget: { type: 'number', description: 'Budget as a decimal amount, e.g. 12000 or "12,000.00".' }, startDate: date('Start date.'), endDate: date('Target end date.'), leadUserId: uuid('A member id.'),
          },
        },
        Task: {
          type: 'object',
          properties: {
            id: uuid('Task id.'), ref: str('Human reference, e.g. ACME-12.'), number: { type: 'integer' }, title: str('Title.'), description: str('Details.', { nullable: true }),
            status: { type: 'string', enum: TASK_STATUS }, priority: { type: 'string', enum: PRIORITY }, projectId: uuid('Project.'), assigneeUserId: uuid('Assignee.'), dueDate: date('Due date.'),
            labels: { type: 'array', items: { type: 'string' } }, checklist: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, done: { type: 'boolean' } } } },
            commentCount: { type: 'integer' }, comments: { type: 'array', items: ref('Comment'), description: 'Only when fetching a single task.' },
            createdBy: uuid('Creator.'), createdAt: str('ISO timestamp.'), updatedAt: str('ISO timestamp.'), completedAt: str('Set while the task is done.', { nullable: true }),
          },
        },
        TaskInput: {
          type: 'object', required: ['title'],
          properties: {
            title: str('What needs to be done. Required when creating.'), description: str('Details, links, acceptance criteria.'), status: { type: 'string', enum: TASK_STATUS, description: 'Defaults to todo.' },
            priority: { type: 'string', enum: PRIORITY, description: 'Defaults to medium.' }, projectId: uuid('Put the task on this project.'), assigneeUserId: uuid('A member id.'), dueDate: date('Due date.'),
            labels: { type: 'array', items: { type: 'string' }, description: 'Up to 10 labels of at most 30 characters.' },
            checklist: { type: 'array', description: 'Replaces the checklist.', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } } } },
          },
        },
        TaskBulk: { type: 'object', required: ['ids', 'action'], properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Up to 200 task ids.' }, action: { type: 'string', enum: ['update', 'move', 'delete', 'duplicate', 'add_label', 'remove_label'] }, data: { type: 'object', description: 'Depends on the action.' } } },
        Comment: { type: 'object', properties: { id: uuid('Comment id.'), taskId: uuid('Task.'), userId: uuid('Author.'), body: str('Text.'), createdAt: str('ISO timestamp.') } },
        Expense: {
          type: 'object',
          properties: {
            id: uuid('Expense id.'), amountCents: { type: 'integer', description: 'Amount in cents.' }, currency: str('ISO currency code.'), date: date('When it was spent.'), vendor: str('Who was paid.', { nullable: true }),
            description: str('What it was for.', { nullable: true }), notes: str('Notes.', { nullable: true }), categoryId: uuid('Category.'), projectId: uuid('Project.'), paidByUserId: uuid('Member who paid; null for the company account.'),
            paymentMethod: { type: 'string', enum: ['card', 'bank', 'cash', 'other'], nullable: true }, status: { type: 'string', enum: EXPENSE_STATUS }, recurring: { type: 'string', enum: ['monthly', 'yearly'], nullable: true },
            receipts: { type: 'array', items: { type: 'object' } }, createdAt: str('ISO timestamp.'), updatedAt: str('ISO timestamp.'),
          },
        },
        ExpenseInput: {
          type: 'object', required: ['amount', 'date'],
          properties: {
            amount: { type: 'number', description: 'Decimal amount such as 249.99. Required when creating.' }, date: date('When it was spent. Required when creating.'), vendor: str('Who was paid.'), description: str('What it was for.'), notes: str('Anything else.'),
            categoryId: uuid('From GET /categories.'), projectId: uuid('From GET /projects.'), paidByUserId: uuid('From GET /members; omit for the company account.'), paymentMethod: { type: 'string', enum: ['card', 'bank', 'cash', 'other'] },
            status: { type: 'string', enum: EXPENSE_STATUS, description: 'Defaults to paid.' }, recurring: { type: 'string', enum: ['monthly', 'yearly'] }, currency: str('Defaults to the company currency.'),
          },
        },
        ExpenseBulk: { type: 'object', required: ['ids', 'action'], properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Up to 500 expense ids.' }, action: { type: 'string', enum: ['update', 'delete'] }, data: { type: 'object', description: 'Fields to set when updating.' } } },
        Activity: { type: 'object', properties: { id: uuid('Entry id.'), userId: uuid('Who did it.'), userName: str('Their name.'), action: str('created, updated, moved, deleted, commented...'), entityType: str('What kind of item.'), entityId: uuid('Which item.'), summary: str('Human-readable sentence.'), createdAt: str('ISO timestamp.') } },
      },
    },
  };
}
