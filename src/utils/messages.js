import {
  money, prettyDate, prettyDateFull, timeRange, prettyTime, ratedList, starLine,
  childLines, weekdayList, statusLabel, numbered, durationMenu, firstName, nannyDisplayName,
} from './format.js';
import {
  LANGUAGES, SKILLS, SUBJECTS, WEEKDAYS, MAX_FEATURED_VIDEOS, MAX_FEATURED_PHOTOS,
} from './constants.js';
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

/**
 * Shown when someone messages the bot before it has been started. Keeping the
 * trigger word explicit means a stray "hi" does not silently do nothing.
 */
/** Shown when the mail provider rejected the verification email. */
export const OTP_SEND_FAILED =
  '\u{26A0}\u{FE0F} We could not send the email just now. Our team has been alerted.\n\nIf you do not receive a code, type *Resend* to try again, or *0* to return to the Main Menu.';

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

/**
 * The house rules, quoted from config so a fee change lands everywhere at once.
 *
 * An emergency raises the transport fee by a flat surcharge — the nanny is
 * being pulled across town at no notice — so the emergency version states the
 * raised band and that it is cash on arrival. It is deliberately not folded
 * into the transfer total: the family pays the platform for hours and the
 * nanny in cash for the journey.
 */
export const importantFamilyInfo = ({ isEmergency = false, surcharge } = {}) => {
  const { min, max } = config.transportFee;
  const bump = surcharge ?? config.emergencySurcharge;
  const transport = isEmergency
    ? `🚕 *Transport:* ${money(min + bump)}–${money(max + bump)} depending on the area — this includes a ${money(bump)} emergency surcharge, paid to the nanny *in cash when she arrives*.`
    : `🚕 *Transport:* A ${money(min)}–${money(max)} transport fee applies depending on the area.`;

  return `⚠️ *Important Information for Families*

🍽️ *Meal:* For bookings of 5+ hours, please provide the nanny with at least 1 meal.
${transport}
⏰ *Overtime:* 15+ mins = 30 mins charged; 45+ mins = 1 hour charged.
🧸 *Kids' Preferences:* Please tell us your children's favorite toys, games, and activities.`;
};

/** Kept for callers that predate the emergency variant. */
export const IMPORTANT_FAMILY_INFO = importantFamilyInfo();

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

export const ASK_START_DATE = `When would you like the booking to start?

1. Today
2. Tomorrow
3. Select a date

Or just type it — *today*, *tomorrow*, a weekday like *Monday*, or a date like *12 August*.`;

export const ASK_START_DATE_CUSTOM =
  '📅 Which date?\n\nType a weekday like *Monday*, or a date like *12 August*, *Aug 12* or *2026-08-12*.';

/** Same-day bookings are urgent by definition, so we ask outright. */
export const ASK_EMERGENCY = `⚡ *Booking for today*

Is this an emergency? We prioritise urgent same-day requests and contact available nannies straight away.

1. It's urgent (Emergency)
2. It's a normal booking for today`;

/**
 * The emergency promise.
 *
 * Someone who needs a nanny in the next hour is not reading a form, they are
 * panicking. So the reassurance comes first and in full — what we are doing,
 * when we will call — and only then the request for details, framed as
 * helping us help them rather than as a queue to get through.
 */
export const EMERGENCY_PROMISE = `⚠️ The most important thing is that we get you someone available straight away.

We are arranging someone within *1 hour* to come to you.

📞 *We will call you within 15 minutes.*

Please fill in the rest of the information so we can help you — and tell us as much as you can.`;

/** Emergencies start from where they already are, so we confirm rather than ask. */
export const confirmEmergencyLocation = (address) => `📍 *Confirm location*

${address}

Do you want to continue with this location?

1. Yes, continue
2. No, I want to change it`;

/* ---- 24-hour care ---------------------------------------------------- */

/**
 * 24-hour care over several days is more than one person can do.
 *
 * Said plainly and early: a family that has already picked dates and children
 * should not discover at the summary that we cannot staff it as asked. The
 * agent call is promised here, and the flow carries on collecting what that
 * agent will need.
 */
