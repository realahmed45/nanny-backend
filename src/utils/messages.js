import {
  money, prettyDate, timeRange, prettyTime, ratedList, starLine,
  childLines, weekdayList, statusLabel, numbered, durationMenu,
} from './format.js';
import { LANGUAGES, SKILLS, SUBJECTS, WEEKDAYS } from './constants.js';
import config from '../config/index.js';

/* ------------------------------------------------------------------ *
 * Shared / global
 * ------------------------------------------------------------------ */

export const WELCOME_FAMILY =
  '👋 Welcome to *My Nanny*\nFind a trusted nanny in just a few minutes.\nHow can I help you today?';

export const WELCOME_NANNY =
  '👋 Welcome to *My Nanny*\n\nFind families, manage your bookings, and grow your childcare work.';

export const FAMILY_MAIN_MENU = `What would you like to do?

1. Find a Nanny
2. My Bookings
3. My Profile
4. My Payments
5. Refer a Friend
6. Help`;

export const NANNY_MAIN_MENU = `What would you like to do?

1. Booking Requests and Updates
2. My Bookings
3. My Availability
4. My Profile
5. Payments
6. Refer a Friend
7. Help / Support`;

export const ROLE_PICKER = `👋 Welcome to *My Nanny*

Are you looking for childcare, or do you want to work as a nanny?

1. 👨‍👩‍👧 I'm a Family — I need a nanny
2. 👩‍🍼 I'm a Nanny — I want to work`;

export const INVALID_CHOICE = '❌ Sorry, I didn\'t understand that. Please reply with one of the listed options.';

export const COMMANDS_HELP = `*Available commands*

• *0* — Return to main menu
• *Back* — Go 1 step back
• *Next* — View more profiles/bookings
• *Skip* — Skip to next block
• *Bye* — Close chat with nanny
• *Cancel* — Cancel a booking
• *None* — No Google Maps location / no medical condition`;

export const IMPORTANT_FAMILY_INFO = `⚠️ *Important Information for Families*

🍽️ *Meal:* For bookings of 5+ hours, please provide the nanny with at least 1 meal.
🚕 *Transport:* A 50,000–100,000 transport fee applies depending on the area.
⏰ *Overtime:* 15+ mins = 30 mins charged; 45+ mins = 1 hour charged.
🧸 *Kids' Preferences:* Please tell us your children's favorite toys, games, and activities.`;

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export const ASK_FULL_NAME = 'Before we begin, let\'s create your account.\nWhat\'s your full name?';
export const ASK_EMAIL = (name) => `Great ${name}.\nWhat's your email?`;
export const ASK_OTP = '📲 We\'ve sent you a verification code.\nEnter the 6-digit code.';
export const OTP_INVALID = '❌ That code doesn\'t match. Please enter the 6-digit code we sent you.\n\nType *RESEND* to get a new code.';
export const OTP_EXPIRED = '⌛ That code has expired.\n\nType *RESEND* to get a new code.';
export const ACCOUNT_VERIFIED = (name) => `✅ Your account has been verified.\nWelcome ${name}!`;

/* ------------------------------------------------------------------ *
 * Find a nanny
 * ------------------------------------------------------------------ */

export const FIND_NANNY_INTRO = 'Let\'s find the right nanny.\n99% of our nannies are female.';
export const ASK_LOCATION = 'Where do you need childcare?\n📍 Share your google map location\nTYPE *None* if not available';
export const ASK_ADDRESS = 'Type your exact address.';
export const ASK_SAVE_ADDRESS = 'Do you want to save this address for later use?\n\n1. Yes\n2. No';
export const ASK_ADDRESS_LABEL = 'What would you like to call this address? Like home, office, granny home';
export const ADDRESS_SAVED = 'Your address has been saved.';

export const ASK_FREQUENCY = `How often do you need a nanny?

1. Single One Day
2. Multiple Days, Weeks, Months etc`;

export const ASK_START_DATE = 'When would you like the booking to start?\n📅 Select a start date.';
export const ASK_END_DATE = 'When would you like the booking to end?\n📅 Select an end date.';
export const ASK_REPEAT_DAYS = `Which days should the booking repeat on?\n\n${numbered(WEEKDAYS)}\n\nSelect multiple, separated by comma (e.g. 1,2,3)`;
export const ASK_START_TIME = 'What time does the session start?';
export const ASK_DURATION = `How long do you need the nanny?\n\n${durationMenu()}`;

export const ASK_LANGUAGES = `Choose a language.\n\n${numbered(LANGUAGES)}\n\nType multiple languages option separated by comma`;
export const ASK_SKILLS = `Choose required skills.\n\n${numbered(SKILLS)}\n\nSelect multiple, separated by comma`;
export const ASK_SUBJECTS = `Choose subjects you want the nanny to teach\n\n${numbered(SUBJECTS)}\n\nSelect multiple. Type separated by comma`;
export const ASK_BUDGET_MIN = 'Your minimum hourly budget in USD?';
export const ASK_BUDGET_MAX = 'Your maximum hourly budget in USD?';
export const ASK_CPR = 'Do you want the nanny to be CPR certified?\n\n1. Yes CPR certification required\n2. No, not required\n3. Works fine if certified or not';

export const ASK_CHILD_COUNT = `How many children need care?

1. One child
2. Two children
3. Three children
4. Four or more`;

export const ASK_CHILD_COUNT_EXACT = 'How many children need care? Please type the number.';
export const CHILD_INTRO = 'Lets address each child one by one';
export const ASK_CHILD_NAME = (ord) => `What is the ${ord} child's name?`;
export const ASK_CHILD_AGE = (name) => `How old is ${name}?`;
export const ASK_CHILD_MEDICAL = (name) =>
  `Does ${name} have any allergies, medical conditions, or special care needs? Please tell us about them. _Example: Peanut allergy, asthma, epilepsy, medication, etc._\n\nif none then type *None*`;
export const ASK_CHILD_DIET = (name) =>
  `Does ${name} have any dietary requirements or foods to avoid?\nPlease provide the details. _Example: Vegan, vegetarian, halal, dairy-free, food allergy, etc._\n\nif none then type *None*`;
export const CHILD_THANKS = (name) => `Thank you for providing details for ${name}`;

export const ASK_CONTINUE_OR_AGENT = `Would you like to continue providing the remaining information yourself, or would you like our agent to call you after your booking is confirmed and fill it in for you?

*1. 📝 Continue Myself*
I'll provide the information now.

*2. 📞 Let an Agent Help*
Our agent will call you after your booking is confirmed, collect the details, and fill them in for you.`;

export const AGENT_WILL_CALL = '✅ No problem! Our agent will call you after your booking is confirmed to collect the remaining details.';

export const ASK_OTHER_INSTRUCTIONS = `Is there anything else the nanny should know about your family or children?

You can include:
• Daily routines
• Sleeping/nap schedule
• Preferred activities
• Things the child should avoid
• Special instructions
• Family preferences

if none then type *None*`;

/* ------------------------------------------------------------------ *
 * Booking summary
 * ------------------------------------------------------------------ */

export function bookingSummary(b, {
  title = '*Booking Summary*', nanny = null, showId = false,
  showStatus = false, paid = false,
} = {}) {
  const lines = [];
  if (showId && b.bookingNumber) lines.push(`*Booking ID# ${b.bookingNumber}*\n`);
  else if (title) lines.push(`${title}\n`);

  const dayCount = (b.serviceDays || []).length;
  const dateLine = b.isMultiDay
    ? `📅 ${prettyDate(b.startDate)} – ${prettyDate(b.endDate)} (${dayCount} days)`
    : `📅 ${prettyDate(b.startDate)}`;
  lines.push(dateLine);
  lines.push(`🕘 ${timeRange(b.startTime, b.hoursPerDay)}`);
  if (b.isMultiDay && b.repeatDays?.length) lines.push(`🔄 Repeat on ${weekdayList(b.repeatDays)}`);
  if (b.address?.mapUrl) lines.push(`📍 ${b.address.mapUrl}`);
  if (b.address?.addressLine) lines.push(`🏡 ${b.address.addressLine}`);

  if (nanny) {
    lines.push('');
    lines.push(`👩 *${nanny.fullName}*`);
    lines.push(`${starLine(nanny.ratingAverage)} | ${nanny.distanceKm ?? 2} km | ${money(b.hourlyRate ?? nanny.hourlyRate)}/hr | Experience ${nanny.experienceYears ?? 0} yrs`);
  }

  lines.push('');
  if (b.requirements?.languages?.length) lines.push(`🗣 Language: ${b.requirements.languages.join(', ')}`);
  if (b.requirements?.skills?.length) lines.push(`🛠 Skills: ${b.requirements.skills.join(', ')}`);
  if (b.requirements?.subjects?.length) lines.push(`📚 Subjects: ${b.requirements.subjects.join(', ')}`);

  if (b.children?.length) {
    lines.push('');
    lines.push(`*Total Children:* ${b.children.length}`);
    lines.push('');
    lines.push(childLines(b.children));
  } else if (b.agentCallRequested) {
    lines.push('');
    lines.push('_Agent will call for more information later_');
  }

  if (b.otherInstructions && b.otherInstructions !== 'None') {
    lines.push('');
    lines.push(`*Other Instructions:*\n ${b.otherInstructions}`);
  }

  lines.push('');
  lines.push(paid ? '*💰 Payment Info*' : '*💰Payment*');
  lines.push(`Rate: ${money(b.hourlyRate)}/hr`);
  const days = dayCount || 1;
  lines.push(`Duration: ${b.hoursPerDay}hrs per day for ${days} day${days > 1 ? 's' : ''}`);
  lines.push(`Total Amount: *${money(b.totalAmount)}*${paid ? ' PAID' : ''}`);

  if (showStatus) {
    lines.push('');
    lines.push(`Status: ${statusLabel(b)}`);
  }
  return lines.join('\n');
}

