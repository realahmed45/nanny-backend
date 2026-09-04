import { on } from './engine.js';
import { User, Booking, Ticket, nextSequence } from '../models/index.js';
import { Payment } from '../models/Payment.js';
import { PAYMENT_STATUS, TICKET_CATEGORY } from '../utils/constants.js';
import {
  parseChoice, parseYesNo, parseEmail, parseMapUrl, parseInteger, parseChildAge, clean, isNone, lower,
} from '../utils/parse.js';
import { PROFILE_MENU, PAYMENTS_MENU, SUPPORT_MENU_TEXT } from './familyMenu.js';
import { uniqueLabel } from './familyFindNanny.js';
import { listTickets } from './nannyProfileAvailability.js';
import { money, prettyDate, nannyDisplayName } from '../utils/format.js';
import * as M from '../utils/messages.js';

const backToMenu = (text, menu, state) => [{ text }, { text: menu, state }];

/* ------------------------------------------------------------------ *
 * My Profile
 * ------------------------------------------------------------------ */

const profileMenuHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return PROFILE_MENU;

  const user = await User.findById(ctx.session.user);

  switch (choice) {
    case 1:
      return backToMenu(renderFamilyProfile(user), PROFILE_MENU, 'FP_MENU');
    case 2:
      return showAddresses(ctx, user);
    case 3:
      return showChildren(ctx, user);
    case 4:
      return showFavourites(ctx, user);
    case 5:
      return showFamilyDocuments(ctx, user);
    case 6:
      return showEmergencyContacts(ctx, user);
    default:
      return PROFILE_MENU;
  }
};
profileMenuHandler.prompt = () => PROFILE_MENU;
on('FP_MENU', profileMenuHandler);

/* ---- Favourite nannies ---------------------------------------------- */

/**
 * Nannies the family saved after a booking. Listing them here is what makes
 * "add to favourites" worth offering at the end of a rating.
 */
async function showFavourites(ctx, user) {
  const ids = user.favouriteNannies || [];
  if (!ids.length) {
    return backToMenu(
      `\u{2B50} *Favourite Nannies*\n\nYou have not saved any nannies yet.\n\nAfter a booking you can add a nanny to this list, and book her again in one step.`,
      PROFILE_MENU, 'FP_MENU',
    );
  }

  const nannies = await User.find({ _id: { $in: ids } })
    .select('fullName nickname hourlyRate experienceYears ratingAverage ratingCount nannyStatus');

  const rows = nannies.map((n, i) => {
    const stars = n.ratingCount ? `\u{2B50} ${n.ratingAverage.toFixed(1)}` : 'No ratings yet';
    return `*${i + 1}. \u{1F469} ${nannyDisplayName(n)}*\n   ${stars} | ${money(n.hourlyRate)}/hr | ${n.experienceYears || 0} yrs exp.`;
  }).join('\n\n');

  return {
    text: `\u{2B50} *Favourite Nannies*\n\nYou have *${nannies.length}* saved.\n\n${rows}\n\nReply with a number to view a profile, or type *Back*.`,
    state: 'FP_FAVOURITES',
    listing: { kind: 'favourites', ids: nannies.map((n) => String(n._id)), page: 0, pageSize: 20 },
  };
}

const favouritesHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') return { text: PROFILE_MENU, state: 'FP_MENU' };

  const ids = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, ids.length);
  if (!n) return M.INVALID_CHOICE;

  const nanny = await User.findById(ids[n - 1]);
  if (!nanny) return M.INVALID_CHOICE;

  ctx.set('selectedNannyId', String(nanny._id));
  return {
    text: `${M.nannyProfile(nanny)}\n\n1. Book this nanny\n2. Remove from favourites\n\nType *Back* to go back.`,
    state: 'FP_FAVOURITE_ACTIONS',
  };
};
favouritesHandler.prompt = () => PROFILE_MENU;
on('FP_FAVOURITES', favouritesHandler);

const favouriteActionsHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') {
    const user = await User.findById(ctx.session.user);
    return showFavourites(ctx, user);
  }

  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;

  const nannyId = ctx.get('selectedNannyId');

  if (choice === 2) {
    await User.updateOne(
      { _id: ctx.session.user },
      { $pull: { favouriteNannies: nannyId } },
    );
    const user = await User.findById(ctx.session.user);
    return [
      { text: '\u{2705} Removed from your favourites.' },
      await showFavourites(ctx, user),
    ];
  }

  // Booking needs a date, time and requirements, so start the normal
  // find-a-nanny flow. She is remembered as the preferred pick and will
  // be shown first in the results if she matches.
  const { startFindNanny } = await import('./familyFindNanny.js');
  ctx.set('preferredNannyId', nannyId);
  return startFindNanny(ctx);
};
favouriteActionsHandler.prompt = () => PROFILE_MENU;
on('FP_FAVOURITE_ACTIONS', favouriteActionsHandler);

