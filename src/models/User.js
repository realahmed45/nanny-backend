import mongoose from 'mongoose';
import { USER_ROLE, NANNY_STATUS, CPR_REQUIREMENT } from '../utils/constants.js';

const AddressSchema = new mongoose.Schema({
  label: String,                 // "Home", "Home 1", "Office"...
  mapUrl: String,                // Google Maps link, or null when family typed "None"
  addressLine: String,
  isDefault: { type: Boolean, default: false },
}, { _id: true, timestamps: true });

const ChildSchema = new mongoose.Schema({
  name: String,
  age: String,                   // free text, e.g. "4 years"
  medicalNotes: String,          // allergies / conditions / special care ("None" -> '')
  dietaryNotes: String,
}, { _id: true });

const RatedItemSchema = new mongoose.Schema({
  name: String,
  rating: { type: Number, min: 1, max: 5 },
}, { _id: false });

const DocumentSchema = new mongoose.Schema({
  type: { type: String, enum: ['id_front', 'id_back', 'cpr_certificate', 'profile_photo', 'other'] },
  url: String,
  mediaId: String,
  uploadedAt: { type: Date, default: Date.now },
  verified: { type: Boolean, default: false },
}, { _id: true });

const EmergencyContactSchema = new mongoose.Schema({
  name: String,
  phone: String,
  relation: String,
}, { _id: true });

const AvailabilitySchema = new mongoose.Schema({
  days: [{ type: String }],       // weekday names
  startTime: String,              // "09:00"
  maxHoursPerDay: Number,
  blockedDates: [{ type: String }], // ISO date strings "YYYY-MM-DD"
}, { _id: false });

/**
 * Who introduced this person, and how firm that claim is.
 *
 * Mongoose drops undeclared paths on save without a word, so every field the
 * engine writes is declared here. A missing declaration is a write that
 * evaporates silently and is found months later.
 */
const ReferralAttributionSchema = new mongoose.Schema({
  /**
   * none      never referred
   * credited  a referrer is claimed, and can still be taken by a later click
   * frozen    settled at the first paid booking, unclaimable (OR10)
   * expired   the 30-day window lapsed before they booked (OR5)
   */
  status: {
    type: String,
    enum: ['none', 'credited', 'frozen', 'expired'],
    default: 'none',
    index: true,
  },

  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  referrerCode: String,
  referrerName: String,

  linkId: { type: String, index: true },
  shareLink: { type: mongoose.Schema.Types.ObjectId, ref: 'ShareLink' },

  clickedAt: Date,
  creditedAt: Date,
  /** Copied off the link, so expiry survives the link being revoked. */
  windowExpiresAt: Date,

  frozenAt: Date,
  frozenByBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  frozenByBookingNumber: String,

  expiredAt: Date,
}, { _id: false });

/**
 * Every referrer this person has ever had, appended, never rewritten.
 *
 * OR3 erases the claim but not the record: the credit-sniping detector reads
 * this to spot a swap moments before a first booking, and without the trail
 * there is nothing to detect.
 */
const ReferralAttributionHistorySchema = new mongoose.Schema({
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referrerCode: String,
  referrerName: String,
  linkId: String,
  creditedAt: Date,
  retiredAt: { type: Date, default: Date.now },
  /** later_referral | frozen | expired | manual */
  reason: String,
  heldClaim: { type: Boolean, default: false },
}, { _id: true });

const UserSchema = new mongoose.Schema({
  role: { type: String, enum: Object.values(USER_ROLE), required: true, index: true },
  phone: { type: String, required: true, index: true },   // WhatsApp number (chat id base)
  fullName: String,
  email: { type: String, index: true },
  emailVerified: { type: Boolean, default: false },

  // --- Family fields ---
  addresses: [AddressSchema],
  children: [ChildSchema],
  familyInstructions: String,
  agentCallRequested: { type: Boolean, default: false },
  idDocuments: [DocumentSchema],
  idVerified: { type: Boolean, default: false },

  // --- Nanny fields ---
  // The name families see. Her legal name is ours to verify, not theirs
  // to know, so this is what appears in listings, chats and bookings.
  nickname: String,

  /**
   * Short presentation videos, shown on her profile.
   *
   * A family choosing someone to leave their child with learns more from
   * thirty seconds of video than from any list of skills, so this is part of
   * the profile rather than an attachment on it.
   */
  videos: [{
    url: { type: String, required: true },
    title: String,
    thumbnailUrl: String,
    durationSeconds: Number,
    uploadedAt: { type: Date, default: Date.now },
    // Nothing reaches families until someone has actually watched it.
    approved: { type: Boolean, default: false },
    approvedAt: Date,
  }],
  age: Number,
  experienceYears: Number,
  languages: [RatedItemSchema],
  skills: [RatedItemSchema],
  subjects: [String],
  hourlyRate: Number,
  cprCertified: { type: Boolean, default: false },
  residingAddress: String,
  residingMapUrl: String,
  profilePhotoUrl: String,
  documents: [DocumentSchema],
  availability: { type: AvailabilitySchema, default: () => ({ days: [], blockedDates: [] }) },
  emergencyContacts: [EmergencyContactSchema],
  // Nannies the family saved after a booking, offered first when rebooking.
  favouriteNannies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  nannyStatus: { type: String, enum: Object.values(NANNY_STATUS), default: NANNY_STATUS.PENDING_VERIFICATION, index: true },
  rejectionReason: String,
  backgroundCheckPassed: { type: Boolean, default: false },
  ratingAverage: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },
  distanceKm: { type: Number, default: 2 },   // placeholder until geocoding is wired

  // --- Shared ---
  referralCode: { type: String, index: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referralCount: { type: Number, default: 0 },
  // When the discount window started. Held separately from createdAt so a
  // later referral extends the window rather than restarting it.
  firstReferralAt: Date,
  // An admin can end the discount early, even one set to never expire.
  referralDiscountCancelled: { type: Boolean, default: false },

  /**
   * The attribution engine's record. `referredBy` above is kept in step with
   * this for the older readers, but this sub-document is authoritative — it
   * is the only one that knows whether the claim is still takeable.
   */
  referralAttribution: { type: ReferralAttributionSchema, default: () => ({}) },
  referralAttributionHistory: { type: [ReferralAttributionHistorySchema], default: [] },
  referralEarnings: { type: Number, default: 0 },
  registrationComplete: { type: Boolean, default: false },
  blocked: { type: Boolean, default: false },
  lastSeenAt: Date,
}, { timestamps: true });

UserSchema.index({ role: 1, phone: 1 }, { unique: true });

UserSchema.methods.isVerifiedNanny = function () {
  return this.role === USER_ROLE.NANNY && this.nannyStatus === NANNY_STATUS.VERIFIED;
};

export default mongoose.model('User', UserSchema);
export { CPR_REQUIREMENT };
