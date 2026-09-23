import { recordAudit, diff } from '../services/audit.js';

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


/**
 * Which collection a path acts on, so the row can be read before it changes.
 *
 * Only the records whose history someone actually has to answer for: money,
 * people, bookings, and the settings that govern them. A path not listed here
 * still gets an audit row, just without an automatic before-image.
 */
const MODEL_BY_RESOURCE = {
  nannies: 'User',
  families: 'User',
  users: 'User',
  bookings: 'Booking',
  payments: 'Payment',
  payouts: 'Payout',
  contracts: 'User',
  tickets: 'Ticket',
  admins: 'AdminUser',
  callbacks: 'CallbackRequest',
  notes: 'Note',
  // A cost is money the business says it spent. Of everything here it is the
  // record most worth being able to reconstruct.
  costs: 'Cost',
};

/**
 * Fields never worth diffing: they change on every save and would bury the
 * handful of fields a person actually altered.
 */
const IGNORE_FIELDS = new Set([
  '__v', 'updatedAt', 'createdAt', 'passwordHash', 'lastActiveAt', 'lastSeenAt',
]);

/** Strip noise and secrets from a snapshot before it is compared or stored. */
function scrub(doc) {
  if (!doc) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (IGNORE_FIELDS.has(k)) continue;
    if (REDACT.has(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string' && v.length > 500) { out[k] = `${v.slice(0, 500)}…`; continue; }
    out[k] = v;
  }
  return out;
}

/**
 * Read the record as it stands, before the handler changes it.
 *
 * Best-effort on purpose: a failure here must not stop the operator's actual
 * request. Without it the trail still records the action and what was sent,
 * just not the value it replaced.
 */
async function snapshot(req) {
  const parts = String(req.path).split('/').filter(Boolean);
  const resource = parts[0];
  const modelName = MODEL_BY_RESOURCE[resource];
  const id = targetIdFrom(req.path);
  if (!modelName || !id) return undefined;

  /**
   * Only ever snapshot the record the path is directly about.
   *
   * `targetIdFrom` returns the first id in the path, which on a nested route
   * like `/nannies/:id/videos/:videoId` is the nanny rather than the video.
   * Snapshotting the parent there is wrong twice over: the diff becomes the
   * whole nanny record instead of the one thing that changed, and a delete
   * looks like an edit, because the parent still exists afterwards.
   *
   * Those routes set `res.locals.auditBefore` themselves and are already
   * correct. Declining to guess here is what keeps a *new* nested route from
   * silently recording the wrong document.
   */
  const idAt = parts.findIndex((p) => /^[a-f\d]{24}$/i.test(p));
  if (idAt !== 1 || parts.length > 3) return undefined;

  try {
    const models = await import('../models/index.js');
    const Model = models[modelName];
    if (!Model) return undefined;
    const doc = await Model.findById(id).lean();
    return doc ? scrub(doc) : undefined;
  } catch {
    return undefined;
  }
}

export async function auditMutations(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  // Login is recorded by its own handler, which knows whether the password
  // was right; auditing it here would log every failed attempt as success.
  if (req.path === '/auth/login') return next();

  // The record as it stands now. Taken before the handler runs, because
  // afterwards the old values are gone: "from what to what" cannot be
  // reconstructed from the request body alone, since a request carries only
  // the new value and often only some of the fields.
  const beforeDoc = await snapshot(req);

  res.on('finish', async () => {
    if (res.statusCode >= 400) return;
    if (!req.admin) return;

    // Read it back and compare, so the trail records the fields that actually
    // moved rather than everything that was submitted. A handler that set its
    // own before/after is trusted over this, since it knows its own semantics.
    let before = res.locals?.auditBefore;
    let after = res.locals?.auditAfter;

    // Whether the comparison ran and concluded nothing moved. Distinct from
    // "we never looked", which is why it is not simply `!before && !after`.
    let unchanged = false;

    if (before === undefined && after === undefined && beforeDoc) {
      const afterDoc = await snapshot(req);
      if (afterDoc) {
        const d = diff(beforeDoc, afterDoc);
        if (d.changed) {
          before = d.before;
          after = d.after;
        } else {
          // An action that changed nothing still gets a row — but it must not
          // fall through to logging the whole submitted form as its "after".
          // A form resubmitted with no edits sends every field, and a row
          // reading "before: empty, after: <the entire record>" is exactly how
          // a no-op comes to look like somebody rewrote the record.
          unchanged = true;
        }
      } else {
        // Gone after the request: a delete. The whole record is the before
        // image, and it is the only copy that will exist. Nothing follows it,
        // so "after" stays empty rather than echoing the request body.
        before = beforeDoc;
        unchanged = true;
      }
    }

    recordAudit(req, {
      action: describeRoute(req.method, req.path),
      targetType: (req.path.split('/').filter(Boolean)[0] || '').replace(/ies$/, 'y').replace(/s$/, ''),
      target: targetIdFrom(req.path),
      targetLabel: res.locals?.auditLabel,
      after: unchanged ? undefined : (after ?? safeBody(req.body)),
      before,
      note: unchanged && !before ? 'No fields changed' : res.locals?.auditNote,
    });
  });

  return next();
}

export default { auditMutations, describeRoute };
