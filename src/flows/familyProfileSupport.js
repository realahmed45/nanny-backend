import { on } from './engine.js';
import { User, Booking, Ticket, nextSequence } from '../models/index.js';
import { Payment } from '../models/Payment.js';
import { PAYMENT_STATUS, TICKET_CATEGORY } from '../utils/constants.js';
import {
  parseChoice, parseYesNo, parseEmail, parseMapUrl, parseInteger, clean, isNone,
} from '../utils/parse.js';
import { PROFILE_MENU, PAYMENTS_MENU, SUPPORT_MENU_TEXT } from './familyMenu.js';
import { uniqueLabel } from './familyFindNanny.js';
import { listTickets } from './nannyProfileAvailability.js';
import { money, prettyDate } from '../utils/format.js';
import * as M from '../utils/messages.js';

const backToMenu = (text, menu, state) => [{ text }, { text: menu, state }];

/* ------------------------------------------------------------------ *
 * My Profile
 * ------------------------------------------------------------------ */

on('FP_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return PROFILE_MENU;

  const user = await User.findById(ctx.session.user);

  switch (choice) {
    case 1:
      return backToMenu(renderFamilyProfile(user), PROFILE_MENU, 'FP_MENU');
    case 2:
      return {
        text: `What would you like to change?\n\n1. Full Name\n2. Email\n\nType *Back* to go back.`,
        state: 'FP_EDIT_DETAILS',
      };
    case 3:
      return showAddresses(ctx, user);
    case 4:
      return showChildren(ctx, user);
    case 5:
      return showFamilyDocuments(ctx, user);
    case 6:
      return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU' };
    default:
      return PROFILE_MENU;
  }
});

function renderFamilyProfile(user) {
  const lines = [
    '👤 *My Profile*', '',
    `Name: ${user.fullName || '—'}`,
    `Email: ${user.email || '—'} ${user.emailVerified ? '✅' : '⏳'}`,
    `Phone: ${user.phone}`,
    `ID verified: ${user.idVerified ? '✅ Yes' : '⏳ Not yet'}`,
    '',
    `📍 Saved addresses: ${(user.addresses || []).length}`,
    `👶 Children on file: ${(user.children || []).length}`,
  ];
  if (user.children?.length) {
    lines.push('');
    user.children.forEach((c, i) => {
      lines.push(`${i % 2 === 0 ? '👧' : '👦'} ${c.name} — ${c.age}`);
      if (c.medicalNotes) lines.push(` • ${c.medicalNotes}`);
      if (c.dietaryNotes) lines.push(` • ${c.dietaryNotes}`);
    });
  }
  if (user.familyInstructions) lines.push('', `*Instructions:* ${user.familyInstructions}`);
  if (user.referralCode) lines.push('', `🎁 Referral code: *${user.referralCode}*`);
  return lines.join('\n');
}

on('FP_EDIT_DETAILS', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;
  if (choice === 1) return { text: 'What is your full name?', state: 'FP_SET_NAME' };
  return { text: 'What is your new email address?', state: 'FP_SET_EMAIL' };
});

on('FP_SET_NAME', async (ctx) => {
  const name = clean(ctx.text);
  if (name.length < 2) return 'Please enter your full name.';
  const user = await User.findById(ctx.session.user);
  user.fullName = name;
  await user.save();
  return backToMenu(`✅ Your name has been updated to *${name}*.`, PROFILE_MENU, 'FP_MENU');
});

on('FP_SET_EMAIL', async (ctx) => {
  const email = parseEmail(ctx.text);
  if (!email) return '❌ That doesn\'t look like a valid email address.';

  const taken = await User.findOne({ email, _id: { $ne: ctx.session.user } });
  if (taken) return '❌ That email is already registered to another account.';

  // Changing the email requires re-verification.
  const { issueOtp } = await import('./common.js');
  ctx.set('pendingEmail', email);
  await issueOtp(ctx.phone, email);
  return { text: `📲 We've sent a verification code to ${email}.\n\nEnter the 6-digit code.`, state: 'FP_VERIFY_EMAIL' };
});

on('FP_VERIFY_EMAIL', async (ctx) => {
  const { Otp } = await import('../models/index.js');
  const { parseOtp } = await import('../utils/parse.js');
  const code = parseOtp(ctx.text);
  if (!code) return M.OTP_INVALID;

  const record = await Otp.findOne({ phone: ctx.phone, consumed: false }).sort({ createdAt: -1 });
  if (!record || new Date(record.expiresAt) < new Date()) return M.OTP_EXPIRED;
  if (record.code !== code) return M.OTP_INVALID;

  record.consumed = true;
  await record.save();

  const user = await User.findById(ctx.session.user);
  user.email = ctx.get('pendingEmail');
  user.emailVerified = true;
  await user.save();

  return backToMenu(`✅ Your email has been updated and verified.`, PROFILE_MENU, 'FP_MENU');
});

