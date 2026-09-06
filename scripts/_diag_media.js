import 'dotenv/config';
import mongoose from 'mongoose';
import { MessageLog, User } from '../src/models/index.js';

await mongoose.connect(process.env.MONGODB_URI);

const n = await User.findOne({ role: 'nanny', fullName: /ahmed/i })
  .select('fullName phone videos photos').lean();

const savedV = new Set((n.videos || []).map((v) => v.url));
const savedP = new Set((n.photos || []).map((p) => p.url));

const logs = await MessageLog.find({
  $or: [{ phone: n.phone }, { from: n.phone }, { to: n.phone }],
}).sort({ createdAt: 1 }).limit(120).lean();

for (const l of logs) {
  const blob = JSON.stringify(l);
  if (!/ultramsgmedia/.test(blob)) continue;

  // Print the whole row's shape once so we can see which field names carry
  // the media type, rather than guessing from the URL.
  console.log('---', new Date(l.createdAt).toISOString().slice(0, 16));
  for (const [k, v] of Object.entries(l)) {
    if (v == null || k === '_id' || k === '__v') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.length > 200) { console.log(`  ${k}: <${s.length} chars>`); continue; }
    console.log(`  ${k}: ${s}`);
  }
  const url = (blob.match(/https:\/\/[^"\\ ]*ultramsgmedia[^"\\ ]*/) || [])[0];
  if (url) {
    console.log(`  >> saved as video: ${savedV.has(url)}   saved as photo: ${savedP.has(url)}`);
  }
}

await mongoose.disconnect();
