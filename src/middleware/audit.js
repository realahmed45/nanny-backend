import { recordAudit } from '../services/audit.js';

/**
 * Record every state-changing admin request.
 *
 * Done as middleware rather than a call inside each handler because the
 * value of an audit trail is that it has no gaps — a route added next month
 * is covered without anyone remembering to instrument it.
 *
 * Only successful requests are recorded: a rejected or failed attempt did not
 * change anything, and mixing the two makes the trail unreadable.
 */

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Never store credentials or proof-of-identity blobs in the trail. */
const REDACT = new Set(['password', 'passwordHash', 'token', 'secret', 'otp', 'code']);

/**
 * Turn a request into a stable verb: POST /payments/123/approve ->
 * "payment.approve". Ids are dropped so actions of the same kind group
 * together when the log is filtered.
 */
export function describeRoute(method, path) {
  const parts = String(path).split('/').filter(Boolean)
    .filter((p) => !/^[a-f\d]{24}$/i.test(p));   // drop object ids

  const resource = parts[0] || 'unknown';
  const verb = parts.slice(1).join('.');

  // Singularise the leading collection, so it reads "payment.approve".
  const singular = resource.replace(/ies$/, 'y').replace(/s$/, '');

  if (verb) return `${singular}.${verb}`;
  return `${singular}.${{ POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' }[method] || 'change'}`;
}

/** The object id in the path, when there is one. */
function targetIdFrom(path) {
  const ids = String(path).split('/').filter((p) => /^[a-f\d]{24}$/i.test(p));
  return ids[0] || undefined;
}

function safeBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (REDACT.has(k)) { out[k] = '[redacted]'; continue; }
    // Screenshots and long free text bloat the trail without adding to it.
    if (typeof v === 'string' && v.length > 500) { out[k] = `${v.slice(0, 500)}…`; continue; }
    out[k] = v;
  }
  return out;
}

export function auditMutations(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  // Login is recorded by its own handler, which knows whether the password
  // was right; auditing it here would log every failed attempt as success.
  if (req.path === '/auth/login') return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    if (!req.admin) return;

    recordAudit(req, {
      action: describeRoute(req.method, req.path),
      targetType: (req.path.split('/').filter(Boolean)[0] || '').replace(/ies$/, 'y').replace(/s$/, ''),
      target: targetIdFrom(req.path),
      targetLabel: res.locals?.auditLabel,
      after: res.locals?.auditAfter ?? safeBody(req.body),
      before: res.locals?.auditBefore,
      note: res.locals?.auditNote,
    });
  });

  return next();
}

export default { auditMutations, describeRoute };