/* ---- Addresses ---- */

async function showAddresses(ctx, user) {
  const addresses = user.addresses || [];
  const rows = addresses.map((a, i) => `${i + 1}. *${a.label || 'Address'}*\n   ${a.addressLine || ''}${a.mapUrl ? `\n   📍 ${a.mapUrl}` : ''}`);
  return {
    text: `📍 *My Addresses*\n\n${rows.join('\n\n') || 'No saved addresses.'}\n\nWhat would you like to do?\n\n1. Add a new address\n${addresses.length ? '2. Remove an address\n' : ''}\nType *Back* to go back.`,
    state: 'FP_ADDRESSES_MENU',
    listing: { kind: 'addresses', ids: addresses.map((a) => String(a._id)), page: 0, pageSize: 50 },
  };
}

on('FP_ADDRESSES_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (choice === 1) return { text: M.ASK_LOCATION, state: 'FP_ADDRESS_MAP' };
  if (choice === 2) {
    const ids = ctx.session.listing?.ids || [];
    if (!ids.length) return 'You have no addresses to remove.';
    const user = await User.findById(ctx.session.user);
    return {
      text: `Which address should I remove?\n\n${user.addresses.map((a, i) => `${i + 1}. ${a.label}`).join('\n')}`,
      state: 'FP_ADDRESS_REMOVE',
    };
  }
  return M.INVALID_CHOICE;
});

on('FP_ADDRESS_MAP', async (ctx) => {
  const parsed = parseMapUrl(ctx.text);
  if (!parsed) return '❌ Please share a Google Maps link, or type *None*.';
  ctx.set('newMapUrl', parsed.url);
  return { text: M.ASK_ADDRESS, state: 'FP_ADDRESS_LINE' };
});

on('FP_ADDRESS_LINE', async (ctx) => {
  const line = clean(ctx.text);
  if (line.length < 3) return M.ASK_ADDRESS;
  ctx.set('newAddressLine', line);
  return { text: M.ASK_ADDRESS_LABEL, state: 'FP_ADDRESS_LABEL' };
});

on('FP_ADDRESS_LABEL', async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_ADDRESS_LABEL;

  const user = await User.findById(ctx.session.user);
  const label = uniqueLabel(raw, (user.addresses || []).map((a) => a.label));
  user.addresses.push({
    label,
    mapUrl: ctx.get('newMapUrl'),
    addressLine: ctx.get('newAddressLine'),
    isDefault: user.addresses.length === 0,
  });
  await user.save();

  return backToMenu(`✅ *${label}* has been saved.`, PROFILE_MENU, 'FP_MENU');
});

on('FP_ADDRESS_REMOVE', async (ctx) => {
  const user = await User.findById(ctx.session.user);
  const n = parseChoice(ctx.text, user.addresses.length);
  if (!n) return M.INVALID_CHOICE;
  const removed = user.addresses[n - 1];
  user.addresses.splice(n - 1, 1);
  await user.save();
  return backToMenu(`✅ *${removed.label}* has been removed.`, PROFILE_MENU, 'FP_MENU');
});

/* ---- Children ---- */

async function showChildren(ctx, user) {
  const children = user.children || [];
  const rows = children.map((c, i) =>
    `${i + 1}. ${c.name} — ${c.age}\n   ${c.medicalNotes || 'No allergies'}\n   ${c.dietaryNotes || 'No dietary restrictions'}`
  );
  return {
    text: `👶 *My Children*\n\n${rows.join('\n\n') || 'No children on file.'}\n\nWhat would you like to do?\n\n1. Add a child\n${children.length ? '2. Update a child\n3. Remove a child\n' : ''}\nType *Back* to go back.`,
    state: 'FP_CHILDREN_MENU',
  };
}

on('FP_CHILDREN_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 3);
  if (!choice) return M.INVALID_CHOICE;

  const user = await User.findById(ctx.session.user);

  if (choice === 1) {
    ctx.set('editChildIndex', null);
    return { text: 'What is the child\'s name?', state: 'FP_CHILD_NAME' };
  }
  if (!user.children?.length) return 'You have no children on file yet.';

  const list = user.children.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
  if (choice === 2) return { text: `Which child would you like to update?\n\n${list}`, state: 'FP_CHILD_PICK_UPDATE' };
  return { text: `Which child should I remove?\n\n${list}`, state: 'FP_CHILD_REMOVE' };
});

