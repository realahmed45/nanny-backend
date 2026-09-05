import { on, mainMenuFor } from './engine.js';
import { makeNameHandler, makeEmailHandler, makeOtpHandler } from './common.js';
import { User } from '../models/index.js';
import {
  USER_ROLE, NANNY_STATUS, LANGUAGES, SKILLS, SUBJECTS, WEEKDAYS, DURATION_OPTIONS,
} from '../utils/constants.js';
import {
  parseChoice, parseMultiChoice, pickFrom, parseMoney, parseInteger,
  parseTime, parseMapUrl, parseWeekdays, clean,
} from '../utils/parse.js';
import { money } from '../utils/format.js';
import * as M from '../utils/messages.js';

/* ------------------------------------------------------------------ *
 * Account creation
 * ------------------------------------------------------------------ */

on('NANNY_REG_NAME', makeNameHandler('NANNY_REG_EMAIL'));
on('NANNY_REG_EMAIL', makeEmailHandler('NANNY_REG_OTP'));
on('NANNY_REG_OTP', makeOtpHandler({
  role: USER_ROLE.NANNY,
  onVerified: async (ctx, user) => {
    const firstName = (user.fullName || '').split(' ')[0];
    return [
      { text: `✅ Your account has been verified.\n\nWelcome to My Nanny, ${firstName}!\n\nLet's complete your nanny profile.` },
      { text: M.NANNY_ASK_NICKNAME, state: 'NR_NICKNAME', user: user._id },
    ];
  },
}));

on('NANNY_REG_RESUME', async (ctx) => {
  // Resume at the first thing still missing, so nobody is asked twice.
  const { User } = await import('../models/index.js');
  const user = await User.findById(ctx.session.user);
  return user?.nickname
    ? { text: M.NANNY_ASK_AGE, state: 'NR_AGE' }
    : { text: M.NANNY_ASK_NICKNAME, state: 'NR_NICKNAME' };
});

const nicknameHandler = async (ctx) => {
  const nickname = clean(ctx.text);
  if (nickname.length < 2) {
    return 'Please give a name families can call you \u{2014} at least 2 characters.';
  }
  if (nickname.length > 30) {
    return 'That is a little long. Please keep it under 30 characters.';
  }

  ctx.set('nickname', nickname);
  const { User } = await import('../models/index.js');
  await User.findByIdAndUpdate(ctx.session.user, { nickname });

  return [
    { text: `Lovely \u{2014} families will see you as *${nickname}*.` },
    { text: M.NANNY_ASK_AGE, state: 'NR_AGE' },
  ];
};
nicknameHandler.prompt = () => M.NANNY_ASK_NICKNAME;
on('NR_NICKNAME', nicknameHandler);

/* ------------------------------------------------------------------ *
 * Profile setup
 * ------------------------------------------------------------------ */

const ageHandler = async (ctx) => {
  const age = parseInteger(ctx.text, { min: 16, max: 80 });
  if (!age) return '❌ Please enter your age as a number (16–80).';
  ctx.set('age', age);
  return { text: M.NANNY_ASK_EXPERIENCE, state: 'NR_EXPERIENCE' };
};
ageHandler.prompt = () => M.NANNY_ASK_AGE;
on('NR_AGE', ageHandler);

const experienceHandler = async (ctx) => {
  const years = parseInteger(ctx.text, { min: 0, max: 60 });
  if (years === null) return '❌ Please enter the number of years, for example *5*.';
  ctx.set('experienceYears', years);
  return { text: M.NANNY_ASK_LANGUAGES, state: 'NR_LANGUAGES' };
};
experienceHandler.prompt = () => M.NANNY_ASK_EXPERIENCE;
on('NR_EXPERIENCE', experienceHandler);

