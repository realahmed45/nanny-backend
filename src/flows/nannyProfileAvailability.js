import dayjs from 'dayjs';
import { on } from './engine.js';
import { User, Payout, Ticket, nextSequence } from '../models/index.js';
import {
  LANGUAGES, SKILLS, SUBJECTS, WEEKDAYS, DURATION_OPTIONS,
  PAYOUT_STATUS, TICKET_CATEGORY, TICKET_STATUS,
} from '../utils/constants.js';
import {
  parseChoice, parseMultiChoice, pickFrom, parseMoney, parseTime,
  parseDate, parseWeekdays, clean,
} from '../utils/parse.js';
import {
  NANNY_AVAILABILITY_MENU, NANNY_PROFILE_MENU, NANNY_PAYMENTS_MENU, NANNY_SUPPORT_MENU,
} from './nannyMenu.js';
import { ratedList, money, prettyDate, starLine } from '../utils/format.js';
import * as M from '../utils/messages.js';

const backToMenu = (text, menu, state) => [{ text }, { text: menu, state }];

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

on('NA_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return NANNY_AVAILABILITY_MENU;

  const user = await User.findById(ctx.session.user);
  const av = user?.availability || {};

  switch (choice) {
    case 1:
      return backToMenu(
        `📆 *My Availability*

Days: ${(av.days || []).join(', ') || 'Not set'}
Start time: ${av.startTime || 'Not set'}
Max hours per day: ${av.maxHoursPerDay || 'Not set'}

🚫 Blocked dates: ${(av.blockedDates || []).length ? av.blockedDates.map(prettyDate).join(', ') : 'None'}`,
        NANNY_AVAILABILITY_MENU, 'NA_MENU'
      );
    case 2: return { text: M.NANNY_ASK_DAYS, state: 'NA_SET_DAYS' };
    case 3: return { text: M.NANNY_ASK_AVAIL_START, state: 'NA_SET_START' };
    case 4: return { text: M.NANNY_ASK_AVAIL_HOURS, state: 'NA_SET_HOURS' };
    case 5: return { text: '🚫 Which date do you want to block?\n\nSend a date like *15 August* or *2026-08-15*.', state: 'NA_BLOCK_DATE' };
    case 6: return showBlockedDates(ctx);
    default: return NANNY_AVAILABILITY_MENU;
  }
});

on('NA_SET_DAYS', async (ctx) => {
  const days = parseWeekdays(ctx.text);
  if (!days) return M.NANNY_ASK_DAYS;
  const user = await User.findById(ctx.session.user);
  user.availability = { ...(user.availability?.toObject?.() ?? user.availability ?? {}), days };
  await user.save();
  return backToMenu(`✅ Your available days are now: ${days.join(', ')}`, NANNY_AVAILABILITY_MENU, 'NA_MENU');
});

on('NA_SET_START', async (ctx) => {
  const time = parseTime(ctx.text);
  if (!time) return '❌ Please enter a time like *9:00 AM*.';
  const user = await User.findById(ctx.session.user);
  user.availability = { ...(user.availability?.toObject?.() ?? user.availability ?? {}), startTime: time };
  await user.save();
  return backToMenu(`✅ Your start time is now ${time}.`, NANNY_AVAILABILITY_MENU, 'NA_MENU');
});

on('NA_SET_HOURS', async (ctx) => {
  const c = parseChoice(ctx.text, DURATION_OPTIONS.length);
  if (!c) return M.NANNY_ASK_AVAIL_HOURS;
  const user = await User.findById(ctx.session.user);
  user.availability = {
    ...(user.availability?.toObject?.() ?? user.availability ?? {}),
    maxHoursPerDay: DURATION_OPTIONS[c - 1],
  };
  await user.save();
  return backToMenu(`✅ You can now work up to ${DURATION_OPTIONS[c - 1]} hours per day.`, NANNY_AVAILABILITY_MENU, 'NA_MENU');
});

