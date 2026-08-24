import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { AdminUser } from '../models/index.js';

export function signToken(admin) {
  return jwt.sign(
    { sub: String(admin._id), email: admin.email, role: admin.role },
    config.jwtSecret,
    { expiresIn: '12h' }
  );
}

/** Require a valid admin bearer token. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const admin = await AdminUser.findById(payload.sub);
    if (!admin || !admin.active) return res.status(401).json({ error: 'Account is not active' });
    req.admin = admin;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Restrict a route to particular admin roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    return next();
  };
}

export default { signToken, requireAuth, requireRole };
