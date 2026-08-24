import mongoose from 'mongoose';

const AdminUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  name: String,
  role: { type: String, enum: ['admin', 'super_admin', 'support'], default: 'admin' },
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { timestamps: true });

export default mongoose.model('AdminUser', AdminUserSchema);