export const CONFIRM_BOOKING_DETAILS = `Please review the booking summary above.

Would you like to continue with these booking details?

1. Continue (Start payment process)
2. Edit Booking`;

export const EDIT_MENU = `What do you want to edit?

1. Address
2. Start Time
3. Repeat on
4. Duration per day
5. Languages
6. Skills
7. Subjects
8. Budget
9. Children Info`;

export const EDIT_ANYTHING_ELSE = 'Do you want to edit anything else?\n\n1. Yes\n2. No';

/* ------------------------------------------------------------------ *
 * Nanny listing / profile
 * ------------------------------------------------------------------ */

export const SEARCHING = 'Hang on I am searching for a perfect nanny.';

export function nannyListing(nannies, { startIndex = 0, total = null } = {}) {
  const head = `I found *${total ?? nannies.length} available nannies*.\n`;
  const items = nannies.map((n, i) =>
    `${startIndex + i + 1}. 👩 *${n.fullName}*\n   ${starLine(n.ratingAverage)} | ${n.distanceKm ?? 2} km | ${money(n.hourlyRate)}/hr | Experience ${n.experienceYears ?? 0} yrs`
  ).join('\n\n');
  const nums = nannies.map((_, i) => startIndex + i + 1).join(',');
  const tail = `\n\nReply with ${nums} to view details\nType *NEXT* to view more profiles`;
  return head + items + tail;
}

export const NO_NANNIES = `😔 Sorry, we couldn't find a nanny matching your requirements right now.

What would you like to do?

1. Change Skills, Language or Budget
2. Change Date or Time
3. Contact Support
4. Back to Main Menu`;

export function nannyProfile(n, { hourlyRate = null } = {}) {
  const lines = [
    `*${n.fullName}*`,
    `${starLine(n.ratingAverage)} | ${n.distanceKm ?? 2} km | ${money(hourlyRate ?? n.hourlyRate)}/hr | Experience ${n.experienceYears ?? 0} yrs.`,
    '',
    `*Age*: ${n.age ?? '-'}yr`,
    '',
    '*Language*',
    ratedList(n.languages) || '-',
    '',
    '*Skills*',
    ratedList(n.skills) || '-',
  ];
  if (n.subjects?.length) {
    lines.push('', '*Tutoring*', n.subjects.join(', '));
  }
  const av = n.availability || {};
  lines.push('', '*Availability*', ` ${av.maxHoursPerDay ? `${av.maxHoursPerDay} hours per day` : 'Flexible'}`);
  lines.push('');
  lines.push(n.backgroundCheckPassed ? '✅Background Check' : '⬜Background Check');
  lines.push(n.cprCertified ? '✅CPR Certificate' : '⬜No CPR Certificate');
  return lines.join('\n');
}

export const NANNY_PROFILE_ACTIONS = `What do you want to do?

1. Book this nanny
2. Chat with Nanny
3. View Other Nannies

Type *Back* to go Back to Nanny Listing`;

export const CHAT_OPENED = (name) =>
  `You can now chat with ${name}.\nYour phone numbers remain private.\nAt any time you can close the chat by typing the word "*Bye*"\nSay *Hi* to ${name}`;

export const CHAT_CLOSED_ACTIONS = `What do you want to do now?

1. Book this nanny
2. Chat with nanny again
3. View More Nannies

Type *Back* to go Back to Nanny Listing`;