on('FP_CHILD_PICK_UPDATE', async (ctx) => {
  const user = await User.findById(ctx.session.user);
  const n = parseChoice(ctx.text, user.children.length);
  if (!n) return M.INVALID_CHOICE;
  ctx.set('editChildIndex', n - 1);
  return { text: `What is the child's name? (currently *${user.children[n - 1].name}*)`, state: 'FP_CHILD_NAME' };
});

on('FP_CHILD_NAME', async (ctx) => {
  const name = clean(ctx.text);
  if (name.length < 1) return 'Please enter the child\'s name.';
  ctx.set('childDraft', { name });
  return { text: M.ASK_CHILD_AGE(name), state: 'FP_CHILD_AGE' };
});

on('FP_CHILD_AGE', async (ctx) => {
  const age = clean(ctx.text);
  if (!age) return M.ASK_CHILD_AGE(ctx.get('childDraft')?.name || 'the child');
  ctx.set('childDraft', { ...ctx.get('childDraft'), age });
  return { text: M.ASK_CHILD_MEDICAL(ctx.get('childDraft').name), state: 'FP_CHILD_MEDICAL' };
});

on('FP_CHILD_MEDICAL', async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_CHILD_MEDICAL(ctx.get('childDraft')?.name || 'the child');
  ctx.set('childDraft', { ...ctx.get('childDraft'), medicalNotes: isNone(raw) ? '' : raw });
  return { text: M.ASK_CHILD_DIET(ctx.get('childDraft').name), state: 'FP_CHILD_DIET' };
});

on('FP_CHILD_DIET', async (ctx) => {
  const raw = clean(ctx.text);
  if (!raw) return M.ASK_CHILD_DIET(ctx.get('childDraft')?.name || 'the child');

  const child = { ...ctx.get('childDraft'), dietaryNotes: isNone(raw) ? '' : raw };
  const user = await User.findById(ctx.session.user);
  const idx = ctx.get('editChildIndex');

  if (idx !== null && idx !== undefined && user.children[idx]) {
    user.children[idx] = child;
  } else {
    user.children.push(child);
  }
  await user.save();

  return backToMenu(`✅ ${child.name}'s details have been saved.`, PROFILE_MENU, 'FP_MENU');
});

on('FP_CHILD_REMOVE', async (ctx) => {
  const user = await User.findById(ctx.session.user);
  const n = parseChoice(ctx.text, user.children.length);
  if (!n) return M.INVALID_CHOICE;
  const removed = user.children[n - 1];
  user.children.splice(n - 1, 1);
  await user.save();
  return backToMenu(`✅ ${removed.name} has been removed.`, PROFILE_MENU, 'FP_MENU');
});

async function showFamilyDocuments(ctx, user) {
  const docs = user.idDocuments || [];
  const rows = docs.map((d, i) => `${i + 1}. ${d.type === 'id_front' ? 'ID card (front)' : 'ID card (back)'} — ${user.idVerified ? '✅ Verified' : '⏳ Pending review'}`);
  return {
    text: `📄 *My Documents*\n\n${rows.join('\n') || 'No documents uploaded.'}\n\nWhat would you like to do?\n\n1. Re-upload ID (front)\n2. Re-upload ID (back)\n\nType *Back* to go back.`,
    state: 'FP_DOCS_MENU',
  };
}

on('FP_DOCS_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;
  ctx.set('uploadDocType', choice === 1 ? 'id_front' : 'id_back');
  return { text: `📎 Please attach the new image.`, state: 'FP_DOC_UPLOAD' };
});

on('FP_DOC_UPLOAD', async (ctx) => {
  if (!ctx.mediaUrl) return '📎 Please attach the image.';
  const type = ctx.get('uploadDocType');
  const user = await User.findById(ctx.session.user);
  user.idDocuments = (user.idDocuments || []).filter((d) => d.type !== type);
  user.idDocuments.push({ type, url: ctx.mediaUrl, mediaId: ctx.mediaId });
  user.idVerified = false;   // needs re-review
  await user.save();
  return backToMenu('✅ Your document has been uploaded and sent for review.', PROFILE_MENU, 'FP_MENU');
});