export const TWENTY_FOUR_HOUR_NOTICE = `⏰ *24-Hour Nanny Care*

You selected 24-hour care.

For multiple-day bookings, 24-hour care can be demanding for one nanny, especially when there are several children. We may recommend *2 nannies* to provide better coverage and allow proper rest.

Don't worry — we'll help you find the right solution.

📞 We will call you within 2 hours, once you have finished filling in the information we need.

Please continue filling in the information required for us to understand your needs.`;

export const ASK_CONTINUE_24H = `Continue with booking details?

1. Yes, continue
2. Change duration`;

export const ASK_LIVE_IN = `🏠 Will the nanny stay at your home during the booking?

1. Yes, the nanny will stay at our home
2. No, the nanny will leave after each 24-hour shift`;

export const LIVE_IN_CONFIRMED = `Got it. The nanny will stay at your home during the booking.

Please make sure the nanny has a suitable place to sleep and rest during the booking.`;

export const LIVE_OUT_CONFIRMED =
  'Got it. The nanny will leave after each 24-hour shift.';

/** More than two children round the clock is an agent conversation, not a form. */
export const TWENTY_FOUR_HOUR_MANY_CHILDREN = `Alright — you need 24-hour care for more than 2 children, so we will need to discuss your requirements with you before sending the booking to a nanny.

After you complete the booking details, our agent will call you to understand your needs and help arrange the best solution. You may need *2 nannies* for suitable coverage.

Let's continue.`;

/* ---- After the agent has called -------------------------------------- */

/** Option A: one nanny will do. */
export const AGENT_DECIDED_ONE = `Your requirements have been reviewed.

*1 nanny* can be arranged for your booking.

Would you like to continue?

1. Yes, continue
2. No, discard booking request`;

/** Option B: two are needed, so the family picks each in turn. */
export const AGENT_DECIDED_TWO = `Based on your requirements, we recommend *2 nannies* to provide suitable coverage.

This will allow the nannies to share the care period and have appropriate rest time.

Would you like to continue with 2 nannies?

1. Yes, continue
2. No, discard booking request`;

export const SEARCHING_TWO = 'Hang on, I am searching for perfect nannies.';
export const PICK_FIRST_NANNY = "Let's start by selecting the first nanny.";
export const pickSecondNanny = (firstName) =>
  `✅ *${firstName}* is your first nanny.\n\nNow let's choose the second nanny.`;

/**
 * The standing answer while an agent decides one nanny or two.
 *
 * Repeated on every message rather than falling back to a menu: a family in
 * this state has one question — what happens now — and a menu does not
 * answer it.
 */
export const AGENT_REVIEW_PENDING = `📞 *An agent will contact you* to discuss your requirements and determine whether 1 or 2 nannies would be the best solution.

Status: 🟤 *Pending for Payment* — agent contact required

You can view this request later under:
*My Bookings → Pending for Payment*

Type *0* for the main menu.`;

/**
 * Told to a nanny when something she sent is turned down.
 *
 * Written to keep her sending. She went to the trouble of filming something,
 * so the message says what was wrong and invites another rather than reading
 * as a telling-off — a nanny who feels judged stops contributing, and an
 * empty profile costs her the bookings.
 */
export const mediaRejected = ({ kind, reasons = [], reason, detail }) => {
  // One reason reads better in a sentence; several read better as a list she
  // can work down. Both end with the same invitation to send another.
  const list = reasons.length ? reasons : [reason].filter(Boolean);

  const lines = [`📷 *About the ${kind} you sent*`, ''];

  if (list.length === 1) {
    lines.push(`We could not add it to your profile because ${list[0]}.`);
  } else if (list.length > 1) {
    lines.push('We could not add it to your profile for these reasons:', '');
    list.forEach((r) => lines.push(`• ${r.charAt(0).toUpperCase()}${r.slice(1)}`));
  } else {
    lines.push('We could not add it to your profile.');
  }

  if (detail) lines.push('', `📝 ${detail}`);

  lines.push(
    '',
    `Please send another when you can — a ${kind} of you with a family or at work helps you get chosen more often.`,
  );
  return lines.join('\n');
};

/* ---- Emergency broadcast --------------------------------------------- */

