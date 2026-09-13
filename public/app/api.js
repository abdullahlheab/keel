// Fetch wrapper: same-origin JSON API with CSRF header, company scoping, and typed errors.
import { state, events } from './state.js';

export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.fields = data.fields || null;
    this.data = data;
  }
}

async function request(method, path, body, { raw = false, headers = {} } = {}) {
  const init = {
    method,
    headers: { 'X-Requested-With': 'fetch', Accept: 'application/json', ...headers },
    credentials: 'same-origin',
  };
  if (state.companyId) init.headers['X-Company-Id'] = state.companyId;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Network error. Check your connection and try again.');
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'Request failed');
    return res;
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : { error: await res.text() };
  if (!res.ok) {
    if (res.status === 401 && !data.mfaRequired && state.user) {
      state.user = null;
      events.dispatchEvent(new CustomEvent('signed-out'));
    }
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
  upload: (path, file) => request('POST', path, file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'receipt') } }),
};
