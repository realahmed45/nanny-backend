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
    return String(data.choices?.[0]?.message?.content || '').trim() || null;
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
    system, user, maxTokens: 24, timeout: EXTRACT_TIMEOUT_MS, temperature: 0,
  });

  if (!answer || /^unclear$/i.test(answer)) return null;
  // A model that starts explaining itself has not answered.
  if (answer.length > 40 || /\s{2,}|\n/.test(answer)) return null;

  return answer.replace(/^["'`]|["'`.]$/g, '').trim();
}

/* ------------------------------------------------------------------ *
 * Replying like a person
 * ------------------------------------------------------------------ */

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
    'You are the assistant for Nanny in Paradise, replying on WhatsApp.',
    `You are talking to a ${role === 'nanny' ? 'nanny who works with us' : 'family looking for childcare'}.`,
    '',
    'FACTS YOU MAY USE:',
    FACTS,
    '',
    'RULES:',
    '1. Reply to what they actually said, warmly and briefly. Two or three sentences at most.',
    '2. Then ask the current question again, in your own words, so the booking can carry on.',
    '3. NEVER invent prices, nanny names, dates, availability or promises.',
    '   If you do not know, say our team will confirm it.',
    '4. If they ask something you cannot answer, say so plainly and offer to have someone call them.',
    '5. No markdown, no bullet points, no emoji spam. Plain WhatsApp text.',
    '6. Never ask them to email or phone anyone. Everything happens here.',
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
    maxTokens: 220,
    timeout: CHAT_TIMEOUT_MS,
    // A little warmth, but not enough to start improvising facts.
    temperature: 0.4,
  });

  if (!reply) return null;

  // A model that returns something enormous has lost the plot; the structured
  // prompt is better than a wall of text.
  if (reply.length > 700) return null;

  return reply;
}

export default { extract, converse, isConfigured };
