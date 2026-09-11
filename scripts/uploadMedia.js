/**
 * Copy the local media archive to a running server.
 *
 * The archive lives on whichever machine received the files. Seeded profiles
 * therefore look right locally and show broken images everywhere else, because
 * the records are correct and the files simply are not there.
 *
 * This pushes them over the admin API, which is the only door into the server
 * that does not need shell access to the host.
 *
 *   node scripts/uploadMedia.js https://your-api.onrender.com you@example.com 'password'
 *
 * Skips anything the server already has, so re-running after a failure costs
 * only the files that did not make it.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../src/config/index.js';

const [, , baseArg, emailArg, passwordArg] = process.argv;

const BASE = (baseArg || '').replace(/\/+$/, '');
const EMAIL = emailArg || config.admin.email;
const PASSWORD = passwordArg || config.admin.password;

if (!BASE) {
  console.error('Usage: node scripts/uploadMedia.js <server-url> [email] [password]');
  process.exit(1);
}

const api = (p) => `${BASE}/api/admin${p}`;

async function signIn() {
  const res = await fetch(api('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  if (!token) throw new Error('login returned no token');
  return token;
}

async function main() {
  const dir = config.media.dir;
  const files = (await fs.readdir(dir)).filter((f) => /\.(mp4|mov|webm|jpe?g|png|webp)$/i.test(f));
  if (!files.length) {
    console.log(`Nothing to upload — ${dir} is empty.`);
    return;
  }

  console.log(`${files.length} file(s) in ${dir}`);
  console.log(`target: ${BASE}\n`);

  const token = await signIn();
  const auth = { Authorization: `Bearer ${token}` };

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of files) {
    // Already there? Then there is nothing to do — the name is a hash of the
    // source, so a file that exists is the same file.
    // eslint-disable-next-line no-await-in-loop
    const head = await fetch(`${BASE}/media/${name}`, { method: 'HEAD' }).catch(() => null);
    if (head?.ok) { skipped += 1; continue; }

    // eslint-disable-next-line no-await-in-loop
    const body = await fs.readFile(path.join(dir, name));
    const type = /\.(mp4|mov|webm)$/i.test(name) ? 'video/mp4'
      : /\.png$/i.test(name) ? 'image/png'
        : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';

    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(api(`/media/${encodeURIComponent(name)}`), {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': type },
      body,
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));

    if (res.ok) {
      sent += 1;
      process.stdout.write(`  sent ${name} (${(body.length / 1024).toFixed(0)} KB)\n`);
    } else {
      failed += 1;
      // eslint-disable-next-line no-await-in-loop
      console.error(`  FAILED ${name}: ${res.status} ${await res.text()}`);
    }
  }

  console.log(`\nsent ${sent}, already there ${skipped}, failed ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