const languagesHandler = async (ctx) => {
  const idx = parseMultiChoice(ctx.text, LANGUAGES.length);
  if (!idx) return M.NANNY_ASK_LANGUAGES;
  const langs = pickFrom(LANGUAGES, idx);
  ctx.merge({ langQueue: langs, languages: [], langIndex: 0 });
  return {
    text: `Great!\n${M.NANNY_ASK_LANG_RATING(langs[0])}`,
    state: 'NR_LANG_RATING',
  };
};
languagesHandler.prompt = () => M.NANNY_ASK_LANGUAGES;
on('NR_LANGUAGES', languagesHandler);

/** Collect a 1–5 rating for each selected language, one at a time. */
const langRatingHandler = async (ctx) => {
  const queue = ctx.get('langQueue', []);
  const i = ctx.get('langIndex', 0);
  const rating = parseChoice(ctx.text, 5);
  if (!rating) return M.NANNY_ASK_LANG_RATING(queue[i]);

  const languages = [...(ctx.get('languages') || []), { name: queue[i], rating }];
  const next = i + 1;
  ctx.merge({ languages, langIndex: next });

  if (next < queue.length) {
    return { text: M.NANNY_ASK_LANG_RATING(queue[next]), state: 'NR_LANG_RATING', noPush: true };
  }
  return { text: M.NANNY_ASK_SKILLS, state: 'NR_SKILLS' };
};
langRatingHandler.prompt = (ctx) => M.NANNY_ASK_LANG_RATING(ctx.get('langQueue', [])[ctx.get('langIndex', 0)]);
on('NR_LANG_RATING', langRatingHandler);

const skillsHandler = async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SKILLS.length);
  if (!idx) return M.NANNY_ASK_SKILLS;
  const skills = pickFrom(SKILLS, idx);
  ctx.merge({ skillQueue: skills, skills: [], skillIndex: 0 });
  return {
    text: `Great!\n${M.NANNY_ASK_SKILL_RATING(skills[0])}`,
    state: 'NR_SKILL_RATING',
  };
};
skillsHandler.prompt = () => M.NANNY_ASK_SKILLS;
on('NR_SKILLS', skillsHandler);

const skillRatingHandler = async (ctx) => {
  const queue = ctx.get('skillQueue', []);
  const i = ctx.get('skillIndex', 0);
  const rating = parseChoice(ctx.text, 5);
  if (!rating) return M.NANNY_ASK_SKILL_RATING(queue[i]);

  const skills = [...(ctx.get('skills') || []), { name: queue[i], rating }];
  const next = i + 1;
  ctx.merge({ skills, skillIndex: next });

  if (next < queue.length) {
    return { text: M.NANNY_ASK_SKILL_RATING(queue[next]), state: 'NR_SKILL_RATING', noPush: true };
  }
  // Subjects only matter when the nanny offers tutoring.
  if (queue.includes('Tutoring')) {
    return { text: M.NANNY_ASK_SUBJECTS, state: 'NR_SUBJECTS' };
  }
  ctx.set('subjects', []);
  return { text: M.NANNY_ASK_RATE, state: 'NR_RATE' };
};
skillRatingHandler.prompt = (ctx) => M.NANNY_ASK_SKILL_RATING(ctx.get('skillQueue', [])[ctx.get('skillIndex', 0)]);
on('NR_SKILL_RATING', skillRatingHandler);

const subjectsHandler = async (ctx) => {
  const idx = parseMultiChoice(ctx.text, SUBJECTS.length);
  if (!idx) return M.NANNY_ASK_SUBJECTS;
  ctx.set('subjects', pickFrom(SUBJECTS, idx));
  return { text: M.NANNY_ASK_RATE, state: 'NR_RATE' };
};
subjectsHandler.prompt = () => M.NANNY_ASK_SUBJECTS;
on('NR_SUBJECTS', subjectsHandler);

const rateHandler = async (ctx) => {
  const rate = parseMoney(ctx.text);
  if (rate === null || rate <= 0) return `❌ Please enter your hourly rate, for example *${money(150000)}*.`;
  ctx.set('hourlyRate', rate);
  return { text: M.NANNY_ASK_CPR, state: 'NR_CPR' };
};
rateHandler.prompt = () => M.NANNY_ASK_RATE;
on('NR_RATE', rateHandler);

const cprHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, 2);
  if (!choice) return M.NANNY_ASK_CPR;
  const certified = choice === 1;
  ctx.set('cprCertified', certified);
  if (certified) return { text: M.NANNY_ASK_CPR_DOC, state: 'NR_CPR_DOC' };
  return { text: M.NANNY_ASK_ID_FRONT, state: 'NR_ID_FRONT' };
};
cprHandler.prompt = () => M.NANNY_ASK_CPR;
on('NR_CPR', cprHandler);

/** Document upload steps all share the same shape. */
function docStep(state, type, nextPrompt, nextState) {
  const handler = async (ctx) => {
    if (!ctx.mediaUrl) return `📎 Please attach the document as an image or file.`;
    const docs = [...(ctx.get('documents') || []), { type, url: ctx.mediaUrl, mediaId: ctx.mediaId }];
    ctx.set('documents', docs);
    return { text: nextPrompt, state: nextState };
  };
  handler.prompt = () => `📎 Please attach the document.`;
  on(state, handler);
}

docStep('NR_CPR_DOC', 'cpr_certificate', M.NANNY_ASK_ID_FRONT, 'NR_ID_FRONT');
docStep('NR_ID_FRONT', 'id_front', M.NANNY_ASK_ID_BACK, 'NR_ID_BACK');
docStep('NR_ID_BACK', 'id_back', M.NANNY_ASK_ADDRESS, 'NR_ADDRESS');

const addressHandler = async (ctx) => {
  const line = clean(ctx.text);
  if (line.length < 3) return M.NANNY_ASK_ADDRESS;
  ctx.set('residingAddress', line);
  return { text: M.NANNY_ASK_MAP, state: 'NR_MAP' };
};
addressHandler.prompt = () => M.NANNY_ASK_ADDRESS;
on('NR_ADDRESS', addressHandler);

const mapHandler = async (ctx) => {
  const parsed = parseMapUrl(ctx.text);
  if (!parsed) return '❌ Please share a Google Maps link, or type *None*.';
  ctx.set('residingMapUrl', parsed.url);
  return { text: M.NANNY_ASK_PHOTO, state: 'NR_PHOTO' };
};
mapHandler.prompt = () => M.NANNY_ASK_MAP;
on('NR_MAP', mapHandler);

const photoHandler = async (ctx) => {
  if (!ctx.mediaUrl) return `📎 Please attach your profile photo.`;
  ctx.set('profilePhotoUrl', ctx.mediaUrl);
  return { text: M.NANNY_ASK_VIDEO, state: 'NR_VIDEO' };
};
photoHandler.prompt = () => M.NANNY_ASK_PHOTO;
on('NR_PHOTO', photoHandler);

/**
 * Her presentation video.
 *
 * Skippable, and a wrong attachment is explained rather than silently
 * accepted: a photo saved as a video would show families a still frame where
 * they expected someone talking.
 */
const videoHandler = async (ctx) => {
  // "Done" and "Skip" both move on: she may have sent several already, or
  // none at all, and either way this is how she leaves.
  if (ctx.command === 'SKIP' || ctx.command === 'NONE'
      || /^(skip|done)$/i.test(String(ctx.text || '').trim())) {
    return { text: M.NANNY_ASK_DAYS, state: 'NR_DAYS' };
  }

  if (!ctx.mediaUrl) return M.NANNY_ASK_VIDEO;

  // We ask for a video and photos, so both are accepted; anything else is
  // explained rather than saved as a broken profile.
  const type = String(ctx.mediaType || '').toLowerCase();
  const isImage = type.includes('image');
  if (type && !type.includes('video') && !isImage) {
    return M.NANNY_VIDEO_WRONG_TYPE;
  }

  // She may send several before moving on, so collect rather than replace and
  // stay put until she says she is done.
  if (isImage) {
    ctx.set('introPhotoUrls', [...ctx.get('introPhotoUrls', []), ctx.mediaUrl].slice(0, 10));
    return M.NANNY_PHOTO_SAVED;
  }

  ctx.set('introVideoUrl', ctx.mediaUrl);
  ctx.set('introVideoMediaId', ctx.mediaId);

  return M.NANNY_VIDEO_SAVED;
};
videoHandler.prompt = () => M.NANNY_ASK_VIDEO;
on('NR_VIDEO', videoHandler);

