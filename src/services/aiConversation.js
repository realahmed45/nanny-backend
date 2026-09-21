import config from '../config/index.js';

/**
 * Talking like a person, while still collecting the same answers.
 *
 * The structured bot asks a fixed question and accepts a fixed answer. That is
 * reliable, and it is also why it feels like filling in a form: ask it
 * anything off-script — "do you have someone who can cook?", "is that price
 * for the whole week?", "sorry what was the question" — and it repeats itself.
 *
 * This is the other half. The sequence of steps does not change: the same
 * questions are asked in the same order and the same answers are stored. What
 * changes is that a reply which is not an answer gets a real reply, and the
 * question is then put again in context rather than pasted again verbatim.
 *
 * Two jobs, deliberately kept apart:
 *
 *   extract  — is this an answer? Return it in the exact form the flow wants.
 *   converse — it was not an answer. Say something useful, then ask again.
 *
 * Extraction stays cold and literal, because a wrong date books a nanny for
 * the wrong day. Only the conversation around it is allowed to be warm.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * The model, and why this one.
 *
 * Groq retired llama-3.3-70b-versatile in August 2026 and every call to it now
 * returns 404 model_not_found — which is silent from the outside, because a
 * failed call falls back to the strict parser and the bot simply carries on
 * being rigid. This is their named replacement. Overridable, so the next
 * retirement is an environment variable rather than a deploy.
 */
const MODEL = () => config.ai.model || 'openai/gpt-oss-120b';

/** Shares the Groq key with transcription: one key, one account. */
const apiKey = () => config.ai.key || config.transcription.groqKey;

export const isConfigured = () => Boolean(apiKey());

/** Extraction must be quick — someone is waiting mid-conversation. */
const EXTRACT_TIMEOUT_MS = 6000;

/** A written reply can take a little longer; it is the whole response. */
const CHAT_TIMEOUT_MS = 9000;

/**
 * One call to the model, with everything that can go wrong handled.
 *
 * Every failure path returns null, and null always means "carry on exactly as
 * the structured bot would have". Nothing here can make the bot worse than it
 * was without it.
 */