on('NA_BLOCK_DATE', async (ctx) => {
  const date = parseDate(ctx.text);
  if (!date) return '❌ I couldn\'t read that date. Try *15 August* or *2026-08-15*.';

  const user = await User.findById(ctx.session.user);
  const av = user.availability?.toObject?.() ?? user.availability ?? {};
  const blocked = new Set(av.blockedDates || []);
  blocked.add(date);
  user.availability = { ...av, blockedDates: [...blocked].sort() };
  await user.save();

  return backToMenu(
    `🚫 *${prettyDate(date)}* has been blocked.\n\nFamilies will not be able to book you on this date.`,
    NANNY_AVAILABILITY_MENU, 'NA_MENU'
  );
});

async function showBlockedDates(ctx) {
  const user = await User.findById(ctx.session.user);
  const blocked = user.availability?.blockedDates || [];
  if (!blocked.length) {
    return backToMenu('You have no blocked dates.', NANNY_AVAILABILITY_MENU, 'NA_MENU');
  }
  return {
    text: `🚫 *Blocked dates*\n\n${blocked.map((d, i) => `${i + 1}. ${prettyDate(d)}`).join('\n')}\n\nReply with a number to unblock that date.`,
    state: 'NA_UNBLOCK_DATE',
    listing: { kind: 'blocked_dates', ids: blocked, page: 0, pageSize: 50 },
  };
}

on('NA_UNBLOCK_DATE', async (ctx) => {
  const dates = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, dates.length);
  if (!n) return M.INVALID_CHOICE;

  const target = dates[n - 1];
  const user = await User.findById(ctx.session.user);
  const av = user.availability?.toObject?.() ?? user.availability ?? {};
  user.availability = { ...av, blockedDates: (av.blockedDates || []).filter((d) => d !== target) };
  await user.save();

  return backToMenu(`✅ *${prettyDate(target)}* is available again.`, NANNY_AVAILABILITY_MENU, 'NA_MENU');
});

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

on('NP_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return NANNY_PROFILE_MENU;

  const user = await User.findById(ctx.session.user);

  switch (choice) {
    case 1:
      return backToMenu(M.nannyProfile(user), NANNY_PROFILE_MENU, 'NP_MENU');
    case 2:
      return { text: `Your current rate is *${money(user.hourlyRate)}/hr*.\n\n⚠️ Changing your rate does *not* affect existing bookings.\n\nWhat is your new hourly rate?`, state: 'NP_SET_RATE' };
    case 3:
      return { text: M.NANNY_ASK_SKILLS, state: 'NP_SET_SKILLS' };
    case 4:
      return { text: M.NANNY_ASK_LANGUAGES, state: 'NP_SET_LANGUAGES' };
    case 5:
      return showDocuments(ctx, user);
    case 6:
      return showEmergencyContacts(ctx, user);
    default: return NANNY_PROFILE_MENU;
  }
});

on('NP_SET_RATE', async (ctx) => {
  const rate = parseMoney(ctx.text);
  if (rate === null || rate <= 0) return `❌ Please enter your hourly rate, for example *${money(150000)}*.`;
  const user = await User.findById(ctx.session.user);
  user.hourlyRate = rate;
  await user.save();
  return backToMenu(
    `✅ Your hourly rate is now *${money(rate)}/hr*.\n\nExisting bookings keep their original rate.`,
    NANNY_PROFILE_MENU, 'NP_MENU'
  );
});

/** Re-collect skill ratings after a skills change. */
on('NP_SET_SKILLS', async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SKILLS.length);
  if (!idx) return M.NANNY_ASK_SKILLS;
  const skills = pickFrom(SKILLS, idx);
  ctx.merge({ skillQueue: skills, newSkills: [], skillIndex: 0 });
  return { text: M.NANNY_ASK_SKILL_RATING(skills[0]), state: 'NP_SKILL_RATING' };
});

on('NP_SKILL_RATING', async (ctx) => {
  const queue = ctx.get('skillQueue', []);
  const i = ctx.get('skillIndex', 0);
  const rating = parseChoice(ctx.text, 5);
  if (!rating) return M.NANNY_ASK_SKILL_RATING(queue[i]);

  const newSkills = [...(ctx.get('newSkills') || []), { name: queue[i], rating }];
  const next = i + 1;
  ctx.merge({ newSkills, skillIndex: next });

  if (next < queue.length) {
    return { text: M.NANNY_ASK_SKILL_RATING(queue[next]), state: 'NP_SKILL_RATING', noPush: true };
  }

  const user = await User.findById(ctx.session.user);
  user.skills = newSkills;
  if (!queue.includes('Tutoring')) user.subjects = [];
  await user.save();

  if (queue.includes('Tutoring')) {
    return { text: M.NANNY_ASK_SUBJECTS, state: 'NP_SET_SUBJECTS' };
  }
  return backToMenu(`✅ Your skills have been updated:\n${ratedList(newSkills)}`, NANNY_PROFILE_MENU, 'NP_MENU');
});

on('NP_SET_SUBJECTS', async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SUBJECTS.length);
  if (!idx) return M.NANNY_ASK_SUBJECTS;
  const user = await User.findById(ctx.session.user);
  user.subjects = pickFrom(SUBJECTS, idx);
  await user.save();
  return backToMenu(`✅ Your subjects have been updated: ${user.subjects.join(', ')}`, NANNY_PROFILE_MENU, 'NP_MENU');
});

on('NP_SET_LANGUAGES', async (ctx) => {
  const idx = parseMultiChoice(ctx.text, LANGUAGES.length);
  if (!idx) return M.NANNY_ASK_LANGUAGES;
  const langs = pickFrom(LANGUAGES, idx);
  ctx.merge({ langQueue: langs, newLanguages: [], langIndex: 0 });
  return { text: M.NANNY_ASK_LANG_RATING(langs[0]), state: 'NP_LANG_RATING' };
});

on('NP_LANG_RATING', async (ctx) => {
  const queue = ctx.get('langQueue', []);
  const i = ctx.get('langIndex', 0);
  const rating = parseChoice(ctx.text, 5);
  if (!rating) return M.NANNY_ASK_LANG_RATING(queue[i]);

  const newLanguages = [...(ctx.get('newLanguages') || []), { name: queue[i], rating }];
  const next = i + 1;
  ctx.merge({ newLanguages, langIndex: next });

  if (next < queue.length) {
    return { text: M.NANNY_ASK_LANG_RATING(queue[next]), state: 'NP_LANG_RATING', noPush: true };
  }

  const user = await User.findById(ctx.session.user);
  user.languages = newLanguages;
  await user.save();
  return backToMenu(`✅ Your languages have been updated:\n${ratedList(newLanguages)}`, NANNY_PROFILE_MENU, 'NP_MENU');
});

async function showDocuments(ctx, user) {
  const docs = user.documents || [];
  const rows = docs.map((d, i) => `${i + 1}. ${labelForDoc(d.type)} — ${d.verified ? '✅ Verified' : '⏳ Pending review'}`);
  return {
    text: `📄 *My Documents*

${rows.join('\n') || 'No documents uploaded.'}

What would you like to do?

1. Re-upload ID (front)
2. Re-upload ID (back)
3. Re-upload CPR certificate
4. Change profile photo

Type *Back* to go back.`,
    state: 'NP_DOCS_MENU',
  };
}

function labelForDoc(type) {
  return {
    id_front: 'ID card (front)', id_back: 'ID card (back)',
    cpr_certificate: 'CPR certificate', profile_photo: 'Profile photo',
  }[type] || type;
}

on('NP_DOCS_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 4);
  if (!choice) return M.INVALID_CHOICE;
  const types = ['id_front', 'id_back', 'cpr_certificate', 'profile_photo'];
  ctx.set('uploadDocType', types[choice - 1]);
  return { text: `📎 Please attach the new ${labelForDoc(types[choice - 1])}.`, state: 'NP_DOC_UPLOAD' };
});