const daysHandler = async (ctx) => {
  const days = parseWeekdays(ctx.text);
  if (!days) return M.NANNY_ASK_DAYS;
  ctx.set('availableDays', days);
  return { text: M.NANNY_ASK_AVAIL_START, state: 'NR_AVAIL_START' };
};
daysHandler.prompt = () => M.NANNY_ASK_DAYS;
on('NR_DAYS', daysHandler);

const availStartHandler = async (ctx) => {
  const time = parseTime(ctx.text);
  if (!time) return '❌ Please enter a time like *9:00 AM*.';
  ctx.set('availStart', time);
  return { text: M.NANNY_ASK_AVAIL_HOURS, state: 'NR_AVAIL_HOURS' };
};
availStartHandler.prompt = () => M.NANNY_ASK_AVAIL_START;
on('NR_AVAIL_START', availStartHandler);

/** Final step: persist everything onto the User and submit for verification. */
const availHoursHandler = async (ctx) => {
  const choice = parseChoice(ctx.text, DURATION_OPTIONS.length);
  if (!choice) return M.NANNY_ASK_AVAIL_HOURS;

  const user = await User.findById(ctx.session.user);
  if (!user) return { text: M.WELCOME_NANNY, state: 'START' };

  user.age = ctx.get('age');
  user.experienceYears = ctx.get('experienceYears');
  user.languages = ctx.get('languages', []);
  user.skills = ctx.get('skills', []);
  user.subjects = ctx.get('subjects', []);
  user.hourlyRate = ctx.get('hourlyRate');
  user.cprCertified = !!ctx.get('cprCertified');
  user.residingAddress = ctx.get('residingAddress');
  user.residingMapUrl = ctx.get('residingMapUrl');
  user.profilePhotoUrl = ctx.get('profilePhotoUrl');
  user.documents = ctx.get('documents', []);

  // Held back from families until someone has watched it.
  const videoUrl = ctx.get('introVideoUrl');
  if (videoUrl) {
    user.videos = [{ url: videoUrl, title: 'Introduction', approved: false }];
  }
  // Same gate as the video: these show other people's children.
  const photoUrls = ctx.get('introPhotoUrls', []);
  if (photoUrls.length) {
    user.photos = photoUrls.map((url) => ({ url, approved: false }));
  }
  user.availability = {
    days: ctx.get('availableDays', []),
    startTime: ctx.get('availStart'),
    maxHoursPerDay: DURATION_OPTIONS[choice - 1],
    blockedDates: [],
  };
  user.nannyStatus = NANNY_STATUS.PENDING_VERIFICATION;
  user.registrationComplete = true;
  await user.save();

  return {
    text: M.NANNY_PROFILE_SUBMITTED,
    state: 'NANNY_PENDING_VERIFICATION',
    resetData: true,
    clearStack: true,
  };
};
availHoursHandler.prompt = () => M.NANNY_ASK_AVAIL_HOURS;
on('NR_AVAIL_HOURS', availHoursHandler);

/** Holding state while admin reviews the profile. */
on('NANNY_PENDING_VERIFICATION', async (ctx) => {
  const user = await User.findById(ctx.session.user);
  if (user?.nannyStatus === NANNY_STATUS.VERIFIED) {
    return { text: `${M.NANNY_VERIFIED}\n\n${M.NANNY_MAIN_MENU}`, state: 'NANNY_MAIN_MENU' };
  }
  if (user?.nannyStatus === NANNY_STATUS.REJECTED) {
    return M.NANNY_REJECTED(user.rejectionReason);
  }
  return `⏳ Your profile is still under review.

Our team is verifying your documents. We'll message you the moment you're approved.`;
});

export default {};
