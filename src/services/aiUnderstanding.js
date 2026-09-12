import config from '../config/index.js';

/**
 * Understand what someone meant, when the strict parser could not.
 *
 * The bot asks precise questions and expects precise answers — "1", "9 AM",
 * "1,3". That is reliable and cheap, and it is why the flow works at all. But
 * real people type "tomorrow morning around nine", "the second one", "cooking
 * and newborn care please", and get told the bot did not understand.
 *
 * This sits *behind* the existing parsers, never in front of them. A message
 * the normal rules can read is never sent anywhere: it is faster, free, and
 * cannot be misread by a model. Only the messages that would otherwise have
 * been rejected are interpreted, and the answer comes back in exactly the form
 * the flow already expects — a menu number, a time, a date. The conversation
 * structure does not change at all; it just stops being brittle about how
 * things are phrased.
 *
 * Deliberately conservative: a low temperature, a short reply, and anything
 * the model is unsure about comes back as "unclear" so the bot asks again
 * rather than guessing. Guessing wrong here books a nanny for the wrong day.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Free, fast, and good enough for one-line intent extraction. This is not
 * being asked to write prose — it turns "tomorrow morning" into a date.
 */
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

/** Shares the Groq key with transcription: one key, one account. */
const apiKey = () => config.ai.key || config.transcription.groqKey;

export const isConfigured = () => Boolean(apiKey());

/** How long to wait before giving up and letting the normal flow answer. */
const TIMEOUT_MS = 6000;

/**
 * Ask the model to read one message as an answer to one question.
 *
 * `expect` describes the shape wanted, in the words the prompt uses:
 *   choice   — a menu number, given the options
 *   time     — "HH:mm"
 *   date     — "YYYY-MM-DD"
 *   multi    — several menu numbers, comma separated
 *   yesno    — "yes" or "no"
 *   text     — free text, tidied
 *
 * Returns the interpreted string, or null when the model is unsure or the
 * call fails. Null always means "carry on as before", so nothing here can
 * make the bot worse than it was without it.
 */
export async function interpret({ message, question, expect, options = [], today }) {
  if (!isConfigured()) return null;
  const text = String(message || '').trim();
  if (!text || text.length > 400) return null;

  const optionList = options.length
    ? `\nThe options are:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : '';

  const shape = {
    choice: 'Reply with the option number alone, e.g. "2".',
    multi: 'Reply with the option numbers separated by commas, e.g. "1,3".',
    time: 'Reply with a 24-hour time alone, e.g. "14:30".',
    date: `Reply with a date alone in YYYY-MM-DD form. Today is ${today}.`,
    yesno: 'Reply with "yes" or "no" alone.',
    text: 'Reply with the cleaned-up answer alone.',
  }[expect] || 'Reply with the answer alone.';

  // The instruction leans hard on refusing rather than guessing: a wrong date
  // here is a nanny sent on the wrong day, which costs far more than asking
  // the question twice.
  const system = [
    'You interpret short WhatsApp replies for a childcare booking service.',
    'The user is answering one specific question.',
    'Decide what they meant and reply with ONLY the answer, no explanation.',
    'If you are not confident, reply with exactly: unclear',
    'Never invent details the user did not give.',
  ].join(' ');

  const user = `Question asked: ${question}${optionList}\n\nTheir reply: "${text}"\n\n${shape}`;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 24,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[ai] ${res.status} from Groq — falling back to the strict parser`);
      return null;
    }

    const data = await res.json();
    const answer = String(data.choices?.[0]?.message?.content || '').trim();

    if (!answer || /^unclear$/i.test(answer)) return null;
    // A model that starts explaining itself has not answered; treat it as a
    // refusal rather than trying to salvage a sentence.
    if (answer.length > 40 || /\s{2,}|\n/.test(answer)) return null;

    return answer.replace(/^["'`]|["'`.]$/g, '').trim();
  } catch (err) {
    // A timeout or a network blip must never break a conversation. The strict
    // parser already handled this message; we were only trying to do better.
    if (err.name !== 'TimeoutError') {
      console.error(`[ai] interpret failed: ${err.message}`);
    }
    return null;
  }
}

export default { interpret, isConfigured };