on('NP_DOC_UPLOAD', async (ctx) => {
  if (!ctx.mediaUrl) return '📎 Please attach the document as an image or file.';
  const type = ctx.get('uploadDocType');
  const user = await User.findById(ctx.session.user);

  if (type === 'profile_photo') {
    user.profilePhotoUrl = ctx.mediaUrl;
  } else {
    user.documents = (user.documents || []).filter((d) => d.type !== type);
    user.documents.push({ type, url: ctx.mediaUrl, mediaId: ctx.mediaId, verified: false });
  }
  await user.save();

  return backToMenu(
    `✅ Your ${labelForDoc(type)} has been uploaded and sent for review.`,
    NANNY_PROFILE_MENU, 'NP_MENU'
  );
});

async function showEmergencyContacts(ctx, user) {
  const contacts = user.emergencyContacts || [];
  const rows = contacts.map((c, i) => `${i + 1}. ${c.name} (${c.relation || 'contact'}) — ${c.phone}`);
  return {
    text: `📞 *Emergency Contacts*

${rows.join('\n') || 'No emergency contacts added yet.'}

1. Add a contact
${contacts.length ? '2. Remove a contact\n' : ''}
Type *Back* to go back.`,
    state: 'NP_CONTACTS_MENU',
  };
}

on('NP_CONTACTS_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (choice === 1) return { text: 'What is the contact\'s name?', state: 'NP_CONTACT_NAME' };
  if (choice === 2) {
    const user = await User.findById(ctx.session.user);
    const contacts = user.emergencyContacts || [];
    if (!contacts.length) return 'You have no contacts to remove.';
    return {
      text: `Which contact should I remove?\n\n${contacts.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}`,
      state: 'NP_CONTACT_REMOVE',
      listing: { kind: 'contacts', ids: contacts.map((c) => String(c._id)), page: 0, pageSize: 20 },
    };
  }
  return M.INVALID_CHOICE;
});

on('NP_CONTACT_NAME', async (ctx) => {
  const name = clean(ctx.text);
  if (name.length < 2) return 'Please enter the contact\'s name.';
  ctx.set('contactName', name);
  return { text: `What is ${name}'s phone number?`, state: 'NP_CONTACT_PHONE' };
});

on('NP_CONTACT_PHONE', async (ctx) => {
  const phone = clean(ctx.text).replace(/[^\d+]/g, '');
  if (phone.length < 7) return 'Please enter a valid phone number.';
  ctx.set('contactPhone', phone);
  return { text: 'What is their relation to you? (e.g. Mother, Sister, Friend)', state: 'NP_CONTACT_RELATION' };
});

on('NP_CONTACT_RELATION', async (ctx) => {
  const relation = clean(ctx.text);
  const user = await User.findById(ctx.session.user);
  user.emergencyContacts.push({
    name: ctx.get('contactName'), phone: ctx.get('contactPhone'), relation,
  });
  await user.save();
  return backToMenu(`✅ ${ctx.get('contactName')} has been added as an emergency contact.`, NANNY_PROFILE_MENU, 'NP_MENU');
});

on('NP_CONTACT_REMOVE', async (ctx) => {
  const ids = ctx.session.listing?.ids || [];
  const n = parseChoice(ctx.text, ids.length);
  if (!n) return M.INVALID_CHOICE;
  const user = await User.findById(ctx.session.user);
  user.emergencyContacts = user.emergencyContacts.filter((c) => String(c._id) !== ids[n - 1]);
  await user.save();
  return backToMenu('✅ Contact removed.', NANNY_PROFILE_MENU, 'NP_MENU');
});

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

