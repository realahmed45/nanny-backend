import mongoose from 'mongoose';

/**
 * Translations we have already paid for.
 *
 * The bot says the same few dozen things to everybody, so without this every
 * menu would be re-translated on every send: slow for the person waiting, and
 * billed every time. Keyed on the English text, so editing a message in the
 * source produces a new key and a fresh translation, and the stale one simply
 * stops being asked for.
 */
const TranslationSchema = new mongoose.Schema({
  /** locale + hash of the English text. */
  key: { type: String, required: true, unique: true, index: true },

  locale: { type: String, required: true, index: true },

  /** The English it came from — kept so a bad translation can be traced. */
  source: { type: String, required: true },

  /** The translation itself. */
  text: { type: String, required: true },

  /** Which model produced it, so a model change can be audited or purged. */
  model: String,
}, { timestamps: true });

export default mongoose.model('Translation', TranslationSchema);
