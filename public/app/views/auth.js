// Sign in, first-run registration, invite acceptance, two-factor challenge.
import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { field, input, select, handleSubmit } from '../components/forms.js';
import { icon } from '../components/ui.js';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'AED', 'SAR', 'INR', 'PKR', 'EGP', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'HKD', 'ZAR', 'BRL', 'MXN', 'TRY', 'NGN', 'KES'];

function logo() {
  return h('div', { class: 'auth-logo' }, h('span', { class: 'brand-key' }, 'K'), 'Keel');
}
function page(card) { return h('div', { class: 'auth' }, card); }

export async function renderLogin(root, ctx) {
  let policy = { openSignup: false, firstRun: false };
  try { policy = await api.get('/api/auth/policy'); } catch { /* ignore */ }
  if (policy.firstRun) { return renderRegister(root, ctx, { firstRun: true }); }
  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Email', name: 'email', input: input({ type: 'email', autocomplete: 'username', required: true, autofocus: true }) }),
    field({ label: 'Password', name: 'password', input: input({ type: 'password', autocomplete: 'current-password', required: true }) }),
    h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Sign in'));
  handleSubmit(form, async (data) => {
    const res = await api.post('/api/auth/login', data);
    if (res.mfaRequired) { ctx.onMfa?.(); window.location.assign(`/mfa${ctx.query.next ? `?next=${encodeURIComponent(ctx.query.next)}` : ''}`); return; }
    ctx.onSignedIn(res, ctx.query.next);
  });
  mount(root, page(h('div', { class: 'card auth-card' },
    logo(),
    h('h1', {}, 'Welcome back'),
    h('p', { class: 'lead' }, 'Sign in to your company workspace.'),
    form,
    h('div', { class: 'auth-foot' }, policy.openSignup ? ['New here? ', h('a', { href: '/register' }, 'Create a company')] : 'Need access? Ask a teammate for an invite link.'))));
}

export async function renderRegister(root, ctx, { firstRun = false } = {}) {
  if (!firstRun) {
    let policy = { openSignup: false };
    try { policy = await api.get('/api/auth/policy'); } catch { /* ignore */ }
    if (!policy.openSignup) {
      return mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'Invite only'),
        h('p', { class: 'lead' }, 'This workspace already has an owner. Ask them for an invite link to join.'),
        h('a', { class: 'btn btn-block', href: '/login' }, 'Back to sign in'))));
    }
  }
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('div', { class: 'section-title', style: { margin: '0' } }, 'Your account'),
    field({ label: 'Your name', name: 'name', input: input({ autocomplete: 'name', required: true, autofocus: true, placeholder: 'Ada Lovelace' }) }),
    field({ label: 'Email', name: 'email', input: input({ type: 'email', autocomplete: 'username', required: true }) }),
    field({ label: 'Password', name: 'password', input: input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), hint: 'At least 10 characters. A passphrase of a few words works well.' }),
    h('div', { class: 'section-title' }, 'Your company'),
    h('div', { class: 'form-row' },
      field({ label: 'Company name', name: 'companyName', input: input({ required: true, placeholder: 'Acme Inc.' }) }),
      field({ label: 'Currency', name: 'currency', input: select(CURRENCIES.map((c) => ({ value: c, label: c })), { value: 'USD' }) })),
    h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, firstRun ? 'Create workspace' : 'Create company'));
  handleSubmit(form, async (data) => {
    const res = await api.post('/api/auth/register', data);
    ctx.onSignedIn(res, '/');
  });
  mount(root, page(h('div', { class: 'card auth-card wide' },
    logo(),
    h('h1', {}, firstRun ? 'Set up your workspace' : 'Create a company'),
    h('p', { class: 'lead' }, firstRun ? 'You are the first person here. Create the owner account and your company. You can invite your co-founder right after.' : 'Start a new company workspace.'),
    form,
    firstRun ? null : h('div', { class: 'auth-foot' }, 'Already have an account? ', h('a', { href: '/login' }, 'Sign in')))));
}