/* ---- Emergency contacts --------------------------------------------- */

async function showEmergencyContacts(ctx, user) {
  const contacts = user.emergencyContacts || [];
  const list = contacts.length
    ? contacts.map((c, i) => `${i + 1}. ${c.name}${c.relation ? ` (${c.relation})` : ''}: ${c.phone}`).join('\n')
    : '_None saved yet._';

  return {
    text: `\u{1F198} *Emergency Contacts*\n\n${list}\n\n1. Add a contact${contacts.length ? '\n2. Remove a contact' : ''}\n\nType *Back* to go back.`,
    state: 'FP_EMERGENCY',
  };
}

const emergencyHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') return { text: PROFILE_MENU, state: 'FP_MENU' };

  const user = await User.findById(ctx.session.user);
  const contacts = user.emergencyContacts || [];
  const choice = parseChoice(ctx.text, contacts.length ? 2 : 1);
  if (!choice) return M.INVALID_CHOICE;

  if (choice === 1) {
    return {
      text: 'Please send the contact as:\n\n*Name, Relation, Phone*\n\ne.g. _Lara Craft, Mother, +92 300 1234567_',
      state: 'FP_EMERGENCY_ADD',
    };
  }

  return {
    text: `Which contact should we remove?\n\n${contacts.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`,
    state: 'FP_EMERGENCY_REMOVE',
  };
};
emergencyHandler.prompt = () => PROFILE_MENU;
on('FP_EMERGENCY', emergencyHandler);

const emergencyAddHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') {
    const user = await User.findById(ctx.session.user);
    return showEmergencyContacts(ctx, user);
  }

  const parts = clean(ctx.text).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    return 'Please send it as *Name, Relation, Phone* \u{2014} for example _Lara Craft, Mother, +92 300 1234567_.';
  }

  // Relation is optional: "Name, Phone" is accepted too.
  const [name, second, third] = parts;
  const relation = third ? second : '';
  const phone = third || second;

  const user = await User.findById(ctx.session.user);
  user.emergencyContacts = [...(user.emergencyContacts || []), { name, relation, phone }];
  await user.save();

  return [
    { text: `\u{2705} ${name} has been added to your emergency contacts.` },
    await showEmergencyContacts(ctx, user),
  ];
};
emergencyAddHandler.prompt = () => 'Please send the contact as *Name, Relation, Phone*.';
on('FP_EMERGENCY_ADD', emergencyAddHandler);

const emergencyRemoveHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') {
    const user = await User.findById(ctx.session.user);
    return showEmergencyContacts(ctx, user);
  }

  const user = await User.findById(ctx.session.user);
  const contacts = user.emergencyContacts || [];
  const n = parseChoice(ctx.text, contacts.length);
  if (!n) return M.INVALID_CHOICE;

  const [removed] = contacts.splice(n - 1, 1);
  user.emergencyContacts = contacts;
  await user.save();

  return [
    { text: `\u{2705} ${removed.name} has been removed.` },
    await showEmergencyContacts(ctx, user),
  ];
};
emergencyRemoveHandler.prompt = () => PROFILE_MENU;
on('FP_EMERGENCY_REMOVE', emergencyRemoveHandler);

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
  await issueOtp(ctx.phone, email);   // failure is reported to the user below
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
  const age = parseChildAge(ctx.text);
  if (!age) return M.INVALID_CHILD_AGE;
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
  const has = (type) => docs.some((d) => d.type === type);

  // Show what has been provided and where it stands, so nobody has to guess
  // why a booking is waiting on verification.
  const status = user.idVerified
    ? '\u{2705} *Verified*'
    : docs.length >= 2
      ? '\u{23F3} *Pending review* \u{2014} our team is checking your ID.'
      : '\u{26A0}\u{FE0F} *Not verified* \u{2014} please upload both sides of your ID.';

  const lines = [
    `ID card (front): ${has('id_front') ? '\u{2705} Uploaded' : '\u{2014} Not uploaded'}`,
    `ID card (back): ${has('id_back') ? '\u{2705} Uploaded' : '\u{2014} Not uploaded'}`,
  ];

  return {
    text: `\u{1F194} *Identity Verification*

Status: ${status}

${lines.join('\n')}

Your ID is a one-time check that keeps families and nannies safe.

1. Upload ID (front)
2. Upload ID (back)

Type *Back* to go back.`,
    state: 'FP_DOCS_MENU',
  };
}


const docsMenuHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.INVALID_CHOICE;
  ctx.set('uploadDocType', choice === 1 ? 'id_front' : 'id_back');
  return { text: `📎 Please attach the new image.`, state: 'FP_DOC_UPLOAD' };
};
docsMenuHandler.prompt = () => PROFILE_MENU;
on('FP_DOCS_MENU', docsMenuHandler);

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

/**
 * How many payments are shown at once.
 *
 * The recent ones are what people are checking on; older entries are a
 * *NEXT* away rather than a wall of text on a phone screen.
 */
const PAYMENT_PAGE_SIZE = 4;

const PAYMENT_STATUSES = [
  PAYMENT_STATUS.COMPLETED, PAYMENT_STATUS.IN_PROCESS,
  PAYMENT_STATUS.REFUND_IN_PROCESS, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.FAILED,
];

/** Render one page of a payment category, newest first. */
async function renderPaymentPage(familyId, status, page = 0) {
  const query = { family: familyId, status };
  const total = await Payment.countDocuments(query);
  if (!total) return null;

  const skip = page * PAYMENT_PAGE_SIZE;
  const payments = await Payment.find(query)
    .populate('booking', 'bookingNumber startDate')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(PAYMENT_PAGE_SIZE);

  // The total covers the whole category, not just this page, which is what
  // someone checking "how much have I paid" actually wants to know.
  const all = await Payment.find(query).select('amount');
  const sum = all.reduce((s, p) => s + (p.amount || 0), 0);

  const rows = payments.map((p, i) => {
    const kind = { booking: 'Booking payment', additional: 'Additional payment', refund: 'Refund', penalty: 'Penalty' }[p.kind] || p.kind;
    return `${skip + i + 1}. ${kind} — *${money(p.amount)}*\n   Booking #${p.booking?.bookingNumber || '—'}\n   ${prettyDate(p.createdAt)}${p.reference ? `\n   Ref: ${p.reference}` : ''}`;
  });

  const shown = skip + payments.length;
  const more = shown < total
    ? `\n\n_Showing ${skip + 1}-${shown} of ${total}._\nType *NEXT* for older payments.`
    : '';

  return {
    text: `💳 *${status.replace(/_/g, ' ').toUpperCase()}*\n\n${rows.join('\n\n')}${more}\n\n*Total: ${money(sum)}*`,
    hasMore: shown < total,
    total,
  };
}

on('FPAY_MENU', async (ctx) => {
  // NEXT continues the category already open, rather than picking a new one.
  if (ctx.command === 'NEXT') {
    const status = ctx.get('paymentStatus');
    if (!status) return PAYMENTS_MENU;
    const page = (ctx.get('paymentPage') || 0) + 1;
    const next = await renderPaymentPage(ctx.session.user, status, page);
    if (!next) {
      return backToMenu("That's the end of the list.", PAYMENTS_MENU, 'FPAY_MENU');
    }
    ctx.set('paymentPage', page);
    return backToMenu(next.text, PAYMENTS_MENU, 'FPAY_MENU');
  }

  const choice = parseChoice(ctx.text, 5);
  if (!choice) return PAYMENTS_MENU;

  const status = PAYMENT_STATUSES[choice - 1];
  const first = await renderPaymentPage(ctx.session.user, status, 0);

  if (!first) {
    return backToMenu('You have no payments in this category.', PAYMENTS_MENU, 'FPAY_MENU');
  }

  ctx.set('paymentStatus', status);
  ctx.set('paymentPage', 0);
  return backToMenu(first.text, PAYMENTS_MENU, 'FPAY_MENU');
});

/* ------------------------------------------------------------------ *
 * Help / Support
 * ------------------------------------------------------------------ */

