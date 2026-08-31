/**
 * Create or reset the dashboard admin account.
 *
 * The bootstrap admin is normally created at server start, but if that ever
 * fails there is otherwise no way back into the dashboard. Run:
 *
 *   node create-admin.mjs you@example.com "your password"
 *
 * With no arguments it uses ADMIN_EMAIL / ADMIN_PASSWORD from the environment.
 * Re-running for an existing email resets that account's password.
 */
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const email = (process.argv[2] || process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || '';

if (!email || !password) {
  console.error('Usage: node create-admin.mjs <email> <password>');
  console.error('   (or set ADMIN_EMAIL and ADMIN_PASSWORD)');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const { connectDB, disconnectDB } = await import('./src/config/db.js');
await connectDB();

const { default: AdminUser } = await import('./src/models/AdminUser.js');

const passwordHash = await bcrypt.hash(password, 10);
const existing = await AdminUser.findOne({ email });

if (existing) {
  existing.passwordHash = passwordHash;
  await existing.save();
  console.log(`Password reset for existing admin: ${email}`);
} else {
  await AdminUser.create({
    email,
    passwordHash,
    name: 'Administrator',
    role: 'super_admin',
  });
  console.log(`Admin account created: ${email}`);
}

const all = await AdminUser.find({}).select('email role');
console.log(`\nAdmin accounts now on this database (${all.length}):`);
for (const a of all) console.log(`  - ${a.email} (${a.role})`);

await disconnectDB();
