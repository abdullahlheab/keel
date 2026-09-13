// Security headers, CSRF defence, and in-memory rate limiting.
import { config } from '../config.js';
import { HttpError } from './errors.js';

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  if (req.secure || config.secureCookies) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
}

// Mutating API requests must carry our custom header (impossible cross-origin without CORS
// approval, which we never grant) and, when the browser sends it, a matching Origin.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') {
    return next(new HttpError(403, 'Missing request header'));
  }
  const origin = req.get('Origin');
  if (origin) {
    const host = req.get('Host');
    let originHost;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!host || originHost !== host) {
      return next(new HttpError(403, 'Cross-origin request blocked'));
    }
  }
  const fetchSite = req.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return next(new HttpError(403, 'Cross-site request blocked'));
  }
  next();
}

// Sliding-window limiter, keyed by whatever the caller derives from the request.
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests, slow down' }) {
  const hits = new Map();
  let lastSweep = Date.now();
  return (req, res, next) => {
    const nowMs = Date.now();
    if (nowMs - lastSweep > windowMs) {
      for (const [k, arr] of hits) {
        const kept = arr.filter((t) => nowMs - t < windowMs);
        if (kept.length) hits.set(k, kept); else hits.delete(k);
      }
      lastSweep = nowMs;
    }
    const k = key(req);
    const arr = (hits.get(k) || []).filter((t) => nowMs - t < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return next(new HttpError(429, message));
    }
    arr.push(nowMs);
    hits.set(k, arr);
    next();
  };
}

const TEST = process.env.NODE_ENV === 'test';
export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: TEST ? 10000 : 20, message: 'Too many attempts. Try again in 15 minutes.' });
export const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: TEST ? 10000 : 10,
  key: (req) => `email:${String(req.body?.email || '').toLowerCase()}`,
  message: 'Too many attempts for this account. Try again in 15 minutes.',
});
export const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });
