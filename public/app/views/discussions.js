// Discussion room: a list of forum topics, and a topic page with threaded replies.
import { h, mount, date, dateTime, relative, debounce, STATUS, TOPIC_CATEGORIES, TOPIC_STATES } from '../dom.js';
import { api } from '../api.js';
import { state, member, isAdmin } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, iconButton, emptyState, badge, statusBadge, colorDot, menu } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, input, textarea, select, handleSubmit, formActions, row } from '../components/forms.js';
import { toast } from '../components/toast.js';
import { createSelection, contextMenu, selectionBar, removeSelectionBar, selectBox } from '../components/selection.js';
import { setQuery, navigate } from '../router.js';

const CATEGORY_OPTIONS = TOPIC_CATEGORIES.map((c) => ({ value: c, label: STATUS.topic[c].label }));
const STATE_OPTIONS = TOPIC_STATES.map((s) => ({ value: s, label: STATUS.topicState[s].label }));

let keepSelection = []; // ids re-selected after a refresh, Explorer style

// ---------- list ----------
export async function render(view, ctx) {
  if (ctx.params.id) return renderTopic(view, ctx);
  const q = ctx.query;
  if (ctx.fresh) { keepSelection = []; removeSelectionBar(); }
  if (!view.querySelector('.topic-list')) mount(view, spinner());

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ category: q.category, state: q.state, project: q.project, author: q.author, q: q.q })) {
    if (value) params.set(key, value);
  }
  if (q.state === 'archived' || q.archived) params.set('includeArchived', '1');
  const res = await api.get(`/api/discussions${params.toString() ? `?${params}` : ''}`);
  const items = res.items;
  const topicsById = new Map(items.map((t) => [t.id, t]));

  const filters = h('div', { class: 'filters' },
    h('div', { class: 'search' }, icon('search', { size: 15 }), input({ placeholder: 'Search topics', value: q.q || '', oninput: debounce((e) => setQuery({ q: e.target.value }), 250) })),
    select(CATEGORY_OPTIONS, { value: q.category || '', placeholder: 'All categories', onchange: (e) => setQuery({ category: e.target.value }) }),
    select(STATE_OPTIONS, { value: q.state || '', placeholder: 'Open & resolved', onchange: (e) => setQuery({ state: e.target.value }) }),
    select([{ value: 'none', label: 'No project' }, ...state.projects.filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.name }))], { value: q.project || '', placeholder: 'All projects', onchange: (e) => setQuery({ project: e.target.value }) }),
    select(state.members.map((m) => ({ value: m.id, label: m.name })), { value: q.author || '', placeholder: 'Anyone', onchange: (e) => setQuery({ author: e.target.value }) }),
    (q.category || q.state || q.project || q.author || q.q) ? button('Clear', { size: 'sm', variant: 'ghost', icon: 'x', onclick: () => setQuery({ category: null, state: null, project: null, author: null, q: null }) }) : null);

  const open = items.filter((t) => t.state === 'open').length;
  const header = pageHeader({
    title: 'Discussion room',
    subtitle: `${items.length} topic${items.length === 1 ? '' : 's'} · ${open} open · ${items.reduce((n, t) => n + (t.replyCount || 0), 0)} replies · Ctrl+click or right-click to work on several at once`,
    actions: [button('New topic', { variant: 'primary', icon: 'plus', onclick: () => openTopicModal({ defaults: { projectId: q.project && q.project !== 'none' ? q.project : null }, onSaved: (t) => navigate(`/discussions/${t.id}`) }) })],
  });

  if (!items.length) {
    mount(view, header, filters, emptyState({
      icon: 'message',
      title: q.q || q.category || q.state ? 'No topics match' : 'No discussions yet',
      text: q.q || q.category || q.state ? 'Try a different filter.' : 'Start a topic to ask a question, float an idea, write down a decision, or announce something to the team.',
      action: button('Start the first topic', { variant: 'primary', icon: 'plus', onclick: () => openTopicModal({ onSaved: (t) => navigate(`/discussions/${t.id}`) }) }),
    }));
    return;
  }

  const list = h('div', { class: 'topic-list card' }, items.map((t) => topicRow(t, ctx)));
  wireSelection(list, '.topic-row', { ctx, topicsById });
  mount(view, header, filters, list);
}

