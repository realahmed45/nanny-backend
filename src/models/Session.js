import mongoose from 'mongoose';

/**
 * Conversation state for one WhatsApp number.
 * `state` is the current node in the flow machine; `data` is the scratch
 * area a multi-step flow fills in; `stack` powers the BACK command.
 */
const SessionSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  role: { type: String, enum: ['family', 'nanny', null], default: null },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  state: { type: String, default: 'START' },
  data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  stack: { type: [String], default: [] },

  // Pagination for listings (nannies, bookings, etc.)
  listing: {
    kind: String,
    ids: [String],
    page: { type: Number, default: 0 },
    pageSize: { type: Number, default: 3 },
  },

  activeChat: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatThread' },
  lastMessageAt: Date,
  lastBotMessage: String,
}, { timestamps: true });

SessionSchema.methods.push = function (nextState) {
  if (this.state && this.state !== nextState) this.stack.push(this.state);
  if (this.stack.length > 40) this.stack = this.stack.slice(-40);
  this.state = nextState;
};

SessionSchema.methods.pop = function () {
  const prev = this.stack.pop();
  if (prev) this.state = prev;
  return prev;
};

SessionSchema.methods.reset = function (state = 'MAIN_MENU') {
  this.state = state;
  this.data = {};
  this.stack = [];
  this.listing = undefined;
  this.activeChat = undefined;
};

export default mongoose.model('Session', SessionSchema);