export const PAY_FIRST_NOTICE = (name) =>
  `*Pay First and* If ${name} isn't available, we'll immediately offer the next best verified Nanny\nIf no Nanny can be confirmed, you'll receive a *100% refund*.\n\nReply:\n1. 💳 Start Payment Process\n2. ❌ Cancel`;

/* ------------------------------------------------------------------ *
 * Payment
 * ------------------------------------------------------------------ */

export const PAYMENT_START = 'Alright Lets start payment process';
export const ASK_ID_FRONT = 'Add front image of your id card\nThis is a one time thing for security reasons';
export const ASK_ID_BACK = 'Add back image of your id card\nThis is a one-time thing for security reasons';
/** Bank details + the amount owed, so the family can make the transfer. */
export const bankTransferInstructions = (amount) => {
  const b = config.bank;
  const lines = [`\u{1F4B3} *Amount to transfer: ${money(amount)}*`, ''];

  if (b.name || b.accountName || b.accountNumber || b.iban) {
    lines.push('Please transfer to:');
    if (b.name) lines.push(`\u{1F3E6} Bank: *${b.name}*`);
    if (b.accountName) lines.push(`\u{1F464} Account name: *${b.accountName}*`);
    if (b.accountNumber) lines.push(`\u{0023}\u{FE0F}\u{20E3} Account number: *${b.accountNumber}*`);
    if (b.iban) lines.push(`\u{1F310} IBAN: *${b.iban}*`);
  } else {
    // Never invent bank details - say so rather than showing a blank block.
    lines.push('\u{26A0}\u{FE0F} Our bank details are not configured yet.');
    lines.push('Please contact support to complete this payment.');
  }

  if (b.instructions) lines.push('', b.instructions);
  lines.push('', '\u{1F4F8} Once you have paid, *send a screenshot* of the transfer receipt here.');
  return lines.join('\n');
};

export const ASK_PAYMENT_PROOF =
  '\u{1F4F8} Please send a *screenshot* of your transfer receipt.\n\nAttach it as an image in this chat.';

export const PAYMENT_PROOF_RECEIVED =
  '\u{2705} Thanks! We have received your payment proof.\n\nOur team will verify the transfer and confirm your booking shortly. You will get a message as soon as it is checked.';

export const PAYMENT_VERIFIED =
  '\u{2705} *Payment verified.*\nYour booking has been confirmed.\nWaiting for nanny confirmation.';

export const paymentRejected = (reason) =>
  `\u{274C} *We could not verify your payment.*${reason ? `\n\nReason: ${reason}` : ''}\n\nWhat would you like to do?\n\n1. Send the screenshot again\n2. Contact Support\n3. Back to Main Menu`;

export const PAYMENT_REJECTED_ACTIONS =
  '\u{274C} We could not verify your payment.\n\nWhat would you like to do?\n\n1. Send the screenshot again\n2. Contact Support\n3. Back to Main Menu';

export const refundIssued = (amount, ref) =>
  `\u{1F4B8} *Refund sent \u{2014} ${money(amount)}*\n\nWe have transferred your refund back to you.${ref ? `\nReference: ${ref}` : ''}\n\nIt may take a few working days to appear in your account.`;

/* ------------------------------------------------------------------ *
 * Nanny-side registration
 * ------------------------------------------------------------------ */

export const NANNY_ASK_AGE = 'What\'s your age?';
export const NANNY_ASK_EXPERIENCE = 'How many years of nanny/childcare experience do you have?';
export const NANNY_ASK_LANGUAGES = `Which languages can you speak?\n\n${numbered(LANGUAGES)}\n\nYou can select multiple separated by comma for example 1,2`;
export const NANNY_ASK_LANG_RATING = (lang) =>
  `Rate your proficiency in ${lang}.\n⭐ 1 – Basic\n⭐ 2 – Elementary\n⭐ 3 – Good\n⭐ 4 – Very Good\n⭐ 5 – Fluent`;
export const NANNY_ASK_SKILLS = `What childcare skills do you have?\n\n${numbered(SKILLS)}\n\nYou can select multiple separated by comma for example 1,2`;
export const NANNY_ASK_SKILL_RATING = (skill) =>
  `Rate your proficiency in ${skill}\n⭐ 1 – Beginner\n⭐ 2 – Basic\n⭐ 3 – Good\n⭐ 4 – Very Good\n⭐ 5 – Expert`;
