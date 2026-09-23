import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Force the WhatsApp provider into dry-run mode BEFORE it is imported, so tests
// capture outbound messages instead of calling UltraMsg over the network.
process.env.ULTRAMSG_INSTANCE_ID = '';
process.env.ULTRAMSG_TOKEN = '';

// And the same for email, for the same reason plus a worse one: with real
// SMTP settings in .env every test that issues a verification code opened a
// live connection to the mail provider. That is seconds of waiting per test,
// mail sent to made-up addresses, and — once the timeouts start overlapping
// with the next test's reset — failures that look like logic bugs and are not.
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.RESEND_API_KEY = '';

// No AI either. A test that reaches the model is slow, costs money, and gives
// a different answer each run; the tests that do want it stub the endpoint.
process.env.GROQ_API_KEY = '';

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

    /**
     * One database per test process, not one shared by all of them.
     *
     * `node --test` runs each file in its own process, in parallel. Pointing
     * them all at the same remote database meant every file's `clearDb()`
     * emptied the collections the others were mid-way through using — so a
     * suite that passes file by file fails when run together, with failures
     * that move around between runs and look like flaky logic rather than
     * what they are.
     */
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const uri = base.replace(/\/([^/?]*)(\?|$)/, `/mynanny_autotest_${suffix}$2`);
    await mongoose.connect(uri);
    console.log(`[test] using remote test database mynanny_autotest_${suffix}`);
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

  // Runtime settings live in the database, so wiping the collections drops
  // them — but the settings service caches, and a test that switched a mode on
  // would otherwise leave it on for every test that ran after it.
  await setEmailVerification(true);
  await setConversationMode('structured');
}

/** Which way the bot reads replies. Tests that want AI mode ask for it. */
export async function setConversationMode(mode) {
  const { setSetting } = await import('../src/services/settings.js');
  await setSetting('conversationMode', { mode });
}

/**
 * Whether registration asks for an email and a code.
 *
 * Tests turn it on, because most of them drive the full registration and the
 * email steps are part of what they cover. Production defaults to off — a mail
 * provider that stops delivering would otherwise block every signup — so a
 * test that wants the short path switches it back.
 */
export async function setEmailVerification(enabled) {
  // Through the service rather than the model, so the cache is dropped the
  // same way a dashboard change would drop it.
  const { setSetting } = await import('../src/services/settings.js');
  await setSetting('emailVerification', { enabled });
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

/**
 * Wake the bot and get past the language picker in one step.
 *
 * A new contact is asked their language before anything else, so almost every
 * test would otherwise open with the same two lines of picking English. This
 * keeps that detail in one place: when the picker changes, the tests do not.
 *
 * Returns the bot's reply to the language choice — that is, the first real
 * screen of the conversation.
 */
export async function startChat(phone, { locale = '1' } = {}) {
  await say(phone, 'nanny');
  return say(phone, locale);
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
