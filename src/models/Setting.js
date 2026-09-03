import mongoose from 'mongoose';

/**
 * Runtime settings an admin can change without a redeploy.
 *
 * Most configuration lives in the environment, which is right for secrets and
 * things that should not drift. This collection is for the handful of switches
 * an operator needs to flip while the bot is running — where waiting on a
 * deploy would mean leaving customers stuck.
 *
 * One document per key, so a new switch never needs a migration.
 */
const SettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: mongoose.Schema.Types.Mixed,
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
}, { timestamps: true });

export default mongoose.model('Setting', SettingSchema);