export const NANNY_ASK_SUBJECTS = `Which subjects can you teach?\n\n${numbered(SUBJECTS)}\n\nYou can select multiple separated by comma for example 1,2`;
export const NANNY_ASK_RATE = 'What is your hourly rate in USD?';
export const NANNY_ASK_CPR = 'Are you CPR certified?\n\n1. Yes\n2. No';
export const NANNY_ASK_CPR_DOC = 'Please upload your *CPR certificate*.';
export const NANNY_ASK_ID_FRONT = 'Please upload your National Identity card document front image';
export const NANNY_ASK_ID_BACK = 'Please upload your National Identity card document back image';
export const NANNY_ASK_ADDRESS = 'Please provide your current residing address.';
export const NANNY_ASK_MAP = 'Please attach a google map location of your current residing address.\nType *None* if google map location is unavailable';
export const NANNY_ASK_PHOTO = 'Please upload your *profile photo*.';
export const NANNY_ASK_DAYS = `Which days are you available in the week?\nYou can later change it from My Availability section\n\n${numbered(WEEKDAYS)}\n\nYou can select multiple separated by comma for example 1,2`;
export const NANNY_ASK_AVAIL_START = 'What time are you available to start? 00:00 AM/PM';
export const NANNY_ASK_AVAIL_HOURS = `How long can you provide a nanny service in a day?\n\n${durationMenu()}`;

export const NANNY_PROFILE_SUBMITTED = `✅ Your profile has been submitted.

Our team will review your documents and verification details.

Your profile will become available to families once approved.`;

export const NANNY_VERIFIED = `🎉 *Congratulations!*

Your profile has been *verified successfully*! ✅

Your profile is now *visible to families*, and they can book you for their childcare needs.

Good luck, and we wish you many successful bookings! 💛`;

export const NANNY_REJECTED = (reason) =>
  `❌ We could not verify your profile at this time.\n\n*Reason:* ${reason || 'Documents could not be verified.'}\n\nPlease contact support or resubmit your documents.`;

export function nannyBookingRequest(b, family, expiresAt, { isChange = false } = {}) {
  const dayCount = (b.serviceDays || []).length;
  const dateLine = b.isMultiDay
    ? `📅 ${prettyDate(b.startDate)} – ${prettyDate(b.endDate)} (${dayCount} days)`
    : `📅 ${prettyDate(b.startDate)}`;
  const lines = [
    isChange ? '🔔 *Booking Change Request*' : '🔔 *New Booking Request*',
    `*Booking ID# ${b.bookingNumber}*`,
    '',
    dateLine,
    `🕘 ${timeRange(b.startTime, b.hoursPerDay)}`,
  ];
  if (b.isMultiDay && b.repeatDays?.length) lines.push(`🔄 Repeat on ${weekdayList(b.repeatDays)}`);
  if (b.address?.mapUrl) lines.push(`📍 ${b.address.mapUrl}`);
  if (b.address?.addressLine) lines.push(`🏡 ${b.address.addressLine}`);
  lines.push('', `👨‍👩‍👧 Family: ${family?.fullName || 'Family'}`);
  if (b.requirements?.skills?.length) lines.push(`🛠 Skills: ${b.requirements.skills.join(', ')}`);
  if (b.requirements?.languages?.length) lines.push(`🗣 Language: ${b.requirements.languages.join(', ')}`);
  if (b.children?.length) {
    lines.push('', `*Total Children:* ${b.children.length}`, '', childLines(b.children));
  }
  if (b.otherInstructions && b.otherInstructions !== 'None') {
    lines.push('', `*Other Instructions:*\n ${b.otherInstructions}`);
  }
  lines.push('', '*💰 Your Earnings*', `Rate: ${money(b.hourlyRate)}/hr`);
  lines.push(`Total: *${money(b.totalAmount)}*`);
  if (expiresAt) {
    const mins = Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 60000));
    lines.push('', `⏳ Please respond within *${mins} minutes*.`);
  }
  lines.push('', 'What would you like to do?', '');
  lines.push(isChange ? '1. ✅ Accept Changes' : '1. ✅ Accept Booking');
  lines.push(isChange ? '2. ❌ Decline Changes' : '2. ❌ Decline Booking');
  lines.push('3. 💬 Message Family');
  return lines.join('\n');
}

export default {
  WELCOME_FAMILY, WELCOME_NANNY, FAMILY_MAIN_MENU, NANNY_MAIN_MENU, ROLE_PICKER,
  INVALID_CHOICE, COMMANDS_HELP, IMPORTANT_FAMILY_INFO,
  bookingSummary, nannyListing, nannyProfile, nannyBookingRequest,
};