function topicRow(t, ctx) {
  const author = member(t.createdBy);
  const proj = state.projects.find((p) => p.id === t.projectId);
  const lastBy = member(t.lastPostBy);
  return h('div', { class: `topic-row ${t.pinned ? 'pinned' : ''}`, dataset: { id: t.id }, onclick: () => navigate(`/discussions/${t.id}`) },
    h('div', { class: 'sel-cell' }, selectBox({ title: 'Select topic' })),
    avatar(author || { name: '?' }, { size: 'sm', title: author ? `Started by ${author.name}` : 'A former member' }),
    h('div', { class: 'topic-main' },
      h('div', { class: 'topic-title' },
        t.pinned ? icon('pin', { size: 13, cls: 'topic-flag' }) : null,
        t.locked ? icon('lock', { size: 13, cls: 'topic-flag' }) : null,
        h('span', { class: 'truncate' }, t.title),
        badge(STATUS.topic[t.category].label, STATUS.topic[t.category].cls),
        t.state !== 'open' ? statusBadge('topicState', t.state) : null),
      h('div', { class: 'topic-meta' },
        h('span', { class: 'mono' }, t.ref),
        h('span', {}, `${author?.name || 'A former member'} · ${relative(t.createdAt)}`),
        proj ? h('span', { class: 'flex', style: { gap: '5px' } }, colorDot(proj.color, 7), proj.name) : null,
        t.replyCount ? h('span', { title: dateTime(t.lastPostAt) }, `last reply ${relative(t.lastPostAt)}${lastBy ? ` by ${lastBy.name.split(' ')[0]}` : ''}`) : null)),
    h('div', { class: 'topic-replies', title: `${t.replyCount} repl${t.replyCount === 1 ? 'y' : 'ies'}` }, icon('message', { size: 14 }), String(t.replyCount || 0)));
}

// ---------- multi-select ----------
function wireSelection(root, itemSelector, shared) {
  const { ctx, topicsById } = shared;
  return createSelection({
    root,
    itemSelector,
    initial: keepSelection,
    onChange: (s) => {
      keepSelection = s.list();
      const ids = s.list();
      selectionBar({
        count: ids.length,
        label: ids.length === 1 ? 'topic selected' : 'topics selected',
        onClear: () => s.clear(),
        actions: ids.length ? [
          { label: 'Category', icon: 'tag', children: categoryItems(ids, ctx, topicsById) },
          { label: 'State', icon: 'check', children: stateItems(ids, ctx, topicsById) },
          isAdmin() ? { label: 'Moderate', icon: 'shield', children: moderationItems(ids, ctx, topicsById) } : null,
          { label: 'Copy as text', icon: 'copy', onclick: () => copyAsText(ids, topicsById) },
          { label: 'Delete', icon: 'trash', danger: true, onclick: () => deleteTopics(ids, ctx, topicsById) },
        ] : [],
      });
    },
    onOpen: (id) => navigate(`/discussions/${id}`),
    onContext: (e, ids) => contextMenu(e.clientX, e.clientY, topicMenuItems(ids, ctx, topicsById)),
    onDelete: (ids) => deleteTopics(ids, ctx, topicsById),
  });
}