/* ------------------------------------------------------------------ *
 * My Payments
 * ------------------------------------------------------------------ */

on('FPAY_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 5);
  if (!choice) return PAYMENTS_MENU;

  const statuses = [
    PAYMENT_STATUS.COMPLETED, PAYMENT_STATUS.IN_PROCESS,
    PAYMENT_STATUS.REFUND_IN_PROCESS, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.FAILED,
  ];
  const status = statuses[choice - 1];

  const payments = await Payment.find({ family: ctx.session.user, status })
    .populate('booking', 'bookingNumber startDate')
    .sort({ createdAt: -1 })
    .limit(20);

  if (!payments.length) {
    return backToMenu('You have no payments in this category.', PAYMENTS_MENU, 'FPAY_MENU');
  }

  const total = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const rows = payments.map((p, i) => {
    const kind = { booking: 'Booking payment', additional: 'Additional payment', refund: 'Refund', penalty: 'Penalty' }[p.kind] || p.kind;
    return `${i + 1}. ${kind} — *${money(p.amount)}*\n   Booking #${p.booking?.bookingNumber || '—'}\n   ${prettyDate(p.createdAt)}${p.reference ? `\n   Ref: ${p.reference}` : ''}`;
  });

  return backToMenu(
    `💳 *${status.replace(/_/g, ' ').toUpperCase()}*\n\n${rows.join('\n\n')}\n\n*Total: ${money(total)}*`,
    PAYMENTS_MENU, 'FPAY_MENU'
  );
});

/* ------------------------------------------------------------------ *
 * Help / Support
 * ------------------------------------------------------------------ */

on('SUPPORT_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return SUPPORT_MENU_TEXT;

  if (choice === 5) {
    const result = await listTickets(ctx, 'family');
    return Array.isArray(result) ? result : [result, { text: SUPPORT_MENU_TEXT, state: 'SUPPORT_MENU' }];
  }
  if (choice === 6) return backToMenu(M.COMMANDS_HELP, SUPPORT_MENU_TEXT, 'SUPPORT_MENU');

  const categories = [
    TICKET_CATEGORY.BOOKING, TICKET_CATEGORY.PAYMENT,
    TICKET_CATEGORY.NANNY, TICKET_CATEGORY.ACCOUNT,
  ];
  ctx.set('ticketCategory', categories[choice - 1]);

  // Offer to attach the ticket to a booking when one is relevant.
  const bookings = await Booking.find({ family: ctx.session.user })
    .sort({ createdAt: -1 }).limit(5).select('bookingNumber startDate status');

  if (bookings.length && choice !== 4) {
    return {
      text: `Which booking is this about?\n\n${bookings.map((b, i) => `${i + 1}. Booking #${b.bookingNumber} — ${prettyDate(b.startDate)} (${b.status})`).join('\n')}\n${bookings.length + 1}. Not about a specific booking`,
      state: 'SUPPORT_PICK_BOOKING',
      listing: { kind: 'support_bookings', ids: bookings.map((b) => String(b._id)), page: 0, pageSize: 10 },
    };
  }
  return { text: '🆘 Please describe your issue in detail.', state: 'SUPPORT_DESCRIBE' };
});

on('SUPPORT_PICK_BOOKING', async (ctx) => {
  const ids = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, ids.length + 1);
  if (!n) return M.INVALID_CHOICE;
  ctx.set('ticketBookingId', n <= ids.length ? ids[n - 1] : null);
  return { text: '🆘 Please describe your issue in detail.', state: 'SUPPORT_DESCRIBE' };
});

on('SUPPORT_DESCRIBE', async (ctx) => {
  const description = clean(ctx.text);
  if (description.length < 5) return '🆘 Please describe your issue in detail.';

  const bookingId = ctx.get('ticketBookingId');
  const booking = bookingId ? await Booking.findById(bookingId) : null;
  const ticketNumber = `T-${await nextSequence('ticket', 1000)}`;

  await Ticket.create({
    ticketNumber,
    raisedBy: ctx.session.user,
    raisedByRole: 'family',
    booking: booking?._id,
    category: ctx.get('ticketCategory', TICKET_CATEGORY.OTHER),
    subject: booking ? `Issue with Booking #${booking.bookingNumber}` : 'Support request',
    description,
  });

  return {
    text: `✅ Your ticket *${ticketNumber}* has been created.

Our support team will get back to you shortly. You can track it under *Help > View My Tickets*.

Type *0* to return to the Main Menu.`,
    state: 'FAMILY_MAIN_MENU',
  };
});

export default {};
