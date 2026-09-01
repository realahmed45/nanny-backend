import mongoose from 'mongoose';

/**
 * A family the bot could not match to a nanny.
 *
 * Rather than leaving them at a dead end, we promise a callback and put
 * everything they told the chatbot in one place, so whoever rings them back
 * does not have to ask for it all again.
 */
const CallbackRequestSchema = new mongoose.Schema({
  reference: { type: String, unique: true, index: true },

  family: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  phone: { type: String, index: true },
  fullName: String,
  email: String,

  reason: {
    type: String,
    enum: ['no_nanny_found', 'agent_requested', 'other'],
    default: 'no_nanny_found',
    index: true,
  },

  /**
   * Everything the family entered before we ran out of matches. Kept as a
   * snapshot because the draft lives in the session and is cleared when they
   * start again — by the time anyone calls, the original request would be gone.
   */
  request: {
    startDate: String,
    endDate: String,
    isMultiDay: Boolean,
    isEmergency: Boolean,
    startTime: String,
    hoursPerDay: Number,
    repeatDays: [String],
    languages: [String],
    skills: [String],
    subjects: [String],
    address: {
      label: String,
      mapUrl: String,
      addressLine: String,
    },
    children: [{
      name: String,
      age: String,
      medicalNotes: String,
      dietaryNotes: String,
    }],
    otherInstructions: String,
  },

  /** When we told the family we would ring: immediately, or 10am next morning. */
  callWindow: { type: String, enum: ['now', 'morning'], default: 'now' },
  promisedCallAt: Date,

  status: {
    type: String,
    enum: ['pending', 'in_progress', 'called', 'closed'],
    default: 'pending',
    index: true,
  },
  assignedTo: String,
  notes: String,
  calledAt: Date,
}, { timestamps: true });

CallbackRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('CallbackRequest', CallbackRequestSchema);