/**
 * The offer, sent to every suitable nanny at once.
 *
 * Written to be decided on in thirty seconds while she is doing something
 * else, so it leads with the two facts that settle it — when, and what it
 * pays — and keeps the rest short. First to reply gets it, and saying so is
 * what makes people answer immediately rather than "in a minute".
 *
 * The address is deliberately absent. Broadcasting a family's home to forty
 * people is a privacy problem, and nobody needs it to decide whether they are
 * free.
 */
export function emergencyBroadcast(b, { hourlyBonus = 0, surcharge = 0, family } = {}) {
  const hours = b.hoursPerDay || 0;
  const bonusTotal = hourlyBonus * hours;

  const lines = [
    '\u{1F6A8} *URGENT — nanny needed now*',
    '',
    `\u{1F4CD} Area: ${b.address?.label || 'nearby'}`,
    `\u{23F0} Starts: *within 1 hour*`,
    `\u{1F552} Duration: ${hours} hour${hours === 1 ? '' : 's'}`,
  ];

  if (b.children?.length) {
    lines.push(`\u{1F476} Children: ${b.children.length}`);
  }
  if (b.requirements?.skills?.length) {
    lines.push(`\u{1F6E0} Needed: ${b.requirements.skills.join(', ')}`);
  }

  lines.push(
    '',
    '*\u{1F4B0} What you earn*',
    `Your usual rate for ${hours} hour${hours === 1 ? '' : 's'}`,
    `\u{002B} *${money(hourlyBonus)} per hour* emergency bonus (${money(bonusTotal)} total)`,
    `\u{002B} *${money(surcharge)}* extra transport, cash on arrival`,
    '',
    '⚡ *First to accept gets the job.*',
    '',
    'Reply *YES* to take it — we will send you the full address straight away.',
    'Reply *NO* if you cannot.',
  );

  return lines.join('\n');
}

/** She won it. Everything held back until now arrives in one message. */
export function emergencyClaimed(b, family) {
  const lines = [
    '\u{2705} *It is yours — please go now.*',
    '',
    `*Booking #${b.bookingNumber}*`,
    `\u{1F551} ${timeRange(b.startTime, b.hoursPerDay)}`,
  ];
  if (family?.fullName) lines.push(`\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} Family: ${family.fullName}`);
  if (b.address?.addressLine) lines.push(`\u{1F3E1} ${b.address.addressLine}`);
  if (b.address?.mapUrl) lines.push(`\u{1F4CD} ${b.address.mapUrl}`);

  if (b.children?.length) {
    lines.push('', `*Children:* ${b.children.length}`, childLines(b.children));
  }
  if (b.otherInstructions && b.otherInstructions !== 'None') {
    lines.push('', `*Please note:*\n${b.otherInstructions}`);
  }

  lines.push(
    '',
    'Please head there straight away. The family has been told you are on your way.',
    '',
    'Open *My Bookings* to confirm your arrival when you get there.',
  );
  return lines.join('\n');
}

/**
 * Told to everyone who did not get it.
 *
 * Sent because silence is worse than a no: a nanny who kept her afternoon
 * clear for a job she never hears about again stops answering the next one.
 */
export const emergencyTaken = (b) =>
  `This urgent booking has been taken by another nanny.\n\nThank you for being available — we will let you know about the next one.`;

/** The family, the moment somebody is on the way. */
export function emergencyNannyFound(b, nanny) {
  return `\u{2705} *We found you a nanny*

*${nannyDisplayName(nanny)}* has accepted and is on her way.

She should arrive within the hour. You will get her details in *My Bookings*.`;
}

/* ---- Follow & save discount ------------------------------------------ */

/**
 * Sent the moment an admin confirms both halves.
 *
 * A two-day discount nobody hears about is not a discount, and by the time
 * they next open the chat half of it may be gone — so this goes out on
 * confirmation rather than waiting for their next booking.
 */
export const socialDiscountUnlocked = (expiresAt) => `🎉 *Your discount is active!*

Thank you for following us on Instagram and saving our number.

You now have *discounted pricing* on your bookings${expiresAt ? ` until *${prettyDateFull(expiresAt)}*` : ''}.

Book now to use it — type *nanny* and choose *Find a Nanny*.`;

