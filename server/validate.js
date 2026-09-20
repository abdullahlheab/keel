// Tiny request-body validator. Every write endpoint declares a schema; unknown keys are dropped.
import { HttpError } from './middleware/errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export const rules = {
  string: (o = {}) => ({ type: 'string', ...o }),
  email: (o = {}) => ({ type: 'string', pattern: EMAIL, max: 254, lower: true, trim: true, ...o }),
  date: (o = {}) => ({ type: 'string', pattern: ISO_DATE, ...o }),
  color: (o = {}) => ({ type: 'string', pattern: COLOR, ...o }),
  enum: (values, o = {}) => ({ type: 'enum', values, ...o }),
  int: (o = {}) => ({ type: 'int', ...o }),
  bool: (o = {}) => ({ type: 'bool', ...o }),
  id: (o = {}) => ({ type: 'string', pattern: /^[0-9a-fA-F-]{36}$/, ...o }),
  array: (item, o = {}) => ({ type: 'array', item, ...o }),
  money: (o = {}) => ({ type: 'money', ...o }),
};

function checkField(name, rule, raw, errors) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && rule.trim !== false && raw.trim() === '' && rule.type !== 'string')) {
    if (rule.required) errors[name] = 'Required';
    return rule.default !== undefined ? rule.default : (raw === undefined ? undefined : null);
  }
  switch (rule.type) {
    case 'string': {
      if (typeof raw !== 'string') { errors[name] = 'Must be text'; return undefined; }
      let v = rule.trim === false ? raw : raw.trim();
      if (rule.lower) v = v.toLowerCase();
      if (v === '') {
        // Declaring a minimum length means empty is not a way to clear the field either.
        if (rule.required) { errors[name] = 'Required'; return undefined; }
        if (rule.min) { errors[name] = `Must be at least ${rule.min} characters`; return undefined; }
        return rule.nullable === false ? '' : null;
      }
      if (rule.min && v.length < rule.min) { errors[name] = `Must be at least ${rule.min} characters`; return undefined; }
      if (v.length > (rule.max ?? 2000)) { errors[name] = `Must be at most ${rule.max ?? 2000} characters`; return undefined; }
      if (rule.pattern && !rule.pattern.test(v)) { errors[name] = rule.message || 'Invalid format'; return undefined; }
      return v;
    }
    case 'enum':
      if (!rule.values.includes(raw)) { errors[name] = `Must be one of: ${rule.values.join(', ')}`; return undefined; }
      return raw;
    case 'int': {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (!Number.isInteger(n)) { errors[name] = 'Must be a whole number'; return undefined; }
      if (rule.min !== undefined && n < rule.min) { errors[name] = `Must be at least ${rule.min}`; return undefined; }
      if (rule.max !== undefined && n > rule.max) { errors[name] = `Must be at most ${rule.max}`; return undefined; }
      return n;
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 0 || raw === '0') return false;
      errors[name] = 'Must be true or false'; return undefined;
    case 'money': {
      const cents = parseMoney(raw);
      if (cents === null) { errors[name] = 'Enter an amount like 1234.56'; return undefined; }
      if (rule.min !== undefined && cents < rule.min) { errors[name] = 'Amount too small'; return undefined; }
      if (Math.abs(cents) > 10 ** 15) { errors[name] = 'Amount too large'; return undefined; }
      return cents;
    }
    case 'array': {
      if (!Array.isArray(raw)) { errors[name] = 'Must be a list'; return undefined; }
      if (raw.length > (rule.max ?? 200)) { errors[name] = `At most ${rule.max ?? 200} items`; return undefined; }
      const out = [];
      raw.forEach((item, i) => {
        const sub = {};
        const v = checkField(`${name}[${i}]`, rule.item, item, sub);
        Object.assign(errors, sub);
        if (v !== undefined) out.push(v);
      });
      return out;
    }
    default:
      return raw;
  }
}

// Accepts 1234.5, "1,234.50", "$1234", "-12.30". Returns integer cents or null.
export function parseMoney(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw * 100);
  }
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s,]/g, '').replace(/^[^\d.-]+/, '');
  const m = cleaned.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return sign === '-' ? -cents : cents;
}

// validate(schema, body, { partial }) -> cleaned object. Throws 400 with field errors.
export function validate(schema, body, { partial = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const errors = {};
  const out = {};
  for (const [name, rule] of Object.entries(schema)) {
    // A partial update skips whatever was not sent. Anything that WAS sent still has to satisfy the
    // rule, `required` included: emptying a required field is an error, not a licence to store null
    // in a NOT NULL column.
    if (partial && !(name in body)) continue;
    const v = checkField(name, rule, body[name], errors);
    if (v !== undefined) out[name] = v;
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Please fix the highlighted fields', { fields: errors });
  return out;
}
