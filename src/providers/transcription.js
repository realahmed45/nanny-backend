import config from '../config/index.js';

/**
 * Speech-to-text for WhatsApp voice notes.
 *
 * People asked to describe a child's medical history or daily routine would
 * rather talk than type it on a phone, so the bot invites a voice message.
 * This turns that audio back into the text the conversation flow expects.
 *
 * Two backends, both Whisper-compatible and chosen by whichever key is set:
 *   - Groq    (GROQ_API_KEY)   — free tier, fast, whisper-large-v3
 *   - OpenAI  (OPENAI_API_KEY) — whisper-1
 *
 * With neither configured, transcription is off and a voice note is answered
 * with a short "please type it instead", rather than being silently ignored.
 *
 * No SDK: both expose the same multipart HTTP endpoint, and fetch is built in.
 */

const ENDPOINTS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3',
    key: () => config.transcription.groqKey,
  },
  openai: {
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    key: () => config.transcription.openaiKey,
  },
};

/** Which backend is in use, or null when transcription is not configured. */
export function activeProvider() {
  if (config.transcription.groqKey) return 'groq';
  if (config.transcription.openaiKey) return 'openai';
  return null;
}

export const isConfigured = () => activeProvider() !== null;

/** Whisper rejects anything much over 25 MB; a voice note is far smaller. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Download a WhatsApp media URL and transcribe it.
 * Returns the text, or null when transcription is unavailable or fails —
 * callers fall back to asking for typed input rather than losing the answer.
 */
export async function transcribe(mediaUrl, { language } = {}) {
  const provider = activeProvider();
  if (!provider || !mediaUrl) return null;

  const { url: defaultUrl, model, key } = ENDPOINTS[provider];
  // A configured base replaces the vendor host, keeping the same path.
  const url = config.transcription.baseUrl
    ? `${config.transcription.baseUrl.replace(/\/+$/, '')}/${new URL(defaultUrl).pathname.replace(/^\/+/, '')}`
    : defaultUrl;

  try {
    const audioRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(20_000) });
    if (!audioRes.ok) throw new Error(`could not fetch audio (${audioRes.status})`);

    const audio = await audioRes.blob();
    if (audio.size > MAX_BYTES) throw new Error('audio is too large to transcribe');
    if (audio.size === 0) throw new Error('audio is empty');

    const form = new FormData();
    // WhatsApp voice notes are OGG/Opus; the filename is what tells the API.
    form.append('file', audio, 'voice-note.ogg');
    form.append('model', model);
    form.append('response_format', 'text');
    // Leaving language unset lets Whisper detect it, which matters for a
    // market where people switch between languages mid-sentence.
    if (language) form.append('language', language);

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${provider} returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const text = (await res.text()).trim();
    return text || null;
  } catch (err) {
    // Never throw into the conversation: a failed transcription should ask
    // the family to type instead, not break the booking they are part-way
    // through.
    console.error(`[transcription] ${err.message}`);
    return null;
  }
}

export default { transcribe, isConfigured, activeProvider };
