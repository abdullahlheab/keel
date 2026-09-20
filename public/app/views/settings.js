// Settings: profile, security (password, 2FA, sessions), company, members & invites, categories.
import { h, mount, date, dateTime, relative } from '../dom.js';
import { api } from '../api.js';
import { state, isAdmin, isOwner, currency } from '../state.js';
import { pageHeader, spinner, icon, avatar, button, badge, emptyState, copyButton, iconButton, colorDot } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, input, select, handleSubmit, formActions, row, colorInput } from '../components/forms.js';
import { toast } from '../components/toast.js';
import { navigate } from '../router.js';

const TABS = [
  { id: 'profile', label: 'Profile', icon: 'users' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'company', label: 'Company', icon: 'settings' },
  { id: 'members', label: 'Members & invites', icon: 'users' },
  { id: 'categories', label: 'Expense categories', icon: 'tag' },
];
const ROLE_OPTIONS = [['owner', 'Owner'], ['admin', 'Admin'], ['member', 'Member']].map(([value, label]) => ({ value, label }));
const ROLE_HELP = 'Owners can do everything, including managing other owners. Admins manage members, settings and any record. Members can add and edit their own expenses and work with tasks.';
const AVATAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

export async function render(view, ctx) {
  const tab = ctx.params.tab || 'profile';
  const nav = h('nav', { class: 'settings-nav' }, TABS.map((t) => h('a', { href: t.id === 'profile' ? '/settings' : `/settings/${t.id}`, class: t.id === tab ? 'active' : '' }, icon(t.icon, { size: 16 }), t.label)));
  const section = h('div', { class: 'settings-section' }, spinner());
  mount(view, pageHeader({ title: 'Settings' }), h('div', { class: 'settings-layout' }, nav, section));
  const renderers = { profile: renderProfile, security: renderSecurity, company: renderCompany, members: renderMembers, categories: renderCategories };
  await (renderers[tab] || renderProfile)(section, ctx);
}

function sectionCard(title, subtitle, ...body) {
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, title), subtitle ? h('div', { class: 'small muted' }, subtitle) : null)), h('div', { class: 'card-body' }, body));
}