function bulk(ids, ctx, action, data, message) {
  return async () => {
    try {
      const r = await api.post('/api/discussions/bulk', { ids, action, data });
      toast(message || (r.deleted ? `Deleted ${r.deleted}` : `Updated ${ids.length} topic${ids.length === 1 ? '' : 's'}`), { duration: 2000 });
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
    ctx.refresh();
  };
}

function sameValue(ids, topicsById, key) {
  const values = new Set(ids.map((id) => topicsById.get(id)?.[key] ?? null));
  return values.size === 1 ? [...values][0] : undefined;
}

function categoryItems(ids, ctx, topicsById) {
  const current = sameValue(ids, topicsById, 'category');
  return TOPIC_CATEGORIES.map((c) => ({ label: STATUS.topic[c].label, checked: current === c, onclick: bulk(ids, ctx, 'update', { category: c }, `Moved to ${STATUS.topic[c].label}`) }));
}

function stateItems(ids, ctx, topicsById) {
  const current = sameValue(ids, topicsById, 'state');
  return TOPIC_STATES.map((s) => ({ label: STATUS.topicState[s].label, checked: current === s, onclick: bulk(ids, ctx, 'update', { state: s }, `Marked as ${STATUS.topicState[s].label.toLowerCase()}`) }));
}

function moderationItems(ids, ctx, topicsById) {
  const pinned = sameValue(ids, topicsById, 'pinned');
  const locked = sameValue(ids, topicsById, 'locked');
  return [
    pinned !== true ? { label: 'Pin to the top', icon: 'pin', onclick: bulk(ids, ctx, 'pin', undefined, 'Pinned') } : null,
    pinned !== false ? { label: 'Unpin', icon: 'pin', onclick: bulk(ids, ctx, 'unpin', undefined, 'Unpinned') } : null,
    { divider: true },
    locked !== true ? { label: 'Lock (no new replies)', icon: 'lock', onclick: bulk(ids, ctx, 'lock', undefined, 'Locked') } : null,
    locked !== false ? { label: 'Unlock', icon: 'unlock', onclick: bulk(ids, ctx, 'unlock', undefined, 'Unlocked') } : null,
  ];
}

function projectItems(ids, ctx, topicsById) {
  const current = sameValue(ids, topicsById, 'projectId');
  return [
    { label: 'No project', checked: current === null, onclick: bulk(ids, ctx, 'update', { projectId: null }, 'Removed from their project') },
    { divider: true },
    ...state.projects.filter((p) => p.status !== 'archived').map((p) => ({ label: p.name, swatch: current === p.id ? null : p.color, checked: current === p.id, onclick: bulk(ids, ctx, 'update', { projectId: p.id }, `Moved to ${p.name}`) })),
  ];
}

function topicMenuItems(ids, ctx, topicsById) {
  const one = ids.length === 1 ? topicsById.get(ids[0]) : null;
  const n = ids.length;
  return [
    { header: one ? one.ref : `${n} topics selected` },
    one ? { label: 'Open', icon: 'external', shortcut: 'Enter', onclick: () => navigate(`/discussions/${one.id}`) } : null,
    one ? { label: 'Copy link', icon: 'copy', onclick: () => copyLink(one) } : null,
    { divider: true },
    { label: 'Category', icon: 'tag', children: categoryItems(ids, ctx, topicsById) },
    { label: 'State', icon: 'check', children: stateItems(ids, ctx, topicsById) },
    { label: 'Project', icon: 'folder', children: projectItems(ids, ctx, topicsById) },
    isAdmin() ? { label: 'Moderate', icon: 'shield', children: moderationItems(ids, ctx, topicsById) } : null,
    { divider: true },
    { label: 'Copy as text', icon: 'copy', onclick: () => copyAsText(ids, topicsById) },
    { label: n === 1 ? 'Delete' : `Delete ${n} topics`, icon: 'trash', shortcut: 'Del', danger: true, onclick: () => deleteTopics(ids, ctx, topicsById) },
  ];
}

async function deleteTopics(ids, ctx, topicsById) {
  const n = ids.length;
  const first = topicsById.get(ids[0]);
  const ok = await confirmDialog({
    title: n === 1 ? `Delete ${first?.ref || 'this topic'}?` : `Delete ${n} topics?`,
    message: n === 1 ? `"${first?.title || ''}" and its replies will be gone. This cannot be undone.` : 'Their replies go with them. This cannot be undone.',
    confirmText: n === 1 ? 'Delete' : `Delete ${n}`,
    danger: true,
  });
  if (!ok) return;
  keepSelection = [];
  await bulk(ids, ctx, 'delete', undefined, `Deleted ${n} topic${n === 1 ? '' : 's'}`)();
}

async function copyLink(topic) {
  try { await navigator.clipboard.writeText(`${location.origin}/discussions/${topic.id}`); toast('Link copied'); }
  catch { toast('Could not copy', { type: 'error' }); }
}

async function copyAsText(ids, topicsById) {
  const text = ids.map((id) => {
    const t = topicsById.get(id);
    return t ? `${t.ref}  ${t.title}  [${STATUS.topic[t.category].label}/${t.state}]  ${t.replyCount || 0} replies` : '';
  }).filter(Boolean).join('\n');
  try { await navigator.clipboard.writeText(text); toast(`Copied ${ids.length} topic${ids.length === 1 ? '' : 's'}`); }
  catch { toast('Could not copy', { type: 'error' }); }
}

// ---------- create / edit a topic ----------
export function openTopicModal({ topic = null, defaults = {}, onSaved } = {}) {
  const editing = Boolean(topic);
  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Title', name: 'title', required: true, input: input({ class: 'input input-lg', placeholder: 'What do you want to talk about?', required: true, autofocus: true, value: topic?.title || '' }) }),
    field({ label: 'Opening post', name: 'body', input: textarea({ rows: 7, placeholder: 'Give people the context they need to reply. Plain text.', value: topic?.body || '' }) }),
    row(
      field({ label: 'Category', name: 'category', input: select(CATEGORY_OPTIONS, { value: topic?.category || defaults.category || 'general' }) }),
      field({ label: 'Project', name: 'projectId', input: select(state.projects.filter((p) => p.status !== 'archived' || p.id === topic?.projectId).map((p) => ({ value: p.id, label: p.name })), { value: topic?.projectId || defaults.projectId || '', placeholder: 'No project' }) })),
    editing ? field({ label: 'State', name: 'state', input: select(STATE_OPTIONS, { value: topic.state }) }) : null,
    formActions(h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, editing ? 'Save changes' : 'Start topic')));

  handleSubmit(form, async (data) => {
    const saved = editing
      ? await api.patch(`/api/discussions/${topic.id}`, data)
      : await api.post('/api/discussions', data);
    toast(editing ? 'Topic updated' : `Started ${saved.ref}`);
    modal.close();
    onSaved?.(saved);
  });

  const modal = openModal({ title: editing ? `Edit ${topic.ref}` : 'New topic', content: form, size: 'lg' });
  return modal;
}

