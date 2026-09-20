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
const TOPIC_CATEGORY = ['general', 'announcement', 'question', 'idea', 'decision'];
const TOPIC_STATE = ['open', 'resolved', 'archived'];

const taskId = p('id', 'Task id (UUID) or its reference such as `ACME-12`.');
const topicId = p('id', 'Topic id (UUID) or its reference such as `ACME-D4`.');
const postId = p('postId', 'Reply id.');

export function buildOpenApi(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Keel API',
      version: '1.0.0',
      description: 'Read and change everything in your Keel workspace: projects, tasks, discussions, expenses, receipts, categories and activity. Anything the app can do to company data, this API can do too. Two things are deliberately left out, both about identity rather than data: creating API keys stays in the app behind your password, so a key can never mint another key; and adding, removing or re-roling people stays there too, so a key can never hand someone access that outlives the key. Authenticate every request with an API key: `Authorization: Bearer keel_...`. A key acts as the person who created it, with their role, and is limited to one company. Read-only keys can only make GET requests. Errors are JSON: `{ "error": "message", "fields": { "name": "problem" } }`. Money is returned as integer cents (`amountCents`) and accepted as a decimal (`amount`: 12.5 or "1,234.50"). Rate limit: 300 requests per minute per key.',
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Account', description: 'Who the key is, the company, its members and expense categories.' },
      { name: 'Projects', description: 'Projects with budget, spend and task progress.' },
      { name: 'Tasks', description: 'Work items on the board. Use a task id or its reference (e.g. ACME-12).' },
      { name: 'Discussions', description: 'The discussion room: forum topics and threaded replies. Use a topic id or its reference (e.g. ACME-D4).' },
      { name: 'Expenses', description: 'Spending, with a company-wide summary, CSV export and receipts.' },
      { name: 'Activity', description: 'The audit trail. Changes made through the API are marked with the key name.' },
      { name: 'Workspace', description: 'Company settings and expense categories. These need the admin role.' },
    ],
    paths: {
      '/me': { get: { tags: ['Account'], summary: 'Check a key', description: 'Returns the key, the person it acts as, and the company. Handy for testing a connection.', responses: ok({ type: 'object' }) } },
      '/company': {
        get: { tags: ['Account'], summary: 'Company details and counts', responses: ok({ type: 'object' }) },
        patch: { tags: ['Workspace'], summary: 'Update company settings', description: 'Admins and owners only. Send any of `name`, `key` (2-6 uppercase characters, used in references like ACME-12) and `currency` (a 3-letter code).', requestBody: { required: true, ...json({ type: 'object', properties: { name: str('Company name.'), key: str('2-6 uppercase letters or digits.'), currency: str('ISO code such as USD.') } }) }, responses: ok({ type: 'object' }) },
      },
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
      '/projects/{id}/discussions': {
        get: { tags: ['Projects'], summary: 'List the discussions of a project', parameters: [p('id', 'Project id.'), q('state', 'Only this state.', { type: 'string', enum: TOPIC_STATE })], responses: ok(list('Topic')) },
        post: { tags: ['Projects'], summary: 'Start a discussion on a project', description: 'Same body as starting a topic; `projectId` is taken from the URL.', parameters: [p('id', 'Project id.')], ...body('TopicInput'), responses: created(ref('Topic')) },
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
      '/tasks/{id}/comments': { post: { tags: ['Tasks'], summary: 'Comment on a task', description: 'Existing comments come back with `GET /tasks/{id}`.', parameters: [taskId], requestBody: { required: true, ...json({ type: 'object', required: ['body'], properties: { body: str('The comment text.') } }) }, responses: created(ref('Comment')) } },
      '/tasks/{id}/comments/{commentId}': {
        patch: { tags: ['Tasks'], summary: 'Edit a comment', description: 'The author, admins and owners only.', parameters: [taskId, p('commentId', 'Comment id.')], requestBody: { required: true, ...json({ type: 'object', required: ['body'], properties: { body: str('The new text.') } }) }, responses: ok(ref('Comment')) },
        delete: { tags: ['Tasks'], summary: 'Delete a comment', parameters: [taskId, p('commentId', 'Comment id.')], responses: ok({ type: 'object' }) },
      },
      '/insights': {
        get: {
          tags: ['Tasks'], summary: 'Board analytics',
          description: 'Cumulative flow, burnup, velocity and cycle time, derived from every recorded status change. `flow` gives one row per day with a count for each column; `burnup` gives total scope against completed work, so scope added mid-flight is visible; `velocity` counts what finished each week; `cycleTime` measures first sighting to done. History from before status changes were recorded shows a task as open from its creation date to its completion date.',
          parameters: [q('project', 'Project id, or `none` for work without a project. Omit for the whole company.'), q('days', 'How far back to look, 7 to 730. Defaults to 30.', { type: 'integer' })],
          responses: ok(ref('Insights')),
        },
      },
      '/projects/{id}/insights': { get: { tags: ['Projects'], summary: 'Board analytics for one project', description: 'The same shape as `/insights`, narrowed to this project.', parameters: [p('id', 'Project id.'), q('days', 'How far back to look, 7 to 730.', { type: 'integer' })], responses: ok(ref('Insights')) } },
      '/tasks/bulk': { post: { tags: ['Tasks'], summary: 'Change many tasks at once', description: '`update` takes `data` with any of status, priority, assigneeUserId, projectId, dueDate. `move` takes `{ status, index }`. `add_label` and `remove_label` take `{ label }`. `duplicate` and `delete` take no data.', ...body('TaskBulk'), responses: ok(list('Task')) } },

      '/discussions': {
        get: {
          tags: ['Discussions'], summary: 'List topics',
          description: 'Pinned topics come first, then the most recent activity. Archived topics are left out unless you ask for them.',
          parameters: [
            q('category', 'Only this category.', { type: 'string', enum: TOPIC_CATEGORY }), q('state', 'Only this state.', { type: 'string', enum: TOPIC_STATE }),
            q('project', 'Project id, or `none` for topics without a project.'), q('author', 'Member id of whoever started the topic.'),
            q('pinned', 'Set to 1 for pinned topics only, 0 for unpinned.'), q('includeArchived', 'Set to 1 to include archived topics.'),
            q('q', 'Search in the title, the opening post, or an exact reference.'),
            q('updatedSince', 'ISO timestamp. Only topics changed or replied to after it; useful for polling.', { type: 'string', format: 'date-time' }),
            q('limit', 'Page size, up to 500.', { type: 'integer' }), q('offset', 'Items to skip.', { type: 'integer' }),
          ],
          responses: ok(list('Topic')),
        },
        post: { tags: ['Discussions'], summary: 'Start a topic', ...body('TopicInput'), responses: created(ref('Topic')) },
      },
      '/discussions/{id}': {
        get: { tags: ['Discussions'], summary: 'Get a topic with its replies', parameters: [topicId], responses: ok(ref('Topic')) },
        patch: { tags: ['Discussions'], summary: 'Update a topic', description: 'The person who started it, or an admin, can change the title, body, category, state and project. `pinned` and `locked` need the admin role.', parameters: [topicId], ...body('TopicInput'), responses: ok(ref('Topic')) },
        delete: { tags: ['Discussions'], summary: 'Delete a topic', description: 'Replies go with it. Allowed for the person who started it, admins and owners.', parameters: [topicId], responses: ok({ type: 'object' }) },
      },
      '/discussions/{id}/posts': {
        get: { tags: ['Discussions'], summary: 'List the replies of a topic', parameters: [topicId, q('updatedSince', 'ISO timestamp. Only replies added or edited after it.', { type: 'string', format: 'date-time' })], responses: ok(list('Post')) },
        post: { tags: ['Discussions'], summary: 'Reply to a topic', description: 'Pass `parentId` to answer another reply. Threads stay one level deep, so replying to a reply attaches to the same parent. Locked and archived topics reject replies from anyone below admin.', parameters: [topicId], ...body('PostInput'), responses: created(ref('Post')) },
      },
      '/discussions/{id}/posts/{postId}': {
        patch: {
          tags: ['Discussions'], summary: 'Edit a reply, or mark it as the answer',
          description: '`body` edits the text and is limited to its author and admins. `answer: true` marks this reply as the answer and moves the topic to resolved; `answer: false` clears it and reopens the topic. Marking is limited to the person who started the topic and admins.',
          parameters: [topicId, postId], ...body('PostPatch'), responses: ok(ref('Post')),
        },
        delete: { tags: ['Discussions'], summary: 'Delete a reply', description: 'The author, admins and owners only.', parameters: [topicId, postId], responses: ok({ type: 'object' }) },
      },
      '/discussions/bulk': { post: { tags: ['Discussions'], summary: 'Change many topics at once', description: '`update` takes `data` with any of category, state, projectId. `pin`, `unpin`, `lock` and `unlock` need the admin role and take no data. `delete` takes no data.', ...body('TopicBulk'), responses: ok(list('Topic')) } },

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
      '/expenses/export.csv': { get: { tags: ['Expenses'], summary: 'Export expenses as CSV', description: 'Takes the same filters as `GET /expenses`. Returns `text/csv`, not JSON.', parameters: [q('project', 'Project id, or `none`.'), q('category', 'Category id, or `none`.'), q('status', 'Only this status.', { type: 'string', enum: EXPENSE_STATUS }), q('from', 'Earliest date, YYYY-MM-DD.'), q('to', 'Latest date, YYYY-MM-DD.')], responses: { 200: { description: 'A CSV file.', content: { 'text/csv': { schema: { type: 'string' } } } } } } },
      '/expenses/{id}/receipts': { post: { tags: ['Expenses'], summary: 'Attach a receipt', description: 'Send the file itself as the raw body, with its media type in `Content-Type` and its name URL-encoded in `X-Filename`. Images and PDFs only, up to 10 per expense. Receipts are encrypted on disk.', parameters: [p('id', 'Expense id.')], requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, responses: created(ref('Receipt')) } },
      '/receipts/{id}': {
        get: { tags: ['Expenses'], summary: 'Download a receipt', description: 'Returns the decrypted file. Add `?download=1` for an attachment disposition.', parameters: [p('id', 'Receipt id.'), q('download', 'Set to 1 to download rather than display.')], responses: { 200: { description: 'The file.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } },
        delete: { tags: ['Expenses'], summary: 'Delete a receipt', parameters: [p('id', 'Receipt id.')], responses: ok({ type: 'object' }) },
      },

      '/activity': { get: { tags: ['Activity'], summary: 'Read the activity log', parameters: [q('limit', 'Up to 200 (default 50).', { type: 'integer' }), q('before', 'ISO timestamp; returns older entries. Use `nextBefore` from the previous page.'), q('entityType', 'project, task, discussion, expense, member, company or apikey.'), q('entityId', 'Only entries about this item.'), q('userId', 'Only entries by this member.')], responses: ok(list('Activity')) } },

      '/company/categories': {
        get: { tags: ['Workspace'], summary: 'List expense categories', description: 'The same list as `GET /categories`.', responses: ok(list('Category')) },
        post: { tags: ['Workspace'], summary: 'Create a category', description: 'Admins and owners only.', requestBody: { required: true, ...json({ type: 'object', required: ['name'], properties: { name: str('Category name.'), color: str('Hex color such as #2a78d6.') } }) }, responses: created(ref('Category')) },
      },
      '/company/categories/{id}': {
        patch: { tags: ['Workspace'], summary: 'Update a category', description: 'Admins and owners only.', parameters: [p('id', 'Category id.')], requestBody: { required: true, ...json({ type: 'object', properties: { name: str('Name.'), color: str('Hex color.'), archived: { type: 'boolean' }, sortOrder: { type: 'integer' } } }) }, responses: ok(ref('Category')) },
        delete: { tags: ['Workspace'], summary: 'Delete a category', description: 'Admins and owners only. Expenses keep their history and become uncategorised.', parameters: [p('id', 'Category id.')], responses: ok({ type: 'object', properties: { ok: { type: 'boolean' }, detachedExpenses: { type: 'integer' } } }) },
      },
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
        Insights: {
          type: 'object',
          properties: {
            from: date('First day in the window.'), to: date('Last day, always today.'), days: { type: 'integer' },
            statuses: { type: 'array', items: { type: 'string', enum: TASK_STATUS }, description: 'The board columns, in order, matching the keys in each flow row.' },
            flow: { type: 'array', description: 'One row per day: { date, backlog, todo, in_progress, review, done }.', items: { type: 'object' } },
            burnup: { type: 'array', description: 'One row per day: { date, total, done }.', items: { type: 'object', properties: { date: date('Day.'), total: { type: 'integer' }, done: { type: 'integer' } } } },
            velocity: { type: 'array', description: 'One row per week: { week, completed }, the week being its Monday.', items: { type: 'object', properties: { week: date('Monday of the week.'), completed: { type: 'integer' } } } },
            cycleTime: { type: 'object', properties: { averageDays: { type: 'number', nullable: true }, medianDays: { type: 'number', nullable: true }, completed: { type: 'integer', description: 'How many finished tasks the figures are based on.' } } },
            totals: { type: 'object', properties: { tracked: { type: 'integer' }, open: { type: 'integer' }, done: { type: 'integer' }, completedInWindow: { type: 'integer' }, weeklyAverage: { type: 'number' } } },
          },
        },
        TaskBulk: { type: 'object', required: ['ids', 'action'], properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Up to 200 task ids.' }, action: { type: 'string', enum: ['update', 'move', 'delete', 'duplicate', 'add_label', 'remove_label'] }, data: { type: 'object', description: 'Depends on the action.' } } },
        Comment: { type: 'object', properties: { id: uuid('Comment id.'), taskId: uuid('Task.'), userId: uuid('Author.'), body: str('Text.'), createdAt: str('ISO timestamp.') } },
        Topic: {
          type: 'object',
          properties: {
            id: uuid('Topic id.'), ref: str('Human reference, e.g. ACME-D4.'), number: { type: 'integer' }, title: str('Title.'), body: str('The opening post.', { nullable: true }),
            category: { type: 'string', enum: TOPIC_CATEGORY }, state: { type: 'string', enum: TOPIC_STATE }, pinned: { type: 'boolean', description: 'Pinned topics sort first.' },
            locked: { type: 'boolean', description: 'Nobody below admin can reply.' }, answerPostId: uuid('The reply marked as the answer.'), projectId: uuid('Project this belongs to.'),
            replyCount: { type: 'integer' }, lastPostBy: uuid('Who replied most recently.'), lastPostAt: str('ISO timestamp of the newest reply, or when the topic was started.'),
            posts: { type: 'array', items: ref('Post'), description: 'Only when fetching a single topic.' },
            createdBy: uuid('Who started it.'), createdAt: str('ISO timestamp.'), updatedAt: str('Any change, including pinning or resolving.'),
            editedAt: str('Set only when the title or body was reworded.', { nullable: true }),
          },
        },
        TopicInput: {
          type: 'object', required: ['title'],
          properties: {
            title: str('What the discussion is about. Required when starting one.'), body: str('The opening post, up to 20000 characters.'),
            category: { type: 'string', enum: TOPIC_CATEGORY, description: 'Defaults to general.' }, state: { type: 'string', enum: TOPIC_STATE, description: 'Defaults to open.' },
            projectId: uuid('Tie the discussion to a project.'), pinned: { type: 'boolean', description: 'Admins and owners only.' }, locked: { type: 'boolean', description: 'Admins and owners only.' },
          },
        },
        Post: { type: 'object', properties: { id: uuid('Reply id.'), topicId: uuid('Topic.'), parentId: uuid('The reply this answers, if any.'), userId: uuid('Author.'), body: str('Text.'), isAnswer: { type: 'boolean', description: 'True when this reply is marked as the answer.' }, createdAt: str('ISO timestamp.'), updatedAt: str('Set once it has been edited.', { nullable: true }) } },
        PostInput: { type: 'object', required: ['body'], properties: { body: str('The reply text, up to 20000 characters.'), parentId: uuid('Reply to this reply instead of the topic.') } },
        PostPatch: { type: 'object', properties: { body: str('New text for the reply.'), answer: { type: 'boolean', description: 'Mark or unmark this reply as the answer.' } } },
        TopicBulk: { type: 'object', required: ['ids', 'action'], properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Up to 200 topic ids.' }, action: { type: 'string', enum: ['update', 'pin', 'unpin', 'lock', 'unlock', 'delete'] }, data: { type: 'object', description: 'Depends on the action.' } } },
        Receipt: { type: 'object', properties: { id: uuid('Receipt id.'), expenseId: uuid('Expense.'), filename: str('Original file name.'), mime: str('Media type.'), size: { type: 'integer', description: 'Bytes.' }, createdAt: str('ISO timestamp.') } },
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