// ---------- profile ----------
async function renderProfile(section, ctx) {
  let color = state.user.avatarColor || AVATAR_COLORS[0];
  const swatches = h('div', { class: 'swatches' });
  const paint = () => mount(swatches, AVATAR_COLORS.map((c) => { const b = h('button', { type: 'button', class: `swatch ${c === color ? 'active' : ''}`, 'aria-label': c, onclick: () => { color = c; paint(); } }); b.style.setProperty('--sw', c); return b; }));
  paint();
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('div', { class: 'flex', style: { gap: '14px' } }, avatar({ ...state.user, avatarColor: color }, { size: 'lg' }), h('div', {}, h('div', { style: { fontWeight: 600 } }, state.user.name), h('div', { class: 'small muted' }, state.user.email))),
    field({ label: 'Display name', name: 'name', required: true, input: input({ value: state.user.name, required: true }) }),
    field({ label: 'Email', input: input({ value: state.user.email, readOnly: true }), hint: 'Email is your sign-in identity and cannot be changed here.' }),
    h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Avatar color'), swatches),
    formActions(h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save profile')));
  handleSubmit(form, async (data) => {
    const res = await api.patch('/api/auth/me', { name: data.name, avatarColor: color });
    state.user = { ...state.user, ...res.user };
    toast('Profile saved'); await ctx.refreshCompany(); ctx.refresh();
  });
  mount(section, sectionCard('Profile', 'How you appear to your team.', form));
}

// ---------- security ----------
async function renderSecurity(section, ctx) {
  const [sessions, keys] = await Promise.all([api.get('/api/auth/me/sessions'), api.get('/api/keys')]);
  const myActiveKeys = keys.items.filter((k) => k.state === 'active' && k.userId === state.user.id);
  const pwForm = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Current password', name: 'currentPassword', required: true, input: input({ type: 'password', autocomplete: 'current-password', required: true }) }),
    field({ label: 'New password', name: 'newPassword', required: true, input: input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), hint: 'At least 10 characters. Changing it signs out every other device and revokes your API keys.' }),
    formActions(h('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password')));
  handleSubmit(pwForm, async (data) => {
    const res = await api.post('/api/auth/me/password', data);
    const n = res.revokedKeys || 0;
    toast(`Password changed. Other devices were signed out.${n ? ` ${n} API key${n === 1 ? '' : 's'} revoked.` : ''}`);
    pwForm.reset(); ctx.refresh();
  });

  const mfaOn = state.user.totpEnabled;
  const mfaCard = sectionCard('Two-factor authentication', 'A code from your phone is required at sign-in, even if someone learns your password.',
    h('div', { class: 'flex', style: { justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' } },
      h('div', { class: 'flex' }, icon(mfaOn ? 'shield' : 'alert', { size: 20, cls: mfaOn ? '' : '' }), h('div', {}, h('div', { style: { fontWeight: 600 } }, mfaOn ? 'Enabled' : 'Not enabled'), h('div', { class: 'small muted' }, mfaOn ? 'Authenticator app (TOTP) with recovery codes.' : 'Strongly recommended for both founders.'))),
      mfaOn ? button('Disable', { variant: 'danger', onclick: () => openDisableMfa(ctx) }) : button('Enable two-factor', { variant: 'primary', icon: 'lock', onclick: () => openEnableMfa(ctx) })));

  const sessionsCard = sectionCard('Active sessions', 'Devices currently signed in to your account.',
    h('div', {}, sessions.items.map((s) => h('div', { class: 'session-row' },
      icon('key', { size: 16 }),
      h('div', { class: 'info' }, h('div', {}, h('b', {}, describeUa(s.userAgent)), s.current ? badge('This device', 'badge-accent') : null), h('div', { class: 'small muted' }, `${s.ip || 'unknown IP'} · active ${relative(s.lastSeenAt)} · signed in ${date(s.createdAt)}`)),
      s.current ? null : button('Revoke', { size: 'sm', onclick: async () => { await api.del(`/api/auth/me/sessions/${s.id}`); toast('Session revoked'); ctx.refresh(); } })))),
    sessions.items.length > 1 ? h('div', { style: { marginTop: '12px' } }, button('Sign out all other devices', { variant: 'danger', size: 'sm', onclick: async () => { const r = await api.post('/api/auth/me/sessions/revoke-others'); toast(`${r.revoked} session${r.revoked === 1 ? '' : 's'} revoked`); ctx.refresh(); } })) : null);

  const keysCard = sectionCard('API keys', 'Keys act as you, without a browser session, until they are revoked or expire.',
    myActiveKeys.length
      ? h('div', {}, myActiveKeys.map((k) => h('div', { class: 'session-row' },
        icon('key', { size: 16 }),
        h('div', { class: 'info' }, h('div', {}, h('b', {}, k.name), badge(k.scope === 'write' ? 'Read & write' : 'Read only', k.scope === 'write' ? 'badge-accent' : '')),
          h('div', { class: 'small muted' }, `${k.lastUsedAt ? `last used ${relative(k.lastUsedAt)}` : 'never used'}${k.expiresAt ? ` · expires ${date(k.expiresAt)}` : ''}`)),
        button('Revoke', { size: 'sm', onclick: async () => { await api.del(`/api/keys/${k.id}`); toast('API key revoked'); ctx.refresh(); } }))))
      : h('p', { class: 'small muted' }, 'You have no active keys.'),
    h('div', { style: { marginTop: '12px' } }, h('a', { class: 'small', href: '/developers' }, 'Manage keys on the API tab')));

  mount(section, mfaCard, sectionCard('Password', null, pwForm), sessionsCard, keysCard);
}

function describeUa(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

function openEnableMfa(ctx) {
  const body = h('div');
  const modal = openModal({ title: 'Enable two-factor authentication', content: body, size: 'md' });
  // step 1: password
  const step1 = h('form', { class: 'form-grid', novalidate: true },
    h('p', { class: 'modal-text' }, 'Confirm your password to start. You will need an authenticator app such as Google Authenticator, 1Password, Authy or Microsoft Authenticator.'),
    field({ label: 'Password', name: 'password', required: true, input: input({ type: 'password', autocomplete: 'current-password', required: true }) }),
    formActions(h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Continue')));
  handleSubmit(step1, async (data) => {
    const setup = await api.post('/api/auth/me/mfa/setup', { password: data.password });
    const step2 = h('form', { class: 'form-grid', novalidate: true },
      h('p', { class: 'modal-text' }, 'Scan this QR code with your authenticator app, then enter the 6-digit code it shows.'),
      h('div', { class: 'qr' }, h('img', { src: setup.qrDataUrl, alt: 'QR code for authenticator app', width: 200, height: 200 })),
      h('details', {}, h('summary', { class: 'small', style: { cursor: 'pointer', color: 'var(--accent)' } }, 'Cannot scan? Enter the key manually'), h('div', { class: 'secret', style: { marginTop: '8px' } }, setup.secret)),
      field({ label: 'Code from app', name: 'code', required: true, input: input({ class: 'input code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '000000', required: true }) }),
      formActions(h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Verify & enable')));
    handleSubmit(step2, async (d2) => {
      const res = await api.post('/api/auth/me/mfa/enable', { code: d2.code });
      state.user.totpEnabled = true;
      mount(body,
        h('div', { class: 'callout' }, icon('shield'), h('span', {}, h('b', {}, 'Two-factor is on.'), ' Save these recovery codes somewhere safe (a password manager). Each works once if you lose your phone.')),
        h('div', { class: 'recovery-codes', style: { marginTop: '14px' } }, res.recoveryCodes.map((c) => h('span', {}, c))),
        h('div', { class: 'flex', style: { marginTop: '12px', gap: '8px' } }, copyButton(res.recoveryCodes.join('\n'), 'Copy codes')),
        formActions(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { modal.close(); toast('Two-factor authentication enabled'); ctx.refresh(); } }, 'I saved them')));
    });
    mount(body, step2); step2.querySelector('input').focus();
  });
  mount(body, step1);
}

function openDisableMfa(ctx) {
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('div', { class: 'callout warn' }, icon('alert'), h('span', {}, 'Your account will rely on the password alone.')),
    field({ label: 'Password', name: 'password', required: true, input: input({ type: 'password', autocomplete: 'current-password', required: true }) }),
    field({ label: 'Current code from app', name: 'code', required: true, input: input({ inputmode: 'numeric', maxlength: 6, required: true }) }),
    formActions(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-danger', type: 'submit' }, 'Disable two-factor')));
  handleSubmit(form, async (data) => { await api.post('/api/auth/me/mfa/disable', data); state.user.totpEnabled = false; m.close(); toast('Two-factor disabled'); ctx.refresh(); });
  const m = openModal({ title: 'Disable two-factor authentication', content: form, size: 'sm' });
}

// ---------- company ----------
async function renderCompany(section, ctx) {
  const c = state.company;
  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Company name', name: 'name', required: true, input: input({ value: c.name, required: true, readOnly: !isAdmin() }) }),
    row(
      field({ label: 'Task key', name: 'key', required: true, input: input({ value: c.key, required: true, readOnly: !isAdmin(), style: { textTransform: 'uppercase' } }), hint: `Tasks are numbered ${c.key}-1, ${c.key}-2… 2–6 uppercase letters or digits.` }),
      field({ label: 'Currency', name: 'currency', required: true, input: input({ value: c.currency, required: true, readOnly: !isAdmin(), maxlength: 3, style: { textTransform: 'uppercase' } }), hint: '3-letter ISO code, e.g. USD, EUR, AED.' })),
    isAdmin() ? formActions(h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')) : h('p', { class: 'small muted' }, 'Only admins and owners can change company settings.'));
  handleSubmit(form, async (data) => {
    await api.patch('/api/company', { name: data.name, key: (data.key || '').toUpperCase(), currency: (data.currency || '').toUpperCase() });
    toast('Company settings saved'); await ctx.refreshCompany(); ctx.refresh();
  });
  mount(section, sectionCard('Company', 'Shared by everyone in the workspace.', form),
    sectionCard('Data & encryption', 'How your information is protected.',
      h('ul', { style: { margin: 0, paddingLeft: '18px', color: 'var(--text-2)', fontSize: '13.5px', lineHeight: 1.7 } },
        h('li', {}, 'Names, descriptions, amounts, notes, comments and receipts are encrypted with AES-256-GCM before they reach the database.'),
        h('li', {}, 'Passwords are hashed with scrypt; sessions and invite links are stored only as hashes.'),
        h('li', {}, 'The encryption key lives in the server .env file, never in the database. Keep a backup of it.'),
        h('li', {}, 'Every change is recorded in the ', h('a', { href: '/activity' }, 'activity log'), '.'))));
}

// ---------- members & invites ----------
async function renderMembers(section, ctx) {
  const admin = isAdmin();
  const [membersRes, invitesRes] = await Promise.all([api.get('/api/company/members'), admin ? api.get('/api/company/invites') : Promise.resolve({ items: [] })]);
  const owners = membersRes.items.filter((m) => m.role === 'owner').length;
  const rank = { member: 1, admin: 2, owner: 3 };

  const rows = membersRes.items.map((m) => {
    const isSelf = m.id === state.user.id;
    const canChange = admin && (isOwner() || m.role !== 'owner') && !(m.role === 'owner' && owners <= 1);
    const canRemove = (isSelf && !(m.role === 'owner' && owners <= 1)) || (admin && !isSelf && rank[m.role] < rank[state.role]);
    return h('div', { class: 'member-row' },
      avatar(m, { size: 'md' }),
      h('div', { class: 'info' }, h('div', { class: 'name' }, m.name, isSelf ? h('span', { class: 'muted small' }, ' (you)') : null), h('div', { class: 'email' }, `${m.email} · joined ${date(m.joinedAt)}`)),
      canChange ? select(ROLE_OPTIONS.filter((r) => isOwner() || r.value !== 'owner'), { value: m.role, onchange: async (e) => { try { await api.patch(`/api/company/members/${m.id}`, { role: e.target.value }); toast('Role updated'); await ctx.refreshCompany(); ctx.refresh(); } catch (err) { toast(err.message, { type: 'error' }); ctx.refresh(); } } }) : badge(m.role, m.role === 'owner' ? 'badge-accent' : ''),
      canRemove ? iconButton('trash', { title: isSelf ? 'Leave company' : 'Remove member', onclick: async () => {
        const ok = await confirmDialog({ title: isSelf ? 'Leave this company?' : `Remove ${m.name}?`, message: isSelf ? 'You will lose access until someone invites you again.' : 'They lose access immediately. Their expenses and tasks stay.', confirmText: isSelf ? 'Leave' : 'Remove', danger: true });
        if (!ok) return;
        try { await api.del(`/api/company/members/${m.id}`); if (isSelf) { window.location.assign('/'); return; } toast('Member removed'); await ctx.refreshCompany(); ctx.refresh(); } catch (err) { toast(err.message, { type: 'error' }); }
      } }) : null);
  });

  let inviteCard = null;
  if (admin) {
    const result = h('div');
    const form = h('form', { class: 'form-grid', novalidate: true },
      h('div', { class: 'form-row' },
        field({ label: 'Email (optional)', name: 'email', input: input({ type: 'email', placeholder: 'cofounder@company.com' }), hint: 'If set, only this email can accept the link.' }),
        field({ label: 'Role', name: 'role', input: select(ROLE_OPTIONS.filter((r) => isOwner() || r.value !== 'owner'), { value: 'admin' }), hint: ROLE_HELP })),
      formActions(h('button', { class: 'btn btn-primary', type: 'submit' }, icon('users', { size: 16 }), 'Create invite link')));
    handleSubmit(form, async (data) => {
      const res = await api.post('/api/company/invites', { email: data.email, role: data.role });
      mount(result, h('div', { class: 'callout', style: { flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginBottom: '14px' } },
        h('div', { class: 'flex' }, icon('check'), h('b', {}, 'Invite link created.'), h('span', {}, ' Send it to your co-founder over a channel you trust. It works once and expires in 7 days.')),
        h('div', { class: 'invite-link' }, input({ value: res.url, readOnly: true, onclick: (e) => e.target.select() }), copyButton(res.url, 'Copy link')),
        h('div', { class: 'small muted' }, 'For security the link is shown only now. If you lose it, revoke it below and create a new one.')));
      form.reset();
      refreshInvites();
    });
    const invitesBox = h('div');
    const refreshInvites = async () => {
      const inv = await api.get('/api/company/invites');
      const pending = inv.items.filter((i) => i.state === 'pending');
      const past = inv.items.filter((i) => i.state !== 'pending').slice(0, 10);
      mount(invitesBox,
        pending.length ? [h('div', { class: 'section-title', style: { marginTop: '6px' } }, 'Pending invites'), pending.map((i) => h('div', { class: 'session-row' }, icon('clock', { size: 16 }), h('div', { class: 'info' }, h('div', {}, h('b', {}, i.email || 'Anyone with the link'), ' as ', badge(i.role)), h('div', { class: 'small muted' }, `Created ${relative(i.createdAt)} by ${i.createdByName || 'someone'} · expires ${date(i.expiresAt)}`)), button('Revoke', { size: 'sm', onclick: async () => { await api.del(`/api/company/invites/${i.id}`); toast('Invite revoked'); refreshInvites(); } })))] : null,
        past.length ? [h('div', { class: 'section-title' }, 'History'), past.map((i) => h('div', { class: 'session-row' }, icon(i.state === 'accepted' ? 'check' : 'x', { size: 16 }), h('div', { class: 'info' }, h('div', {}, i.email || 'Open invite', ' · ', badge(i.state, i.state === 'accepted' ? 'badge-good' : '')), h('div', { class: 'small muted' }, `${i.role} · ${date(i.createdAt)}`))))] : null);
    };
    refreshInvites();
    inviteCard = sectionCard('Invite your co-founder', 'Create a one-time link. They pick a password and land in this workspace.', result, form, invitesBox);
  }

  mount(section,
    inviteCard,
    sectionCard(`Members (${membersRes.items.length})`, ROLE_HELP, h('div', {}, rows)));
}

// ---------- categories ----------
async function renderCategories(section, ctx) {
  const admin = isAdmin();
  const res = await api.get('/api/company/categories');
  const list = h('div');
  const rows = res.items.map((c) => {
    const nameInput = input({ value: c.name, readOnly: !admin, class: 'input', onblur: async (e) => { const v = e.target.value.trim(); if (v && v !== c.name) { try { await api.patch(`/api/company/categories/${c.id}`, { name: v }); c.name = v; toast('Category renamed'); ctx.refreshCompany(); } catch (err) { toast(err.message, { type: 'error' }); e.target.value = c.name; } } } });
    const color = admin ? colorInput({ value: c.color || '#898781', onchange: async (e) => { await api.patch(`/api/company/categories/${c.id}`, { color: e.target.value }); ctx.refreshCompany(); } }) : colorDot(c.color, 14);
    return h('div', { class: 'member-row', style: c.archived ? { opacity: .55 } : null },
      color, h('div', { class: 'info' }, nameInput),
      c.archived ? badge('Archived') : null,
      admin ? button(c.archived ? 'Unarchive' : 'Archive', { size: 'sm', variant: 'ghost', onclick: async () => { await api.patch(`/api/company/categories/${c.id}`, { archived: !c.archived }); await ctx.refreshCompany(); ctx.refresh(); } }) : null,
      admin ? iconButton('trash', { title: 'Delete category', onclick: async () => {
        const ok = await confirmDialog({ title: `Delete "${c.name}"?`, message: 'Expenses in this category become uncategorised. Archiving keeps history intact.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        await api.del(`/api/company/categories/${c.id}`); toast('Category deleted'); await ctx.refreshCompany(); ctx.refresh();
      } }) : null);
  });
  mount(list, rows);
  let addForm = null;
  if (admin) {
    addForm = h('form', { class: 'flex', novalidate: true, style: { alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
      field({ label: 'New category', name: 'name', input: input({ placeholder: 'e.g. Payroll', required: true }) }),
      field({ label: 'Color', name: 'color', input: colorInput({ value: '#2a78d6' }) }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add'));
    handleSubmit(addForm, async (data) => { await api.post('/api/company/categories', { name: data.name, color: data.color }); toast('Category added'); await ctx.refreshCompany(); ctx.refresh(); });
  }
  mount(section, sectionCard('Expense categories', 'Group spending so the summary tells you where the money goes.', list, addForm ? h('div', { class: 'divider' }) : null, addForm));
}
