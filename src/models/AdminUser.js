import mongoose from 'mongoose';

const AdminUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  name: String,
  /**
   * What this person may do.
   *
   * `finance` exists so whoever keeps the books can record spending without
   * also being handed control of nannies, bookings and payments. It is the
   * only role besides super_admin that may enter a cost.
   */
  role: {
    type: String,
    enum: ['admin', 'super_admin', 'support', 'finance'],
    default: 'admin',
  },
  active: { type: Boolean, default: true },
  /**
   * Sign-ins issued before this moment no longer work. Set when the password
   * changes or the account is switched off, so a leaked login is shut out at
   * once rather than when its 12-hour token happens to expire.
   */
  tokensValidAfter: Date,
  lastLoginAt: Date,
}, { timestamps: true });

export default mongoose.model('AdminUser', AdminUserSchema);