async function ask({ system, user, maxTokens, timeout, temperature }) {
  if (!isConfigured()) return null;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Named loudly, because the usual cause is a retired model and the only
      // symptom otherwise is the bot quietly staying rigid forever.
      console.error(`[ai] ${res.status} from Groq using model "${MODEL()}" — ${detail.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const content = String(choice?.message?.content || '').trim();
    if (!content) return null;

    // Stopped because it ran out of room, not because it had finished. The
    // reply is a sentence cut in half — usually losing the question at the end
    // of it, which is the one part that has to be there.
    if (choice.finish_reason === 'length') {
      console.error('[ai] reply hit the token limit and was cut off; using the original wording');
      return null;
    }

    return content;
  } catch (err) {
    if (err.name !== 'TimeoutError') console.error(`[ai] call failed: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Reading an answer
 * ------------------------------------------------------------------ */

const SHAPES = {
  choice: 'Reply with the option number alone, e.g. "2".',
  multi: 'Reply with the option numbers separated by commas, e.g. "1,3".',
  time: 'Reply with a 24-hour time alone, e.g. "14:30".',
  date: 'Reply with a date alone in YYYY-MM-DD form.',
  yesno: 'Reply with "yes" or "no" alone.',
  text: 'Reply with the cleaned-up answer alone.',
};

/**
 * Does the extracted answer match the shape the question asked for?
 *
 * Each case is a real failure mode of a model that was asked politely and
 * answered in its own format anyway. The out-of-range option number is the
 * dangerous one: it looks like a valid choice to everything downstream.
 */
function matchesShape(value, expect, optionCount) {
  switch (expect) {
    case 'choice': {
      if (!/^\d+$/.test(value)) return false;
      const n = Number(value);
      return n >= 1 && (!optionCount || n <= optionCount);
    }
    case 'multi': {
      if (!/^\d+(\s*,\s*\d+)*$/.test(value)) return false;
      return value.split(',').every((part) => {
        const n = Number(part.trim());
        return n >= 1 && (!optionCount || n <= optionCount);
      });
    }
    case 'time':
      // 24-hour, as asked for. "2pm" is a failure here, not a near miss:
      // handlers parse HH:MM and nothing else.
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      // Shape alone still admits 2026-02-31, so round-trip through Date to
      // catch the days that do not exist.
      const d = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
    }
    case 'yesno':
      return /^(yes|no)$/i.test(value);
    default:
      return true;
  }
}

/**
 * Is this message an answer to the question, and what is it?
 *
 * Unchanged in spirit from the original: cold, literal, and quick to give up.
 * "unclear" is a perfectly good outcome — it hands the message to `converse`,
 * which is better at not knowing.
 */
export async function extract({ message, question, expect, options = [], today }) {
  const text = String(message || '').trim();
  if (!text || text.length > 400) return null;

  const optionList = options.length
    ? `\nThe options are:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : '';

  const shape = expect === 'date'
    ? `${SHAPES.date} Today is ${today}.`
    : (SHAPES[expect] || 'Reply with the answer alone.');

  const system = [
    'You interpret short WhatsApp replies for a childcare booking service.',
    'The user is answering one specific question.',
    'Decide what they meant and reply with ONLY the answer, no explanation.',
    'If the message is a question, a complaint, or anything other than an answer,',
    'reply with exactly: unclear',
    'If you are not confident, reply with exactly: unclear',
    'Never invent details the user did not give.',
  ].join(' ');

  const user = `Question asked: ${question}${optionList}\n\nTheir reply: "${text}"\n\n${shape}`;

  const answer = await ask({
    system, user, maxTokens: 300, timeout: EXTRACT_TIMEOUT_MS, temperature: 0,
  });

  if (!answer || /^unclear$/i.test(answer)) return null;
  // A model that starts explaining itself has not answered. The budget is
  // large because this model reasons before replying; the answer it settles on
  // still has to be a few characters.
  if (answer.length > 40 || /\s{2,}|\n/.test(answer)) return null;

  const cleaned = answer.replace(/^["'`]|["'`.]$/g, '').trim();
  if (!cleaned) return null;

  // Check the answer is actually the shape we asked for.
  //
  // Everything above this point trusts the model to have followed the
  // instruction. It usually does — but "unclear" is not the only way it can
  // fail, and the others are silent: a date that comes back as "next Tuesday",
  // or an option number of "7" when there are four options, both flow straight
  // into the handler. The handler then rejects them, which reads to the family
  // as the bot ignoring her. Worse, a plausible-but-wrong date books a nanny
  // for the wrong day, which is the one failure nobody notices until someone
  // is standing at a door.
  //
  // So: anything not in the requested shape becomes null, and null hands the
  // message to converse(), which is good at not knowing.
  if (!matchesShape(cleaned, expect, options.length)) {
    console.error(`[ai] extracted "${cleaned}" is not a valid ${expect}; treating as unclear`);
    return null;
  }

  return cleaned;
}

/* ------------------------------------------------------------------ *
 * Replying like a person
 * ------------------------------------------------------------------ */

/**
 * Answer what they actually said, then ask the question again.
 *
 * This is the part that makes it feel like a conversation rather than a form.
 * Someone who asks "how much is it for three days?" mid-booking gets an
 * answer, not the same question pasted back at them.
 *
 * The hard rules:
 *
 *   - Never invent a price, a name, a date or a promise. If it is not in the
 *     facts or the conversation, say we will confirm it.
 *   - Always end by asking the current question again, in her own words, so
 *     the flow can carry on. A friendly reply that forgets to ask is a dead
 *     end.
 *   - Short. This is WhatsApp on a phone, not an essay.
 */
export async function converse({
  message, question, options = [], role = 'customer', history = [],
}) {
  const text = String(message || '').trim();
  if (!text || text.length > 600) return null;

  const optionList = options.length
    ? `\nThe options for the current question are:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : '';

  // A few turns of context, so "what about the other one?" means something.
  const recent = history.slice(-6)
    .map((h) => `${h.from === 'user' ? 'Them' : 'You'}: ${h.text}`)
    .join('\n');

  const system = [
    VOICE,
    `You are talking to a ${role === 'nanny' ? 'nanny who works with us' : 'family looking for childcare'}.`,
    '',
    'FACTS YOU MAY USE:',
    FACTS,
    '',
    'YOUR TASK:',
    '1. Reply to what they actually said, warmly and briefly.',
    '2. Then ask the current question again, in your own words, so the booking',
    '   can carry on. A friendly reply that forgets to ask is a dead end.',
    '3. If they asked something you cannot answer, say so plainly and offer to',
    '   have someone from the team call them.',
    '4. If the question has options, include them exactly as numbered.',
    '',
    'SHAPE OF YOUR REPLY:',
    'Send the answer and the question as separate messages, split by a --- line.',
    'Two messages is usually right. Three at most.',
    '',
    'Example of the shape (not the words):',
    'Yes, every nanny is interviewed and ID-checked before she appears. 😊',
    '---',
    'So which languages would you like her to speak?',
  ].join('\n');

  const user = [
    recent ? `Recent conversation:\n${recent}\n` : '',
    `The question you need answered is: ${question}${optionList}`,
    '',
    `They just said: "${text}"`,
    '',
    'Reply to them, then ask the question again naturally.',
  ].join('\n');

  const reply = await ask({
    system,
    user,
    // Generous on purpose: this model thinks before it writes, and the
    // reasoning comes out of the same budget. Too tight and every reply
    // ends mid-sentence.
    maxTokens: 700,
    timeout: CHAT_TIMEOUT_MS,
    // A little warmth, but not enough to start improvising facts.
    temperature: 0.4,
  });

  if (!reply) return null;

  // A model that returns something enormous has lost the plot; the structured
  // prompt is better than a wall of text.
  if (reply.length > 700) return null;

  // The whole contract of this function is "answer them, then ask again". A
  // reply that answers warmly and forgets to ask is a dead end: the flow is
  // still waiting on that question, she has nothing to respond to, and the
  // booking stops with no error anywhere. Falling back to the original prompt
  // is mechanical but it always moves.
  if (!/\?/.test(reply)) {
    console.error('[ai] conversational reply asked nothing; using the original question');
    return null;
  }

  // Arrives as one string with --- between the parts; the caller wants the
  // separate WhatsApp messages it is meant to become.
  const parts = splitForWhatsApp(reply);
  return parts.length ? parts : null;
}

/* ------------------------------------------------------------------ *
 * Saying the next question in its own words
 * ------------------------------------------------------------------ */

/**
 * The bot's voice, used by everything that writes a sentence.
 *
 * Kept in one place so warmth does not drift between the two paths — answering
 * a question and asking the next one — and so the rules about not inventing
 * anything are stated once.
 */
const VOICE = [
  'You are the assistant for Nanny in Paradise, a nanny booking service in Bali.',
  'You speak on WhatsApp: warm, brief, and human. Never robotic.',
  '',
  'HOW YOU WRITE ON WHATSAPP:',
  '- Short messages. One thought per message, the way a person texts.',
  '- A long paragraph is wrong here. Break it into separate messages instead.',
  '- Separate messages with a line containing only ---',
  '- Never more than 3 messages. Keep each under 250 characters.',
  '- Answer first. The question you need answered goes last, in its own message.',
  '',
  'FORMATTING (WhatsApp, not markdown):',
  '- *bold* is single asterisks. Use it for the one thing that matters most.',
  '- _italic_ is single underscores. Use it rarely.',
  '- Never use **double asterisks**, # headings, or - dashes as bullets.',
  '- In a list, put each item on its own line. Numbered options stay numbered.',
  '- Leave a blank line between a sentence and a list so both are easy to read.',
  '- One or two emoji per message, only where they help. Never a row of them.',
  '',
  'NEVER:',
  '- Invent prices, nanny names, dates, availability or promises.',
  '- Ask anyone to email or phone. Everything happens in this chat.',
  '- Repeat a question word for word if you have just asked it.',
].join('\n');

/* ------------------------------------------------------------------ *
 * Turning one AI reply into WhatsApp-shaped messages
 * ------------------------------------------------------------------ */

/**
 * Tidy the formatting a model reaches for out of habit.
 *
 * It is trained on markdown, so it writes **bold** and "- item" no matter what
 * the prompt says. WhatsApp renders neither: the asterisks show up as
 * asterisks. Rather than hope the instruction sticks, translate the output.
 */
function toWhatsAppMarkup(text) {
  return String(text || '')
    // **bold** and __bold__ are markdown; WhatsApp bold is a single asterisk.
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // Headings have no meaning here; keep the words, drop the hashes.
    .replace(/^#{1,6}\s*/gm, '')
    // Bullets written as - or * become a middle dot, which survives WhatsApp
    // intact and does not collide with its bold syntax.
    .replace(/^[ \t]*[-*][ \t]+/gm, '\u00b7 ')
    // Three or more blank lines is always a formatting accident.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split one reply into the separate WhatsApp messages it should arrive as.
 *
 * The model is asked to mark the breaks with a --- line. When it does, honour
 * that. When it does not — and it often does not — fall back to paragraph
 * breaks, so a wall of text still arrives as something readable.
 *
 * Capped at MAX_BUBBLES: a phone buzzing six times for one answer is worse
 * than one slightly long message.
 */
const MAX_BUBBLES = 3;
const MAX_BUBBLE_CHARS = 400;

export function splitForWhatsApp(reply) {
  const clean = toWhatsAppMarkup(reply);
  if (!clean) return [];

  let parts = clean.includes('---')
    ? clean.split(/^\s*-{3,}\s*$/m)
    : clean.split(/\n{2,}/);

  parts = parts.map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return [];

  // Anything past the cap is folded back into the last message rather than
  // dropped, so no part of the answer is silently lost.
  if (parts.length > MAX_BUBBLES) {
    const keep = parts.slice(0, MAX_BUBBLES - 1);
    keep.push(parts.slice(MAX_BUBBLES - 1).join('\n\n'));
    parts = keep;
  }

  // A message that runs past MAX_BUBBLE_CHARS is split again at a sentence
  // end, never mid-sentence: a screenful in one bubble defeats the point of
  // texting like a person, but a sentence cut in half is worse than a long one.
  // Only the overflow moves, and only when there is room left under the cap.
  const sized = [];
  for (const part of parts) {
    if (part.length <= MAX_BUBBLE_CHARS || sized.length >= MAX_BUBBLES) {
      sized.push(part);
      continue;
    }
    const cut = part.lastIndexOf('. ', MAX_BUBBLE_CHARS);
    if (cut < MAX_BUBBLE_CHARS * 0.5) {
      sized.push(part);
      continue;
    }
    sized.push(part.slice(0, cut + 1).trim());
    sized.push(part.slice(cut + 1).trim());
  }
  return sized.slice(0, MAX_BUBBLES);
}

/** What the bot may say about the business, so it cannot invent terms. */
const FACTS = [
  'We are Nanny in Paradise, a nanny booking service in Bali, Indonesia.',
  'Families book nannies through WhatsApp. Prices are in Indonesian Rupiah.',
  'Every nanny is interviewed, ID-checked and verified by our team before she appears.',
  'Bookings can be for one day or many, and there is an emergency option for urgent care.',
  'Payment is by bank transfer and confirmed by our team.',
  'A family and a nanny never exchange phone numbers; messages are passed through us.',
].join(' ');

/**
 * Put the next question in the bot's own words.
 *
 * This is what makes AI mode a conversation rather than a form with a helpful
 * error message. Without it the bot answers warmly when someone goes off
 * script, then snaps straight back to a numbered list for the next step —
 * which is more jarring than being consistently mechanical.
 *
 * The options are kept, and kept numbered. They are how she answers, and
 * hiding them to sound casual would leave her guessing what to type. What
 * changes is everything around them.
 *
 * Returns null on any doubt, and null means the original prompt is sent
 * unchanged — so a bad rewrite is never worse than no rewrite.
 */
export async function rephrase({ question, options = [], role = 'customer', history = [], justSaid }) {
  const text = String(question || '').trim();
  if (!text || text.length > 900) return null;

  // Nothing to gain from rewriting a bare confirmation or a one-word prompt.
  if (text.length < 25) return null;

  const optionList = options.length
    ? `\n\nThese are the options, and they must appear in your reply exactly as numbered:\n${
      options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : '';

  const recent = history.slice(-4)
    .map((h) => `${h.from === 'user' ? 'Them' : 'You'}: ${h.text}`)
    .join('\n');

  const system = [
    VOICE,
    '',
    'FACTS YOU MAY USE:',
    FACTS,
    '',
    'YOUR TASK:',
    'You are given the next question the booking needs answered, written in a',
    'plain, form-like way. Rewrite it so it sounds like you asking, not a form.',
    'Keep the exact meaning. Keep every option, numbered exactly as given.',
    'Do not answer it yourself. Do not add questions of your own.',
  ].join('\n');

  const user = [
    recent ? `Recent conversation:\n${recent}\n` : '',
    justSaid ? `They just told you: "${String(justSaid).slice(0, 200)}"\n` : '',
    `The question to ask, as written by the system:\n"""\n${text}\n"""${optionList}`,
    '',
    justSaid
      ? 'Acknowledge briefly what they just said, then ask the question in your own words.'
      : 'Ask the question in your own words.',
  ].join('\n');

  const reply = await ask({
    system, user, maxTokens: 700, timeout: CHAT_TIMEOUT_MS, temperature: 0.4,
  });

  if (!reply) return null;
  if (reply.length > 900) return null;

  // If the question had options, they must have survived. A rewrite that
  // dropped them leaves her with no idea what to type.
  if (options.length) {
    const kept = options.filter((_, i) => reply.includes(String(i + 1))).length;
    if (kept < options.length) return null;
  }

  const parts = splitForWhatsApp(reply);
  if (!parts.length) return null;

  // A numbered list split across two messages is unusable — she sees "1. Yes"
  // arrive without the question that gave it meaning. So when the question
  // carries options, it stays whole however the model chose to break it up.
  if (options.length) return [parts.join('\n\n')];

  return parts;
}

export default { extract, converse, rephrase, isConfigured };