on('SUPPORT_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 7);
  if (!choice) return SUPPORT_MENU_TEXT;

  if (choice === 4) return { text: TECHNICAL_MENU, state: 'SUPPORT_TECHNICAL' };
  if (choice === 5) {
    ctx.set('ticketCategory', TICKET_CATEGORY.AGENT);
    return {
      text: '\u{1F464} *Talk to an Agent*\n\nPlease briefly describe what you need help with.',
      state: 'SUPPORT_DESCRIBE',
    };
  }
  if (choice === 6) return { text: FAQ_TOPICS, state: 'SUPPORT_FAQ_TOPIC' };
  if (choice === 7) {
    const result = await listTickets(ctx, 'family');
    return Array.isArray(result) ? result : [result, { text: SUPPORT_MENU_TEXT, state: 'SUPPORT_MENU' }];
  }

  const categories = [
    TICKET_CATEGORY.BOOKING, TICKET_CATEGORY.PAYMENT, TICKET_CATEGORY.NANNY,
  ];
  ctx.set('ticketCategory', categories[choice - 1]);

  // Offer to attach the ticket to a booking when one is relevant.
  const bookings = await Booking.find({ family: ctx.session.user })
    .sort({ createdAt: -1 }).limit(5).select('bookingNumber startDate status');

  if (bookings.length) {
    return {
      text: `Which booking is this about?\n\n${bookings.map((b, i) => `${i + 1}. Booking #${b.bookingNumber} \u{2014} ${prettyDate(b.startDate)} (${b.status})`).join('\n')}\n${bookings.length + 1}. Not about a specific booking`,
      state: 'SUPPORT_PICK_BOOKING',
      listing: { kind: 'support_bookings', ids: bookings.map((b) => String(b._id)), page: 0, pageSize: 10 },
    };
  }
  return { text: '\u{1F198} Please describe your issue in detail.', state: 'SUPPORT_DESCRIBE' };
});

/* ---- Technical problem ---------------------------------------------- */

export const TECHNICAL_MENU = `\u{2699}\u{FE0F} *Technical Problem*

What problem are you experiencing?

1. Bot is not responding
2. Cannot upload a document
3. Cannot upload a photo
4. Location is not working
5. Payment screenshot will not send
6. Other technical problem

Type *0* Return to Main Menu`;

const TECHNICAL_LABELS = [
  'Bot is not responding',
  'Cannot upload a document',
  'Cannot upload a photo',
  'Location is not working',
  'Payment screenshot will not send',
  'Other technical problem',
];

const technicalHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return TECHNICAL_MENU;

  ctx.set('ticketCategory', TICKET_CATEGORY.TECHNICAL);
  ctx.set('ticketSubject', TECHNICAL_LABELS[choice - 1]);
  return { text: 'Please describe the problem.', state: 'SUPPORT_DESCRIBE' };
};
technicalHandler.prompt = () => TECHNICAL_MENU;
on('SUPPORT_TECHNICAL', technicalHandler);

/* ---- FAQs ------------------------------------------------------------ */

export const FAQ_TOPICS = `\u{2753} *Frequently Asked Questions*

What would you like to know about?

1. Payments
2. Bookings
3. Profile & Verification

Type *Back* to go back to Help & Support.`;

/**
 * Answers describe how this platform actually works: payments are manual bank
 * transfers checked by a person, so the copy says that rather than describing
 * a card gateway that does not exist.
 */
const FAQ = {
  1: {
    title: '\u{1F4B0} *Payment FAQ*',
    questions: [
      ['Why is my payment still pending?',
        'Payments are verified by our team against the bank before a booking is confirmed. This usually happens within a few hours, and you get a message as soon as it is checked.'],
      ['What if my payment could not be verified?',
        'We message you with the reason, usually the amount not matching or an unreadable screenshot. Send a new screenshot and we will check it again.'],
      ['What should I do if I was charged the wrong amount?',
        'Raise a Payment & Refunds ticket from the Help menu with your booking number. We will check the transfer and refund any difference.'],
      ['What happens after I make a payment?',
        'Your transfer is verified by our team, then the booking request goes to the nanny. She has 1 hour to accept. If she accepts, your booking is confirmed; if she declines, we help you choose another nanny.'],
      ['What happens if my booking is not confirmed?',
        'If no nanny can be confirmed you receive a *100% refund*. We transfer it back to you and send the receipt.'],
    ],
  },
  2: {
    title: '\u{1F4C5} *Booking FAQ*',
    questions: [
      ['How do I book a nanny?',
        'From the Main Menu choose *Find a Nanny*, tell us the date, time and what you need, then pick from the matching nannies.'],
      ['Can I change a booking after it is confirmed?',
        'Yes. Open *My Bookings*, choose the booking and select *Reschedule*. Your first 3 reschedules are free; after that a 5% penalty applies.'],
      ['What if I need to cancel?',
        'Open *My Bookings* and choose *Cancel Booking*. The refund depends on how close the cancellation is to the service date, and the exact amount is always shown before you confirm.'],
      ['What if the nanny cancels?',
        'You are never left without help: we immediately offer replacement nannies, and you are refunded in full if no replacement can be confirmed.'],
      ['What are the arrival and end-of-service codes?',
        'You give the nanny a code when she arrives, and another when the service ends. This confirms the times and protects both sides.'],
    ],
  },
  3: {
    title: '\u{1F464} *Profile & Verification FAQ*',
    questions: [
      ['Why do I need to verify my email?',
        'It keeps your account secure and lets us send booking confirmations and receipts.'],
      ['Why do you ask for my ID?',
        'ID is a one-time check that keeps families and nannies safe. It is stored securely and only reviewed by our team.'],
      ['Are your nannies verified?',
        'Yes. Every nanny is ID-checked and background-checked before she appears in search, and CPR certificates are verified where claimed.'],
      ['How do I update my details?',
        'From the Main Menu choose *My Profile*, then *Personal Information*.'],
      ['Is my phone number shared with the nanny?',
        'No. Messages are relayed through this chat, so neither side sees the other number.'],
    ],
  },
};