export const BOOKING_DISCARDED =
  '🗑️ Your booking request has been discarded. You can start a new one any time from the main menu.';
/** Echo the date we settled on, so a weekday answer is unambiguous. */
export const startDateConfirmed = (date) =>
  `\u{1F4C5} Start date: *${prettyDate(date)}*`;

/** Same for the end date of a multi-day booking. */
export const endDateConfirmed = (date) =>
  `\u{1F4C5} End date: *${prettyDate(date)}*`;

/**
 * Echo the repeat days back.
 *
 * Someone typing "monday, tuesday and wed" has no way of knowing whether we
 * understood it, and the day count makes a wrong answer obvious immediately
 * rather than at the payment screen.
 */
export const repeatDaysConfirmed = (days, dayCount) =>
  `\u{1F501} Repeating on *${weekdayList(days)}*${dayCount ? ` \u2014 *${dayCount}* day${dayCount > 1 ? 's' : ''} in total` : ''}`;

export const ASK_END_DATE =
  'When would you like the booking to end?\n\n📅 Type a weekday like *Friday*, or a date like *26 September*.';
export const ASK_REPEAT_DAYS = `Which days should the booking repeat on?\n\n${numbered(WEEKDAYS)}\n8. All days of the week\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;
export const ASK_START_TIME =
  'What time does the session start?\n\nUse a time like *9:00 AM* or *2:30 PM*.';
export const ASK_DURATION = `How long do you need the nanny?\n\n${durationMenu()}`;

export const ASK_LANGUAGES = `Choose a language.\n\n${numbered(LANGUAGES)}\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;

/** Sent on its own after the language list, so it is not lost in the menu. */
export const LANGUAGE_NOTE =
  'We will try to find your language requirement. English is the minimum for every nanny.';
export const ASK_SKILLS = `Choose required skills.\n\n${numbered(SKILLS)}\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;
export const ASK_SUBJECTS = `Choose subjects you want the nanny to teach\n\n${numbered(SUBJECTS)}\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;

export const ASK_CHILD_COUNT = `How many children need care?

1. One child
2. Two children
3. Three children
4. Four or more`;

export const ASK_CHILD_COUNT_EXACT = 'How many children need care? Please type the number.';
export const CHILD_INTRO = 'Lets address each child one by one';
/**
 * Said once the first of several children is named, so it is clear the others
 * are not being skipped -- people otherwise wonder why only one was asked for.
 */
export const childFocusNotice = (name, remaining) =>
  `Perfect! Let's go through ${name}'s details first` +
  (remaining > 0
    ? `, then we will cover the ${remaining === 1 ? 'second child' : `other ${remaining} children`}.`
    : '.');

export const ASK_CHILD_NAME = (ord) => `What is the ${ord} child's name?`;
export const ASK_CHILD_AGE = (name) =>
  `How old is ${name}?

Reply with the age in years, e.g. *4*, *4y* or *4 years*.
For a baby you can say *6 months*.`;

export const INVALID_CHILD_AGE =
  'Please give the age as a number of years — for example *4*, *4y* or *4 years*.\nFor a baby, *6 months* works too.';
/** Shown under every free-text question that expects a long answer. */
export const LONG_ANSWER_HINT =
  "Write as much detail as you'd like here! We recommend drafting your text elsewhere and pasting it in, or you can simply send us a voice message.";

export const ASK_CHILD_MEDICAL = (name) =>
  `Does ${name} have any allergies, medical conditions, or special care needs? Please tell us about them. _Example: Peanut allergy, asthma, epilepsy, medication, etc._\n\n${LONG_ANSWER_HINT}\n\nif none then type *None*`;