export async function renderInvite(root, ctx) {
  const token = ctx.params.token;
  mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('p', { class: 'lead' }, 'Checking your invite…'))));
  let info;
  try { info = await api.get(`/api/auth/invites/${encodeURIComponent(token)}`); }
  catch (err) {
    return mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'Invite not found'), h('p', { class: 'lead' }, err.status === 404 ? 'This link is not valid. Ask for a new invite.' : err.message), h('a', { class: 'btn btn-block', href: '/login' }, 'Go to sign in'))));
  }
  if (info.state !== 'valid') {
    const msg = { expired: 'This invite has expired. Ask for a fresh link.', accepted: 'This invite was already used.', revoked: 'This invite was revoked.' }[info.state];
    return mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'Invite unavailable'), h('p', { class: 'lead' }, msg), h('a', { class: 'btn btn-block', href: '/login' }, 'Go to sign in'))));
  }
  const intro = h('p', { class: 'lead' }, h('b', {}, info.inviterName), ` invited you to join `, h('b', {}, info.companyName), ` as ${info.role}.`);
  if (info.signedIn) {
    const form = h('form', { class: 'form-grid', novalidate: true },
      h('div', { class: 'callout' }, icon('users'), h('span', {}, `You are signed in as ${info.signedInEmail}. Joining will add ${info.companyName} to your account.`)),
      h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, `Join ${info.companyName}`));
    handleSubmit(form, async () => {
      const res = await api.post(`/api/auth/invites/${encodeURIComponent(token)}/accept`, {});
      try { localStorage.setItem('keel.companyId', res.companyId); } catch { /* ignore */ }
      ctx.onSignedIn(res, '/');
    });
    return mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'You are invited'), intro, form)));
  }
  const form = h('form', { class: 'form-grid', novalidate: true },
    field({ label: 'Your name', name: 'name', input: input({ autocomplete: 'name', required: true, autofocus: true }) }),
    field({ label: 'Email', name: 'email', input: input({ type: 'email', autocomplete: 'username', required: true, value: info.email || '', readOnly: Boolean(info.email) }), hint: info.email ? 'This invite is tied to this email address.' : null }),
    field({ label: 'Choose a password', name: 'password', input: input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), hint: 'At least 10 characters.' }),
    h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Create account & join'));
  handleSubmit(form, async (data) => {
    const res = await api.post(`/api/auth/invites/${encodeURIComponent(token)}/accept`, data);
    try { localStorage.setItem('keel.companyId', res.companyId); } catch { /* ignore */ }
    ctx.onSignedIn(res, '/');
  });
  mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'You are invited'), intro, form,
    h('div', { class: 'auth-foot' }, 'Already have an account? ', h('a', { href: `/login?next=${encodeURIComponent(`/invite/${token}`)}` }, 'Sign in first')))));
}

export async function renderMfa(root, ctx) {
  let useRecovery = false;
  const codeInput = input({ class: 'input code-input', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '000000', maxlength: 6, autofocus: true });
  const f = field({ label: 'Authentication code', name: 'code', input: codeInput, hint: 'Open your authenticator app and enter the 6-digit code.' });
  const toggle = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Use a recovery code instead');
  toggle.addEventListener('click', () => {
    useRecovery = !useRecovery;
    codeInput.className = useRecovery ? 'input' : 'input code-input';
    codeInput.placeholder = useRecovery ? 'xxxxx-xxxxx' : '000000';
    codeInput.maxLength = useRecovery ? 11 : 6;
    codeInput.inputMode = useRecovery ? 'text' : 'numeric';
    f.querySelector('.field-label').textContent = useRecovery ? 'Recovery code' : 'Authentication code';
    f.querySelector('.field-hint').textContent = useRecovery ? 'Enter one of the recovery codes you saved when enabling two-factor.' : 'Open your authenticator app and enter the 6-digit code.';
    toggle.textContent = useRecovery ? 'Use authenticator app instead' : 'Use a recovery code instead';
    codeInput.focus();
  });
  const form = h('form', { class: 'form-grid', novalidate: true }, f, h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Verify'), toggle);
  handleSubmit(form, async (data) => {
    const res = await api.post('/api/auth/mfa', { code: data.code });
    ctx.onSignedIn(res, ctx.query.next);
  });
  mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'Two-factor check'), h('p', { class: 'lead' }, 'One more step to keep your company data safe.'), form,
    h('div', { class: 'auth-foot' }, h('a', { href: '/login', onclick: async (e) => { e.preventDefault(); try { await api.post('/api/auth/logout'); } catch { /* ignore */ } window.location.assign('/login'); } }, 'Cancel and sign out')))));
}

export function renderNoCompany(root, ctx) {
  mount(root, page(h('div', { class: 'card auth-card' }, logo(), h('h1', {}, 'No company yet'),
    h('p', { class: 'lead' }, `You are signed in as ${state.user?.email}, but you are not a member of any company. Open the invite link your teammate sent you.`),
    h('button', { class: 'btn btn-block', onclick: async () => { try { await api.post('/api/auth/logout'); } catch { /* ignore */ } window.location.assign('/login'); } }, 'Sign out'))));
}