// ---------- a single topic ----------
async function renderTopic(view, ctx) {
  mount(view, spinner());
  const topic = await api.get(`/api/discussions/${ctx.params.id}`);
  const author = member(topic.createdBy);
  const proj = state.projects.find((p) => p.id === topic.projectId);
  const canManage = isAdmin() || topic.createdBy === state.user.id;
  const canReply = !topic.locked && topic.state !== 'archived' ? true : isAdmin();
  const refresh = () => renderTopic(view, ctx);

  async function patchTopic(body, message) {
    try { await api.patch(`/api/discussions/${topic.id}`, body); if (message) toast(message); refresh(); }
    catch (err) { toast(err.message, { type: 'error' }); }
  }

  const actions = menu(button('Actions', { icon: 'more' }), [
    canManage ? { label: 'Edit topic', icon: 'edit', onclick: () => openTopicModal({ topic, onSaved: refresh }) } : null,
    canManage ? { label: topic.state === 'resolved' ? 'Reopen' : 'Mark resolved', icon: 'check', onclick: () => patchTopic({ state: topic.state === 'resolved' ? 'open' : 'resolved' }, topic.state === 'resolved' ? 'Reopened' : 'Marked resolved') } : null,
    canManage ? { label: topic.state === 'archived' ? 'Unarchive' : 'Archive', icon: 'inbox', onclick: () => patchTopic({ state: topic.state === 'archived' ? 'open' : 'archived' }, topic.state === 'archived' ? 'Unarchived' : 'Archived') } : null,
    isAdmin() ? { divider: true } : null,
    isAdmin() ? { label: topic.pinned ? 'Unpin' : 'Pin to the top', icon: 'pin', onclick: () => patchTopic({ pinned: !topic.pinned }, topic.pinned ? 'Unpinned' : 'Pinned') } : null,
    isAdmin() ? { label: topic.locked ? 'Unlock' : 'Lock (no new replies)', icon: topic.locked ? 'unlock' : 'lock', onclick: () => patchTopic({ locked: !topic.locked }, topic.locked ? 'Unlocked' : 'Locked') } : null,
    { divider: true },
    { label: 'Copy link', icon: 'copy', onclick: () => copyLink(topic) },
    canManage ? { label: 'Delete topic', icon: 'trash', danger: true, onclick: async () => {
      const ok = await confirmDialog({ title: `Delete ${topic.ref}?`, message: 'Every reply goes with it. This cannot be undone.', confirmText: 'Delete', danger: true });
      if (!ok) return;
      await api.del(`/api/discussions/${topic.id}`);
      toast('Topic deleted');
      navigate('/discussions');
    } } : null,
  ], { align: 'right' });

  const header = pageHeader({
    crumbs: [{ label: 'Discussion room', href: '/discussions' }, { label: topic.ref }],
    title: topic.title,
    subtitle: `Started by ${author?.name || 'a former member'} ${relative(topic.createdAt)} · ${topic.replyCount} repl${topic.replyCount === 1 ? 'y' : 'ies'}`,
    actions: [actions],
  });

  const flags = h('div', { class: 'topic-flags' },
    badge(STATUS.topic[topic.category].label, STATUS.topic[topic.category].cls),
    statusBadge('topicState', topic.state),
    topic.pinned ? badge('Pinned', 'badge-accent') : null,
    topic.locked ? badge('Locked', 'badge-warning') : null,
    proj ? h('a', { href: `/projects/${proj.id}`, class: 'chip' }, colorDot(proj.color, 8), proj.name) : null);

  const opening = h('div', { class: 'card card-pad post post-opening' },
    h('div', { class: 'post-head' },
      avatar(author || { name: '?' }, { size: 'md' }),
      h('div', { class: 'grow' },
        h('div', {}, h('b', {}, author?.name || 'A former member'), topic.createdBy === state.user.id ? badge('You', 'st-planning') : null),
        h('div', { class: 'small muted', title: dateTime(topic.createdAt) }, `${date(topic.createdAt)}${topic.editedAt ? ' · edited' : ''}`)),
      canManage ? iconButton('edit', { title: 'Edit topic', size: 15, onclick: () => openTopicModal({ topic, onSaved: refresh }) }) : null),
    topic.body ? h('div', { class: 'post-text' }, topic.body) : h('div', { class: 'post-text muted' }, 'No description was given.'));

  const repliesBox = h('div', { class: 'replies' });
  renderReplies(repliesBox, topic, refresh);

  const composer = canReply ? replyComposer(topic, null, refresh) : h('div', { class: 'callout' }, icon('lock'),
    h('span', {}, topic.state === 'archived' ? 'This topic is archived, so it is read-only.' : 'This topic is locked. An admin can still reply, or unlock it.'));

  mount(view,
    header,
    flags,
    opening,
    h('div', { class: 'section-title', style: { margin: '20px 0 10px' } }, `${topic.replyCount} repl${topic.replyCount === 1 ? 'y' : 'ies'}`),
    repliesBox,
    composer);
}

