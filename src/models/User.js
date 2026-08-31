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
