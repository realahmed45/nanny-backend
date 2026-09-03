import express from 'express';
import config from '../config/index.js';
import { handleMessage } from '../flows/index.js';
import { normalizePhone } from '../providers/ultramsg.js';

const router = express.Router();

/**
 * UltraMsg webhook.
 *
 * UltraMsg posts an event like:
 *   { event_type: 'message_received',
 *     data: { from: '971500000000@c.us', body: 'Hi', type: 'chat',
 *             media: '<url>', fromMe: false, ... } }
 *
 * We ACK immediately and process asynchronously so UltraMsg never times out
 * and never retries a message we already accepted.
 */
router.post('/ultramsg', async (req, res) => {
  // Optional shared-secret check.
  if (config.ultramsg.webhookToken) {
    const supplied = req.query.token || req.headers['x-webhook-token'];
    if (supplied !== config.ultramsg.webhookToken) {
      return res.status(401).json({ error: 'Invalid webhook token' });
    }
  }

  res.status(200).json({ ok: true });

  try {
    const payload = req.body || {};
    const event = payload.event_type || payload.eventType;
    if (event && event !== 'message_received') return;

    const data = payload.data || payload;

    // Ignore our own outbound echoes and group chats.
    if (data.fromMe === true || data.self === true || data.self === 'true') return;
    if (String(data.from || '').includes('@g.us')) return;

    const phone = normalizePhone(data.from || data.author || '');
    if (!phone) return;

    const type = data.type || 'chat';
    const media = data.media || data.url || null;

    // Location messages arrive as coordinates; turn them into a maps link.
    let text = data.body ?? data.text ?? '';
    if (type === 'location' && data.location) {
      const { latitude, longitude } = data.location;
      text = `https://maps.google.com/?q=${latitude},${longitude}`;
    }

    await handleMessage({
      phone,
      text,
      mediaUrl: ['image', 'document', 'video', 'audio', 'ptt'].includes(type) ? media : undefined,
      mediaId: data.id,
      // Voice notes arrive as 'ptt' (push-to-talk); the engine needs to
      // know so it can transcribe rather than treat them as an attachment.
      mediaType: type,
    });
  } catch (err) {
    console.error('[webhook] processing error:', err);
  }
});

/** Health probe for the webhook URL. */
router.get('/ultramsg', (req, res) => {
  res.json({ ok: true, service: 'my-nanny-whatsapp-webhook' });
});

export default router;
