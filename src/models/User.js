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
   * Short presentation videos.
   *
   * A family choosing someone to leave their child with learns more from
   * thirty seconds of video than from any list of skills.
   *
   * Two separate gates, and the distinction matters:
   *
   *   approved — someone watched it and it is not objectionable. A safety
   *              check, nothing more. It does not put the video anywhere.
   *   featured — chosen to appear on her public profile. This is an editorial
   *              decision about what represents her best.
   *
   * The archive is unlimited; the profile is not. Only featured media is ever
   * shown to a family, capped by MAX_FEATURED_VIDEOS / MAX_FEATURED_PHOTOS —
   * a family scrolling forty photos is not choosing a nanny, they are
   * abandoning the chat.
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
    // Picked for the public profile. Never true without approved.
    featured: { type: Boolean, default: false },
    featuredAt: Date,
    // Turned down, with the reason she was told. Kept rather than deleted:
    // it records what was sent and what was decided, and stops the same file
    // reappearing in a queue that has already judged it.
    rejectedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    // Several can apply at once — a video is often both dark and too short.
    // `rejectionReason` holds the first for anything still reading one value.
    rejectionReasons: [{ type: String }],
    rejectionReason: { type: String, default: null },
    rejectionDetail: String,
  }],

  /**
   * Photos of her at work — with a family, on the job.
   *
   * Kept alongside the videos rather than folded into them: a nanny sends
   * these as she goes, and a family scanning a profile reads a strip of
   * photos differently from a video it has to sit through. Same two gates,
   * for the same reasons — these show other people's children.
   */
  photos: [{
    url: { type: String, required: true },
    caption: String,
    uploadedAt: { type: Date, default: Date.now },
    approved: { type: Boolean, default: false },
    approvedAt: Date,
    featured: { type: Boolean, default: false },
    featuredAt: Date,
    rejectedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    // Several can apply at once — a video is often both dark and too short.
    // `rejectionReason` holds the first for anything still reading one value.
    rejectionReasons: [{ type: String }],
    rejectionReason: { type: String, default: null },
    rejectionDetail: String,
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
  /**
   * Her profile pictures — the headshots, as opposed to photos of her at work.
   *
   * Several are kept rather than one, for the same reason the videos are: she
   * sends a better one months later, and the old one should not simply vanish
   * in case the new one turns out worse. Same two gates as everything else,
   * and the same review queue.
   *
   * Exactly one can be featured at a time, which is the difference from photos
   * and videos: this is the picture families see beside her name, and a
   * profile cannot have two faces. `profilePhotoUrl` stays as the resolved
   * answer so everything already reading it keeps working.
   */
  profilePictures: [{
    url: { type: String, required: true },
    caption: String,
    uploadedAt: { type: Date, default: Date.now },
    approved: { type: Boolean, default: false },
    approvedAt: Date,
    featured: { type: Boolean, default: false },
    featuredAt: Date,
    rejectedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    rejectionReasons: [{ type: String }],
    rejectionReason: { type: String, default: null },
    rejectionDetail: String,
  }],

  /**
   * The picture actually in use. Kept in step with whichever profilePicture is
   * featured, so the many callers that only want "her photo" need not know the
   * list exists.
   */
  profilePhotoUrl: String,
  documents: [DocumentSchema],
  availability: { type: AvailabilitySchema, default: () => ({ days: [], blockedDates: [] }) },

  /**
   * Is she able to take a job in the next hour, right now?
   *
   * Distinct from `availability`, which is her usual working pattern, and from
   * having no booking — a nanny with a free afternoon may still be at the
   * beach. An emergency broadcast reaching forty people who are merely
   * unbooked is forty messages and no nanny; reaching six who said "yes, I am
   * free now" is the whole point of asking.
   *
   * It expires on its own. Someone who switches it on at breakfast and forgets
   * is worse than someone who never switched it on: the booking is offered to
   * her, she misses it, and a family waits while the clock runs.
   */
  emergencyAvailable: { type: Boolean, default: false, index: true },
  emergencyAvailableUntil: Date,

  /**
   * Where to send a push notification, per device.
   *
   * A nanny signs in on a new phone without signing out of the old one, so
   * this is a list. Tokens are dropped when the push service says they are
   * dead rather than kept forever.
   */
  /**
   * Where her phone last said she was.
   *
   * One position, overwritten — not a trail. A history of everywhere a nanny
   * has been is a thing we would then have to protect, justify and eventually
   * hand to someone who asks for it; the only question this has to answer is
   * "where is she now", and one row answers that.
   *
   * Families never read this. What a family sees during a booking is written
   * on the booking itself, and only while she has sharing switched on for it.
   */
  lastLocation: {
    lat: Number,
    lng: Number,
    accuracy: Number,
    at: Date,
  },

  pushTokens: [{
    token: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web'] },
    registeredAt: { type: Date, default: Date.now },
    lastUsedAt: Date,
  }],
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
   * Following us on Instagram and saving our number, and the discount earned
   * for doing both.
   *
   * Neither can be checked automatically — Instagram will not tell us who
   * follows, and nothing can see a stranger's contacts — so an admin confirms
   * each one by eye. That is why every field records who verified it and when:
   * the record is a person's judgement, and it needs to be attributable.
   *
   * The discount runs from the moment the second of the two is confirmed,
   * because that is when the family has actually done what was asked.
   */
  social: {
    instagramHandle: String,
    instagramFollowing: { type: Boolean, default: false },
    instagramVerifiedAt: Date,
    instagramVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },

    whatsappSaved: { type: Boolean, default: false },
    whatsappVerifiedAt: Date,
    whatsappVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },

    // Set when both are true; the window is measured from here.
    discountStartedAt: Date,
    // An admin can revoke it early, the same as the referral discount.
    discountCancelled: { type: Boolean, default: false },
    notes: String,
  },

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