export const ASK_CHILD_DIET = (name) =>
  `Does ${name} have any dietary requirements or foods to avoid?\nPlease provide the details. _Example: Vegan, vegetarian, halal, dairy-free, food allergy, etc._\n\n${LONG_ANSWER_HINT}\n\nif none then type *None*`;
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
    lines.push(`👩 *${nannyDisplayName(nanny)}*`);
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

  if (b.isEmergency) {
    lines.push('');
    lines.push('⚡ *EMERGENCY BOOKING* — needed today');
    // Stated beside the total, because it is the one cost that is not in it.
    // The booking's own figure, not today's rate: an old booking must keep
    // quoting what it was actually sold at.
    lines.push(`🚕 Transport includes a ${money(b.emergencySurcharge ?? config.emergencySurcharge)} emergency surcharge, paid to the nanny in cash on arrival.`);
  }

  // Round-the-clock care changes what is being staffed, so it is stated on
  // the summary rather than left implicit in "24hrs per day".
  if (b.hoursPerDay === 24) {
    lines.push('');
    lines.push('⏰ *24-hour care*');
    lines.push(b.isLiveIn
      ? '🏠 The nanny will stay at your home'
      : '🏠 The nanny will leave after each 24-hour shift');
    if (b.nanniesNeeded > 1) lines.push(`👥 ${b.nanniesNeeded} nannies sharing the care period`);
  }

  const days = dayCount || 1;

  // Before a nanny is chosen there is no rate yet, so quoting one would
  // read as a price the family is being charged. Show the schedule only.
  lines.push('');
  if (b.hourlyRate) {
    lines.push(paid ? '*💰 Payment Info*' : '*💰Payment*');
    lines.push(`Rate: ${money(b.hourlyRate)}/hr`);
    lines.push(`Duration: ${b.hoursPerDay}hrs per day for ${days} day${days > 1 ? 's' : ''}`);
    lines.push(`Total Amount: *${money(b.totalAmount)}*${paid ? ' PAID' : ''}`);
  } else {
    lines.push('*⏱ Schedule*');
    lines.push(`Duration: ${b.hoursPerDay}hrs per day for ${days} day${days > 1 ? 's' : ''}`);
    lines.push('');
    lines.push('_The total is shown once you choose a nanny._');
  }

  if (showStatus) {
    lines.push('');
    lines.push(`Status: ${statusLabel(b)}`);
  }
  return lines.join('\n');
}

export const CONFIRM_BOOKING_DETAILS = `Please review the booking summary above.

Would you like to continue with these booking details?

1. Continue
2. Edit Booking`;

export const EDIT_MENU = `What do you want to edit?

1. Address
2. Start Time
3. Repeat on
4. Duration per day
5. Languages
6. Skills
7. Subjects
8. Children Info`;

export const EDIT_ANYTHING_ELSE = 'Do you want to edit anything else?\n\n1. Yes\n2. No';

/* ------------------------------------------------------------------ *
 * Nanny listing / profile
 * ------------------------------------------------------------------ */

export const SEARCHING = 'Hang on I am searching for a perfect nanny.';

export function nannyListing(nannies, { startIndex = 0, total = null } = {}) {
  const head = `I found *${total ?? nannies.length} available nannies*.\n`;
  const items = nannies.map((n, i) =>
    `${startIndex + i + 1}. 👩 *${nannyDisplayName(n)}*\n   ${starLine(n.ratingAverage)} | ${n.distanceKm ?? 2} km | ${money(n.hourlyRate)}/hr | Experience ${n.experienceYears ?? 0} yrs`
  ).join('\n\n');
  const nums = nannies.map((_, i) => startIndex + i + 1).join(',');
  const tail = `\n\nReply with ${nums} to view details\nType *NEXT* to view more profiles`;
  return head + items + tail;
}

/**
 * Split in two: the promise of a callback, then the options.
 *
 * After 00:30 there is nobody to ring, so we say when we will call instead of
 * implying someone is about to pick up the phone in the middle of the night.
 */
export const noNanniesCallback = (now = new Date()) => {
  const hour = now.getHours();
  const minute = now.getMinutes();
  const afterCutoff = hour === 0 ? minute >= 30 : hour < 10;

  return afterCutoff
    ? `\u{1F4DE} *We will call you first thing in the morning \u{2014} 10:00 AM.*

Our team will go through your request personally and find you a nanny.`
    : `\u{1F4DE} *We will call you shortly.*

Our team will go through your request personally and find you a nanny.`;
};

export const NO_NANNIES_ACTIONS = `What would you like to do?

1. Change Skills or Language
2. Change Date or Time
3. Contact Support
4. Back to Main Menu`;

