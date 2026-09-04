import { on, mainMenuFor, mainMenuState } from './engine.js';
import { User, Session, Otp } from '../models/index.js';
import { USER_ROLE, NANNY_STATUS } from '../utils/constants.js';
import { parseChoice, parseEmail, parseOtp, clean, lower } from '../utils/parse.js';
import { sendVerificationCode } from '../providers/email.js';
import { firstName } from '../utils/format.js';
import * as M from '../utils/messages.js';

/** Six-digit email verification code. */
export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Create a verification code and email it.
 *
 * The code is stored before the send, and a delivery failure is reported
 * rather than thrown: a bounced provider call must not abandon someone
 * mid-registration with a generic error. The caller decides what to say.
 */
export async function issueOtp(phone, email) {
  await Otp.deleteMany({ phone, purpose: 'email_verification' });
  const code = generateOtp();
  await Otp.create({
    phone, email, code,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  try {
    await sendVerificationCode(email, code);
    return { code, delivered: true };
  } catch (err) {
    // Loud in the logs, because a misconfigured mail provider silently
    // blocks every signup and is otherwise invisible from the outside.
    console.error(`[otp] could not email ${email}: ${err.message}`);
    return { code, delivered: false, error: err.message };
  }
}

/**
 * The word that wakes the bot up. Matched case-insensitively and ignoring
 * surrounding punctuation, because phones capitalise the first letter of a
 * message automatically and people add greetings around it.
 */
const START_WORD = 'nanny';

const isStartWord = (text) =>
  clean(text)
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')   // drop punctuation, keep word breaks
    .split(/\s+/)
    .filter(Boolean)
    .includes(START_WORD);

/**
 * "Return back": drop straight to the role picker.
 *
 * Unlike the START state this does not require the trigger word, because
 * the family has already typed a command to get here.
 */
export async function restartHandler() {
  return { text: M.ROLE_PICKER, state: 'ROLE_PICK', noPush: true };
}

/**
 * Credit whoever referred this person.
 *
 * A referral link opens WhatsApp with "nanny ABC123" prefilled, so the code
 * arrives on the very first message. Attribution has to happen here: by the
 * time they finish registering the original text is long gone, and without it
 * nobody ever qualifies for the discount the referral promised.
 *
 * Stored on the session so it survives until the account is actually created.
 */
async function captureReferralCode(ctx) {
  const words = clean(ctx.text).toUpperCase().split(/\s+/).filter(Boolean);

  // A favourite-nanny link carries "N<id>", so the chat can open on the nanny
  // who was actually recommended rather than a cold search.
  const recommended = words.find((w) => /^N[A-F\d]{24}$/i.test(w));
  if (recommended) ctx.set('recommendedNannyId', recommended.slice(1).toLowerCase());

  // Anything that is not the trigger word itself could be a code.
  const candidate = words.find((w) => w !== 'NANNY' && /^[A-Z]{2,}\d{2,}$/.test(w));
  if (!candidate) return;

  const { User } = await import('../models/index.js');
  const referrer = await User.findOne({ referralCode: candidate }).select('_id referralCode');
  if (!referrer) return;

  // Nobody refers themselves.
  const existing = await User.findOne({ phone: ctx.phone }).select('_id');
  if (existing && String(existing._id) === String(referrer._id)) return;

  ctx.set('referredByCode', candidate);
  ctx.set('referredById', String(referrer._id));

  // Close the loop on the click, so the funnel can show conversions.
  try {
    const { ReferralClick } = await import('../models/index.js');
    await ReferralClick.findOneAndUpdate(
      { code: candidate, convertedTo: null },
      { convertedAt: new Date() },
      { sort: { createdAt: -1 } },
    );
  } catch {
    // Tracking must never block a signup.
  }
}

/**
 * Apply a captured referral once the account exists.
 *
 * The referrer earns the discount, so their counters move — not the new
 * user's. The window starts at the first referral and is extended by later
 * ones rather than restarted, which is what makes stacking meaningful.
 */
export async function applyReferral(ctx, newUser) {
  if (!newUser) return;

  // The attribution engine owns this when they arrived through a share link:
  // it applies the full rule set — the 30-day window, one-referrer-ever, the
  // click record — where the block below only knows how to add one.
  //
  // Running both would count the same referral twice, so the engine goes
  // first and the older road is skipped whenever it took the claim.
  try {
    const { creditOnInteraction } = await import('../services/referralAttribution.js');
    const result = await creditOnInteraction(newUser, { phone: ctx.phone });
    if (result.changed) {
      ctx.set('referredById', null);
      ctx.set('referredByCode', null);
      return;
    }
  } catch (err) {
    console.error('[referral] engine could not attribute:', err.message);
  }

  const referrerId = ctx.get('referredById');
  if (!referrerId) return;

  const { User } = await import('../models/index.js');

  // Only ever attributed once.
  if (newUser.referredBy) return;

  newUser.referredBy = referrerId;
  await newUser.save();

  const referrer = await User.findById(referrerId);
  if (!referrer) return;

  referrer.referralCount = (referrer.referralCount || 0) + 1;
  if (!referrer.firstReferralAt) referrer.firstReferralAt = new Date();
  referrer.referralDiscountCancelled = false;
  await referrer.save();

  ctx.set('referredById', null);
  ctx.set('referredByCode', null);
}

/** Landing state: greet, route returning users, ask new ones who they are. */
on('START', async (ctx) => {
  // Anything other than the trigger word gets a nudge, not a menu.
  if (!isStartWord(ctx.text)) return M.START_HINT;

  // A referral link prefills the code, so it is here or nowhere.
  await captureReferralCode(ctx).catch(() => {});

  const existing = await User.findOne({ phone: ctx.phone });

  if (existing && existing.registrationComplete) {
    const state = mainMenuState(existing.role);
    return {
      text: `${existing.role === USER_ROLE.NANNY ? M.WELCOME_NANNY : M.WELCOME_FAMILY}\n\n${mainMenuFor(existing.role)}`,
      state,
      role: existing.role,
      user: existing._id,
      noPush: true,
    };
  }

  // Registration was started but not finished — resume where they left off.
  if (existing) {
    const state = existing.role === USER_ROLE.NANNY ? 'NANNY_REG_RESUME' : 'FAMILY_REG_RESUME';
    return {
      text: `👋 Welcome back ${firstName(existing.fullName) || ''}! Let's finish setting up your account.`,
      state,
      role: existing.role,
      user: existing._id,
      noPush: true,
    };
  }

  return { text: M.ROLE_PICKER, state: 'ROLE_PICK', noPush: true };
});

on('ROLE_PICK', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return `${M.INVALID_CHOICE}\n\n${M.ROLE_PICKER}`;

  if (choice === 1) {
    return {
      text: `${M.WELCOME_FAMILY}\n\n${M.FAMILY_MAIN_MENU}`,
      state: 'FAMILY_MAIN_MENU',
      role: USER_ROLE.FAMILY,
      noPush: true,
    };
  }
  return {
    text: `${M.WELCOME_NANNY}\n\n${M.ASK_FULL_NAME}`,
    state: 'NANNY_REG_NAME',
    role: USER_ROLE.NANNY,
    noPush: true,
  };
});

/* ------------------------------------------------------------------ *
 * Shared registration steps (name -> email -> OTP)
 * Family and nanny both use these; `role` in the session decides where
 * the flow continues once the account is verified.
 * ------------------------------------------------------------------ */

export async function startRegistration(ctx, role) {
  ctx.session.role = role;
  return { text: M.ASK_FULL_NAME, state: role === USER_ROLE.NANNY ? 'NANNY_REG_NAME' : 'FAMILY_REG_NAME' };
}

/** Shared handler body for the "what's your name" step. */
export function makeNameHandler(nextState) {
  const handler = async (ctx) => {
    const name = clean(ctx.text);
    if (name.length < 2) return 'Please tell me your full name.';
    ctx.set('fullName', name);
    return { text: M.ASK_EMAIL(name.split(' ')[0]), state: nextState };
  };
  handler.prompt = () => M.ASK_FULL_NAME;
  return handler;
}

/** Shared handler body for the "what's your email" step. */
export function makeEmailHandler(nextState) {
  const handler = async (ctx) => {
    const email = parseEmail(ctx.text);
    if (!email) return '❌ That doesn\'t look like a valid email. Please enter your email address.';

    const taken = await User.findOne({ email, phone: { $ne: ctx.phone } });
    if (taken) {
      return '❌ That email is already registered to another account. Please use a different email address.';
    }

    ctx.set('email', email);
    const { delivered } = await issueOtp(ctx.phone, email);

    // Saying "we sent a code" when the send failed leaves people waiting on
    // an email that will never arrive, so be straight about it.
    if (!delivered) {
      return {
        text: `${M.OTP_SEND_FAILED}\n\n${M.ASK_OTP}`,
        state: nextState,
      };
    }
    return { text: M.ASK_OTP, state: nextState };
  };
  handler.prompt = (ctx) => M.ASK_EMAIL((ctx.get('fullName') || '').split(' ')[0]);
  return handler;
}

/**
 * Shared OTP verification. On success it creates (or completes) the User and
 * hands control to `onVerified(ctx, user)`.
 */
export function makeOtpHandler({ role, onVerified }) {
  const handler = async (ctx) => {
    if (lower(ctx.text) === 'resend') {
      const email = ctx.get('email');
      if (!email) return M.ASK_EMAIL('');
      const { delivered } = await issueOtp(ctx.phone, email);
      if (!delivered) return `${M.OTP_SEND_FAILED}\n\n${M.ASK_OTP}`;
      return `\u{1F4F2} A new code is on its way.\n\n${M.ASK_OTP}`;
    }

    const code = parseOtp(ctx.text);
    if (!code) return M.OTP_INVALID;

    const record = await Otp.findOne({
      phone: ctx.phone, purpose: 'email_verification', consumed: false,
    }).sort({ createdAt: -1 });

    if (!record) return M.OTP_EXPIRED;
    if (new Date(record.expiresAt) < new Date()) return M.OTP_EXPIRED;

    if (record.code !== code) {
      record.attempts += 1;
      await record.save();
      if (record.attempts >= 5) {
        await Otp.deleteMany({ phone: ctx.phone });
        return '❌ Too many incorrect attempts. Type *RESEND* to get a new code.';
      }
      return M.OTP_INVALID;
    }

    record.consumed = true;
    await record.save();

    let user = await User.findOne({ phone: ctx.phone, role });
    if (!user) {
      user = await User.create({
        role,
        phone: ctx.phone,
        fullName: ctx.get('fullName'),
        email: ctx.get('email'),
        emailVerified: true,
        referralCode: makeReferralCode(ctx.get('fullName')),
      });
    } else {
      user.fullName = ctx.get('fullName') || user.fullName;
      user.email = ctx.get('email') || user.email;
      user.emailVerified = true;
      if (!user.referralCode) user.referralCode = makeReferralCode(user.fullName);
      await user.save();
    }

    ctx.session.user = user._id;
    ctx.session.role = role;
    ctx.user = user;

    // The account now exists, so a referral captured on the first message
    // can finally be credited. Never fatal: a signup must not fail over it.
    await applyReferral(ctx, user).catch((err) => {
      console.error('[referral] could not attribute:', err.message);
    });

    return onVerified(ctx, user);
  };
  handler.prompt = () => M.ASK_OTP;
  return handler;
}

export function makeReferralCode(name = '') {
  const base = String(name).replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'NANY';
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${base}${rand}`;
}

/** Help command, available everywhere. */
on('COMMANDS_HELP', async (ctx) => ({
  text: `${M.COMMANDS_HELP}\n\n${mainMenuFor(ctx.session.role)}`,
  state: mainMenuState(ctx.session.role),
}));

export default { generateOtp, issueOtp, makeNameHandler, makeEmailHandler, makeOtpHandler, makeReferralCode };
