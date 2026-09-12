import mongoose from 'mongoose';

/** Email verification codes (6-digit) issued during registration. */
const OtpSchema = new mongoose.Schema({
  phone: { type: String, index: true },
  email: String,
  code: String,
  // 'nanny_login' is the app's sign-in code, sent over WhatsApp rather than
  // email: a nanny has no password and should not need one, and her number is
  // already the thing that identifies her to us.
  purpose: {
    type: String,
    enum: ['email_verification', 'nanny_login'],
    default: 'email_verification',
  },
  attempts: { type: Number, default: 0 },
  consumed: { type: Boolean, default: false },
  expiresAt: { type: Date },
}, { timestamps: true });

// TTL index: Mongo drops the doc once expiresAt passes.
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Otp', OtpSchema);
