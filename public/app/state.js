// App-wide state: who is signed in, which company is active, cached reference data.
export const events = new EventTarget();

export const state = {
  user: null,
  companies: [],
  companyId: null,
  company: null,
  role: null,
  members: [],
  categories: [],
  projects: [],
  counts: {},
  theme: 'system',
};

const COMPANY_KEY = 'keel.companyId';

export function setSession(payload) {
  state.user = payload?.user || null;
  state.companies = payload?.companies || [];
  if (state.companies.length) {
    let saved = null;
    try { saved = localStorage.getItem(COMPANY_KEY); } catch { /* ignore */ }
    const pick = state.companies.find((c) => c.id === saved) || state.companies[0];
    state.companyId = pick.id;
    state.role = pick.role;
    state.company = pick;
  } else {
    state.companyId = null; state.role = null; state.company = null;
  }
  events.dispatchEvent(new CustomEvent('session'));
}

export function selectCompany(id) {
  const c = state.companies.find((x) => x.id === id);
  if (!c) return;
  state.companyId = c.id; state.role = c.role; state.company = c;
  try { localStorage.setItem(COMPANY_KEY, id); } catch { /* ignore */ }
  events.dispatchEvent(new CustomEvent('company'));
}

export function setCompanyData(data) {
  state.company = { ...state.company, ...data.company };
  state.role = data.role;
  state.members = data.members;
  state.categories = data.categories;
  state.counts = data.counts || {};
  const idx = state.companies.findIndex((c) => c.id === data.company.id);
  if (idx !== -1) state.companies[idx] = { ...state.companies[idx], ...data.company, role: data.role };
  events.dispatchEvent(new CustomEvent('company'));
}

export function member(id) { return state.members.find((m) => m.id === id) || null; }
export function category(id) { return state.categories.find((c) => c.id === id) || null; }
export function project(id) { return state.projects.find((p) => p.id === id) || null; }
export function isAdmin() { return state.role === 'admin' || state.role === 'owner'; }
export function isOwner() { return state.role === 'owner'; }
export const currency = () => state.company?.currency || 'USD';

// ---------- theme ----------
export function applyTheme(theme) {
  state.theme = theme;
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem('keel.theme', theme); } catch { /* ignore */ }
}
export function loadTheme() {
  let t = 'system';
  try { t = localStorage.getItem('keel.theme') || 'system'; } catch { /* ignore */ }
  applyTheme(t);
}