on('NPAY_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 5);
  if (!choice) return NANNY_PAYMENTS_MENU;

  const statuses = [
    PAYOUT_STATUS.PENDING, PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.COMPLETED,
    PAYOUT_STATUS.FINAL_DONE, PAYOUT_STATUS.FAILED,
  ];
  const status = statuses[choice - 1];

  const payouts = await Payout.find({ nanny: ctx.session.user, status })
    .populate('booking', 'bookingNumber')
    .sort({ createdAt: -1 })
    .limit(20);

  if (!payouts.length) {
    return backToMenu(`You have no payments in this category.`, NANNY_PAYMENTS_MENU, 'NPAY_MENU');
  }

  const total = payouts.reduce((s, p) => s + (p.amount || 0), 0);
  const rows = payouts.map((p, i) =>
    `${i + 1}. ${money(p.amount)} — Booking #${p.booking?.bookingNumber || '—'}\n   ${p.releasedAt ? `Released ${prettyDate(p.releasedAt)}` : `Scheduled ${prettyDate(p.scheduledFor)}`}`
  );

  return backToMenu(
    `💰 *${status.replace(/_/g, ' ').toUpperCase()}*\n\n${rows.join('\n\n')}\n\n*Total: ${money(total)}*\n\n_Payments are released every Monday._`,
    NANNY_PAYMENTS_MENU, 'NPAY_MENU'
  );
});

/* ------------------------------------------------------------------ *
 * Support
 * ------------------------------------------------------------------ */

on('NSUP_MENU', async (ctx) => {
  const choice = parseChoice(ctx.text, 6);
  if (!choice) return NANNY_SUPPORT_MENU;

  if (choice === 5) return listTickets(ctx, 'nanny');
  if (choice === 6) return backToMenu(M.COMMANDS_HELP, NANNY_SUPPORT_MENU, 'NSUP_MENU');

  const categories = [
    TICKET_CATEGORY.BOOKING, TICKET_CATEGORY.PAYMENT,
    TICKET_CATEGORY.FAMILY, TICKET_CATEGORY.ACCOUNT,
  ];
  ctx.set('ticketCategory', categories[choice - 1]);
  return { text: '🆘 Please describe your issue in detail.', state: 'NSUP_DESCRIBE' };
});

on('NSUP_DESCRIBE', async (ctx) => {
  const description = clean(ctx.text);
  if (description.length < 5) return '🆘 Please describe your issue in detail.';

  const ticketNumber = `T-${await nextSequence('ticket', 1000)}`;
  await Ticket.create({
    ticketNumber,
    raisedBy: ctx.session.user,
    raisedByRole: 'nanny',
    category: ctx.get('ticketCategory', TICKET_CATEGORY.OTHER),
    subject: 'Nanny support request',
    description,
  });

  return {
    text: `✅ Your ticket *${ticketNumber}* has been created.\n\nOur support team will contact you shortly.\n\nType *0* to return to the Main Menu.`,
    state: 'NANNY_MAIN_MENU',
  };
});

/** Shared ticket list used by both roles. */
export async function listTickets(ctx, role) {
  const tickets = await Ticket.find({ raisedBy: ctx.session.user }).sort({ createdAt: -1 }).limit(10);
  const menu = role === 'nanny' ? NANNY_SUPPORT_MENU : null;
  const state = role === 'nanny' ? 'NSUP_MENU' : 'SUPPORT_MENU';

  if (!tickets.length) {
    const text = 'You have no support tickets.';
    return menu ? backToMenu(text, menu, state) : { text, state };
  }

  const rows = tickets.map((t) => {
    const icon = { open: '🟠', in_progress: '🔵', resolved: '🟢', closed: '⚪' }[t.status] || '•';
    return `${icon} *${t.ticketNumber}* — ${t.status.replace(/_/g, ' ')}\n   ${t.subject}\n   _${prettyDate(t.createdAt)}_${t.replies?.length ? `\n   💬 ${t.replies.length} repl${t.replies.length > 1 ? 'ies' : 'y'}` : ''}`;
  });

  const text = `📄 *My Tickets*\n\n${rows.join('\n\n')}`;
  return menu ? backToMenu(text, menu, state) : { text, state };
}

export default { listTickets };
