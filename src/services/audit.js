import { AuditLog } from '../models/index.js';

/**
 * Record an admin action.
 *
 * Never throws: an audit write failing must not roll back the thing the
 * operator was actually trying to do. A missing row is logged loudly instead,
 * because silently losing the trail is the worse failure of the two.
 */
export async function recordAudit(req, {
  action, targetType, target, targetLabel, before, after, note,
}) {
  try {
    await AuditLog.create({
      admin: req?.admin?.id,
      adminName: req?.admin?.name,
      adminEmail: req?.admin?.email,
      action,
      targetType,
      target,
      targetLabel,
      before,
      after,
      note,
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
    });
  } catch (err) {
    console.error(`[audit] could not record ${action}: ${err.message}`);
  }
}

/**
 * Only the fields that actually moved.
 *
 * Storing whole documents makes a diff unreadable and bloats the collection,
 * so a change is recorded as the handful of keys that differ.
 */
export function diff(before = {}, after = {}, fields) {
  const keys = fields || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const b = {};
  const a = {};
  for (const k of keys) {
    const from = before?.[k];
    const to = after?.[k];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    b[k] = from;
    a[k] = to;
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

export default { recordAudit, diff };