/** Kept for the prompt replay when re-entering the state. */
export const NO_NANNIES = NO_NANNIES_ACTIONS;

export function nannyProfile(n, { hourlyRate = null } = {}) {
  const lines = [
    `*${nannyDisplayName(n)}*`,
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

  // Only what was picked for the profile. A nanny sends whatever she likes
  // over months; the family sees the selection, not the archive.
  const media = featuredMedia(n);
  if (media.length) {
    lines.push('', '*📸 Photos & Videos*');
    media.forEach((m, i) => lines.push(`${i + 1}. ${m.caption || m.title || (m.kind === 'video' ? 'Video' : 'Photo')}\n   ${m.url}`));
  }
  return lines.join('\n');
}

/**
 * The media on a nanny's public profile, videos first.
 *
 * Two conditions, both required. `approved` means someone watched it and it
 * is safe to show; `featured` means it was chosen to represent her. Approval
 * alone puts nothing in front of a family — that is the whole point of having
 * two flags.
 *
 * The caps are enforced here as well as when the box is ticked, so a record
 * that somehow carries too many (an import, a hand-edit) still shows a
 * sensible profile rather than forty photos.
 */
export function featuredMedia(n) {
  const pick = (list, kind, limit) => (list || [])
    .filter((m) => m.approved && m.featured)
    .map((m) => ({ ...(m.toObject?.() ?? m), kind }))
    .slice(0, limit);

  return [
    ...pick(n.videos, 'video', MAX_FEATURED_VIDEOS),
    ...pick(n.photos, 'photo', MAX_FEATURED_PHOTOS),
  ];
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

/**
 * Approval and rejection both name the payment and booking.
 *
 * A family with more than one booking in flight cannot tell which was approved
 * without a reference, and support cannot help them without one either.
 */
export const paymentVerified = ({ reference, bookingNumber } = {}) => {
  const ids = [
    reference ? `Payment: *${reference}*` : '',
    bookingNumber ? `Booking: *#${bookingNumber}*` : '',
  ].filter(Boolean).join('\n');

  return [
    '\u{2705} *Payment verified.*',
    ids,
    'Your booking has been confirmed.\nWaiting for nanny confirmation.',
  ].filter(Boolean).join('\n\n');
};

/** Kept for callers that have no reference to hand. */
export const PAYMENT_VERIFIED = paymentVerified();

export const paymentRejected = (reason, { reference, bookingNumber } = {}) => {
  const ids = [
    reference ? `Payment: *${reference}*` : '',
    bookingNumber ? `Booking: *#${bookingNumber}*` : '',
  ].filter(Boolean).join('\n');

  return [
    '\u{274C} *We could not verify your payment.*',
    ids,
    reason ? `Reason: ${reason}` : '',
    'What would you like to do?\n\n1. Send the screenshot again\n2. Contact Support\n3. Back to Main Menu',
  ].filter(Boolean).join('\n\n');
};

export const PAYMENT_REJECTED_ACTIONS =
  '\u{274C} We could not verify your payment.\n\nWhat would you like to do?\n\n1. Send the screenshot again\n2. Contact Support\n3. Back to Main Menu';

export const refundIssued = (amount, ref) =>
  `\u{1F4B8} *Refund sent \u{2014} ${money(amount)}*\n\nWe have transferred your refund back to you.${ref ? `\nReference: ${ref}` : ''}\n\nIt may take a few working days to appear in your account.`;

/* ------------------------------------------------------------------ *
 * Nanny-side registration
 * ------------------------------------------------------------------ */

export const NANNY_ASK_NICKNAME = `What would you like families to call you?

This is the name families will see — your full name stays private.

For example: *Maria*, *Ibu Sari*, *Nanny Anna*`;

export const NANNY_ASK_AGE = 'What\'s your age?';
export const NANNY_ASK_EXPERIENCE = 'How many years of nanny/childcare experience do you have?';
export const NANNY_ASK_LANGUAGES = `Which languages can you speak?\n\n${numbered(LANGUAGES)}\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;
export const NANNY_ASK_LANG_RATING = (lang) =>
  `Rate your proficiency in ${lang}.\n⭐ 1 – Basic\n⭐ 2 – Elementary\n⭐ 3 – Good\n⭐ 4 – Very Good\n⭐ 5 – Fluent`;
export const NANNY_ASK_SKILLS = `What childcare skills do you have?\n\n${numbered(SKILLS)}\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;
export const NANNY_ASK_SKILL_RATING = (skill) =>
  `Rate your proficiency in ${skill}\n⭐ 1 – Beginner\n⭐ 2 – Basic\n⭐ 3 – Good\n⭐ 4 – Very Good\n⭐ 5 – Expert`;
export const NANNY_ASK_SUBJECTS = `Which subjects can you teach?\n\n${numbered(SUBJECTS)}\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;
export const NANNY_ASK_RATE = `What is your hourly rate in ${config.currency}?`;
export const NANNY_ASK_CPR = 'Are you CPR certified?\n\n1. Yes\n2. No';
export const NANNY_ASK_CPR_DOC = 'Please upload your *CPR certificate*.';
export const NANNY_ASK_ID_FRONT = 'Please upload your National Identity card document front image';
export const NANNY_ASK_ID_BACK = 'Please upload your National Identity card document back image';
export const NANNY_ASK_ADDRESS = 'Please provide your current residing address.';
export const NANNY_ASK_MAP = 'Please attach a google map location of your current residing address.\nType *None* if google map location is unavailable';
export const NANNY_ASK_PHOTO = 'Please upload your *profile photo*.';
/**
 * A short self-introduction video.
 *
 * Families are choosing who to leave a child with, and thirty seconds of
 * someone speaking says more than any list of skills. Optional, because
 * requiring it would block signups from anyone on a poor connection.
 */
export const NANNY_ASK_VIDEO = `\u{1F3A5} *Add a video and photos* (optional)

Add a video and photos showing you with the family or when you are working.

Record a short video (up to about 1 minute) saying hello, your name, your experience, and what you enjoy about caring for children.

Families see these on your profile, and nannies with a video get chosen more often.

\u{1F4F8} Keep adding videos and pictures from time to time — send them any time and we will add them to your profile.

\u{1F4CE} Send a video or photo now, or type *Skip* to do this later.`;

export const NANNY_VIDEO_SAVED = `\u{2705} Got it \u2014 your video has been saved and will show on your profile once our team has checked it.

Send another photo or video, or type *Done* to carry on.`;

export const NANNY_PHOTO_SAVED = `\u{2705} Photo saved \u2014 it will show on your profile once our team has checked it.

Send another photo or video, or type *Done* to carry on.`;

/**
 * She typed something at the media step that was neither a file nor a way of
 * saying she is finished. Restates both options plainly rather than repeating
 * the original ask, which she has evidently not read the way we hoped.
 */
export const NANNY_VIDEO_NOT_UNDERSTOOD = `\u{1F914} Sorry — I did not catch that.

\u{1F4CE} *Send* a photo or video, or
\u{2705} *Type "Done"* to carry on with your profile.`;

/**
 * Said on the way past after a second unrecognised answer. Nobody is held at
 * this step: she cannot be booked at all until she gets through it, so a
 * missing video is much the cheaper loss.
 */
export const NANNY_VIDEO_MOVING_ON = `No problem — let's carry on. You can add photos and videos any time from *My Profile*.`;

export const NANNY_VIDEO_WRONG_TYPE = `\u{274C} That does not look like a video. Please record and send a short video, or type *Skip*.`;

export const NANNY_VIDEO_TOO_LONG = `\u{26A0}\u{FE0F} That video is quite long. Please send one under about 2 minutes, or type *Skip*.`;

export const NANNY_ASK_DAYS = `Which days are you available in the week?\nYou can later change it from My Availability section\n\n${numbered(WEEKDAYS)}\n8. All days of the week\n\nSelect multiple with spaces or commas (e.g. 1 2 3)`;
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
  // She is the one collecting it, so she is told before she accepts.
  if (b.isEmergency && b.emergencySurcharge) {
    lines.push('', `⚡ *Emergency booking* — the family pays you an extra ${money(b.emergencySurcharge)} in cash on top of the usual transport fee when you arrive.`);
  }
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