const faqList = (topic) =>
  `${topic.title}\n\n${topic.questions.map(([q], i) => `${i + 1}. ${q}`).join('\n')}\n\nSelect a question, or type *Back*.`;

const faqTopicHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') return { text: SUPPORT_MENU_TEXT, state: 'SUPPORT_MENU' };
  if (clean(ctx.text) === '0') {
    return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', clearStack: true };
  }

  const choice = parseChoice(ctx.text, 3);
  if (!choice) return FAQ_TOPICS;

  ctx.set('faqTopic', choice);
  return { text: faqList(FAQ[choice]), state: 'SUPPORT_FAQ_ANSWER' };
};
faqTopicHandler.prompt = () => FAQ_TOPICS;
faqTopicHandler.allowCommands = true;
on('SUPPORT_FAQ_TOPIC', faqTopicHandler);

const faqAnswerHandler = async (ctx) => {
  if (lower(ctx.text) === 'back') return { text: FAQ_TOPICS, state: 'SUPPORT_FAQ_TOPIC' };
  if (clean(ctx.text) === '0') {
    return { text: M.FAMILY_MAIN_MENU, state: 'FAMILY_MAIN_MENU', clearStack: true };
  }

  const topic = FAQ[ctx.get('faqTopic')] || FAQ[1];
  const choice = parseChoice(ctx.text, topic.questions.length);
  if (!choice) return faqList(topic);

  const [question, answer] = topic.questions[choice - 1];
  return [
    { text: `*${question}*\n\n${answer}` },
    { text: FAQ_TOPICS, state: 'SUPPORT_FAQ_TOPIC' },
  ];
};
faqAnswerHandler.prompt = (ctx) => faqList(FAQ[ctx.get('faqTopic')] || FAQ[1]);
faqAnswerHandler.allowCommands = true;
on('SUPPORT_FAQ_ANSWER', faqAnswerHandler);

on('SUPPORT_PICK_BOOKING', async (ctx) => {
  const ids = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, ids.length + 1);
  if (!n) return M.INVALID_CHOICE;
  ctx.set('ticketBookingId', n <= ids.length ? ids[n - 1] : null);
  return { text: '🆘 Please describe your issue in detail.', state: 'SUPPORT_DESCRIBE' };
});

on('SUPPORT_DESCRIBE', async (ctx) => {
  const description = clean(ctx.text);
  if (description.length < 5) return '\u{1F198} Please describe your issue in detail.';

  const bookingId = ctx.get('ticketBookingId');
  const booking = bookingId ? await Booking.findById(bookingId) : null;
  const category = ctx.get('ticketCategory', TICKET_CATEGORY.OTHER);
  const ticketNumber = `T-${await nextSequence('ticket', 1000)}`;

  // Technical tickets carry the specific problem the family picked; agent
  // callbacks are labelled so support sees at a glance that someone is waiting.
  const subject = ctx.get('ticketSubject')
    || (category === TICKET_CATEGORY.AGENT ? 'Agent callback requested' : null)
    || (booking ? `Issue with Booking #${booking.bookingNumber}` : 'Support request');

  await Ticket.create({
    ticketNumber,
    raisedBy: ctx.session.user,
    raisedByRole: 'family',
    booking: booking?._id,
    category,
    subject,
    description,
    // A person is waiting on the phone for these, so they jump the queue.
    priority: category === TICKET_CATEGORY.AGENT ? 'high' : 'medium',
  });

  ctx.set('ticketSubject', null);

  const closing = category === TICKET_CATEGORY.AGENT
    ? 'All our agents are currently busy. An agent will contact you shortly.'
    : 'Our team will review this and contact you shortly.';

  return [
    {
      text: `\u{2705} Your support request has been submitted.

*Support Ticket:* ${ticketNumber}

${closing}`,
    },
    { text: SUPPORT_MENU_TEXT, state: 'SUPPORT_MENU' },
  ];
});

export default {};