function renderReplies(box, topic, refresh) {
  const top = topic.posts.filter((p) => !p.parentId);
  const childrenOf = (id) => topic.posts.filter((p) => p.parentId === id);
  if (!top.length) {
    mount(box, emptyState({ icon: 'message', title: 'No replies yet', text: 'Be the first to weigh in.' }));
    return;
  }
  mount(box, top.map((p) => h('div', { class: 'thread' },
    postCard(p, topic, refresh),
    childrenOf(p.id).length ? h('div', { class: 'thread-children' }, childrenOf(p.id).map((c) => postCard(c, topic, refresh))) : null)));
}

function postCard(post, topic, refresh) {
  const who = member(post.userId);
  const mine = post.userId === state.user.id;
  const canEdit = mine || isAdmin();
  const canMarkAnswer = isAdmin() || topic.createdBy === state.user.id;
  const canReply = topic.locked || topic.state === 'archived' ? isAdmin() : true;
  const card = h('div', { class: `card card-pad post ${post.isAnswer ? 'post-answer' : ''}`, dataset: { id: post.id } });
  const textBox = h('div', { class: 'post-text' }, post.body);

  const startEdit = () => {
    const ta = textarea({ value: post.body, rows: 4 });
    const save = async () => {
      const body = ta.value.trim();
      if (!body || body === post.body) { mount(textBox, post.body); return; }
      try { await api.patch(`/api/discussions/${topic.id}/posts/${post.id}`, { body }); toast('Reply updated'); refresh(); }
      catch (err) { toast(err.message, { type: 'error' }); }
    };
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); if (e.key === 'Escape') mount(textBox, post.body); });
    mount(textBox, ta, h('div', { class: 'flex', style: { gap: '6px', marginTop: '6px' } },
      button('Save', { size: 'sm', variant: 'primary', onclick: save }),
      button('Cancel', { size: 'sm', onclick: () => mount(textBox, post.body) })));
    ta.focus();
  };

  const replyBox = h('div');
  const openReply = () => {
    if (replyBox.firstChild) { mount(replyBox); return; }
    mount(replyBox, replyComposer(topic, post.parentId || post.id, refresh, { compact: true, to: who?.name }));
    replyBox.querySelector('textarea')?.focus();
  };

  card.append(
    h('div', { class: 'post-head' },
      avatar(who || { name: '?' }, { size: 'sm' }),
      h('div', { class: 'grow' },
        h('div', { class: 'flex', style: { gap: '8px', flexWrap: 'wrap' } },
          h('b', {}, who?.name || 'A former member'),
          mine ? badge('You', 'st-planning') : null,
          post.isAnswer ? badge('Answer', 'st-done') : null),
        h('div', { class: 'small muted', title: dateTime(post.createdAt) }, `${relative(post.createdAt)}${post.updatedAt ? ' · edited' : ''}`)),
      canMarkAnswer ? iconButton('check', { title: post.isAnswer ? 'Unmark as the answer' : 'Mark as the answer', size: 15, cls: post.isAnswer ? 'is-answer' : '', onclick: async () => {
        try { await api.patch(`/api/discussions/${topic.id}/posts/${post.id}`, { answer: !post.isAnswer }); toast(post.isAnswer ? 'Answer cleared' : 'Marked as the answer'); refresh(); }
        catch (err) { toast(err.message, { type: 'error' }); }
      } }) : null,
      canEdit ? iconButton('edit', { title: 'Edit', size: 15, onclick: startEdit }) : null,
      canEdit ? iconButton('trash', { title: 'Delete', size: 15, onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete this reply?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        try { await api.del(`/api/discussions/${topic.id}/posts/${post.id}`); toast('Reply deleted'); refresh(); }
        catch (err) { toast(err.message, { type: 'error' }); }
      } }) : null),
    textBox,
    canReply ? h('div', { class: 'post-actions' }, button('Reply', { size: 'sm', variant: 'ghost', icon: 'reply', onclick: openReply })) : null,
    replyBox);
  return card;
}

function replyComposer(topic, parentId, refresh, { compact = false, to = null } = {}) {
  const ta = textarea({ placeholder: to ? `Reply to ${to}…` : 'Write a reply…', rows: compact ? 3 : 4 });
  const post = async () => {
    const body = ta.value.trim();
    if (!body) return;
    btn.disabled = true;
    try { await api.post(`/api/discussions/${topic.id}/posts`, { body, parentId: parentId || null }); refresh(); }
    catch (err) { toast(err.message, { type: 'error' }); btn.disabled = false; }
  };
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') post(); });
  const btn = button(parentId ? 'Reply' : 'Post reply', { size: 'sm', variant: 'primary', onclick: post });
  return h('div', { class: `card card-pad comment-add ${compact ? 'reply-inline' : 'reply-main'}` },
    avatar(state.user, { size: 'sm' }),
    h('div', { class: 'grow stack', style: { gap: '8px' } },
      ta,
      h('div', { class: 'flex', style: { justifyContent: 'flex-end' } },
        h('span', { class: 'small muted grow' }, 'Ctrl+Enter to post'),
        btn)));
}
