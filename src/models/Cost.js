import mongoose from 'mongoose';

/**
 * Money the business spends that is not a nanny's pay.
 *
 * Commission looks like profit until the running costs are set against it.
 * Transport, phone credit, advertising, a replacement laptop — none of it
 * passes through a booking, so none of it appears anywhere else in the
 * system, and a dashboard that reports commission alone reports a number
 * nobody can bank.
 *
 * Deliberately append-mostly: a cost can be edited or voided, never silently
 * deleted, because these rows are what the year's figures are built from.
 */

/** What a cost is for. Fixed rather than free text, so totals can group. */
export const COST_CATEGORY = {
  TRANSPORT: 'transport',
  SUPPLIES: 'supplies',
  MARKETING: 'marketing',
  SALARIES: 'salaries',          // office staff, not nannies — those are payouts
  SOFTWARE: 'software',
  RENT: 'rent',
  UTILITIES: 'utilities',
  FEES: 'fees',                  // bank charges, licences, professional fees
  OTHER: 'other',
};

const CostSchema = new mongoose.Schema({
  /**
   * The day the money was spent, not the day it was typed in.
   *
   * Someone entering last week's receipts on a Monday would otherwise push
   * every one of them into this week's figures.
   */
  spentOn: { type: Date, required: true, index: true },

  category: {
    type: String,
    enum: Object.values(COST_CATEGORY),
    default: COST_CATEGORY.OTHER,
    index: true,
  },

  /** What it was. Free text, because a category alone never explains a row. */
  description: { type: String, required: true, trim: true },

  /** Always positive. A negative cost is a refund, and belongs in its own row. */
  amount: { type: Number, required: true, min: 0 },

  /** Who was paid, when that matters — a supplier, a landlord, a contractor. */
  paidTo: { type: String, trim: true },

  /**
   * A recurring cost is one the business will pay again next month.
   *
   * Flagged rather than duplicated forward: a rent row invented for a month
   * that has not happened is a number in the accounts nobody has spent.
   */
  recurring: { type: Boolean, default: false },

  /** A photo of the receipt, stored in our own media archive. */
  receiptUrl: String,

  note: String,

  /**
   * Voided rather than deleted.
   *
   * A cost entered by mistake still happened as an event: somebody recorded
   * it, and the figures may already have been reported. Voiding keeps the
   * row and takes it out of the totals; deleting would make last month's
   * report irreproducible.
   */
  voided: { type: Boolean, default: false, index: true },
  voidedAt: Date,
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  voidReason: String,

  /** Who entered it, and who last touched it. This is a money record. */
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
}, { timestamps: true });

// The finance page reads a date range, newest first, almost every time.
CostSchema.index({ spentOn: -1, voided: 1 });

export default mongoose.model('Cost', CostSchema);
