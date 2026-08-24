import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Force the WhatsApp provider into dry-run mode BEFORE it is imported, so tests
// capture outbound messages instead of calling UltraMsg over the network.
process.env.ULTRAMSG_INSTANCE_ID = '';
process.env.ULTRAMSG_TOKEN = '';

const { outbox } = await import('../src/providers/ultramsg.js');

let mongod;

/**
 * Connect the test suite to a database.
 *
 * Prefers an in-memory MongoDB; if the local mongod cannot start (missing
 * system runtime, no disk space) it falls back to a dedicated *_test database
 * on MONGODB_URI so tests never touch production data.
 */
export async function setupDb() {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri('mynanny_test'));
    return mongoose.connection;
  } catch {
    const base = process.env.MONGODB_URI;
    if (!base) throw new Error('No in-memory MongoDB and no MONGODB_URI set for tests.');
    const uri = base.replace(/\/([^/?]*)(\?|$)/, '/mynanny_autotest$2');
    await mongoose.connect(uri);
    console.log('[test] using remote test database mynanny_autotest');
    return mongoose.connection;
  }
}

export async function teardownDb() {
  // Leave nothing behind in the remote test database.
  if (!mongod && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase().catch(() => {});
  }
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

export async function clearDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  outbox.length = 0;
}

/**
 * Drive the chatbot: send `text` from `phone` and return the bot's replies
 * as a single joined string (so tests can assert on wording).
 */
export async function say(phone, text, extra = {}) {
  const { handleMessage } = await import('../src/flows/index.js');
  const replies = await handleMessage({ phone, text, ...extra });
  return replies.join('\n---\n');
}

/** Read the most recent OTP issued to a phone (email delivery is mocked). */
export async function latestOtp(phone) {
  const { Otp } = await import('../src/models/index.js');
  const record = await Otp.findOne({ phone, consumed: false }).sort({ createdAt: -1 });
  return record?.code;
}

/** Messages the bot sent to a specific number during the test. */
export function messagesTo(phone) {
  return outbox.filter((m) => m.to === phone).map((m) => m.body);
}

export { outbox };
